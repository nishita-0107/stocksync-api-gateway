const crypto = require('crypto');
const logger = require('../logger');

const VALID_REQUEST_ID = /^[\w\-.:]{1,128}$/;

/** Assigns/propagates X-Request-Id and records the start time. */
function requestId() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.startedAt = process.hrtime.bigint();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/** On completion, records metrics and pushes a log entry to the async log pipeline. */
function requestLogger({ metrics, logBuffer, gatewayId, logToStdout = false }) {
  return (req, res, next) => {
    let done = false;
    const finish = (aborted) => {
      if (done) return;
      done = true;
      const latencyMs = Number((process.hrtime.bigint() - req.startedAt) / 1000000n);
      const entry = {
        request_id: req.id,
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl.slice(0, 500),
        status: aborted ? 499 : res.statusCode,
        latency_ms: latencyMs,
        service: req.service?.name ?? res.locals.route ?? null,
        upstream: res.locals.upstream ?? null,
        client_id: req.principal?.id ?? null,
        client_ip: req.ip,
        cache_status: res.locals.cacheStatus ?? null,
        rate_limited: Boolean(res.locals.rateLimited),
        error: res.locals.error ?? (aborted ? 'client_closed_request' : null),
        gateway_id: gatewayId,
      };
      // don't count probes, static files or the dashboard's own polling as traffic
      const p = req.originalUrl;
      if (p === '/health' || p === '/ready' || p.startsWith('/dashboard') || (req.method === 'GET' && p.startsWith('/admin'))) return;
      metrics.record(entry);
      logBuffer.push(entry);
      if (logToStdout) logger.info('request', entry);
    };
    res.on('finish', () => finish(false));
    res.on('close', () => finish(!res.writableFinished));
    next();
  };
}

module.exports = { requestId, requestLogger };
