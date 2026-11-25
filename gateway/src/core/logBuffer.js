const logger = require('../logger');
const { withTimeout } = require('../utils');

/**
 * Batches request-log entries in memory and ships them to the `request-logs` queue.
 * A worker bulk-inserts them into Postgres, so logging never adds DB latency to requests.
 */
class LogBuffer {
  constructor({ queue, flushIntervalMs = 1000, batchSize = 200, maxBuffered = 20000 }) {
    this.queue = queue;
    this.flushIntervalMs = flushIntervalMs;
    this.batchSize = batchSize;
    this.maxBuffered = maxBuffered;
    this.buffer = [];
    this.flushing = false;
    this.dropped = 0;
    this.shipped = 0;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  push(entry) {
    if (this.buffer.length >= this.maxBuffered) {
      this.dropped++;
      return;
    }
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) setImmediate(() => this.flush());
  }

  async flush() {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.batchSize);
    try {
      await withTimeout(this.queue.add('batch', { entries: batch }), 2000, 'log enqueue');
      this.shipped += batch.length;
    } catch (err) {
      // put the batch back (bounded) and try again on the next tick
      const room = this.maxBuffered - this.buffer.length;
      this.buffer.unshift(...batch.slice(0, room));
      this.dropped += Math.max(0, batch.length - room);
      logger.warn('request log flush failed', { error: err.message, buffered: this.buffer.length });
    } finally {
      this.flushing = false;
    }
    if (this.buffer.length >= this.batchSize) setImmediate(() => this.flush());
  }

  async stop() {
    clearInterval(this.timer);
    for (let i = 0; i < 5 && this.buffer.length > 0; i++) {
      while (this.flushing) await new Promise((r) => setTimeout(r, 20));
      await this.flush();
    }
  }

  stats() {
    return { buffered: this.buffer.length, shipped: this.shipped, dropped: this.dropped };
  }
}

module.exports = { LogBuffer };
