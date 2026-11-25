const path = require('path');
const express = require('express');
const logger = require('./logger');
const { sendError, withTimeout } = require('./utils');
const { requestId, requestLogger } = require('./middleware/requestContext');
const { authRoutes } = require('./routes/authRoutes');
const { adminRoutes } = require('./routes/adminRoutes');
const { ServiceRegistry, allowedRoles } = require('./core/serviceRegistry');

/**
 * Request pipeline for proxied services:
 *   request id -> logging/metrics -> service match -> body -> auth -> rate limit -> Redis cache -> proxy (LB + retries + circuit breaker)
 */
function createApp(deps) {
  const { config, db, redis, registry, metrics, logBuffer, auth, rateLimiter, cache, proxy } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestId());
  app.use(requestLogger({ metrics, logBuffer, gatewayId: config.gatewayId, logToStdout: config.logRequests }));

  // ---- gateway's own endpoints ----
  app.get('/', (req, res) => res.redirect('/dashboard/'));
  app.get('/inventory', (req, res) => res.redirect('/dashboard/inventory.html'));
  app.get('/health', (req, res) => res.json({ status: 'ok', gateway: config.gatewayId }));
  app.get('/ready', async (req, res) => {
    const [r, d] = await Promise.allSettled([
      withTimeout(redis.ping(), 500, 'redis'),
      withTimeout(db.query('SELECT 1'), 500, 'postgres'),
    ]);
    const checks = { redis: r.status === 'fulfilled' ? 'ok' : 'down', postgres: d.status === 'fulfilled' ? 'ok' : 'down' };
    // Redis down = degraded (gateway still serves with local rate limits, no cache); Postgres down = not ready
    const ready = checks.postgres === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? (checks.redis === 'ok' ? 'ready' : 'degraded') : 'not_ready', checks });
  });
  app.use('/dashboard', express.static(path.join(__dirname, '..', 'public')));

  app.use('/auth', express.json({ limit: '16kb' }), authRoutes(deps));
  app.use('/admin', express.json({ limit: '64kb' }), adminRoutes(deps));

  // ---- proxied services ----
  const forService = (mw) => (req, res, next) => (req.service ? mw(req, res, next) : next());
  app.use((req, res, next) => {
    req.service = registry.match(req.path);
    next();
  });
  app.use(forService(express.raw({ type: () => true, limit: '1mb' })));
  app.use(forService((req, res, next) => auth.middleware(req.service.auth)(req, res, next)));
  // business permissions: e.g. suppliers may only receive stock, the storefront may only ship
  app.use(forService((req, res, next) => {
    const roles = allowedRoles(req.service, req.method, ServiceRegistry.upstreamPath(req.service, req.originalUrl));
    if (!roles || (req.principal && roles.includes(req.principal.tier))) return next();
    if (!req.principal) return sendError(res, 401, 'unauthorized', 'Provide X-API-Key or Authorization: Bearer <token>');
    return sendError(res, 403, 'forbidden', `Client role "${req.principal.tier}" may not ${req.method} ${req.path}`, { allowedRoles: roles });
  }));
  app.use(forService(rateLimiter.middleware()));
  app.use(forService(cache.middleware()));
  app.use(forService(proxy));

  // ---- fallthrough & errors ----
  app.use((req, res) => sendError(res, 404, 'not_found', `No route for ${req.method} ${req.path}`));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large', 'Request body too large');
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'bad_request', 'Malformed JSON body');
    logger.error('unhandled error', { err, requestId: req.id, path: req.originalUrl });
    res.locals.error = err.message;
    sendError(res, 500, 'internal_error', 'Internal gateway error');
  });

  return app;
}

module.exports = { createApp };
