// "inventory" service: SKU catalog + stock levels per warehouse (read-heavy, cached by the gateway).
const { pool, tx } = require('./db');
const { HttpError, requireClient, requireAdmin, str, int, num } = require('./http');

const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;

function stockStatus(onHand, reorderLevel) {
  if (onHand <= 0) return 'out';
  if (onHand <= reorderLevel) return 'low';
  return 'ok';
}

async function listItems({ category, q, sku } = {}) {
  const { rows } = await pool.query(
    `SELECT i.sku, i.name, i.category, i.unit_cost::float8 AS "unitCost", i.reorder_level AS "reorderLevel",
            COALESCE(SUM(l.qty), 0)::int AS "onHand",
            COALESCE(jsonb_object_agg(l.warehouse, l.qty) FILTER (WHERE l.warehouse IS NOT NULL), '{}'::jsonb) AS levels,
            GREATEST(i.updated_at, MAX(l.updated_at)) AS "updatedAt"
       FROM inventory.items i
       LEFT JOIN inventory.stock_levels l ON l.sku = i.sku
      WHERE ($1::text IS NULL OR i.category = $1)
        AND ($2::text IS NULL OR i.sku ILIKE $2 || '%' OR i.name ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR i.sku = $3)
      GROUP BY i.sku
      ORDER BY i.sku`,
    [category ?? null, q ?? null, sku ?? null]
  );
  for (const it of rows) {
    it.stockValue = Math.round(it.onHand * it.unitCost * 100) / 100;
    it.status = stockStatus(it.onHand, it.reorderLevel);
  }
  return rows;
}

async function warehouses() {
  const { rows } = await pool.query('SELECT code, name, city FROM inventory.warehouses ORDER BY code');
  return rows;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = (router) => {
  // GET /?category=&q=&status=low|out|ok&warehouse=&limit=&offset=
  router.get('/', async ({ query, send }) => {
    const status = query.get('status');
    const warehouse = query.get('warehouse');
    const limit = Math.min(Number(query.get('limit')) || 100, 500);
    const offset = Math.max(Number(query.get('offset')) || 0, 0);
    let items = await listItems({ category: query.get('category'), q: query.get('q') });
    if (warehouse) {
      items = items.map((it) => {
        const onHand = it.levels[warehouse] ?? 0;
        return { ...it, onHand, stockValue: round2(onHand * it.unitCost), status: stockStatus(onHand, it.reorderLevel) };
      });
    }
    if (status) items = items.filter((it) => status.split(',').includes(it.status));
    send(200, { count: items.length, items: items.slice(offset, offset + limit) });
  });

  // Aggregates for the inventory dashboard.
  router.get('/summary', async ({ send }) => {
    const [items, whs] = await Promise.all([listItems(), warehouses()]);
    const byWarehouse = whs.map((w) => ({ ...w, units: 0, value: 0 }));
    const byCategory = {};
    const totals = { skus: items.length, units: 0, value: 0, low: 0, out: 0, ok: 0 };
    for (const it of items) {
      totals.units += it.onHand;
      totals.value += it.stockValue;
      totals[it.status]++;
      const c = (byCategory[it.category] ??= { category: it.category, skus: 0, units: 0, value: 0 });
      c.skus++;
      c.units += it.onHand;
      c.value += it.stockValue;
      for (const w of byWarehouse) {
        const qty = it.levels[w.code] ?? 0;
        w.units += qty;
        w.value += qty * it.unitCost;
      }
    }
    totals.value = round2(totals.value);
    byWarehouse.forEach((w) => (w.value = round2(w.value)));
    const categories = Object.values(byCategory).map((c) => ({ ...c, value: round2(c.value) })).sort((a, b) => b.value - a.value);
    const alerts = items
      .filter((it) => it.status !== 'ok')
      .sort((a, b) => a.onHand / Math.max(a.reorderLevel, 1) - b.onHand / Math.max(b.reorderLevel, 1))
      .slice(0, 50);
    send(200, { generatedAt: new Date().toISOString(), totals, warehouses: byWarehouse, categories, alerts });
  });

  router.get('/warehouses', async ({ send }) => send(200, { warehouses: await warehouses() }));

  router.get('/:sku', async ({ params, send }) => {
    const [item] = await listItems({ sku: params.sku.toUpperCase() });
    if (!item) throw new HttpError(404, 'sku_not_found', `Unknown SKU ${params.sku}`);
    send(200, { item });
  });

  // Create an item. Stock starts at 0 in every warehouse; use POST /api/stock/receive to add stock.
  router.post('/', async ({ body, principal, send }) => {
    requireClient(principal);
    const sku = str(body.sku, 'sku', { max: 40 }).toUpperCase();
    if (!SKU_RE.test(sku)) throw new HttpError(422, 'validation_error', 'sku must be 2-40 chars of A-Z, 0-9 and "-"');
    const item = {
      sku,
      name: str(body.name, 'name', { max: 120 }),
      category: str(body.category ?? 'Uncategorised', 'category', { max: 40 }),
      unitCost: num(body.unitCost ?? 0, 'unitCost', { min: 0, max: 1e7 }),
      reorderLevel: int(body.reorderLevel ?? 0, 'reorderLevel', { min: 0, max: 1e7 }),
    };
    try {
      await tx(async (c) => {
        await c.query(
          'INSERT INTO inventory.items (sku, name, category, unit_cost, reorder_level) VALUES ($1,$2,$3,$4,$5)',
          [item.sku, item.name, item.category, item.unitCost, item.reorderLevel]
        );
        await c.query('INSERT INTO inventory.stock_levels (sku, warehouse) SELECT $1, code FROM inventory.warehouses', [item.sku]);
      });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'sku_exists', `SKU ${item.sku} already exists`);
      throw err;
    }
    const [created] = await listItems({ sku: item.sku });
    send(201, { item: created });
  });

  router.patch('/:sku', async ({ params, body, principal, send }) => {
    requireClient(principal);
    const sku = params.sku.toUpperCase();
    const sets = [];
    const values = [sku];
    const add = (col, v) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.name !== undefined) add('name', str(body.name, 'name', { max: 120 }));
    if (body.category !== undefined) add('category', str(body.category, 'category', { max: 40 }));
    if (body.unitCost !== undefined) add('unit_cost', num(body.unitCost, 'unitCost', { min: 0, max: 1e7 }));
    if (body.reorderLevel !== undefined) add('reorder_level', int(body.reorderLevel, 'reorderLevel', { min: 0, max: 1e7 }));
    if (!sets.length) throw new HttpError(422, 'validation_error', 'Nothing to update (name, category, unitCost, reorderLevel)');
    const r = await pool.query(`UPDATE inventory.items SET ${sets.join(', ')}, updated_at = now() WHERE sku = $1`, values);
    if (!r.rowCount) throw new HttpError(404, 'sku_not_found', `Unknown SKU ${sku}`);
    const [item] = await listItems({ sku });
    send(200, { item });
  });

  // Removes the item with its stock levels and ledger entries (used to clean up load-test SKUs). Admin only.
  router.delete('/:sku', async ({ params, principal, send }) => {
    requireAdmin(principal);
    const sku = params.sku.toUpperCase();
    const r = await pool.query('DELETE FROM inventory.items WHERE sku = $1', [sku]);
    if (!r.rowCount) throw new HttpError(404, 'sku_not_found', `Unknown SKU ${sku}`);
    send(200, { deleted: sku });
  });
};
