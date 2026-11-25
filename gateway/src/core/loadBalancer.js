const STRATEGIES = ['round-robin', 'least-connections', 'random'];

/**
 * Picks an upstream instance for a request. Only instances that are healthy and whose
 * circuit breaker allows traffic are considered. `exclude` holds ids already tried by
 * this request (used when retrying on another instance).
 */
class LoadBalancer {
  constructor(strategy = 'round-robin', { random = Math.random } = {}) {
    if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown load-balancing strategy: ${strategy}`);
    this.strategy = strategy;
    this.random = random;
    this.cursor = 0;
  }

  pick(instances, exclude = new Set()) {
    const candidates = instances.filter((i) => !exclude.has(i.id) && i.isAvailable());
    if (candidates.length === 0) return null;

    switch (this.strategy) {
      case 'least-connections': {
        const min = Math.min(...candidates.map((i) => i.activeConnections));
        const tied = candidates.filter((i) => i.activeConnections === min);
        return tied[this.cursor++ % tied.length]; // rotate among ties so load still spreads
      }
      case 'random':
        return candidates[Math.floor(this.random() * candidates.length)];
      case 'round-robin':
      default:
        return candidates[this.cursor++ % candidates.length];
    }
  }
}

module.exports = { LoadBalancer, STRATEGIES };
