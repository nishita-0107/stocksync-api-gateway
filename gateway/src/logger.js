// Minimal structured (JSON lines) logger.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function serialize(fields) {
  if (!fields) return {};
  const out = { ...fields };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Error) out[k] = { message: v.message, name: v.name, stack: v.stack };
  }
  return out;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...serialize(fields) });
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
