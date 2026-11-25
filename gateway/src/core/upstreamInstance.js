const { CircuitBreaker } = require('./circuitBreaker');

/** Runtime state for one backend instance: health, circuit breaker, and traffic counters. */
class UpstreamInstance {
  constructor({ id, url, service }, breakerOptions = {}) {
    this.id = id;
    this.url = url.replace(/\/+$/, '');
    this.service = service;
    this.healthy = true; // optimistic until the first health check says otherwise
    this.breaker = new CircuitBreaker(breakerOptions);
    this.activeConnections = 0;
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.ewmaLatencyMs = null; // exponentially weighted moving average of proxied response time
    this.health = { consecutiveFailures: 0, consecutiveSuccesses: 0, lastCheckedAt: null, lastLatencyMs: null, lastError: null };
  }

  /** Whether the load balancer may route to this instance right now. */
  isAvailable() {
    return this.healthy && this.breaker.canRequest();
  }

  recordResponseTime(ms) {
    this.ewmaLatencyMs = this.ewmaLatencyMs === null ? ms : 0.8 * this.ewmaLatencyMs + 0.2 * ms;
  }

  /** Apply a health-check result. Returns 'up' | 'down' when the health state flips, otherwise null. */
  recordHealth(ok, { latencyMs, error, healthyThreshold, unhealthyThreshold }) {
    const h = this.health;
    h.lastCheckedAt = new Date().toISOString();
    h.lastLatencyMs = latencyMs;
    h.lastError = ok ? null : error || 'unhealthy';
    if (ok) {
      h.consecutiveSuccesses++;
      h.consecutiveFailures = 0;
      if (!this.healthy && h.consecutiveSuccesses >= healthyThreshold) {
        this.healthy = true;
        return 'up';
      }
    } else {
      h.consecutiveFailures++;
      h.consecutiveSuccesses = 0;
      if (this.healthy && h.consecutiveFailures >= unhealthyThreshold) {
        this.healthy = false;
        return 'down';
      }
    }
    return null;
  }

  snapshot() {
    return {
      id: this.id,
      url: this.url,
      healthy: this.healthy,
      available: this.healthy && this.breaker.state !== 'OPEN',
      breaker: this.breaker.snapshot(),
      activeConnections: this.activeConnections,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      avgLatencyMs: this.ewmaLatencyMs === null ? null : Math.round(this.ewmaLatencyMs),
      health: { ...this.health },
    };
  }
}

module.exports = { UpstreamInstance };
