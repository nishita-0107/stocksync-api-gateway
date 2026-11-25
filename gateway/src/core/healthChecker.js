const logger = require('../logger');

/** Actively polls GET <instance>/health and marks instances up/down using thresholds (hysteresis). */
class HealthChecker {
  constructor(registry, { intervalMs, timeoutMs, unhealthyThreshold, healthyThreshold }, fetchImpl = fetch) {
    this.registry = registry;
    this.opts = { intervalMs, timeoutMs, unhealthyThreshold, healthyThreshold };
    this.fetch = fetchImpl;
    this.timer = null;
  }

  start() {
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async checkAll() {
    await Promise.all(this.registry.allInstances().map((inst) => this.checkOne(inst)));
  }

  async checkOne(instance) {
    const started = Date.now();
    let ok = false;
    let error = null;
    try {
      const res = await this.fetch(`${instance.url}/health`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
      await res.body?.cancel();
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
    }
    const change = instance.recordHealth(ok, { latencyMs: Date.now() - started, error, ...this.opts });
    if (change === 'down') logger.warn('instance marked DOWN', { instance: instance.id, error });
    if (change === 'up') logger.info('instance marked UP', { instance: instance.id });
  }
}

module.exports = { HealthChecker };
