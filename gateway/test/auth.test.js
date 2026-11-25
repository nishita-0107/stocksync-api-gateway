const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('../src/middleware/auth');

const config = {
  jwtSecret: 'test-secret',
  jwtTtlSeconds: 60,
  apiKeys: [
    { key: 'free-key', tier: 'free', name: 'alice' },
    { key: 'admin-key', tier: 'admin', name: 'ops' },
  ],
};
const auth = createAuth({ config });

function run(mode, headers) {
  const out = { status: null, nextCalled: false, req: { headers } };
  const res = { status(code) { out.status = code; return this; }, json() { return this; }, headersSent: false };
  auth.middleware(mode)(out.req, res, () => (out.nextCalled = true));
  return out;
}

test('resolves configured API keys and rejects unknown ones', () => {
  assert.deepEqual({ ...auth.resolveApiKey('free-key') }, { id: 'alice', name: 'alice', tier: 'free' });
  assert.equal(auth.resolveApiKey('nope'), null);
});

test('required mode: 401 without credentials, passes with a valid key', () => {
  assert.equal(run('required', {}).status, 401);
  assert.equal(run('required', { 'x-api-key': 'bad' }).status, 401);
  const ok = run('required', { 'x-api-key': 'free-key' });
  assert.equal(ok.nextCalled, true);
  assert.equal(ok.req.principal.id, 'alice');
});

test('optional mode lets anonymous requests through', () => {
  const r = run('optional', {});
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.principal, null);
});

test('admin mode: 403 for non-admin tiers', () => {
  assert.equal(run('admin', { 'x-api-key': 'free-key' }).status, 403);
  assert.equal(run('admin', { 'x-api-key': 'admin-key' }).nextCalled, true);
});

test('issued JWT authenticates as the same client; tampered token is rejected', () => {
  const token = auth.issueToken(auth.resolveApiKey('free-key'));
  const ok = run('required', { authorization: `Bearer ${token}` });
  assert.equal(ok.nextCalled, true);
  assert.equal(ok.req.principal.id, 'alice');
  assert.equal(ok.req.principal.tier, 'free');
  assert.equal(run('required', { authorization: `Bearer ${token}x` }).status, 401);
});
