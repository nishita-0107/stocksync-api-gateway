// "stock" service: stock movements (write path). Every movement is one transaction that updates the
// stock level and appends to the ledger, so concurrent requests on any instance can never oversell.
const { pool, tx } = require('./db');
const { HttpError, requireClient, str, int } = require('./http');

const INSTANCE = process.env.INSTANCE_ID || require('os').hostname();
const MAX_QTY = 100000;

const movementCols = (t = '') =>
  `${t}id, ${t}ts, ${t}type, ${t}status, ${t}sku, ${t}from_wh AS "from", ${t}to_wh AS "to", ${t}qty, ${t}reference,
   ${t}idempotency_key AS "idempotencyKey", ${t}client_id AS "clientId", ${t}instance`;
const MOVEMENT_COLS = movementCols();

/**
 * Inserts the ledger row first. With an Idempotency-Key, a duplicate request finds the existing row
 * (ON CONFLICT DO NOTHING returns nothing) and is answered with the original outcome instead of
 * applying the movement twice. A concurrent duplicate blocks on the unique index until the first commits.
 */
async function insertMovement(c, m) {
  const { rows } = await c.query(
    `INSERT INTO inventory.movements (type, sku, from_wh, to_wh, qty, reference, idempotency_key, client_id, instance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${MOVEMENT_COLS}`,
    [m.type, m.sku, m.from ?? null, m.to ?? null, m.qty, m.reference ?? null, m.key ?? null, m.clientId ?? null, INSTANCE]
  );
  return rows[0] ?? null;
}

async function levelsFor(c, sku) {
  const { rows } = await c.query('SELECT warehouse, qty FROM inventory.stock_levels WHERE sku = $1 ORDER BY warehouse', [sku]);
  return Object.fromEntries(rows.map((r) => [r.warehouse, r.qty]));
}

async function replay(key, type, sku) {
  const { rows } = await pool.query(`SELECT ${MOVEMENT_COLS} FROM inventory.movements WHERE idempotency_key = $1`, [key]);
  const m = rows[0];
  if (!m) throw new HttpError(409, 'idempotency_conflict', 'Request with this Idempotency-Key is still in progress');
  if (m.type !== type || m.sku !== sku) {
    throw new HttpError(422, 'idempotency_key_reused', 'Idempotency-Key was already used for a different movement');
  }
  return {
    status: m.status === 'ok' ? 200 : 409,
    headers: { 'idempotent-replay': 'true' },
    body: { replayed: true, movement: m, levels: await levelsFor(pool, sku) },
  };
}

function parseCommon(body, headers, principal) {
  requireClient(principal);
  const key = headers['idempotency-key'] ? str(headers['idempotency-key'], 'Idempotency-Key', { max: 100 }) : null;
  return {
    sku: str(body.sku, 'sku', { max: 40 }).toUpperCase(),
    reference: body.reference !== undefined ? str(body.reference, 'reference', { max: 120 }) : null,
    key,
    clientId: principal.id,
  };
}

const notFound = (sku, wh) => new HttpError(404, 'not_found', `Unknown SKU ${sku}${wh ? ` or warehouse ${wh}` : ''}`);

/** Runs one movement transaction; maps FK violations (unknown sku/warehouse) to 404. */
async function runMovement(m, work) {
  try {
    const out = await tx(async (c) => {
      const movement = await insertMovement(c, m);
      if (!movement) return null; // duplicate idempotency key
      return work(c, movement);
    });
    return out ?? replay(m.key, m.type, m.sku);
  } catch (err) {
    if (err.code === '23503') throw notFound(m.sku, m.to || m.from);
    throw err;
  }
}

async function reject(c, movement, sku, message, available) {
  await c.query(`UPDATE inventory.movements SET status = 'rejected' WHERE id = $1`, [movement.id]);
  return {
    status: 409,
    body: {
      error: { code: 'insufficient_stock', message, available },
      movement: { ...movement, status: 'rejected' },
      levels: await levelsFor(c, sku),
    },
  };
}

const ok = async (c, movement, sku, status = 201) => ({ status, body: { movement, levels: await levelsFor(c, sku) } });

module.exports = (router) => {
  // { sku, warehouse, qty, reference? }  -> adds stock (goods received from a supplier)
  router.post('/receive', async ({ body, headers, principal, respond }) => {
    const m = { ...parseCommon(body, headers, principal), type: 'receive' };
    m.to = str(body.warehouse, 'warehouse', { max: 20 }).toUpperCase();
    m.qty = int(body.qty, 'qty', { min: 1, max: MAX_QTY });
    respond(await runMovement(m, async (c, movement) => {
      await c.query(
        `INSERT INTO inventory.stock_levels (sku, warehouse, qty) VALUES ($1, $2, $3)
         ON CONFLICT (sku, warehouse) DO UPDATE SET qty = inventory.stock_levels.qty + EXCLUDED.qty, updated_at = now()`,
        [m.sku, m.to, m.qty]
      );
      return ok(c, movement, m.sku);
    }));
  });

  // { sku, warehouse, qty, reference? }  -> removes stock (customer shipment). 409 if not enough on hand.
  router.post('/ship', async ({ body, headers, principal, respond }) => {
    const m = { ...parseCommon(body, headers, principal), type: 'ship' };
    m.from = str(body.warehouse, 'warehouse', { max: 20 }).toUpperCase();
    m.qty = int(body.qty, 'qty', { min: 1, max: MAX_QTY });
    respond(await runMovement(m, async (c, movement) => {
      // Single conditional UPDATE: check-and-decrement is atomic, no read-then-write race.
      const r = await c.query(
        `UPDATE inventory.stock_levels SET qty = qty - $3, updated_at = now()
          WHERE sku = $1 AND warehouse = $2 AND qty >= $3 RETURNING qty`,
        [m.sku, m.from, m.qty]
      );
      if (r.rowCount) return ok(c, movement, m.sku);
      const cur = await c.query('SELECT qty FROM inventory.stock_levels WHERE sku = $1 AND warehouse = $2', [m.sku, m.from]);
      if (!cur.rowCount) throw notFound(m.sku, m.from);
      return reject(c, movement, m.sku, `Only ${cur.rows[0].qty} of ${m.sku} on hand in ${m.from}, ${m.qty} requested`, cur.rows[0].qty);
    }));
  });

  // { sku, from, to, qty, reference? }  -> moves stock between warehouses atomically.
  router.post('/transfer', async ({ body, headers, principal, respond }) => {
    const m = { ...parseCommon(body, headers, principal), type: 'transfer' };
    m.from = str(body.from, 'from', { max: 20 }).toUpperCase();
    m.to = str(body.to, 'to', { max: 20 }).toUpperCase();
    m.qty = int(body.qty, 'qty', { min: 1, max: MAX_QTY });
    if (m.from === m.to) throw new HttpError(422, 'validation_error', '"from" and "to" must be different warehouses');
    respond(await runMovement(m, async (c, movement) => {
      // Lock both rows in a fixed order so opposite transfers (A->B, B->A) cannot deadlock.
      const { rows } = await c.query(
        `SELECT warehouse, qty FROM inventory.stock_levels WHERE sku = $1 AND warehouse = ANY($2) ORDER BY warehouse FOR UPDATE`,
        [m.sku, [m.from, m.to]]
      );
      const src = rows.find((r) => r.warehouse === m.from);
      if (!src) throw notFound(m.sku, m.from);
      if (src.qty < m.qty) {
        return reject(c, movement, m.sku, `Only ${src.qty} of ${m.sku} on hand in ${m.from}, ${m.qty} requested`, src.qty);
      }
      await c.query('UPDATE inventory.stock_levels SET qty = qty - $3, updated_at = now() WHERE sku = $1 AND warehouse = $2', [m.sku, m.from, m.qty]);
      await c.query(
        `INSERT INTO inventory.stock_levels (sku, warehouse, qty) VALUES ($1, $2, $3)
         ON CONFLICT (sku, warehouse) DO UPDATE SET qty = inventory.stock_levels.qty + EXCLUDED.qty, updated_at = now()`,
        [m.sku, m.to, m.qty]
      );
      return ok(c, movement, m.sku);
    }));
  });

  // { sku, warehouse, delta, reason? }  -> cycle-count correction (delta may be negative).
  router.post('/adjust', async ({ body, headers, principal, respond }) => {
    const m = { ...parseCommon(body, headers, principal), type: 'adjust' };
    m.to = str(body.warehouse, 'warehouse', { max: 20 }).toUpperCase();
    m.qty = int(body.delta, 'delta', { min: -MAX_QTY, max: MAX_QTY });
    if (m.qty === 0) throw new HttpError(422, 'validation_error', 'delta must not be 0');
    if (body.reason !== undefined) m.reference = str(body.reason, 'reason', { max: 120 });
    respond(await runMovement(m, async (c, movement) => {
      const r = await c.query(
        `UPDATE inventory.stock_levels SET qty = qty + $3, updated_at = now()
          WHERE sku = $1 AND warehouse = $2 AND qty + $3 >= 0 RETURNING qty`,
        [m.sku, m.to, m.qty]
      );
      if (r.rowCount) return ok(c, movement, m.sku);
      const cur = await c.query('SELECT qty FROM inventory.stock_levels WHERE sku = $1 AND warehouse = $2', [m.sku, m.to]);
      if (!cur.rowCount) throw notFound(m.sku, m.to);
      return reject(c, movement, m.sku, `Adjustment would make ${m.sku} in ${m.to} negative`, cur.rows[0].qty);
    }));
  });

  // GET /movements?sku=&type=&status=&limit=
  router.get('/movements', async ({ query, send }) => {
    const limit = Math.min(Number(query.get('limit')) || 50, 500);
    const { rows } = await pool.query(
      `SELECT ${movementCols('m.')}, i.name
         FROM inventory.movements m JOIN inventory.items i ON i.sku = m.sku
        WHERE m.instance <> 'seed'
          AND ($1::text IS NULL OR m.sku = $1) AND ($2::text IS NULL OR m.type = $2) AND ($3::text IS NULL OR m.status = $3)
        ORDER BY m.id DESC LIMIT ${limit}`,
      [query.get('sku')?.toUpperCase() ?? null, query.get('type'), query.get('status')]
    );
    send(200, { count: rows.length, movements: rows });
  });

  // Movements per minute by type, for the dashboard chart. GET /throughput?minutes=30
  router.get('/throughput', async ({ query, send }) => {
    const minutes = Math.min(Math.max(Number(query.get('minutes')) || 30, 1), 240);
    const [perMinute, recent] = await Promise.all([
      pool.query(
        `SELECT (extract(epoch FROM date_trunc('minute', ts)) * 1000)::bigint AS minute, type, status,
                count(*)::int AS n, COALESCE(sum(abs(qty)), 0)::int AS units
           FROM inventory.movements
          WHERE ts >= date_trunc('minute', now()) - make_interval(mins => $1 - 1) AND instance <> 'seed'
          GROUP BY 1, 2, 3`,
        [minutes]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE status = 'rejected')::int AS rejected
           FROM inventory.movements WHERE ts > now() - interval '60 seconds' AND instance <> 'seed'`
      ),
    ]);
    const now = Math.floor(Date.now() / 60000) * 60000;
    const buckets = Array.from({ length: minutes }, (_, i) => ({
      minute: now - (minutes - 1 - i) * 60000, receive: 0, ship: 0, transfer: 0, adjust: 0, rejected: 0, units: 0,
    }));
    const index = new Map(buckets.map((b) => [b.minute, b]));
    for (const r of perMinute.rows) {
      const b = index.get(Number(r.minute));
      if (!b) continue;
      if (r.status === 'rejected') b.rejected += r.n;
      else {
        b[r.type] += r.n;
        b.units += r.units;
      }
    }
    send(200, { minutes: buckets, last60s: recent.rows[0] });
  });

  // Consistency check: every stock level must equal the sum of its ledger entries and be >= 0.
  // GET /audit?skuPrefix=LT-
  router.get('/audit', async ({ query, send }) => {
    const prefix = query.get('skuPrefix')?.toUpperCase() ?? null;
    const { rows } = await pool.query(
      `WITH deltas AS (
         SELECT sku, to_wh AS wh, qty AS d FROM inventory.movements
          WHERE status = 'ok' AND to_wh IS NOT NULL AND ($1::text IS NULL OR sku LIKE $1 || '%')
         UNION ALL
         SELECT sku, from_wh, -qty FROM inventory.movements
          WHERE status = 'ok' AND from_wh IS NOT NULL AND ($1::text IS NULL OR sku LIKE $1 || '%')
       ), ledger AS (SELECT sku, wh, sum(d)::int AS qty FROM deltas GROUP BY sku, wh)
       SELECT l.sku, l.warehouse, l.qty AS level, COALESCE(g.qty, 0) AS ledger
         FROM inventory.stock_levels l
         LEFT JOIN ledger g ON g.sku = l.sku AND g.wh = l.warehouse
        WHERE ($1::text IS NULL OR l.sku LIKE $1 || '%')`,
      [prefix]
    );
    const mismatches = rows.filter((r) => r.level !== r.ledger);
    const negative = rows.filter((r) => r.level < 0);
    send(200, { consistent: !mismatches.length && !negative.length, checked: rows.length, mismatches, negative });
  });
};
