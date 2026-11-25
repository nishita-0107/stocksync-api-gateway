#!/usr/bin/env node
// End-to-end walkthrough of every gateway feature. Run after `docker compose up -d`.
// usage: node scripts/demo.js [baseUrl]
const BASE = process.argv[2] || 'http://localhost:8080';
const ADMIN = 'demo-admin-key';
const FREE = 'demo-free-key';
const PRO = 'demo-pro-key';
const SUPPLIER = 'demo-supplier-key';
const STOREFRONT = 'demo-storefront-key';
const SCANNER = 'demo-scanner-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = (s) => console.log(`\n\x1b[1;36m== ${s} ==\x1b[0m`);
const line = (s) => console.log('  ' + s);

async function call(path, { key, token, method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h['x-api-key'] = key;
  if (token) h.authorization = `Bearer ${token}`;
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

(async () => {
  title('1. Gateway health');
  const ready = await call('/ready');
  line(`GET /ready -> ${ready.status} ${JSON.stringify(ready.body)}`);

  title('2. Authentication');
  const noAuth = await call('/api/stock/movements');
  line(`GET /api/stock/movements without credentials -> ${noAuth.status} (${noAuth.body.error?.code})`);
  const bad = await call('/api/stock/movements', { key: 'wrong' });
  line(`GET /api/stock/movements with a bad key -> ${bad.status}`);
  const tok = await call('/auth/token', { key: PRO, method: 'POST' });
  line(`POST /auth/token (pro key) -> ${tok.status}, JWT expires in ${tok.body.expiresIn}s`);
  const withJwt = await call('/api/stock/movements', { token: tok.body.accessToken });
  line(`GET /api/stock/movements with Bearer JWT -> ${withJwt.status}, served by ${withJwt.headers.get('x-upstream-instance')}`);

  title('3. Load balancing (round-robin across inventory-1..3)');
  await call('/admin/cache/purge', { key: ADMIN, method: 'POST', body: { service: 'inventory' } });
  const skus = ['ELE-1001', 'ELE-1002', 'HRD-2001', 'PKG-3001', 'OFF-4001', 'SAF-5001'];
  for (const sku of skus) {
    const r = await call(`/api/inventory/${sku}`, { key: PRO, headers: { 'cache-control': 'no-cache' } });
    line(`GET /api/inventory/${sku} -> ${r.status} served by ${r.headers.get('x-upstream-instance')}  (on hand: ${r.body.item?.onHand})`);
  }

  title('4. Redis response cache');
  for (let i = 1; i <= 3; i++) {
    const t0 = performance.now();
    const r = await call('/api/inventory?limit=5', { key: PRO });
    line(`GET /api/inventory?limit=5 -> X-Cache=${r.headers.get('x-cache')}  ${(performance.now() - t0).toFixed(1)}ms`);
  }
  const post = await call('/api/stock/receive', { key: SUPPLIER, method: 'POST', body: { sku: 'ELE-1001', warehouse: 'WH-NORTH', qty: 10, reference: 'demo' } });
  line(`POST /api/stock/receive -> ${post.status} (stock service "invalidates" the inventory cache)`);
  const after = await call('/api/inventory?limit=5', { key: PRO });
  line(`GET /api/inventory?limit=5 -> X-Cache=${after.headers.get('x-cache')} (fresh data after write)`);

  title('4b. Inventory rules: no overselling, idempotent retries');
  const over = await call('/api/stock/ship', { key: STOREFRONT, method: 'POST', body: { sku: 'ELE-1005', warehouse: 'WH-SOUTH', qty: 100000 } });
  line(`ship 100000 x ELE-1005 -> ${over.status} ${over.body.error?.code}: ${over.body.error?.message}`);
  const idem = `demo-${Date.now()}`;
  const first = await call('/api/stock/receive', { key: SCANNER, method: 'POST', headers: { 'idempotency-key': idem }, body: { sku: 'SAF-5001', warehouse: 'WH-EAST', qty: 5 } });
  const again = await call('/api/stock/receive', { key: SCANNER, method: 'POST', headers: { 'idempotency-key': idem }, body: { sku: 'SAF-5001', warehouse: 'WH-EAST', qty: 5 } });
  line(`receive with Idempotency-Key twice -> ${first.status}, then ${again.status} replay=${again.headers.get('idempotent-replay')} (applied once: WH-EAST ${first.body.levels?.['WH-EAST']} -> ${again.body.levels?.['WH-EAST']})`);

  title('4c. Business permissions (each client role may only do its own job)');
  for (const [who, key, path, body] of [
    ['supplier', SUPPLIER, '/api/stock/ship', { sku: 'ELE-1001', warehouse: 'WH-NORTH', qty: 1 }],
    ['storefront', STOREFRONT, '/api/stock/receive', { sku: 'ELE-1001', warehouse: 'WH-NORTH', qty: 1 }],
    ['storefront', STOREFRONT, '/api/stock/adjust', { sku: 'ELE-1001', warehouse: 'WH-NORTH', delta: 5 }],
    ['scanner', SCANNER, '/api/stock/transfer', { sku: 'ELE-1001', from: 'WH-NORTH', to: 'WH-EAST', qty: 1 }],
  ]) {
    const r = await call(path, { key, method: 'POST', body });
    const why = r.status === 403 ? ` forbidden (allowed: ${r.body.error.allowedRoles.join(', ')})` : '';
    line(`${who.padEnd(10)} POST ${path.padEnd(20)} -> ${r.status}${why}`);
  }

  title('5. Rate limiting (free tier: burst 20, 5 req/s)');
  const results = await Promise.all(Array.from({ length: 30 }, () => call('/api/inventory/ELE-1001', { key: FREE })));
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  line(`30 concurrent requests -> ${JSON.stringify(counts)}`);
  const limited = results.find((r) => r.status === 429);
  if (limited) line(`429 response: Retry-After=${limited.headers.get('retry-after')}s, policy="${limited.headers.get('x-ratelimit-policy')}"`);

  title('6. Health checks + circuit breaker (chaos on inventory-2)');
  await call('/admin/instances/inventory-2/chaos', { key: ADMIN, method: 'POST', body: { failRate: 1 } });
  line('inventory-2 now returns 500 for every request');
  const statuses = {};
  for (let i = 0; i < 15; i++) {
    const r = await call('/api/inventory/ELE-1002', { key: PRO, headers: { 'cache-control': 'no-cache' } });
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  }
  line(`15 requests -> ${JSON.stringify(statuses)} (failed attempts were retried on another instance)`);
  let svc = (await call('/admin/services', { key: ADMIN })).body.services.find((s) => s.name === 'inventory');
  for (const inst of svc.instances) line(`${inst.id}: healthy=${inst.healthy} circuit=${inst.breaker.state} failures=${inst.totalFailures}`);
  await call('/admin/instances/inventory-3/chaos', { key: ADMIN, method: 'POST', body: { down: true } });
  line('inventory-3 health endpoint now returns 503; waiting for health checks...');
  await sleep(7000);
  svc = (await call('/admin/services', { key: ADMIN })).body.services.find((s) => s.name === 'inventory');
  for (const inst of svc.instances) line(`${inst.id}: healthy=${inst.healthy} circuit=${inst.breaker.state}`);
  const served = new Set();
  for (let i = 0; i < 6; i++) {
    const r = await call('/api/inventory/ELE-1003', { key: PRO, headers: { 'cache-control': 'no-cache' } });
    served.add(`${r.status}@${r.headers.get('x-upstream-instance')}`);
  }
  line(`traffic still succeeds, routed to: ${[...served].join(', ')}`);
  await call('/admin/instances/inventory-2/chaos', { key: ADMIN, method: 'POST', body: { reset: true } });
  await call('/admin/instances/inventory-3/chaos', { key: ADMIN, method: 'POST', body: { reset: true } });
  line('chaos reset (instances recover after health checks / breaker reset timeout)');

  title('7. Request logs (gateway -> queue -> workers -> PostgreSQL)');
  await sleep(1500);
  const logs = (await call('/admin/logs?limit=8', { key: ADMIN })).body.logs;
  for (const l of logs) {
    line(`${l.method} ${l.path} -> ${l.status} ${l.latency_ms}ms [client=${l.client_id ?? 'anonymous'} service=${l.service ?? '-'} upstream=${l.upstream ?? '-'}]`);
  }
  line(`Open ${BASE}/dashboard/ (gateway) and ${BASE}/dashboard/inventory.html (inventory); connect with "${ADMIN}"`);
})().catch((err) => {
  console.error('\nDemo failed:', err.message, '\nIs the stack running? (docker compose up -d --build)');
  process.exit(1);
});
