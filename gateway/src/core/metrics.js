const { withTimeout } = require('../utils');

const RING_SIZE = 2000;
const RPM_TTL_SECONDS = 2 * 60 * 60;

/**
 * Metrics:
 *  - cluster-wide counters in Redis (totals, per-service, per-minute request/error counts)
 *  - per-gateway latency percentiles from an in-memory ring buffer of recent requests
 */
class Metrics {
  constructor({ redis }) {
    this.redis = redis;
    this.latencies = new Array(RING_SIZE);
    this.ringIndex = 0;
    this.ringCount = 0;
  }

  record(entry) {
    this.latencies[this.ringIndex] = entry.latency_ms;
    this.ringIndex = (this.ringIndex + 1) % RING_SIZE;
    this.ringCount = Math.min(this.ringCount + 1, RING_SIZE);

    const minute = Math.floor(Date.now() / 60000);
    const statusClass = `${Math.floor(entry.status / 100)}xx`;
    const p = this.redis.pipeline();
    p.hincrby('metrics:totals', 'requests', 1);
    p.hincrby('metrics:totals', `status_${statusClass}`, 1);
    p.incr(`metrics:rpm:${minute}`).expire(`metrics:rpm:${minute}`, RPM_TTL_SECONDS);
    if (entry.status >= 500) p.incr(`metrics:errpm:${minute}`).expire(`metrics:errpm:${minute}`, RPM_TTL_SECONDS);
    if (entry.rate_limited) {
      p.hincrby('metrics:totals', 'rate_limited', 1);
      p.incr(`metrics:rlpm:${minute}`).expire(`metrics:rlpm:${minute}`, RPM_TTL_SECONDS);
    }
    if (entry.cache_status === 'HIT') p.hincrby('metrics:totals', 'cache_hit', 1);
    if (entry.cache_status === 'MISS') p.hincrby('metrics:totals', 'cache_miss', 1);
    if (entry.service) {
      p.hincrby('metrics:services', `${entry.service}:requests`, 1);
      if (entry.status >= 500) p.hincrby('metrics:services', `${entry.service}:errors`, 1);
      p.hincrby('metrics:services', `${entry.service}:latency_sum`, entry.latency_ms);
    }
    p.exec().catch(() => {}); // metrics are best-effort; never fail a request because of them
  }

  latencyPercentiles() {
    if (this.ringCount === 0) return { samples: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = this.latencies.slice(0, this.ringCount).sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return { samples: sorted.length, avg: Math.round(avg), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
  }

  async snapshot(minutes = 30) {
    const nowMinute = Math.floor(Date.now() / 60000);
    const range = Array.from({ length: minutes }, (_, i) => nowMinute - minutes + 1 + i);
    const series = (prefix) => this.redis.mget(range.map((m) => `metrics:${prefix}:${m}`));

    const [totals, services, rpm, errpm, rlpm] = await withTimeout(
      Promise.all([
        this.redis.hgetall('metrics:totals'),
        this.redis.hgetall('metrics:services'),
        series('rpm'),
        series('errpm'),
        series('rlpm'),
      ]),
      500,
      'metrics snapshot'
    );

    const toInt = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
    const perService = {};
    for (const [field, value] of Object.entries(services)) {
      const idx = field.lastIndexOf(':');
      const name = field.slice(0, idx);
      (perService[name] ??= {})[field.slice(idx + 1)] = Number(value);
    }
    return {
      totals: toInt(totals),
      services: perService,
      timeline: range.map((m, i) => ({
        minute: new Date(m * 60000).toISOString(),
        requests: Number(rpm[i] || 0),
        errors: Number(errpm[i] || 0),
        rateLimited: Number(rlpm[i] || 0),
      })),
    };
  }
}

module.exports = { Metrics };
