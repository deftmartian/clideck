const { test } = require('node:test');
const assert = require('node:assert');
const { askSession, canAskWithoutInterrupt } = require('../session-ask');

test('ask protects unrelated existing sessions before injecting input', async () => {
  const sessions = new Map([
    ['caller-id', { name: 'Caller', projectId: 'project-1' }],
    ['target-id', { name: 'Personal Session', projectId: 'project-1', working: false }],
  ]);
  let inputs = 0;
  const api = {
    getSessions: () => sessions,
    input: () => { inputs++; },
  };

  await assert.rejects(
    askSession({ callerSessionId: 'caller-id', target: 'Personal Session', message: 'review this' }, api, {}),
    /would inject a prompt and interrupt its conversation/,
  );
  assert.equal(inputs, 0);
});

test('ask recognizes only a caller-owned spawned worker as non-interrupting', () => {
  assert.equal(canAskWithoutInterrupt('caller-id', { spawnedBySessionId: 'caller-id' }), true);
  assert.equal(canAskWithoutInterrupt('caller-id', { spawnedBySessionId: 'someone-else' }), false);
  assert.equal(canAskWithoutInterrupt('caller-id', {}), false);
});
