const crypto = require('crypto');

/** Reject if `promise` does not settle within `ms`. Used to keep Redis/queue outages from stalling requests. */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sendError(res, status, code, message, extra = {}) {
  if (res.headersSent) return;
  res.status(status).json({
    error: { code, message, requestId: res.req?.id, ...extra },
  });
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Retry an async function until it succeeds (used to wait for Postgres/Redis on boot). */
async function waitFor(name, fn, { attempts = 30, delayMs = 1000, logger } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      logger?.warn(`waiting for ${name}`, { attempt: i, error: err.message });
      await sleep(delayMs);
    }
  }
}

module.exports = { withTimeout, sendError, sha256, sleep, isUuid, waitFor };
