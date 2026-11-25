#!/usr/bin/env node
/*
 * Flash-sale scenario: a limited stock of one product goes on sale and many customers try to buy
 * at the same moment through the online storefront.
 *
 *   setup    ops-admin creates the product, the supplier delivers --stock units to one warehouse
 *   sale     --buyers concurrent customers each try to ship 1 unit (storefront key)
 *   verify   exactly --stock sales succeed, everyone else gets "sold out" (409) or is throttled (429),
 *            stock ends at 0 (never negative) and the ledger audit is consistent
 *
 * usage: node scripts/flash-sale.js [--base URL] [--buyers 300] [--stock 50] [--warehouse WH-NORTH]
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), [])
);
const BASE = (args.base || 'http://localhost:8080').replace(/\/$/, '');
const BUYERS = Number(args.buyers || 300);
const STOCK = Number(args.stock || 50);
const WH = args.warehouse || 'WH-NORTH';
const KEYS = { admin: 'demo-admin-key', supplier: 'demo-supplier-key', storefront: 'demo-storefront-key' };
const SKU = `FS-${Date.now().toString(36).toUpperCase().slice(-6)}`;

async function call(key, method, path, body, headers = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ms: performance.now() - t0, body: await res.json().catch(() => null), instance: res.headers.get('x-upstream-instance') };
  } catch (err) {
    return { status: 0, ms: performance.now() - t0, body: null, error: err.cause?.code || err.message };
  }
}
const ok = (c, msg) => console.log(`  ${c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${msg}`);

(async () => {
  console.log(`\x1b[1;36mFlash sale\x1b[0m  ${STOCK} units of ${SKU} in ${WH}, ${BUYERS} customers buying at once\n`);

  const created = await call(KEYS.admin, 'POST', '/api/inventory', {
    sku: SKU, name: 'Limited Edition Smartwatch', category: 'Flash sale', unitCost: 199, reorderLevel: 10,
  });
  if (created.status !== 201) throw new Error(`create product -> ${created.status} ${JSON.stringify(created.body)}`);
  const delivered = await call(KEYS.supplier, 'POST', '/api/stock/receive', { sku: SKU, warehouse: WH, qty: STOCK, reference: 'flash-sale delivery' });
  if (delivered.status !== 201) throw new Error(`supplier delivery -> ${delivered.status} ${JSON.stringify(delivered.body)}`);
  console.log(`  ops-admin created ${SKU}; supplier "acme-supplies" delivered ${STOCK} units\n`);

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: BUYERS }, (_, i) =>
      call(KEYS.storefront, 'POST', '/api/stock/ship', { sku: SKU, warehouse: WH, qty: 1, reference: `web-order-${i + 1}` }, { 'idempotency-key': `${SKU}-order-${i + 1}` })
    )
  );
  const elapsed = performance.now() - t0;

  const count = (s) => results.filter((r) => r.status === s).length;
  const sold = count(201), soldOut = count(409), throttled = count(429);
  const other = BUYERS - sold - soldOut - throttled;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const byInstance = results.filter((r) => r.status === 201).reduce((a, r) => ((a[r.instance] = (a[r.instance] || 0) + 1), a), {});

  console.log(`  ${BUYERS} orders in ${(elapsed / 1000).toFixed(2)}s  (p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)} ms, p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)} ms)`);
  console.log(`    sold         ${sold}   (committed by ${Object.entries(byInstance).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  console.log(`    sold out     ${soldOut}   (409 insufficient_stock)`);
  console.log(`    throttled    ${throttled}   (429 storefront rate limit)`);
  if (other) console.log(`    other        ${other}   ${JSON.stringify(results.filter((r) => ![201, 409, 429].includes(r.status)).slice(0, 3).map((r) => r.status || r.error))}`);

  const item = await call(KEYS.admin, 'GET', `/api/inventory/${SKU}`, null, { 'cache-control': 'no-cache' });
  const left = item.body?.item?.levels?.[WH];
  const audit = await call(KEYS.admin, 'GET', `/api/stock/audit?skuPrefix=${SKU}`);

  console.log('\n\x1b[1mChecks\x1b[0m');
  ok(sold === STOCK || (sold < STOCK && throttled > 0 && sold + left === STOCK), `units sold (${sold}) + units left (${left}) == ${STOCK} delivered; no unit sold twice`);
  ok(left >= 0, `stock never negative (left: ${left})`);
  ok(sold + soldOut + throttled === BUYERS, `every customer got a clear answer (sold / sold out / try again)`);
  ok(audit.body?.consistent === true, `ledger audit consistent (${audit.body?.checked} levels checked)`);
  console.log(`\n  See it on ${BASE}/dashboard/inventory.html (category "Flash sale")`);
})().catch((err) => {
  console.error(`\nFlash sale failed: ${err.message}`);
  process.exit(1);
});
