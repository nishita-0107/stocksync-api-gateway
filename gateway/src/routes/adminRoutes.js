const express = require('express');
const { sendError, withTimeout } = require('../utils');

const COUNT_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'];

/** Admin API (admin tier only). Powers the dashboard. */
function adminRoutes({ db, redis, queues, registry, metrics, logBuffer, auth, cache, config }) {
  const router = express.Router();
  const startedAt = Date.now();
  router.use((req, res, next) => {
    res.locals.route = 'admin';
    next();
  });
  router.use(auth.middleware('admin'));

  // ---------- overview ----------
  router.get('/stats', async (req, res) => {
    const [m, logsQ] = await Promise.allSettled([
      metrics.snapshot(30),
      withTimeout(queues.logs.getJobCounts(...COUNT_STATES), 1000, 'queue counts'),
    ]);
    const val = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
    res.json({
      gateway: {
        id: config.gatewayId,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        redis: redis.status,
      },
      metrics: val(m, null),
      latency: metrics.latencyPercentiles(),
      services: registry.snapshot(),
      queues: { logs: val(logsQ, null) },
      logPipeline: logBuffer.stats(),
      tiers: config.tiers,
    });
  });

  router.get('/services', (req, res) => res.json({ services: registry.snapshot() }));

  // ---------- request logs (Postgres) ----------
  router.get('/logs', async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.service) {
      params.push(String(req.query.service));
      where.push(`service = $${params.length}`);
    }
    if (req.query.client) {
      params.push(String(req.query.client));
      where.push(`client_id = $${params.length}`);
    }
    const status = String(req.query.status || '');
    if (/^[1-5]xx$/.test(status)) {
      const base = Number(status[0]) * 100;
      where.push(`status >= ${base} AND status < ${base + 100}`);
    } else if (/^\d{3}$/.test(status)) {
      params.push(Number(status));
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const sql = `SELECT request_id, ts, method, path, status, latency_ms, service, upstream, client_id,
                        cache_status, rate_limited, error, client_ip
                 FROM request_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ts DESC LIMIT ${limit}`;
    const { rows } = await db.query(sql, params);
    res.json({ logs: rows });
  });

  // ---------- cache ----------
  router.post('/cache/purge', async (req, res) => {
    const service = req.body?.service;
    const names = service ? [service] : [...registry.services.keys()];
    if (service && !registry.services.has(service)) return sendError(res, 404, 'not_found', 'Unknown service');
    await Promise.all(names.map((n) => cache.invalidate(n)));
    res.json({ purged: names });
  });

  // ---------- chaos testing (forwarded to the backend's internal endpoint) ----------
  router.post('/instances/:id/chaos', async (req, res) => {
    const instance = registry.findInstance(req.params.id);
    if (!instance) return sendError(res, 404, 'not_found', 'Unknown instance');
    try {
      const upstream = await fetch(`${instance.url}/_chaos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(2000),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch (err) {
      sendError(res, 502, 'bad_gateway', `Could not reach ${instance.id}: ${err.message}`);
    }
  });

  return router;
}

module.exports = { adminRoutes };
