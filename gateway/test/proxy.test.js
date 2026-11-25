// Integration test: real HTTP upstreams + the real proxy/registry, without Redis or Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { ServiceRegistry } = require('../src/core/serviceRegistry');
const { createProxy } = require('../src/core/proxy');

function startUpstream(id, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler || ((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, path: req.url, auth: req.headers['x-api-key'] ?? null, rid: req.headers['x-request-id'] }));
    }));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function setup(upstreams, serviceOverrides = {}) {
  const registry = new ServiceRegistry(
    {
      svc: {
        prefix: '/api/svc',
        auth: 'optional',
        retries: 2,
        timeoutMs: 500,
        instances: upstreams.map((u, i) => ({ id: `u${i + 1}`, url: u.url })),
        ...serviceOverrides,
      },
    },
    { failureThreshold: 2, resetTimeoutMs: 60000 }
  );
  const app = express();
  app.use((req, res, next) => {
    req.id = 'test-req';
    req.service = registry.match(req.path);
    req.service ? next() : res.status(404).end();
  });
  app.use(express.raw({ type: () => true }));
  app.use(createProxy());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { registry, base, close: () => server.close() };
}

test('path rewrite and round-robin across instances; credentials are not forwarded', async (t) => {
  const ups = await Promise.all([startUpstream('A'), startUpstream('B')]);
  const gw = await setup(ups);
  t.after(() => { gw.close(); ups.forEach((u) => u.server.close()); });

  const r1 = await (await fetch(`${gw.base}/api/svc/items/7?x=1`, { headers: { 'x-api-key': 'secret' } })).json();
  const r2 = await (await fetch(`${gw.base}/api/svc/items/7?x=1`)).json();
  assert.equal(r1.path, '/items/7?x=1');
  assert.equal(r1.auth, null);
  assert.equal(r1.rid, 'test-req');
  assert.notEqual(r1.id, r2.id);
});

test('fails over to a healthy instance when one is unreachable', async (t) => {
  const good = await startUpstream('GOOD');
  const dead = { url: 'http://127.0.0.1:1' }; // nothing listens on port 1
  const gw = await setup([dead, good]);
  t.after(() => { gw.close(); good.server.close(); });

  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${gw.base}/api/svc/`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 'GOOD');
  }
  const deadInstance = gw.registry.findInstance('u1');
  assert.equal(deadInstance.breaker.state, 'OPEN', 'circuit opens after repeated failures');
});

test('retries 503 on another instance for GET', async (t) => {
  const failing = await startUpstream('F', (req, res) => { res.statusCode = 503; res.end('busy'); });
  const ok = await startUpstream('OK');
  const gw = await setup([failing, ok]);
  t.after(() => { gw.close(); failing.server.close(); ok.server.close(); });

  const res = await fetch(`${gw.base}/api/svc/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream-instance'), 'u2');
  assert.equal(res.headers.get('x-upstream-attempts'), '2');
});

test('does not retry non-idempotent POST', async (t) => {
  let hits = 0;
  const failing = await startUpstream('F', (req, res) => { hits++; res.statusCode = 503; res.end('busy'); });
  const ok = await startUpstream('OK');
  const gw = await setup([failing, ok]);
  t.after(() => { gw.close(); failing.server.close(); ok.server.close(); });

  const res = await fetch(`${gw.base}/api/svc/`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.equal(hits, 1);
});

test('returns 504 on upstream timeout and 503 when no instance is available', async (t) => {
  const slow = await startUpstream('S', (req, res) => setTimeout(() => res.end('late'), 2000));
  const gw = await setup([slow], { retries: 0 });
  t.after(() => { gw.close(); slow.server.closeAllConnections(); slow.server.close(); });

  const r1 = await fetch(`${gw.base}/api/svc/`);
  assert.equal(r1.status, 504);

  gw.registry.findInstance('u1').healthy = false;
  const r2 = await fetch(`${gw.base}/api/svc/`);
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error.code, 'service_unavailable');
});

test('blocks internal upstream endpoints', async (t) => {
  const up = await startUpstream('A');
  const gw = await setup([up]);
  t.after(() => { gw.close(); up.server.close(); });
  const res = await fetch(`${gw.base}/api/svc/_chaos`, { method: 'POST' });
  assert.equal(res.status, 404);
});
