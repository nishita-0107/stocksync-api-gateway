/**
 * In-process token bucket. Used as a fallback when Redis is unreachable so the gateway
 * keeps protecting upstreams (per gateway instance) instead of failing open completely.
 */
class LocalTokenBucket {
  constructor({ maxKeys = 50000 } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
  }

  consume(id, capacity, refillPerSec, cost = 1, now = Date.now()) {
    let b = this.buckets.get(id);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: capacity, ts: now };
      this.buckets.set(id, b);
    }
    const elapsed = Math.max(0, now - b.ts);
    b.tokens = Math.min(capacity, b.tokens + (elapsed * refillPerSec) / 1000);
    b.ts = now;

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    return {
      allowed: false,
      remaining: Math.floor(b.tokens),
      retryAfterMs: Math.ceil(((cost - b.tokens) * 1000) / refillPerSec),
    };
  }
}

module.exports = { LocalTokenBucket };
