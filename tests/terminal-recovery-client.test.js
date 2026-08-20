const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

async function loadRecoveryClient() {
  const source = readFileSync(join(__dirname, '..', 'public', 'js', 'terminal-recovery-client.js'), 'utf8')
    .replace(
      "import { countPerf, maxPerf, notePerf } from './perf.js';",
      'const countPerf = () => {}; const maxPerf = () => {}; const notePerf = () => {};',
    );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
}

function entry(overrides = {}) {
  const writes = [];
  return {
    id: 'session-a',
    term: { reset() {} },
    receivedSeq: 0,
    appliedSeq: 0,
    queue() { return false; },
    writeChunk(data, replay, callback) { writes.push({ data, replay, callback }); },
    writes,
    ...overrides,
  };
}

test('received output is not acknowledged or resumable until xterm applies it', async () => {
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  const rafs = new Map();
  let nextRaf = 1;
  global.requestAnimationFrame = fn => { const id = nextRaf++; rafs.set(id, fn); return id; };
  global.cancelAnimationFrame = id => rafs.delete(id);
  try {
    const { createTerminalRecoveryClient } = await loadRecoveryClient();
    const acknowledgements = [];
    const current = [];
    const recovery = createTerminalRecoveryClient({
      requestResync() {},
      sendAck: message => acknowledgements.push(message),
      onCurrent: value => current.push(value),
    });
    const target = entry();
    recovery.handleSync(target, {
      type: 'session.sync', id: 'session-a', streamId: 17,
      generation: 'generation-a', mode: 'delta', targetSeq: 4,
    });
    recovery.handleOutput(null, target, {
      type: 'output', id: 'session-a', streamId: 17,
      generation: 'generation-a', startSeq: 0, endSeq: 4,
      data: 'same', replay: true,
    });

    assert.equal(target.receivedSeq, 4);
    assert.equal(target.appliedSeq, 0);
    assert.equal(acknowledgements.length, 0);
    assert.equal(current.length, 0);
    target.writes[0].callback();
    assert.equal(target.appliedSeq, 4);
    assert.deepEqual(acknowledgements.map(message => message.seq), [4]);
    assert.equal(current.length, 1);
  } finally {
    global.requestAnimationFrame = previousRaf;
    global.cancelAnimationFrame = previousCancel;
  }
});

test('stale xterm callbacks cannot advance a replacement stream', async () => {
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  try {
    const { createTerminalRecoveryClient } = await loadRecoveryClient();
    const acknowledgements = [];
    const recovery = createTerminalRecoveryClient({
      requestResync() {}, sendAck: message => acknowledgements.push(message), onCurrent() {},
    });
    const target = entry();
    recovery.handleSync(target, {
      id: 'session-a', streamId: 1, generation: 'generation-a', mode: 'delta', targetSeq: 4,
    });
    recovery.handleOutput(null, target, {
      id: 'session-a', streamId: 1, generation: 'generation-a',
      startSeq: 0, endSeq: 4, data: 'same', replay: true,
    });
    recovery.handleSync(target, {
      id: 'session-a', streamId: 2, generation: 'generation-a', mode: 'current', targetSeq: 0,
    });
    target.writes[0].callback();
    assert.equal(target.streamId, 2);
    assert.equal(target.appliedSeq, 0);
    assert.equal(acknowledgements.length, 0);
  } finally {
    global.requestAnimationFrame = previousRaf;
    global.cancelAnimationFrame = previousCancel;
  }
});

test('snapshot credit is released only after each ordered xterm write completes', async () => {
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  const rafs = new Map();
  global.requestAnimationFrame = fn => { rafs.set(1, fn); return 1; };
  global.cancelAnimationFrame = id => rafs.delete(id);
  try {
    const { createTerminalRecoveryClient } = await loadRecoveryClient();
    const acknowledgements = [];
    const recovery = createTerminalRecoveryClient({
      requestResync() {}, sendAck: message => acknowledgements.push(message), onCurrent() {},
    });
    let resets = 0;
    const target = entry({ term: { reset() { resets += 1; } } });
    recovery.handleSync(target, {
      id: 'session-a', streamId: 9, generation: 'generation-b', mode: 'snapshot', targetSeq: 8,
    });
    recovery.handleSnapshot(target, {
      id: 'session-a', streamId: 9, generation: 'generation-b', atSeq: 8,
      part: 0, parts: 2, data: 'left',
    });
    recovery.handleSnapshot(target, {
      id: 'session-a', streamId: 9, generation: 'generation-b', atSeq: 8,
      part: 1, parts: 2, data: 'right',
    });
    assert.equal(resets, 1);
    assert.equal(acknowledgements.length, 0);
    target.writes[0].callback();
    assert.equal(acknowledgements.length, 0);
    const flush = rafs.get(1);
    rafs.delete(1);
    flush();
    assert.deepEqual(acknowledgements.map(message => message.part), [0]);
    assert.equal(target.appliedSeq, null);
    target.writes[1].callback();
    assert.deepEqual(acknowledgements.map(message => message.part), [0, 1]);
    assert.equal(target.appliedSeq, 8);
  } finally {
    global.requestAnimationFrame = previousRaf;
    global.cancelAnimationFrame = previousCancel;
  }
});
