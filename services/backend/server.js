// Inventory-management microservice. One image runs as two services, picked by SERVICE_NAME:
//   inventory  - SKU catalog and stock levels per warehouse (read-heavy, cached by the gateway)
//   stock      - stock movements: receive / ship / transfer / adjust (transactional write path)
// All instances share one PostgreSQL schema, so any instance can serve any request.
const http = require('http');
const os = require('os');
const { pool, migrateAndSeed } = require('./db');
const { HttpError, Router } = require('./http');

const SERVICE = process.env.SERVICE_NAME || 'inventory';
const INSTANCE = process.env.INSTANCE_ID || os.hostname();
const PORT = Number(process.env.PORT || 3000);

const ROUTES = { inventory: require('./inventory'), stock: require('./stock') };
if (!ROUTES[SERVICE]) throw new Error(`SERVICE_NAME must be one of ${Object.keys(ROUTES).join(', ')}`);
const router = new Router();
ROUTES[SERVICE](router);

// Chaos settings, changed through POST /_chaos (the gateway exposes this to admins only).
const chaos = { failRate: 0, latencyMs: 0, down: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify({ ...body, servedBy: INSTANCE });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-instance-id': INSTANCE,
    ...headers,
  });
  res.end(payload);
}
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) reject(new HttpError(413, 'payload_too_large', 'Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'bad_request', 'Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // ---- internal endpoints (not chaos-affected) ----
  if (path === '/health') {
    if (chaos.down) return send(res, 503, { status: 'down' });
    try {
      await pool.query('SELECT 1');
      return send(res, 200, { status: 'ok', service: SERVICE });
    } catch (err) {
      return send(res, 503, { status: 'down', reason: `database: ${err.message}` });
    }
  }
  if (path === '/_chaos') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.reset) Object.assign(chaos, { failRate: 0, latencyMs: 0, down: false });
      if (body.failRate !== undefined) chaos.failRate = Math.min(Math.max(Number(body.failRate) || 0, 0), 1);
      if (body.latencyMs !== undefined) chaos.latencyMs = Math.min(Math.max(Number(body.latencyMs) || 0, 0), 30000);
      if (body.down !== undefined) chaos.down = Boolean(body.down);
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'chaos updated', instance: INSTANCE, chaos }));
    }
    return send(res, 200, { chaos });
  }

  // ---- chaos injection ----
  if (chaos.down) return fail(res, 503, 'instance_down', 'instance down (chaos)');
  if (chaos.latencyMs) await sleep(chaos.latencyMs);
  if (chaos.failRate && Math.random() < chaos.failRate) return fail(res, 500, 'injected_failure', 'injected failure (chaos)');

  // used to demonstrate the gateway timeout
  if (path === '/slow' && req.method === 'GET') {
    const ms = Math.min(Number(url.searchParams.get('ms')) || 2000, 30000);
    await sleep(ms);
    return send(res, 200, { sleptMs: ms });
  }

  // ---- business endpoints ----
  const { handler, params, pathMatched } = router.match(req.method, path);
  if (!handler) {
    return pathMatched
      ? fail(res, 405, 'method_not_allowed', `${req.method} not allowed on ${path}`)
      : fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
  }
  const clientId = req.headers['x-gateway-client-id'];
  const ctx = {
    params,
    query: url.searchParams,
    headers: req.headers,
    principal: clientId ? { id: clientId, tier: req.headers['x-gateway-client-tier'] } : null,
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {},
    send: (status, body, headers) => send(res, status, body, headers),
    respond: ({ status, body, headers }) => send(res, status, body, headers),
  };
  await handler(ctx);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return fail(res, err.status, err.code, err.message, err.extra);
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'request failed', instance: INSTANCE, error: err.message, code: err.code }));
    fail(res, 500, 'internal_error', 'Internal service error');
  });
});
server.keepAliveTimeout = 65000;

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      const seeded = await migrateAndSeed();
      if (seeded) console.log(JSON.stringify({ msg: 'inventory database seeded', instance: INSTANCE }));
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(JSON.stringify({ msg: 'waiting for postgres', instance: INSTANCE, attempt, error: err.message }));
      await sleep(1000);
    }
  }
  server.listen(PORT, () => console.log(JSON.stringify({ msg: 'backend listening', service: SERVICE, instance: INSTANCE, port: PORT })));
}

start().catch((err) => {
  console.error(JSON.stringify({ msg: 'backend failed to start', instance: INSTANCE, error: err.message }));
  process.exit(1);
});

const stop = () => server.close(() => pool.end().finally(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
