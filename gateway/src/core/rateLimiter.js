const logger = require('../logger');
const { withTimeout } = require('../utils');
const { LocalTokenBucket } = require('./localTokenBucket');

/*
 * Distributed token bucket, executed atomically inside Redis.
 * Uses Redis server TIME so multiple gateway instances share one clock.
 * KEYS[1] = bucket key; ARGV = capacity, refillPerSec, cost
 * Returns { allowed (0|1), tokensRemaining (string), retryAfterMs }
 */
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local t        = redis.call('TIME')
local now      = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill / 1000)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / refill)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity * 1000 / refill) + 1000)
return { allowed, tostring(tokens), retry }
`;

function createRateLimiter({ redis, tiers, metrics, sendError }) {
  redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  const local = new LocalTokenBucket();
  let lastFallbackLog = 0;

  async function consume(id, tier, cost) {
    try {
      const [allowed, tokens, retry] = await withTimeout(
        redis.tokenBucket(`rl:${id}`, tier.capacity, tier.refillPerSec, cost),
        250,
        'rate limiter'
      );
      return { allowed: allowed === 1, remaining: Math.floor(Number(tokens)), retryAfterMs: Number(retry), source: 'redis' };
    } catch (err) {
      if (Date.now() - lastFallbackLog > 5000) {
        logger.warn('rate limiter falling back to local buckets', { error: err.message });
        lastFallbackLog = Date.now();
      }
      return { ...local.consume(id, tier.capacity, tier.refillPerSec, cost), source: 'local' };
    }
  }

  /** Express middleware. Identity = API key / JWT subject when authenticated, else client IP. */
  function middleware({ cost } = {}) {
    return async (req, res, next) => {
      const principal = req.principal;
      const tierName = principal?.tier ?? 'anonymous';
      const tier = tiers[tierName] ?? tiers.anonymous;
      const identity = principal ? `key:${principal.id}` : `ip:${req.ip}`;
      const requestCost = cost ?? req.service?.cost ?? 1;

      const result = await consume(identity, tier, requestCost);
      res.setHeader('X-RateLimit-Limit', tier.capacity);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
      res.setHeader('X-RateLimit-Policy', `token-bucket;capacity=${tier.capacity};refill=${tier.refillPerSec}/s;tier=${tierName}`);
      if (result.source === 'local') res.setHeader('X-RateLimit-Mode', 'local-fallback');

      if (!result.allowed) {
        res.locals.rateLimited = true;
        res.setHeader('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
        return sendError(res, 429, 'rate_limited', `Rate limit exceeded for tier "${tierName}"`, {
          retryAfterMs: result.retryAfterMs,
        });
      }
      next();
    };
  }

  return { middleware, consume };
}

module.exports = { createRateLimiter, TOKEN_BUCKET_LUA };
