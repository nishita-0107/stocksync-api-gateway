// Shared PostgreSQL store for the inventory domain. Every instance of every service talks to the same
// schema, so stock levels stay consistent no matter which instance the gateway picks.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://gateway:gateway@localhost:5433/gateway',
  max: Number(process.env.DB_POOL_MAX || 8),
  idleTimeoutMillis: 30000,
  statement_timeout: 5000,
});
pool.on('error', (err) => console.error(JSON.stringify({ msg: 'postgres pool error', error: err.message })));

const MIGRATION_LOCK_ID = 7262002;

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.warehouses (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory.items (
  sku           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  unit_cost     NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
  reorder_level INT NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- qty can never go negative: the CHECK is the last line of defence against overselling
CREATE TABLE IF NOT EXISTS inventory.stock_levels (
  sku         TEXT NOT NULL REFERENCES inventory.items(sku) ON DELETE CASCADE,
  warehouse   TEXT NOT NULL REFERENCES inventory.warehouses(code),
  qty         INT  NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, warehouse)
);

-- Append-only ledger. Effect on a warehouse = +qty where to_wh = it, -qty where from_wh = it.
-- An adjust stores a signed qty in to_wh. Rejected movements (insufficient stock) have no effect.
CREATE TABLE IF NOT EXISTS inventory.movements (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  type            TEXT NOT NULL CHECK (type IN ('receive', 'ship', 'transfer', 'adjust')),
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'rejected')),
  sku             TEXT NOT NULL REFERENCES inventory.items(sku) ON DELETE CASCADE,
  from_wh         TEXT,
  to_wh           TEXT,
  qty             INT  NOT NULL,
  reference       TEXT,
  idempotency_key TEXT UNIQUE,
  client_id       TEXT,
  instance        TEXT
);
CREATE INDEX IF NOT EXISTS idx_movements_ts  ON inventory.movements (ts DESC);
CREATE INDEX IF NOT EXISTS idx_movements_sku ON inventory.movements (sku, ts DESC);
`;

const WAREHOUSES = [
  ['WH-NORTH', 'North Distribution Centre', 'Northfield'],
  ['WH-SOUTH', 'South Fulfilment Hub', 'Southport'],
  ['WH-EAST', 'East Cross-Dock', 'Eastbridge'],
];

// sku, name, category, unit cost, reorder level
const ITEMS = [
  ['ELE-1001', 'Wireless Barcode Scanner', 'Electronics', 89.0, 40],
  ['ELE-1002', 'Thermal Label Printer', 'Electronics', 215.5, 15],
  ['ELE-1003', 'Handheld RFID Reader', 'Electronics', 340.0, 10],
  ['ELE-1004', 'Rugged Tablet 10"', 'Electronics', 499.0, 12],
  ['ELE-1005', 'USB-C Charging Dock', 'Electronics', 42.75, 60],
  ['HRD-2001', 'Steel Pallet Rack Beam', 'Hardware', 64.0, 80],
  ['HRD-2002', 'Heavy-Duty Caster Wheel', 'Hardware', 18.4, 150],
  ['HRD-2003', 'Hex Bolt M12 (box of 100)', 'Hardware', 22.0, 120],
  ['HRD-2004', 'Galvanised Shelf Bracket', 'Hardware', 7.9, 300],
  ['HRD-2005', 'Hydraulic Pallet Jack', 'Hardware', 380.0, 6],
  ['PKG-3001', 'Corrugated Box 40x30x30', 'Packaging', 1.35, 2000],
  ['PKG-3002', 'Stretch Wrap Roll 500m', 'Packaging', 14.2, 200],
  ['PKG-3003', 'Bubble Mailer A4', 'Packaging', 0.45, 3000],
  ['PKG-3004', 'Packing Tape 66m', 'Packaging', 2.1, 800],
  ['PKG-3005', 'Wooden Pallet EUR', 'Packaging', 11.5, 250],
  ['OFF-4001', 'A4 Copy Paper (ream)', 'Office', 4.6, 400],
  ['OFF-4002', 'Clipboard with Storage', 'Office', 9.8, 50],
  ['OFF-4003', 'Shipping Label Roll', 'Office', 6.3, 300],
  ['OFF-4004', 'Desk Organiser', 'Office', 15.0, 30],
  ['SAF-5001', 'Hi-Vis Safety Vest', 'Safety', 6.75, 200],
  ['SAF-5002', 'Steel Toe Boots', 'Safety', 58.0, 40],
  ['SAF-5003', 'Hard Hat (white)', 'Safety', 12.9, 80],
  ['SAF-5004', 'Cut-Resistant Gloves', 'Safety', 5.2, 400],
  ['SAF-5005', 'First Aid Kit (50 person)', 'Safety', 44.0, 20],
];

// Deterministic opening stock: most items are healthy, a few are low, two are out of stock.
function openingQty(itemIdx, whIdx, reorderLevel) {
  if (itemIdx === 4 || itemIdx === 18) return 0; // out of stock everywhere
  if (itemIdx % 6 === 2) return Math.floor(reorderLevel / 6) + whIdx; // low stock
  const factor = 0.7 + (((itemIdx * 7 + whIdx * 3) % 10) / 10);
  return Math.round(reorderLevel * factor);
}

async function migrateAndSeed() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM inventory.items');
    if (rows[0].n > 0) return false;

    await client.query('BEGIN');
    for (const [code, name, city] of WAREHOUSES) {
      await client.query('INSERT INTO inventory.warehouses (code, name, city) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, name, city]);
    }
    for (const [i, [sku, name, category, cost, reorder]] of ITEMS.entries()) {
      await client.query(
        'INSERT INTO inventory.items (sku, name, category, unit_cost, reorder_level) VALUES ($1,$2,$3,$4,$5)',
        [sku, name, category, cost, reorder]
      );
      for (const [w, [code]] of WAREHOUSES.entries()) {
        const qty = openingQty(i, w, reorder);
        await client.query('INSERT INTO inventory.stock_levels (sku, warehouse, qty) VALUES ($1,$2,$3)', [sku, code, qty]);
        // opening balance goes into the ledger too, so the audit (levels == ledger) holds from the start
        if (qty > 0) {
          await client.query(
            `INSERT INTO inventory.movements (ts, type, sku, to_wh, qty, reference, instance)
             VALUES (now() - interval '1 day', 'receive', $1, $2, $3, 'opening-balance', 'seed')`,
            [sku, code, qty]
          );
        }
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Run fn(client) inside a transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx, migrateAndSeed };
