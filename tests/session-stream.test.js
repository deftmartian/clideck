const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  BACKLOG_HIGH_WATER,
  BATCH_MAX_BYTES,
  createSessionStream,
} = require('../session-stream');
const { ReplayRing } = require('../replay-ring');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.messages = [];
    this.rawFrames = [];
    this.closeCode = null;
    this.failNextSend = false;
  }
  send(raw) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send refused');
    }
    this.rawFrames.push(raw);
    this.messages.push(JSON.parse(raw));
  }
  close(code) { this.closeCode = code; this.readyState = 3; }
  ping() {}
  terminate() { this.readyState = 3; }
}

function fixture() {
  const clients = new Set();
  const sessions = new Map();
  const captures = new Map();
  const resizes = [];
  function add(id, data = '', generation = `${id}-generation`) {
    const session = {
      outputGeneration: generation,
      outputSeq: data.length,
      replayRing: new ReplayRing(2 * 1024 * 1024),
    };
    if (data) session.replayRing.append(data, 0);
    sessions.set(id, session);
    captures.set(id, async () => ({ data: `snapshot:${id}`, atSeq: session.outputSeq, cols: 80, rows: 24 }));
    return session;
  }
  const stream = createSessionStream({
    clients,
    getSession: id => sessions.get(id),
    snapshot: id => captures.get(id)(),
    applyResize: (id, cols, rows) => resizes.push({ id, cols, rows }),
  });
  stream.start();
  return { add, captures, clients, resizes, sessions, stream };
}

function messages(ws, type) { return ws.messages.filter(message => message.type === type); }

test('different subscriptions receive no cross-session output and same-session subscribers both receive it', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const a = f.add('a');
  const b = f.add('b');
  const one = new FakeSocket();
  const two = new FakeSocket();
  const three = new FakeSocket();
  [one, two, three].forEach(ws => f.stream.register(ws));
  await f.stream.subscribe(one, { id: 'a', replay: 'snapshot' });
  await f.stream.subscribe(two, { id: 'b', replay: 'snapshot' });
  await f.stream.subscribe(three, { id: 'a', replay: 'snapshot' });
  one.messages.length = two.messages.length = three.messages.length = 0;

  a.replayRing.append('A', a.outputSeq); a.outputSeq += 1;
  f.stream.queueOutput('a', 'A', 0, 1);
  b.replayRing.append('B', b.outputSeq); b.outputSeq += 1;
  f.stream.queueOutput('b', 'B', 0, 1);
  f.stream._flush('a');
  f.stream._flush('b');

  assert.deepEqual(messages(one, 'output').map(item => item.data), ['A']);
  assert.deepEqual(messages(two, 'output').map(item => item.data), ['B']);
  assert.deepEqual(messages(three, 'output').map(item => item.data), ['A']);
});

test('only the most recently interacting subscriber owns validated resize', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  f.add('a');
  const one = new FakeSocket();
  const two = new FakeSocket();
  f.stream.register(one); f.stream.register(two);
  await f.stream.subscribe(one, { id: 'a', replay: 'snapshot', claimResize: true, cols: 100, rows: 30 });
  await f.stream.subscribe(two, { id: 'a', replay: 'snapshot', claimResize: true, cols: 110, rows: 31 });
  assert.equal(f.stream.resize(one, { id: 'a', cols: 120, rows: 32 }), false);
  assert.equal(f.stream.resize(two, { id: 'a', cols: 120, rows: 32 }), true);
  assert.equal(f.stream.resize(two, { id: 'a', cols: 10, rows: 2 }), false);
  f.stream.claimResize(one, 'a');
  assert.equal(f.stream._resizeOwner('a'), one);
  assert.equal(f.stream.resize(one, { id: 'a', cols: 90, rows: 20 }), true);
  assert.deepEqual(f.resizes.map(item => [item.cols, item.rows]), [[100, 30], [110, 31], [120, 32], [90, 20]]);
});

test('invalid replacement subscriptions retain the previous stream and resize ownership', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  f.add('a'); f.add('b');
  const one = new FakeSocket();
  f.stream.register(one);
  await f.stream.subscribe(one, {
    id: 'a', replay: 'snapshot', claimResize: true, cols: 100, rows: 30,
  });
  one.messages.length = 0;
  assert.equal(await f.stream.subscribe(one, {
    id: 'b', replay: 'snapshot', claimResize: true, cols: 10, rows: 2,
  }), false);
  assert.equal(f.stream._stateFor(one).sessionId, 'a');
  assert.equal(f.stream._resizeOwner('a'), one);
  assert.equal(f.stream._resizeOwner('b'), undefined);
  assert.equal(messages(one, 'session.resyncRequired').at(-1).reason, 'invalid-size');
});

test('resume current, delta, generation changes, and buffer gaps use one recovery state machine', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const session = f.add('a', 'abcdef', 'g1');
  const ws = new FakeSocket();
  f.stream.register(ws);

  await f.stream.subscribe(ws, { id: 'a', replay: 'resume', cursor: { generation: 'g1', seq: 6 } });
  assert.equal(messages(ws, 'session.subscribed').at(-1).mode, 'current');
  ws.messages.length = 0;
  await f.stream.subscribe(ws, { id: 'a', replay: 'resume', cursor: { generation: 'g1', seq: 3 } });
  assert.equal(messages(ws, 'output')[0].data, 'def');
  assert.equal(messages(ws, 'session.subscribed')[0].mode, 'delta');

  ws.messages.length = 0;
  await f.stream.subscribe(ws, { id: 'a', replay: 'resume', cursor: { generation: 'old', seq: 6 } });
  assert.equal(messages(ws, 'session.snapshot').length, 1);
  assert.equal(messages(ws, 'session.subscribed')[0].mode, 'snapshot');

  session.replayRing = new ReplayRing(3);
  session.replayRing.append('abcdef', 0);
  ws.messages.length = 0;
  await f.stream.subscribe(ws, { id: 'a', replay: 'resume', cursor: { generation: 'g1', seq: 1 } });
  assert.equal(messages(ws, 'session.snapshot').length, 1);
  assert.equal(messages(ws, 'session.subscribed')[0].reason, 'buffer-gap');
});

test('rapid switching discards a stale snapshot and never overlaps replay with live output', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  f.add('a'); f.add('b');
  let releaseA;
  f.captures.set('a', () => new Promise(resolve => { releaseA = resolve; }));
  const ws = new FakeSocket();
  f.stream.register(ws);
  const pendingA = f.stream.subscribe(ws, { id: 'a', replay: 'snapshot' });
  await Promise.resolve();
  await f.stream.subscribe(ws, { id: 'b', replay: 'snapshot' });
  releaseA({ data: 'stale-a', atSeq: 0, cols: 80, rows: 24 });
  await pendingA;
  assert.equal(messages(ws, 'session.snapshot').some(item => item.id === 'a'), false);
  assert.equal(messages(ws, 'session.snapshot').filter(item => item.id === 'b').length, 1);
});

test('backpressured clients stop terminal delivery and request resynchronization after drain', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const session = f.add('a');
  const ws = new FakeSocket();
  f.stream.register(ws);
  await f.stream.subscribe(ws, { id: 'a', replay: 'snapshot' });
  ws.messages.length = 0;
  ws.bufferedAmount = BACKLOG_HIGH_WATER + 1;
  session.replayRing.append('x', session.outputSeq); session.outputSeq += 1;
  f.stream.queueOutput('a', 'x', 0, 1);
  f.stream._flush('a');
  assert.equal(messages(ws, 'output').length, 0);
  ws.bufferedAmount = 0;
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(messages(ws, 'session.resyncRequired').at(-1).reason, 'backpressure');
  assert.equal(f.stream._stateFor(ws).phase, 'awaiting-resubscribe');
});

test('failed terminal sends do not advance the client cursor', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const session = f.add('a');
  const ws = new FakeSocket();
  f.stream.register(ws);
  await f.stream.subscribe(ws, { id: 'a', replay: 'snapshot' });
  ws.failNextSend = true;
  session.replayRing.append('x', session.outputSeq); session.outputSeq += 1;
  f.stream.queueOutput('a', 'x', 0, 1);
  f.stream._flush('a');
  assert.equal(f.stream._stateFor(ws).nextSeq, 0);
});

test('a recoverable network-batch gap replays from the ring without another snapshot', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const session = f.add('a', 'abc', 'g1');
  const ws = new FakeSocket();
  f.stream.register(ws);
  await f.stream.subscribe(ws, { id: 'a', replay: 'snapshot' });
  const state = f.stream._stateFor(ws);
  state.nextSeq = 0;
  ws.messages.length = 0;

  session.replayRing.append('D', session.outputSeq);
  session.outputSeq += 1;
  f.stream.queueOutput('a', 'D', 3, 4);
  f.stream._flush('a');

  assert.deepEqual(messages(ws, 'output').map(message => [message.data, !!message.replay]), [
    ['abc', true],
    ['D', false],
  ]);
  assert.equal(messages(ws, 'session.resyncRequired').length, 0);
  assert.equal(state.nextSeq, 4);
});

test('large terminal output is emitted as UTF-8-safe bounded batches', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const session = f.add('a');
  const ws = new FakeSocket();
  f.stream.register(ws);
  await f.stream.subscribe(ws, { id: 'a', replay: 'snapshot' });
  ws.messages.length = 0; ws.rawFrames.length = 0;
  const data = `${'🙂'.repeat(9000)}${'x'.repeat(40000)}`;
  session.replayRing.append(data, session.outputSeq);
  session.outputSeq += data.length;
  f.stream.queueOutput('a', data, 0, data.length);
  f.stream._flush('a');
  const output = messages(ws, 'output');
  assert.ok(output.length >= 3);
  assert.equal(output.map(item => item.data).join(''), data);
  assert.ok(output.every(item => Buffer.byteLength(item.data) <= BATCH_MAX_BYTES));
  assert.ok(output.every(item => !item.data.startsWith('\ude00') && !item.data.endsWith('\ud83d')));
});

test('a control frame crossing high water closes with 1013', async t => {
  const f = fixture();
  t.after(() => f.stream.stop());
  const ws = new FakeSocket();
  f.stream.register(ws);
  ws.bufferedAmount = BACKLOG_HIGH_WATER - 2;
  assert.equal(f.stream.sendControl(ws, { type: 'control', value: 'large enough' }), false);
  assert.equal(ws.closeCode, 1013);
});
