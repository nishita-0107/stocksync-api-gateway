const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30000 });
pool.on('error', (err) => logger.error('postgres pool error', { err }));

const MIGRATION_LOCK_ID = 7262001;

/** Apply schema.sql. An advisory lock prevents gateway and workers from racing on first boot. */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { pool, migrate };
