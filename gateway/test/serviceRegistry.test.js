const test = require('node:test');
const assert = require('node:assert/strict');
const { ServiceRegistry } = require('../src/core/serviceRegistry');
const { buildCacheKey } = require('../src/core/cache');

const registry = new ServiceRegistry({
  a: { prefix: '/api/a', instances: ['http://a1'] },
  ab: { prefix: '/api/a/b', instances: ['http://ab1'], auth: 'optional' },
});

test('matches by longest prefix on path-segment boundaries', () => {
  assert.equal(registry.match('/api/a').name, 'a');
  assert.equal(registry.match('/api/a/x').name, 'a');
  assert.equal(registry.match('/api/a/b/c').name, 'ab');
  assert.equal(registry.match('/api/abc'), null);
  assert.equal(registry.match('/other'), null);
});

test('rewrites upstream path', () => {
  const svc = registry.services.get('a');
  assert.equal(ServiceRegistry.upstreamPath(svc, '/api/a'), '/');
  assert.equal(ServiceRegistry.upstreamPath(svc, '/api/a?q=1'), '/?q=1');
  assert.equal(ServiceRegistry.upstreamPath(svc, '/api/a/42'), '/42');
});

test('string instances get generated ids', () => {
  assert.equal(registry.findInstance('a-1').url, 'http://a1');
});

test('validates config', () => {
  assert.throws(() => new ServiceRegistry({ x: { prefix: 'api', instances: ['http://x'] } }), /prefix/);
  assert.throws(() => new ServiceRegistry({ x: { prefix: '/x', instances: [] } }), /no instances/);
  assert.throws(() => new ServiceRegistry({ x: { prefix: '/x', auth: 'maybe', instances: ['http://x'] } }), /auth/);
});

test('cache keys are versioned per service', () => {
  assert.equal(buildCacheKey('inventory', '3', '/api/inventory?limit=5'), 'cache:inventory:v3:/api/inventory?limit=5');
});

test('validates "invalidates" references', () => {
  const r = new ServiceRegistry({
    inv: { prefix: '/inv', instances: ['http://i'] },
    stock: { prefix: '/stock', instances: ['http://s'], invalidates: ['inv'] },
  });
  assert.deepEqual(r.services.get('stock').invalidates, ['inv']);
  assert.deepEqual(r.services.get('inv').invalidates, []);
  assert.throws(
    () => new ServiceRegistry({ s: { prefix: '/s', instances: ['http://s'], invalidates: ['nope'] } }),
    /invalidates unknown service/
  );
});

test('permissions: rules match method + path (with * segments); unmatched requests are open', () => {
  const { allowedRoles } = require('../src/core/serviceRegistry');
  const r = new ServiceRegistry({
    stock: { prefix: '/s', instances: ['http://s'], permissions: { 'POST /receive': ['supplier'], 'PATCH /*': ['admin'] } },
  });
  const svc = r.services.get('stock');
  assert.deepEqual(allowedRoles(svc, 'POST', '/receive?x=1'), ['supplier']);
  assert.deepEqual(allowedRoles(svc, 'PATCH', '/ELE-1'), ['admin']);
  assert.equal(allowedRoles(svc, 'PATCH', '/a/b'), null);
  assert.equal(allowedRoles(svc, 'GET', '/receive'), null);
  assert.throws(() => new ServiceRegistry({ x: { prefix: '/x', instances: ['http://x'], permissions: { 'receive': ['a'] } } }), /invalid permission/);
});
