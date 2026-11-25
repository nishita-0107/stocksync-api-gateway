const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, STATES } = require('../src/core/circuitBreaker');

function makeBreaker(opts = {}) {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: () => now, ...opts });
  return { breaker, advance: (ms) => (now += ms) };
}

test('opens after consecutive failures reach the threshold', () => {
  const { breaker } = makeBreaker();
  breaker.onFailure();
  breaker.onFailure();
  assert.equal(breaker.state, STATES.CLOSED);
  breaker.onFailure();
  assert.equal(breaker.state, STATES.OPEN);
  assert.equal(breaker.canRequest(), false);
});

test('a success resets the consecutive failure count', () => {
  const { breaker } = makeBreaker();
  breaker.onFailure();
  breaker.onFailure();
  breaker.onSuccess();
  breaker.onFailure();
  breaker.onFailure();
  assert.equal(breaker.state, STATES.CLOSED);
});

test('moves to HALF_OPEN after the reset timeout and allows a single trial', () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  advance(999);
  assert.equal(breaker.canRequest(), false);
  advance(1);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.state, STATES.HALF_OPEN);
  breaker.onRequestStart();
  assert.equal(breaker.canRequest(), false, 'only one trial request in flight');
});

test('HALF_OPEN success closes, failure re-opens', () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 3; i++) breaker.onFailure();
  advance(1000);
  breaker.canRequest();
  breaker.onRequestStart();
  breaker.onSuccess();
  assert.equal(breaker.state, STATES.CLOSED);

  for (let i = 0; i < 3; i++) breaker.onFailure();
  advance(1000);
  breaker.canRequest();
  breaker.onRequestStart();
  breaker.onFailure();
  assert.equal(breaker.state, STATES.OPEN);
  assert.equal(breaker.timesOpened, 3);
});

test('emits stateChange events', () => {
  const { breaker } = makeBreaker({ failureThreshold: 1 });
  const events = [];
  breaker.on('stateChange', (e) => events.push(e));
  breaker.onFailure();
  assert.deepEqual(events, [{ from: 'CLOSED', to: 'OPEN' }]);
});
