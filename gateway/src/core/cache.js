const logger = require('../logger');
const { withTimeout } = require('../utils');

const REDIS_TIMEOUT_MS = 200;
const UNCACHEABLE_HEADERS = new Set(['set-cookie', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-policy', 'retry-after']);

/*
 * Redis response cache for GET requests on services with cacheTtlSeconds > 0.
 *
 * Key:          cache:<service>:v<version>:<url>
 * Invalidation: any successful write (POST/PUT/PATCH/DELETE) to a service bumps
 *               cachever:<service>, so all of that service's entries become unreachable at once
 *               (O(1), no SCAN/KEYS) and expire on their own TTL. A service can also list
 *               "invalidates": [...] in its config to purge other services' caches on write.
 * Failure mode: if Redis is slow or down the request simply bypasses the cache.
 */
const versionKey = (service) => `cachever:${service}`;
const buildCacheKey = (service, version, url) => `cache:${service}:v${version}:${url}`;

function createCache({ redis }) {
  function middleware() {
    return async (req, res, next) => {
      const svc = req.service;

      if (req.method !== 'GET') {
        res.locals.cacheStatus = 'BYPASS';
        // A successful write purges this service's cache and the caches of services that depend on it
        // (e.g. a stock movement changes what GET /api/inventory returns).
        const targets = [...(svc.cacheTtlSeconds ? [svc.name] : []), ...(svc.invalidates || [])];
        if (targets.length && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
          res.on('finish', () => {
            if (res.statusCode < 400) for (const t of targets) invalidate(t).catch(() => {});
          });
        }
        return next();
      }

      if (!svc.cacheTtlSeconds) {
        res.locals.cacheStatus = 'BYPASS';
        return next();
      }

      if (/no-cache|no-store/.test(req.headers['cache-control'] || '')) {
        res.locals.cacheStatus = 'BYPASS';
        return next();
      }

      try {
        const version = (await withTimeout(redis.get(versionKey(svc.name)), REDIS_TIMEOUT_MS, 'cache')) || '0';
        const key = buildCacheKey(svc.name, version, req.originalUrl);
        const cached = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS, 'cache');

        if (cached) {
          const entry = JSON.parse(cached);
          res.locals.cacheStatus = 'HIT';
          res.locals.upstream = 'cache';
          for (const [k, v] of Object.entries(entry.headers)) res.setHeader(k, v);
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('Age', Math.floor((Date.now() - entry.storedAt) / 1000));
          return res.status(entry.status).send(Buffer.from(entry.body, 'base64'));
        }

        res.locals.cacheStatus = 'MISS';
        res.locals.cache = { key, ttl: svc.cacheTtlSeconds }; // the proxy stores the response under this key
        res.setHeader('X-Cache', 'MISS');
      } catch (err) {
        res.locals.cacheStatus = 'BYPASS';
        logger.debug('cache bypassed', { error: err.message });
      }
      next();
    };
  }

  /** Called by the proxy after a successful upstream response. */
  async function store({ key, ttl }, { status, headers, body }) {
    const storable = {};
    for (const [k, v] of Object.entries(headers)) if (!UNCACHEABLE_HEADERS.has(k)) storable[k] = v;
    const entry = JSON.stringify({ status, headers: storable, body: body.toString('base64'), storedAt: Date.now() });
    await withTimeout(redis.set(key, entry, 'EX', ttl), REDIS_TIMEOUT_MS, 'cache store');
  }

  async function invalidate(service) {
    return redis.incr(versionKey(service));
  }

  return { middleware, store, invalidate };
}

module.exports = { createCache, buildCacheKey };
