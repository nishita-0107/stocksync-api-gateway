const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalTokenBucket } = require('../src/core/localTokenBucket');
const { createRateLimiter } = require('../src/core/rateLimiter');

test('token bucket allows a burst up to capacity, then rejects', () => {
  const b = new LocalTokenBucket();
  const results = Array.from({ length: 6 }, () => b.consume('k', 5, 1, 1, 0).allowed);
  assert.deepEqual(results, [true, true, true, true, true, false]);
});

test('tokens refill over time at refillPerSec', () => {
  const b = new LocalTokenBucket();
  for (let i = 0; i < 5; i++) b.consume('k', 5, 2, 1, 0);
  assert.equal(b.consume('k', 5, 2, 1, 0).allowed, false);
  assert.equal(b.consume('k', 5, 2, 1, 500).allowed, true); // 0.5s * 2/s = 1 token
  assert.equal(b.consume('k', 5, 2, 1, 500).allowed, false);
});

test('reports retryAfterMs when rejected', () => {
  const b = new LocalTokenBucket();
  b.consume('k', 2, 4, 2, 0);
  const r = b.consume('k', 2, 4, 1, 0);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs, 250);
});

test('cost > 1 consumes several tokens', () => {
  const b = new LocalTokenBucket();
  assert.equal(b.consume('k', 10, 1, 5, 0).allowed, true);
  assert.equal(b.consume('k', 10, 1, 5, 0).allowed, true);
  assert.equal(b.consume('k', 10, 1, 1, 0).allowed, false);
});

test('buckets are independent per identity', () => {
  const b = new LocalTokenBucket();
  b.consume('a', 1, 1, 1, 0);
  assert.equal(b.consume('a', 1, 1, 1, 0).allowed, false);
  assert.equal(b.consume('b', 1, 1, 1, 0).allowed, true);
});

test('middleware falls back to local buckets when Redis fails and returns 429', async () => {
  const fakeRedis = { defineCommand() {}, tokenBucket: () => Promise.reject(new Error('redis down')) };
  const errors = [];
  const limiter = createRateLimiter({
    redis: fakeRedis,
    tiers: { anonymous: { capacity: 2, refillPerSec: 0.001 } },
    sendError: (res, status) => errors.push(status),
  });
  const mw = limiter.middleware();
  const headers = {};
  const res = { locals: {}, setHeader: (k, v) => (headers[k] = v) };
  let passed = 0;
  for (let i = 0; i < 3; i++) await mw({ ip: '1.2.3.4' }, res, () => passed++);
  assert.equal(passed, 2);
  assert.deepEqual(errors, [429]);
  assert.equal(headers['X-RateLimit-Mode'], 'local-fallback');
  assert.ok(headers['Retry-After'] >= 1);
});
