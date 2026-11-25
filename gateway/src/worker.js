// Worker process: consumes batched request logs from the queue and bulk-inserts them into PostgreSQL.
const os = require('os');
const { Worker } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { waitFor } = require('./utils');
const { pool, migrate } = require('./db');
const { createBullConnection } = require('./redis');
const { createQueues, QUEUE_NAMES } = require('./queues');

const WORKER_ID = process.env.WORKER_ID || os.hostname();
const LOG_COLUMNS = ['request_id', 'ts', 'method', 'path', 'status', 'latency_ms', 'service', 'upstream',
  'client_id', 'client_ip', 'cache_status', 'rate_limited', 'error', 'gateway_id'];

async function ingestLogs(job) {
  const entries = job.data.entries ?? [];
  if (entries.length === 0) return { inserted: 0 };
  const values = [];
  const params = [];
  entries.forEach((e, row) => {
    const placeholders = LOG_COLUMNS.map((_, col) => `$${row * LOG_COLUMNS.length + col + 1}`);
    values.push(`(${placeholders.join(', ')})`);
    for (const c of LOG_COLUMNS) params.push(e[c] ?? (c === 'rate_limited' ? false : null));
  });
  await pool.query(`INSERT INTO request_logs (${LOG_COLUMNS.join(', ')}) VALUES ${values.join(', ')}`, params);
  logger.debug('log batch inserted', { worker: WORKER_ID, rows: entries.length });
  return { inserted: entries.length };
}

async function pruneLogs() {
  const { rowCount } = await pool.query(
    `DELETE FROM request_logs WHERE ts < now() - make_interval(days => $1)`,
    [config.logs.retentionDays]
  );
  if (rowCount) logger.info('pruned old request logs', { rows: rowCount });
}

async function main() {
  await waitFor('postgres', () => pool.query('SELECT 1'), { logger });
  await migrate();

  const connection = createBullConnection(`worker-${WORKER_ID}`);
  const queues = createQueues(connection);

  const logWorker = new Worker(QUEUE_NAMES.logs, ingestLogs, { connection, concurrency: 2 });
  logWorker.on('failed', (job, err) =>
    logger.warn('log batch insert failed, will retry', { error: err.message, attempt: job?.attemptsMade })
  );
  logWorker.on('error', (err) => logger.error('log worker error', { err }));

  const pruneTimer = setInterval(
    () => pruneLogs().catch((err) => logger.warn('log prune failed', { error: err.message })),
    3600000
  );

  logger.info('worker started', { worker: WORKER_ID, queue: QUEUE_NAMES.logs });

  const shutdown = async (signal) => {
    logger.info('worker shutting down (finishing in-flight batches)', { signal });
    clearInterval(pruneTimer);
    await logWorker.close().catch(() => {});
    await queues.logs.close().catch(() => {});
    await Promise.allSettled([connection.quit(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('worker failed to start', { err });
  process.exit(1);
});
