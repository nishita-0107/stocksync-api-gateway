const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

/**
 * Connection used on the request path (rate limiting, caching, metrics).
 * Fails fast instead of queueing commands while Redis is down, so the gateway can degrade gracefully.
 */
function createRedis(name) {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  attachLogging(client, name);
  return client;
}

/** Connection for BullMQ (it requires maxRetriesPerRequest = null for blocking commands). */
function createBullConnection(name) {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  attachLogging(client, name);
  return client;
}

function attachLogging(client, name) {
  let lastError = 0;
  client.on('ready', () => logger.info('redis connected', { connection: name }));
  client.on('error', (err) => {
    // throttle repeated connection errors to one line every 5s
    if (Date.now() - lastError > 5000) logger.warn('redis error', { connection: name, error: err.message });
    lastError = Date.now();
  });
}

module.exports = { createRedis, createBullConnection };
