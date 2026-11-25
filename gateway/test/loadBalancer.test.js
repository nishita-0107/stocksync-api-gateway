const test = require('node:test');
const assert = require('node:assert/strict');
const { LoadBalancer } = require('../src/core/loadBalancer');
const { UpstreamInstance } = require('../src/core/upstreamInstance');

const make = (n) => Array.from({ length: n }, (_, i) => new UpstreamInstance({ id: `i${i + 1}`, url: `http://h${i + 1}` }));

test('round-robin cycles through instances', () => {
  const lb = new LoadBalancer('round-robin');
  const instances = make(3);
  const picks = Array.from({ length: 6 }, () => lb.pick(instances).id);
  assert.deepEqual(picks, ['i1', 'i2', 'i3', 'i1', 'i2', 'i3']);
});

test('skips unhealthy instances and instances with an open circuit', () => {
  const lb = new LoadBalancer('round-robin');
  const [a, b, c] = make(3);
  b.healthy = false;
  for (let i = 0; i < 5; i++) c.breaker.onFailure();
  const picks = new Set(Array.from({ length: 5 }, () => lb.pick([a, b, c]).id));
  assert.deepEqual([...picks], ['i1']);
});

test('returns null when nothing is available', () => {
  const lb = new LoadBalancer();
  const instances = make(2);
  instances.forEach((i) => (i.healthy = false));
  assert.equal(lb.pick(instances), null);
});

test('excludes already-tried instances (retry on a different instance)', () => {
  const lb = new LoadBalancer();
  const instances = make(2);
  const first = lb.pick(instances);
  const second = lb.pick(instances, new Set([first.id]));
  assert.notEqual(first.id, second.id);
  assert.equal(lb.pick(instances, new Set(['i1', 'i2'])), null);
});

test('least-connections prefers the least busy instance', () => {
  const lb = new LoadBalancer('least-connections');
  const [a, b, c] = make(3);
  a.activeConnections = 5;
  b.activeConnections = 1;
  c.activeConnections = 3;
  assert.equal(lb.pick([a, b, c]).id, 'i2');
});

test('rejects unknown strategies', () => {
  assert.throws(() => new LoadBalancer('fastest'), /Unknown load-balancing strategy/);
});
