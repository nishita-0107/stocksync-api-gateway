const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCache } = require('../src/core/cache');

function fakeRedis() {
  const incrs = [];
  return { incrs, incr: async (k) => incrs.push(k), get: async () => null, set: async () => 'OK' };
}

/** Runs the cache middleware for one request, then "finishes" the response with the given status. */
async function write(cache, service, { method = 'POST', status = 201 } = {}) {
  const req = { method, service, headers: {}, originalUrl: '/x' };
  const res = Object.assign(new EventEmitter(), { locals: {}, setHeader() {} });
  let nextCalled = false;
  await cache.middleware()(req, res, () => (nextCalled = true));
  assert.ok(nextCalled);
  res.statusCode = status;
  res.emit('finish');
  await new Promise((r) => setImmediate(r));
}

test('a successful write to an uncached service purges the services it invalidates', async () => {
  const redis = fakeRedis();
  const cache = createCache({ redis });
  await write(cache, { name: 'stock', cacheTtlSeconds: 0, invalidates: ['inventory'] });
  assert.deepEqual(redis.incrs, ['cachever:inventory']);
});

test('a write to a cached service purges itself and its dependents', async () => {
  const redis = fakeRedis();
  const cache = createCache({ redis });
  await write(cache, { name: 'inventory', cacheTtlSeconds: 5, invalidates: ['reports'] }, { method: 'PATCH', status: 200 });
  assert.deepEqual(redis.incrs, ['cachever:inventory', 'cachever:reports']);
});

test('failed writes (e.g. 409 insufficient stock) do not purge anything', async () => {
  const redis = fakeRedis();
  const cache = createCache({ redis });
  await write(cache, { name: 'stock', cacheTtlSeconds: 0, invalidates: ['inventory'] }, { status: 409 });
  assert.deepEqual(redis.incrs, []);
});

test('writes to an uncached service with no dependents do nothing', async () => {
  const redis = fakeRedis();
  const cache = createCache({ redis });
  await write(cache, { name: 'audit', cacheTtlSeconds: 0, invalidates: [] });
  assert.deepEqual(redis.incrs, []);
});
