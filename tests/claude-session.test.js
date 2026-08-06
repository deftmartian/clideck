const test = require('node:test');
const assert = require('node:assert/strict');

const { updateClaudeSessionToken } = require('../claude-session');

test('hook-established Claude tokens are authoritative over telemetry', () => {
  const session = { presetId: 'claude-code', sessionToken: null };
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';

  assert.equal(updateClaudeSessionToken(session, first, 'clideck00', { origin: 'telemetry' }), true);
  assert.equal(session.sessionToken, first);
  assert.equal(updateClaudeSessionToken(session, second, 'clideck00', { origin: 'hook' }), true);
  assert.equal(session.sessionToken, second);

  // An out-of-order telemetry batch must not replace the hook's current ID.
  assert.equal(updateClaudeSessionToken(session, first, 'clideck00', { origin: 'telemetry' }), false);
  assert.equal(session.sessionToken, second);

  // A newer synchronous hook update is still authoritative.
  assert.equal(updateClaudeSessionToken(session, first, 'clideck00', { origin: 'hook' }), true);
  assert.equal(session.sessionToken, first);
});
