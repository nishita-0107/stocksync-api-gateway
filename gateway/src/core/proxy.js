const logger = require('../logger');
const { sendError } = require('../utils');
const { ServiceRegistry } = require('./serviceRegistry');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
// never forward client credentials to upstreams; the gateway passes identity via x-gateway-* headers
const STRIP_REQUEST = new Set([...HOP_BY_HOP, 'authorization', 'x-api-key', 'accept-encoding']);
// fetch() already decoded the body, so encoding/length headers from upstream no longer apply
const STRIP_RESPONSE = new Set([...HOP_BY_HOP, 'content-encoding', 'set-cookie']);
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]); // only ever retried for safe methods
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function buildUpstreamHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST.has(k) && !k.startsWith('x-gateway-')) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const xff = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = xff ? `${xff}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers['x-forwarded-proto'] = req.protocol;
  headers['x-request-id'] = req.id;
  if (req.principal) {
    headers['x-gateway-client-id'] = req.principal.id;
    headers['x-gateway-client-tier'] = req.principal.tier;
  }
  return headers;
}

/**
 * Forwards the request to an upstream instance chosen by the service's load balancer.
 * Safe (idempotent) requests are retried on a *different* instance on network errors,
 * timeouts and 500/502/503/504. Every outcome feeds the instance's circuit breaker.
 */
function createProxy({ cache, fetchImpl = fetch } = {}) {
  return async function proxy(req, res) {
    const svc = req.service;
    const upstreamPath = ServiceRegistry.upstreamPath(svc, req.originalUrl);
    if (upstreamPath.startsWith('/_')) {
      return sendError(res, 404, 'not_found', 'Internal upstream endpoints are not exposed');
    }

    const maxAttempts = SAFE_METHODS.has(req.method) ? 1 + svc.retries : 1;
    const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0 && !['GET', 'HEAD'].includes(req.method);
    const headers = buildUpstreamHeaders(req);
    const tried = new Set();
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const instance = svc.balancer.pick(svc.instances, tried);
      if (!instance) break;
      tried.add(instance.id);

      instance.breaker.onRequestStart();
      instance.activeConnections++;
      instance.totalRequests++;
      const started = Date.now();

      let upstreamRes;
      let body;
      try {
        upstreamRes = await fetchImpl(instance.url + upstreamPath, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(svc.timeoutMs),
        });
        body = Buffer.from(await upstreamRes.arrayBuffer());
      } catch (err) {
        instance.breaker.onFailure();
        instance.totalFailures++;
        lastError = err.name === 'TimeoutError' ? 'upstream_timeout' : `upstream_error: ${err.cause?.code || err.message}`;
        logger.warn('upstream request failed', { requestId: req.id, instance: instance.id, attempt, error: lastError });
        continue;
      } finally {
        instance.activeConnections--;
        instance.recordResponseTime(Date.now() - started);
      }

      if (upstreamRes.status >= 500) {
        instance.breaker.onFailure();
        instance.totalFailures++;
        lastError = `upstream_status_${upstreamRes.status}`;
        if (RETRYABLE_STATUS.has(upstreamRes.status) && attempt < maxAttempts) continue;
      } else {
        instance.breaker.onSuccess();
      }

      // ---- respond ----
      const outHeaders = {};
      upstreamRes.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE.has(key)) outHeaders[key] = value;
      });
      for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v);
      const cookies = upstreamRes.headers.getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.setHeader('X-Upstream-Instance', instance.id);
      res.setHeader('X-Upstream-Attempts', attempt);
      res.locals.upstream = instance.id;
      res.locals.attempts = attempt;
      if (upstreamRes.status >= 500) res.locals.error = lastError;

      if (req.method === 'HEAD') res.status(upstreamRes.status).end();
      else res.status(upstreamRes.status).send(body);

      const cacheable =
        res.locals.cache && cache && upstreamRes.status === 200 &&
        !/no-store|private/.test(upstreamRes.headers.get('cache-control') || '');
      if (cacheable) {
        cache.store(res.locals.cache, { status: 200, headers: outHeaders, body }).catch((err) =>
          logger.debug('cache store failed', { error: err.message })
        );
      }
      return;
    }

    // No instance could serve the request.
    res.locals.attempts = tried.size;
    if (tried.size === 0) {
      res.locals.error = 'no_available_upstream';
      res.setHeader('Retry-After', 5);
      return sendError(res, 503, 'service_unavailable', `No healthy instance available for service "${svc.name}"`);
    }
    res.locals.error = lastError;
    const timedOut = lastError === 'upstream_timeout';
    return sendError(res, timedOut ? 504 : 502, timedOut ? 'gateway_timeout' : 'bad_gateway',
      `Upstream "${svc.name}" failed after ${tried.size} attempt(s)`, { lastError });
  };
}

module.exports = { createProxy, buildUpstreamHeaders };
