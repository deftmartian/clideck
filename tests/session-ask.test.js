const { test } = require('node:test');
const assert = require('node:assert');
const { askSession, canAskWithoutInterrupt, waitForAnswer } = require('../session-ask');

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

test('ask waits for capture completion before reading the committed response', async () => {
  const target = { name: 'Worker', working: true, lastPreview: '', lastActivityAt: null };
  const sessions = new Map([['target-id', target]]);
  const broadcastListeners = new Set();
  const outputListeners = new Set();
  let captureFinished = false;
  const api = {
    getSessions: () => sessions,
    addBroadcastListener(fn) { broadcastListeners.add(fn); return () => broadcastListeners.delete(fn); },
    addOutputListener(fn) { outputListeners.add(fn); return () => outputListeners.delete(fn); },
    async capture() {
      await new Promise(resolve => setTimeout(resolve, 50));
      target.lastPreview = 'committed response';
      target.lastActivityAt = new Date().toISOString();
      captureFinished = true;
      return true;
    },
  };
  const pending = waitForAnswer({
    sessionsApi: api,
    targetId: 'target-id',
    sinceTs: Date.now() - 1,
    timeoutMs: 1000,
  });
  target.working = false;
  for (const listener of broadcastListeners) {
    listener({ type: 'session.status', id: 'target-id', working: false });
  }
  const response = await pending;
  assert.equal(captureFinished, true);
  assert.equal(response, 'committed response');
});

test('ask quiet detection listens to internal session.output events', async () => {
  const target = { name: 'Worker', working: false, lastPreview: '', lastActivityAt: null };
  const sessions = new Map([['target-id', target]]);
  const outputListeners = new Set();
  const api = {
    getSessions: () => sessions,
    addBroadcastListener() { return () => {}; },
    addOutputListener(fn) { outputListeners.add(fn); return () => outputListeners.delete(fn); },
    async capture() {
      target.lastPreview = 'quiet response';
      target.lastActivityAt = new Date().toISOString();
      return true;
    },
  };
  const pending = waitForAnswer({
    sessionsApi: api,
    targetId: 'target-id',
    sinceTs: Date.now() - 1,
    timeoutMs: 1000,
    quietMs: 10,
  });
  for (const listener of outputListeners) {
    listener({ type: 'session.output', id: 'target-id', endSeq: 42 });
  }
  assert.equal(await pending, 'quiet response');
});
