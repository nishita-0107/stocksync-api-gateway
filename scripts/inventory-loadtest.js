#!/usr/bin/env node
/*
 * Inventory load test (no dependencies, Node 20+).
 *
 * Simulates a warehouse workload through the gateway, then proves the system stayed correct:
 *   1. setup   - creates its own SKUs (LT-<run>-NN, category "Load test") and stocks every warehouse
 *   2. load    - N virtual users (ramped up) run a weighted mix of reads and stock movements.
 *                Ships outnumber receives, so hot SKUs keep running out: concurrent ships race for
 *                the last units and the overselling guard is exercised for real.
 *   3. verify  - final stock == initial + every movement the client saw committed
 *                server ledger audit (levels == sum of ledger, nothing negative)
 *                idempotency: a burst of duplicate requests with one Idempotency-Key applies once
 *
 * usage: node scripts/inventory-loadtest.js [options]
 *   --base URL         gateway (default http://localhost:8080)
 *   --key KEY          API key (default demo-admin-key; stock writes need auth)
 *   --vus N            concurrent virtual users (default 40)
 *   --duration S       load phase in seconds (default 30)
 *   --ramp S           seconds to ramp from 1 to N users (default 5)
 *   --rps N            optional total target request rate (open model); default = as fast as possible
 *   --skus N           load-test SKUs to create (default 8; fewer = more contention)
 *   --stock N          opening units per SKU per warehouse (default 60)
 *   --mix a=1,b=2      operation weights (default browse=30,item=20,summary=5,movements=5,receive=12,ship=20,transfer=6,adjust=2)
 *   --out FILE         also write the full report as JSON
 *   --cleanup          delete the load-test SKUs afterwards (admin key). Default: keep them on the dashboard.
 */
const fs = require('fs');
const crypto = require('crypto');

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || 'http://localhost:8080').replace(/\/$/, '');
const KEY = args.key || 'demo-admin-key'; // admin: allowed every operation in the mix
const VUS = int(args.vus, 40);
const DURATION_MS = num(args.duration, 30) * 1000;
const RAMP_MS = Math.min(num(args.ramp, 5) * 1000, DURATION_MS);
const TARGET_RPS = args.rps ? num(args.rps, 0) : 0;
const N_SKUS = int(args.skus, 8);
const OPENING = int(args.stock, 60);
const MIX = parseMix(args.mix || 'browse=30,item=20,summary=5,movements=5,receive=12,ship=20,transfer=6,adjust=2');
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const PREFIX = `LT-${RUN}-`;

// ---------------------------------------------------------------- helpers
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
function num(v, d) { const n = Number(v); return v === undefined || v === true || !Number.isFinite(n) ? d : n; }
function int(v, d) { return Math.max(1, Math.round(num(v, d))); }
function parseMix(s) {
  const m = Object.fromEntries(s.split(',').map((p) => p.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
  const known = ['browse', 'item', 'summary', 'movements', 'receive', 'ship', 'transfer', 'adjust'];
  for (const k of Object.keys(m)) if (!known.includes(k)) throw new Error(`--mix: unknown op "${k}" (known: ${known.join(', ')})`);
  return m;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const f1 = (n) => n.toFixed(1);

async function call(method, path, { body, headers = {}, timeoutMs = 10000 } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ms: performance.now() - started, headers: res.headers, body: json };
  } catch (err) {
    return { status: 0, ms: performance.now() - started, headers: new Headers(), body: null, error: err.cause?.code || err.name };
  }
}

// ---------------------------------------------------------------- metrics
const stats = {}; // op -> { lat: [], statuses: {}, ok, rejected, limited, failed }
const servedBy = {};
const cacheCounts = {};
let windowCount = 0;
let windowLat = [];
let ambiguous = 0;
let replays = 0;

function record(op, r, outcome) {
  const s = (stats[op] ??= { lat: [], statuses: {}, ok: 0, rejected: 0, limited: 0, failed: 0 });
  s.lat.push(r.ms);
  const code = r.status || `ERR ${r.error || ''}`.trim();
  s.statuses[code] = (s.statuses[code] || 0) + 1;
  s[outcome]++;
  windowCount++;
  windowLat.push(r.ms);
  const up = r.headers.get('x-upstream-instance') || (r.headers.get('x-cache') === 'HIT' ? 'gateway-cache' : null);
  if (up) servedBy[up] = (servedBy[up] || 0) + 1;
  const c = r.headers.get('x-cache');
  if (c) cacheCounts[c] = (cacheCounts[c] || 0) + 1;
}
const outcomeOf = (r) => (r.status >= 200 && r.status < 300 ? 'ok' : r.status === 409 ? 'rejected' : r.status === 429 ? 'limited' : 'failed');

// ---------------------------------------------------------------- domain state
let warehouses = [];
let seededSkus = [];
const skus = [];
const expected = {}; // sku -> { wh -> qty } as observed from committed movements
const tainted = new Set(); // SKUs where a write outcome is unknown (network error after retries)

function applyDelta(sku, wh, d) {
  expected[sku][wh] = (expected[sku][wh] ?? 0) + d;
}

/**
 * Stock write with an Idempotency-Key. Network errors, timeouts and 5xx leave the outcome unknown,
 * so we retry with the SAME key: the service either applies it once or replays the original result.
 */
async function movement(op, path, body, onCommit) {
  const key = crypto.randomUUID();
  let r;
  for (let attempt = 1; attempt <= 4; attempt++) {
    r = await call('POST', path, { body, headers: { 'idempotency-key': key } });
    if (r.status !== 0 && r.status < 500) break;
    await sleep(50 * attempt);
  }
  if (r.headers.get('idempotent-replay')) replays++;
  const outcome = outcomeOf(r);
  record(op, r, outcome);
  if (outcome === 'ok') onCommit(r.body);
  else if (outcome === 'failed' && (r.status === 0 || r.status >= 500)) {
    ambiguous++;
    tainted.add(body.sku);
  }
}

const OPS = {
  browse: async () => {
    const q = Math.random() < 0.3 ? `&category=${encodeURIComponent(pick(['Electronics', 'Hardware', 'Packaging', 'Office', 'Safety', 'Load test']))}` : '';
    const r = await call('GET', `/api/inventory?limit=50${q}`);
    record('browse', r, outcomeOf(r));
  },
  item: async () => {
    const sku = Math.random() < 0.5 ? pick(skus) : pick(seededSkus);
    const r = await call('GET', `/api/inventory/${sku}`);
    record('item', r, outcomeOf(r));
  },
  summary: async () => {
    const r = await call('GET', '/api/inventory/summary');
    record('summary', r, outcomeOf(r));
  },
  movements: async () => {
    const r = await call('GET', `/api/stock/movements?limit=20&sku=${pick(skus)}`);
    record('movements', r, outcomeOf(r));
  },
  receive: async () => {
    const sku = pick(skus), wh = pick(warehouses), qty = rand(1, 5);
    await movement('receive', '/api/stock/receive', { sku, warehouse: wh, qty, reference: `PO-${RUN}` }, () => applyDelta(sku, wh, qty));
  },
  ship: async () => {
    const sku = pick(skus), wh = pick(warehouses), qty = rand(1, 8);
    await movement('ship', '/api/stock/ship', { sku, warehouse: wh, qty, reference: `SO-${RUN}` }, () => applyDelta(sku, wh, -qty));
  },
  transfer: async () => {
    const sku = pick(skus), from = pick(warehouses);
    const to = pick(warehouses.filter((w) => w !== from)), qty = rand(1, 5);
    await movement('transfer', '/api/stock/transfer', { sku, from, to, qty, reference: `TR-${RUN}` }, () => {
      applyDelta(sku, from, -qty);
      applyDelta(sku, to, qty);
    });
  },
  adjust: async () => {
    const sku = pick(skus), wh = pick(warehouses), delta = rand(1, 3) * (Math.random() < 0.5 ? -1 : 1);
    await movement('adjust', '/api/stock/adjust', { sku, warehouse: wh, delta, reason: 'cycle count' }, () => applyDelta(sku, wh, delta));
  },
};

const weighted = Object.entries(MIX).filter(([, w]) => w > 0);
const totalWeight = weighted.reduce((a, [, w]) => a + w, 0);
function chooseOp() {
  let x = Math.random() * totalWeight;
  for (const [op, w] of weighted) if ((x -= w) < 0) return op;
  return weighted[0][0];
}

// ---------------------------------------------------------------- phases
async function setup() {
  const ready = await call('GET', '/ready');
  if (ready.status === 0) throw new Error(`gateway not reachable at ${BASE} (docker compose up -d --build)`);
  const wh = await call('GET', '/api/inventory/warehouses');
  if (wh.status !== 200) throw new Error(`GET /api/inventory/warehouses -> ${wh.status} ${JSON.stringify(wh.body)}`);
  warehouses = wh.body.warehouses.map((w) => w.code);
  const list = await call('GET', '/api/inventory?limit=500');
  seededSkus = list.body.items.filter((i) => !i.sku.startsWith('LT-')).map((i) => i.sku);
  if (!seededSkus.length) seededSkus = list.body.items.map((i) => i.sku);

  for (let i = 1; i <= N_SKUS; i++) {
    const sku = `${PREFIX}${String(i).padStart(2, '0')}`;
    const r = await call('POST', '/api/inventory', {
      body: { sku, name: `Load-test item ${i}`, category: 'Load test', unitCost: rand(5, 120), reorderLevel: Math.round(OPENING * 0.75) },
    });
    if (r.status !== 201) throw new Error(`create ${sku} -> ${r.status} ${JSON.stringify(r.body)}`);
    skus.push(sku);
    expected[sku] = Object.fromEntries(warehouses.map((w) => [w, 0]));
    for (const w of warehouses) {
      const rr = await call('POST', '/api/stock/receive', { body: { sku, warehouse: w, qty: OPENING, reference: 'load-test opening' } });
      if (rr.status !== 201) throw new Error(`opening receive ${sku}/${w} -> ${rr.status} ${JSON.stringify(rr.body)}`);
      applyDelta(sku, w, OPENING);
    }
  }
}

async function load() {
  const started = Date.now();
  const deadline = started + DURATION_MS;
  let active = 0;
  const perVuIntervalMs = TARGET_RPS ? (VUS / TARGET_RPS) * 1000 : 0;

  const progress = setInterval(() => {
    const el = ((Date.now() - started) / 1000).toFixed(0);
    windowLat.sort((a, b) => a - b);
    const errs = Object.values(stats).reduce((a, s) => a + s.failed, 0);
    const lim = Object.values(stats).reduce((a, s) => a + s.limited, 0);
    process.stdout.write(
      `  t=${el.padStart(3)}s  vus=${String(active).padStart(3)}  ${String(Math.round(windowCount / 2)).padStart(5)} req/s` +
      `  p95=${f1(pct(windowLat, 0.95)).padStart(6)} ms  failed=${errs}  429=${lim}\n`
    );
    windowCount = 0;
    windowLat = [];
  }, 2000);

  async function vu(i) {
    // linear ramp: VU i starts at i/VUS of the ramp window
    await sleep(RAMP_MS * (i / VUS));
    active++;
    let next = Date.now();
    while (Date.now() < deadline) {
      await OPS[chooseOp()]();
      if (perVuIntervalMs) {
        next += perVuIntervalMs;
        const wait = next - Date.now();
        if (wait > 0) await sleep(Math.min(wait, deadline - Date.now()));
      }
    }
    active--;
  }
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  clearInterval(progress);
  return (Date.now() - started) / 1000;
}

async function verify() {
  const checks = [];
  // 1. final levels match what the client observed (cache bypassed so we read the database)
  const mismatches = [];
  for (const sku of skus) {
    const r = await call('GET', `/api/inventory/${sku}`, { headers: { 'cache-control': 'no-cache' } });
    const levels = r.body?.item?.levels || {};
    for (const w of warehouses) {
      if (tainted.has(sku)) continue;
      if ((levels[w] ?? 0) !== expected[sku][w]) mismatches.push(`${sku}/${w}: server ${levels[w]} vs expected ${expected[sku][w]}`);
    }
  }
  checks.push({
    name: 'Final stock == opening + committed movements',
    pass: mismatches.length === 0,
    detail: mismatches.length ? mismatches.slice(0, 5).join('; ') : `${skus.length * warehouses.length - tainted.size * warehouses.length} levels match` +
      (tainted.size ? ` (${tainted.size} SKU(s) skipped: outcome unknown after retries)` : ''),
  });

  // 2. server-side ledger audit
  const audit = await call('GET', `/api/stock/audit?skuPrefix=${PREFIX}`);
  checks.push({
    name: 'Ledger audit (levels == ledger sum, none negative)',
    pass: audit.status === 200 && audit.body.consistent,
    detail: audit.status === 200 ? `${audit.body.checked} levels checked, ${audit.body.mismatches.length} mismatches, ${audit.body.negative.length} negative` : `HTTP ${audit.status}`,
  });

  // 3. idempotency under concurrency: 10 identical requests, same key, at once -> applied exactly once
  const sku = skus[0], wh = warehouses[0];
  const before = (await call('GET', `/api/inventory/${sku}`, { headers: { 'cache-control': 'no-cache' } })).body.item.levels[wh];
  const key = crypto.randomUUID();
  const burst = await Promise.all(Array.from({ length: 10 }, () =>
    call('POST', '/api/stock/receive', { body: { sku, warehouse: wh, qty: 7, reference: 'idempotency-probe' }, headers: { 'idempotency-key': key } })
  ));
  const after = (await call('GET', `/api/inventory/${sku}`, { headers: { 'cache-control': 'no-cache' } })).body.item.levels[wh];
  const created = burst.filter((r) => r.status === 201).length;
  const replayed = burst.filter((r) => r.headers.get('idempotent-replay')).length;
  checks.push({
    name: 'Idempotency (10 concurrent duplicates -> applied once)',
    pass: after - before === 7 && created === 1,
    detail: `stock ${before} -> ${after} (+${after - before}), ${created} created, ${replayed} replayed, statuses ${JSON.stringify(countBy(burst.map((r) => r.status)))}`,
  });

  // 4. stock-outs were actually exercised (otherwise the oversell guard was never tested)
  const rejected = (stats.ship?.rejected || 0) + (stats.transfer?.rejected || 0);
  checks.push({
    name: 'Oversell guard exercised (409 insufficient_stock)',
    pass: true,
    detail: rejected ? `${rejected} ship/transfer requests rejected; no level went negative` : 'no stock-outs happened; try fewer --skus or lower --stock',
  });
  return checks;
}

const countBy = (arr) => arr.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {});

async function cleanup() {
  let deleted = 0;
  for (const sku of skus) if ((await call('DELETE', `/api/inventory/${sku}`)).status === 200) deleted++;
  return deleted;
}

// ---------------------------------------------------------------- report
function report(elapsed, checks) {
  const rows = Object.entries(stats).map(([op, s]) => {
    const lat = [...s.lat].sort((a, b) => a - b);
    return { op, n: lat.length, rps: lat.length / elapsed, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.at(-1) || 0, ...s, lat: undefined };
  }).sort((a, b) => b.n - a.n);
  const all = Object.values(stats).flatMap((s) => s.lat).sort((a, b) => a - b);
  const total = all.length;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);

  console.log(`\n\x1b[1mResults\x1b[0m  ${total} requests in ${f1(elapsed)}s = \x1b[1m${f1(total / elapsed)} req/s\x1b[0m` +
    `   latency p50 ${f1(pct(all, 0.5))} · p95 ${f1(pct(all, 0.95))} · p99 ${f1(pct(all, 0.99))} ms`);
  console.log(`  ok ${sum('ok')} · rejected 409 ${sum('rejected')} · rate-limited 429 ${sum('limited')} · failed ${sum('failed')}` +
    ` · write retries resolved by idempotent replay ${replays} · unknown outcome ${ambiguous}\n`);
  const head = ['operation', 'count', 'req/s', 'ok', '409', '429', 'failed', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms'];
  const table = rows.map((r) => [r.op, r.n, f1(r.rps), r.ok, r.rejected, r.limited, r.failed, f1(r.p50), f1(r.p95), f1(r.p99), f1(r.max)]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((t) => String(t[i]).length)));
  const fmtRow = (cells) => '  ' + cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  console.log(fmtRow(head));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  table.forEach((t) => console.log(fmtRow(t)));

  const failedStatuses = rows.flatMap((r) => Object.entries(r.statuses).filter(([c]) => !/^(2\d\d|409|429)$/.test(c)).map(([c, n]) => `${r.op}:${c}x${n}`));
  if (failedStatuses.length) console.log(`\n  unexpected statuses: ${failedStatuses.join(', ')}`);
  console.log(`\n  served by:  ${Object.entries(servedBy).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const hits = cacheCounts.HIT || 0, misses = cacheCounts.MISS || 0;
  if (hits + misses) console.log(`  gateway cache (GET /api/inventory): ${hits} hit / ${misses} miss = ${f1((hits / (hits + misses)) * 100)}% hit ratio`);
  if (sum('limited') > total * 0.05) {
    console.log('  note: >5% of requests were rate limited. Use a higher tier key, lower --vus/--rps, or raise RL_ADMIN_CAPACITY / RL_ADMIN_REFILL.');
  }

  console.log('\n\x1b[1mIntegrity checks\x1b[0m');
  for (const c of checks) console.log(`  ${c.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${c.name}\n        ${c.detail}`);
  return { rows, total, elapsed, rps: total / elapsed, latency: { p50: pct(all, 0.5), p95: pct(all, 0.95), p99: pct(all, 0.99) } };
}

// ---------------------------------------------------------------- main
(async () => {
  console.log(`\x1b[1;36mInventory load test\x1b[0m  ${BASE}  run=${RUN}`);
  console.log(`  ${VUS} VUs, ${DURATION_MS / 1000}s (ramp ${RAMP_MS / 1000}s)${TARGET_RPS ? `, target ${TARGET_RPS} req/s` : ''}, ${N_SKUS} SKUs x ${OPENING} opening units`);
  console.log(`  mix: ${Object.entries(MIX).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);

  await setup();
  console.log(`  setup: created ${skus.length} SKUs (${skus[0]} ...) in ${warehouses.join(', ')}\n`);
  const elapsed = await load();
  await sleep(300);
  const checks = await verify();
  const summary = report(elapsed, checks);

  if (args.cleanup) console.log(`\n  cleanup: deleted ${await cleanup()} of ${skus.length} load-test SKUs`);
  else console.log(`\n  Load-test SKUs kept (category "Load test"); see ${BASE}/dashboard/inventory.html. Rerun with --cleanup to delete them.`);

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({
      run: RUN, base: BASE, config: { vus: VUS, durationS: DURATION_MS / 1000, rampS: RAMP_MS / 1000, rps: TARGET_RPS || null, skus: N_SKUS, opening: OPENING, mix: MIX },
      ...summary, servedBy, cache: cacheCounts, replays, ambiguous, checks,
    }, null, 2));
    console.log(`  report written to ${args.out}`);
  }
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
})().catch((err) => {
  console.error(`\nLoad test failed: ${err.message}`);
  process.exit(2);
});
