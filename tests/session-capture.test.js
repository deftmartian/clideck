const test = require('node:test');
const assert = require('node:assert/strict');
const { MENU_LINES, SCROLLBACK_LINES } = require('../server-capture');
const { createSessionCapture } = require('../session-capture');

function createHarness(session, overrides = {}) {
  const messages = [];
  let candidate = '';
  const transcript = {
    detectMenu: () => null,
    stripMenu: lines => lines,
    updateAgentCandidate: (_id, _presetId, lines) => { candidate = lines.join('\n'); },
    commitAgentCandidate: () => {},
    getAgentCandidate: () => candidate,
    ...overrides.transcript,
  };
  const coordinator = createSessionCapture({
    getSession: id => id === 'session-1' ? session : undefined,
    transcript,
    telemetry: {
      getLastEvent: () => '',
      cancelCodexMenuPoll: () => {},
      ...overrides.telemetry,
    },
    plugins: {
      shouldAutoApproveMenu: () => false,
      notifyMenu: () => {},
      ...overrides.plugins,
    },
    menuStartsWork: overrides.menuStartsWork || (() => true),
    broadcast: message => messages.push(message),
    input: overrides.input || (() => {}),
  });
  return { coordinator, messages };
}

test('session capture updates the latest preview from a settled headless snapshot', async () => {
  const calls = [];
  const session = {
    presetId: 'shell',
    outputSeq: 24,
    working: true,
    capture: {
      async lines(options) {
        calls.push(options);
        return ['first line', 'latest reply'];
      },
    },
  };
  const { coordinator, messages } = createHarness(session);

  assert.equal(await coordinator.capture('session-1'), true);
  assert.deepEqual(calls, [{ atSeq: 24, limit: SCROLLBACK_LINES }]);
  assert.equal(session.lastPreview, 'latest reply');
  assert.match(session.lastActivityAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(messages.at(-1), {
    type: 'session.preview', id: 'session-1', text: 'latest reply',
  });
});

test('overlapping capture requests merge into one bounded follow-up pass', async () => {
  let releaseFirst;
  const firstPass = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  let detectionPass = 0;
  const session = {
    presetId: 'claude-code',
    outputSeq: 30,
    working: true,
    capture: {
      async lines(options) {
        calls.push(options);
        if (calls.length === 1) return firstPass;
        return ['Choose one', '1. Continue'];
      },
    },
  };
  const { coordinator } = createHarness(session, {
    transcript: {
      detectMenu: () => (++detectionPass === 1 ? null : ['Continue']),
    },
  });

  const first = coordinator.capture('session-1', { menuVersion: 1, settled: false, atSeq: 10 });
  const second = coordinator.capture('session-1', { menuVersion: 2, settled: true, atSeq: 20 });
  const third = coordinator.capture('session-1', { menuVersion: 3, settled: false, atSeq: 15 });
  assert.equal(second, first);
  assert.equal(third, first);
  releaseFirst(['working']);

  assert.equal(await first, true);
  assert.deepEqual(calls, [
    { atSeq: 10, limit: MENU_LINES },
    { atSeq: 20, limit: SCROLLBACK_LINES },
  ]);
  assert.equal(session._menuActiveVersion, 3);
  assert.equal(session._captureFlight, null);
});
