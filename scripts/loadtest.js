#!/usr/bin/env node
// Simple single-endpoint load generator (no dependencies). For the full inventory workload with
// integrity checks use scripts/inventory-loadtest.js.
// usage: node scripts/loadtest.js [--url URL] [--key KEY] [--concurrency N] [--duration SECONDS] [--method GET]
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), [])
);
const url = args.url || 'http://localhost:8080/api/inventory';
const key = args.key || 'demo-free-key';
const concurrency = Number(args.concurrency || 20);
const durationMs = Number(args.duration || 10) * 1000;
const method = (args.method || 'GET').toUpperCase();

const statuses = {};
const upstreams = {};
const cache = {};
const latencies = [];
let errors = 0;
const deadline = Date.now() + durationMs;

async function workerLoop() {
  while (Date.now() < deadline) {
    const start = performance.now();
    try {
      const res = await fetch(url, { method, headers: key ? { 'x-api-key': key } : {} });
      await res.arrayBuffer();
      latencies.push(performance.now() - start);
      statuses[res.status] = (statuses[res.status] || 0) + 1;
      const up = res.headers.get('x-upstream-instance') || (res.headers.get('x-cache') === 'HIT' ? 'cache' : '-');
      upstreams[up] = (upstreams[up] || 0) + 1;
      const c = res.headers.get('x-cache');
      if (c) cache[c] = (cache[c] || 0) + 1;
    } catch {
      errors++;
    }
  }
}

(async () => {
  console.log(`Load test: ${method} ${url}  key=${key || '(none)'}  concurrency=${concurrency}  duration=${durationMs / 1000}s\n`);
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, workerLoop));
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1) : '-');
  const total = latencies.length;
  console.log(`Requests:     ${total} (${(total / elapsed).toFixed(1)} req/s), network errors: ${errors}`);
  console.log(`Latency ms:   p50=${pct(0.5)}  p95=${pct(0.95)}  p99=${pct(0.99)}  max=${pct(1)}`);
  console.log('Status codes:', statuses);
  console.log('Served by:   ', upstreams);
  if (Object.keys(cache).length) console.log('Cache:       ', cache);
})();
