const config = require('./config');
const logger = require('./logger');
const { waitFor, sendError } = require('./utils');
const { pool, migrate } = require('./db');
const { createRedis, createBullConnection } = require('./redis');
const { createQueues } = require('./queues');
const { ServiceRegistry } = require('./core/serviceRegistry');
const { HealthChecker } = require('./core/healthChecker');
const { Metrics } = require('./core/metrics');
const { LogBuffer } = require('./core/logBuffer');
const { createRateLimiter } = require('./core/rateLimiter');
const { createCache } = require('./core/cache');
const { createProxy } = require('./core/proxy');
const { createAuth } = require('./middleware/auth');
const { createApp } = require('./app');

async function main() {
  await waitFor('postgres', () => pool.query('SELECT 1'), { logger });
  await migrate();

  const redis = createRedis('gateway');
  const bullConnection = createBullConnection('gateway-queues');
  const queues = createQueues(bullConnection);

  const registry = new ServiceRegistry(config.loadServices(), config.circuitBreaker);
  const healthChecker = new HealthChecker(registry, config.healthCheck);
  healthChecker.start();

  const metrics = new Metrics({ redis });
  const logBuffer = new LogBuffer({ queue: queues.logs, ...config.logs });
  logBuffer.start();

  const auth = createAuth({ config });
  const rateLimiter = createRateLimiter({ redis, tiers: config.tiers, metrics, sendError });
  const cache = createCache({ redis });
  const proxy = createProxy({ cache });

  const app = createApp({ config, db: pool, redis, queues, registry, metrics, logBuffer, auth, rateLimiter, cache, proxy });
  const server = app.listen(config.port, () =>
    logger.info('gateway listening', {
      port: config.port,
      gatewayId: config.gatewayId,
      services: registry.snapshot().map((s) => `${s.name} -> ${s.prefix} (${s.instances.length} instances, ${s.strategy})`),
    })
  );
  server.keepAliveTimeout = 65000;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close();
    healthChecker.stop();
    await logBuffer.stop();
    await queues.logs.close().catch(() => {});
    await Promise.allSettled([redis.quit(), bullConnection.quit(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('gateway failed to start', { err });
  process.exit(1);
});
