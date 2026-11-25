const { EventEmitter } = require('events');

const STATES = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

/**
 * Per-upstream-instance circuit breaker.
 *
 * CLOSED    -> requests flow; consecutive failures are counted.
 * OPEN      -> after `failureThreshold` consecutive failures; requests are rejected fast
 *              until `resetTimeoutMs` has elapsed.
 * HALF_OPEN -> up to `halfOpenMaxRequests` trial requests are let through.
 *              A success closes the circuit, a failure re-opens it.
 */
class CircuitBreaker extends EventEmitter {
  constructor({ failureThreshold = 5, resetTimeoutMs = 10000, halfOpenMaxRequests = 1, now = Date.now } = {}) {
    super();
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMaxRequests = halfOpenMaxRequests;
    this.now = now;
    this.state = STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
    this.timesOpened = 0;
  }

  /** Whether a request may be sent now. May move OPEN -> HALF_OPEN once the reset timeout passes. */
  canRequest() {
    if (this.state === STATES.CLOSED) return true;
    if (this.state === STATES.OPEN) {
      if (this.now() - this.openedAt < this.resetTimeoutMs) return false;
      this._transition(STATES.HALF_OPEN);
    }
    return this.halfOpenInFlight < this.halfOpenMaxRequests;
  }

  /** Call when a request is actually dispatched to the instance. */
  onRequestStart() {
    if (this.state === STATES.HALF_OPEN) this.halfOpenInFlight++;
  }

  onSuccess() {
    this.consecutiveFailures = 0;
    if (this.state === STATES.HALF_OPEN) this._transition(STATES.CLOSED);
  }

  onFailure() {
    if (this.state === STATES.HALF_OPEN) {
      this._open();
      return;
    }
    this.consecutiveFailures++;
    if (this.state === STATES.CLOSED && this.consecutiveFailures >= this.failureThreshold) this._open();
  }

  _open() {
    this.openedAt = this.now();
    this.timesOpened++;
    this._transition(STATES.OPEN);
  }

  _transition(next) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.halfOpenInFlight = 0;
    if (next === STATES.CLOSED) this.consecutiveFailures = 0;
    this.emit('stateChange', { from: prev, to: next });
  }

  snapshot() {
    const retryInMs =
      this.state === STATES.OPEN ? Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt)) : 0;
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      timesOpened: this.timesOpened,
      retryInMs,
    };
  }
}

module.exports = { CircuitBreaker, STATES };
