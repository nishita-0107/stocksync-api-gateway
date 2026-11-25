const fs = require('fs');
const os = require('os');
const path = require('path');

const env = process.env;
const num = (name, fallback) => (env[name] !== undefined ? Number(env[name]) : fallback);

function loadServices() {
  const file = env.SERVICES_CONFIG
    ? path.resolve(env.SERVICES_CONFIG)
    : path.join(__dirname, '..', 'config', 'services.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// generic tiers + business client roles (storefront, supplier, scanner)
const TIERS = ['free', 'pro', 'admin', 'storefront', 'supplier', 'scanner'];

// "rawKey:tier[:name],rawKey:tier[:name]" -> [{ key, tier, name }]
function parseApiKeys(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, tier, name] = entry.split(':');
      if (!key || !TIERS.includes(tier)) throw new Error(`API_KEYS: invalid entry "${entry}" (expected key:tier[:name])`);
      return { key, tier, name: name || `demo-${tier}` };
    });
}

module.exports = {
  port: num('PORT', 8080),
  gatewayId: env.GATEWAY_ID || os.hostname(),
  trustProxy: env.TRUST_PROXY === 'true',
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
  databaseUrl: env.DATABASE_URL || 'postgres://gateway:gateway@localhost:5432/gateway',
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  jwtTtlSeconds: num('JWT_TTL_SECONDS', 3600),
  logRequests: env.LOG_REQUESTS === 'true',

  // Token-bucket rate limits per client tier. capacity = max burst, refillPerSec = sustained rate.
  tiers: {
    anonymous: { capacity: num('RL_ANON_CAPACITY', 10), refillPerSec: num('RL_ANON_REFILL', 1) },
    free: { capacity: num('RL_FREE_CAPACITY', 20), refillPerSec: num('RL_FREE_REFILL', 5) },
    pro: { capacity: num('RL_PRO_CAPACITY', 200), refillPerSec: num('RL_PRO_REFILL', 50) },
    admin: { capacity: num('RL_ADMIN_CAPACITY', 1000), refillPerSec: num('RL_ADMIN_REFILL', 500) },
    // business clients: the online storefront takes customer traffic, suppliers are low-volume partners,
    // warehouse scanners sit in between
    storefront: { capacity: num('RL_STOREFRONT_CAPACITY', 1000), refillPerSec: num('RL_STOREFRONT_REFILL', 300) },
    supplier: { capacity: num('RL_SUPPLIER_CAPACITY', 30), refillPerSec: num('RL_SUPPLIER_REFILL', 5) },
    scanner: { capacity: num('RL_SCANNER_CAPACITY', 200), refillPerSec: num('RL_SCANNER_REFILL', 50) },
  },

  healthCheck: {
    intervalMs: num('HEALTH_INTERVAL_MS', 3000),
    timeoutMs: num('HEALTH_TIMEOUT_MS', 1500),
    unhealthyThreshold: num('HEALTH_UNHEALTHY_THRESHOLD', 2),
    healthyThreshold: num('HEALTH_HEALTHY_THRESHOLD', 2),
  },

  circuitBreaker: {
    failureThreshold: num('CB_FAILURE_THRESHOLD', 5),
    resetTimeoutMs: num('CB_RESET_TIMEOUT_MS', 10000),
    halfOpenMaxRequests: num('CB_HALF_OPEN_MAX', 1),
  },

  logs: {
    flushIntervalMs: num('LOG_FLUSH_INTERVAL_MS', 1000),
    batchSize: num('LOG_BATCH_SIZE', 200),
    retentionDays: num('LOG_RETENTION_DAYS', 7),
  },

  // Static API keys (no database). Override with API_KEYS="key:tier:name,...".
  apiKeys: parseApiKeys(env.API_KEYS || 'demo-free-key:free,demo-pro-key:pro,demo-admin-key:admin,demo-storefront-key:storefront:web-storefront,demo-supplier-key:supplier:acme-supplies,demo-scanner-key:scanner:wh-scanner'),

  loadServices,
};
