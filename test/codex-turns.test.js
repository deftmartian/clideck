const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createCodexTurnReader } = require('../src/codex-turns');
const { watchCodexContext } = require('../src/context-usage');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');

const line = (type, turn_id, extra = {}) => JSON.stringify({
  type: 'event_msg', payload: { type, turn_id, ...extra },
}) + '\n';
function fixture(t, initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-codex-turns-'));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, initial);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

test('rollout reader skips history, processes burst in order, and ignores unrelated/malformed records', t => {
  const path = fixture(t, line('task_started', 'old'));
  const seen = [];
  const read = createCodexTurnReader(path, e => seen.push(e));
  read(); assert.deepEqual(seen, []);
  appendFileSync(path, 'invalid\n' + JSON.stringify({ type: 'response_item', payload: { type: 'task_started', turn_id: 'fake' } }) + '\n'
    + line('task_started', '') + line('unknown', 'fake') + line('task_complete', 'old')
    + line('task_started', 'next', { root_turn_id: 'old' }));
  read(); read();
  assert.deepEqual(seen.map(e => [e.type, e.turn_id]), [['task_complete', 'old'], ['task_started', 'next']]);
});

test('rollout reader retains split UTF-8, waits for newline, and skips pre-attach partial records', t => {
  const old = line('task_started', 'old');
  const path = fixture(t, old.slice(0, 18));
  const seen = [];
  const read = createCodexTurnReader(path, e => seen.push(e));
  appendFileSync(path, old.slice(18)); read(); assert.equal(seen.length, 0);
  const next = Buffer.from(line('task_complete', 'next', { last_agent_message: 'Done 🚀' }));
  const cut = next.indexOf(Buffer.from('🚀')) + 2;
  appendFileSync(path, next.subarray(0, cut)); read();
  appendFileSync(path, next.subarray(cut, next.length - 1)); read();
  assert.equal(seen.length, 0);
  appendFileSync(path, '\n'); read();
  assert.equal(seen[0].last_agent_message, 'Done 🚀');
});

test('rollout reader bounds huge records and still reaches following lifecycle events', t => {
  const path = fixture(t);
  const seen = [];
  const read = createCodexTurnReader(path, e => seen.push(e));
  appendFileSync(path, line('task_started', 'first')
    + JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024 * 1024) } }) + '\n'
    + line('task_complete', 'first') + line('task_started', 'second'));
  let reads = 1;
  while (read()) { assert.ok(++reads < 10); }
  assert.ok(reads > 1);
  assert.deepEqual(seen.map(e => e.turn_id), ['first', 'first', 'second']);
});

test('truncation and replacement reset at EOF without replaying or joining unrelated fragments', t => {
  const path = fixture(t);
  const seen = []; let resets = 0;
  const read = createCodexTurnReader(path, e => seen.push(e.turn_id), () => resets++);
  appendFileSync(path, line('task_started', 'first') + 'x'.repeat(500)); read();
  writeFileSync(path, line('task_started', 'historical')); read();
  appendFileSync(path, line('task_started', 'second')); read();
  writeFileSync(path + '.new', line('task_started', 'historical-again'));
  renameSync(path + '.new', path); read();
  appendFileSync(path, line('task_started', 'third')); read();
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.equal(resets, 2);
});

test('watcher preserves initial usage, drains bursts, polls missed changes, and stops pending work', async t => {
  const path = fixture(t, line('token_count', undefined, { info: {
    last_token_usage: { total_tokens: 20000 }, model_context_window: 100000,
  } }));
  const events = [], usage = []; let notify, closed = false;
  const stop = watchCodexContext(path, e => usage.push(e.usedTokens), {
    onTurn: e => events.push(e.turn_id), debounceMs: 1, pollMs: 10,
    watch: (_p, _o, fn) => { notify = fn; return { on() {}, close() { closed = true; } }; },
  });
  t.after(stop);
  assert.deepEqual(usage, [20000]);
  appendFileSync(path, 'x'.repeat(600000) + '\n' + line('task_started', 'polled'));
  // No fs.watch signal: polling must recover and drain more than one chunk.
  for (let i = 0; i < 100 && !events.length; i++) await tick();
  assert.deepEqual(events, ['polled']);
  appendFileSync(path, line('task_started', 'after-stop'));
  notify(); stop(); await tick(25);
  assert.deepEqual(events, ['polled']); assert.equal(closed, true);
});

test('goal continuation without a prompt hook becomes working; completions/finals dedup in either order', () => {
  for (const hookFirst of [false, true]) {
    const session = new AgentSession({ provider: getProvider('codex') });
    const events = []; session.on('event', e => events.push(e));
    session.handleHook('start', { turn_id: 'first', prompt: 'Research' });
    const done = { turn_id: 'first', last_assistant_message: 'First result' };
    if (hookFirst) session.handleHook('stop', done);
    session.handleCodexTurn({ type: 'task_complete', turn_id: 'first', last_agent_message: 'First result' });
    session.handleCodexTurn({ type: 'task_started', turn_id: 'next', root_turn_id: 'first' });
    session.lastUpdate = 'keep this';
    session.handleCodexTurn({ type: 'task_started', turn_id: 'next' });
    assert.equal(session.lastUpdate, 'keep this');
    session.handleHook('stop', done); // old hook cannot end the continuation
    session.handleHook('stop', { last_assistant_message: 'untagged old hook' });
    session.handleCodexTurn({ type: 'task_complete', turn_id: 'unrelated', last_agent_message: 'wrong' });
    assert.equal(session.status, 'working');
    assert.equal(session.turnOpen, true);
    session.handleCodexTurn({ type: 'task_complete', turn_id: 'next', last_agent_message: 'Next result' });
    session.handleHook('stop', { turn_id: 'next', last_assistant_message: 'Next result' });
    assert.equal(session.status, 'idle');
    assert.deepEqual(events.filter(e => e.type === 'agent.final').map(e => e.text), ['First result', 'Next result']);
    assert.deepEqual(events.filter(e => e.type === 'turn.user').map(e => e.text), ['Research']);
    assert.equal(session.resumeTranscriptPath, '');
  }
});

test('aborts announce no stale final; unknown and untagged rollout events do nothing', () => {
  const session = new AgentSession({ provider: getProvider('codex') });
  const events = []; session.on('event', e => events.push(e));
  session.handleCodexTurn({ type: 'task_started', turn_id: 'active' });
  session.pendingFinalText = 'old result';
  session.handleCodexTurn({ type: 'turn_aborted', turn_id: 'other' });
  session.handleCodexTurn({ type: 'task_complete' });
  session.handleCodexTurn({ type: 'unknown', turn_id: 'active' });
  assert.equal(session.status, 'working');
  session.handleCodexTurn({ type: 'turn_aborted', turn_id: 'active' });
  assert.equal(session.status, 'idle');
  assert.equal(events.some(e => e.type === 'agent.final'), false);
  const claude = new AgentSession({ provider: getProvider('claude-code') });
  claude.handleCodexTurn({ type: 'task_started', turn_id: 'not-codex' });
  assert.equal(claude.status, null);
});

test('path changes, native clear and teardown release observer ownership and ignore late callbacks', () => {
  const monitors = new Map();
  const session = new AgentSession({ provider: { ...getProvider('codex'),
    watchContextUsage(path, _usage, options) { monitors.set(path, options); return () => {}; },
  } });
  session.recordResumeMetadata({ transcriptPath: '/old' });
  monitors.get('/old').onTurn({ type: 'task_started', turn_id: 'first' });
  assert.equal(session.observedCodexTurn, 'first');
  session.recordResumeMetadata({ transcriptPath: '/new' });
  assert.equal(session.observedCodexTurn, '');
  monitors.get('/old').onTurn({ type: 'task_started', turn_id: 'late' });
  assert.notEqual(session.activeHookTurn, 'late');
  monitors.get('/new').onTurn({ type: 'task_started', turn_id: 'second' });
  monitors.get('/new').onReset();
  assert.equal(session.observedCodexTurn, '');
  session.handleHook('stop', { last_assistant_message: 'Hook fallback' });
  assert.equal(session.status, 'idle');
  monitors.get('/new').onTurn({ type: 'task_started', turn_id: 'third' });
  session.handleHook('session-start', { source: 'clear' });
  assert.equal(session.observedCodexTurn, '');
  assert.equal(session.status, 'idle');
  monitors.get('/new').onTurn({ type: 'task_started', turn_id: 'late-again' });
  assert.equal(session.status, 'idle');
  session.recordResumeMetadata({ transcriptPath: '/final' });
  monitors.get('/final').onTurn({ type: 'task_started', turn_id: 'fourth' });
  session.handleExit(0, null);
  assert.equal(session.observedCodexTurn, '');
  monitors.get('/final').onTurn({ type: 'task_started', turn_id: 'after-exit' });
  assert.notEqual(session.activeHookTurn, 'after-exit');
});

test('real transcript appends update session status and ask availability without a native process', async t => {
  const { availableAskSession } = require('../src/ask');
  const path = fixture(t, line('task_started', 'historical'));
  const session = new AgentSession({ provider: getProvider('codex') });
  t.after(() => session.stopContextMonitor());
  session.handleHook('session-start', { source: 'resume' });
  session.recordResumeMetadata({ transcriptPath: path });
  const events = []; session.on('event', e => events.push(e));
  const entry = { id: session.id, provider: 'codex' };
  const sessions = new Map([[session.id, session]]);
  const coordinator = { isActive: () => false };
  assert.equal(availableAskSession(entry, sessions, coordinator).session, session);
  session.handleHook('start', { turn_id: 'first', prompt: 'Investigate' });
  appendFileSync(path, line('task_complete', 'first', { last_agent_message: 'First result' })
    + line('task_started', 'continuation', { root_turn_id: 'first' }));
  for (let i = 0; i < 200 && session.activeHookTurn !== 'continuation'; i++) await tick();
  assert.equal(session.activeHookTurn, 'continuation');
  assert.equal(session.status, 'working');
  assert.equal(availableAskSession(entry, sessions, coordinator).error, 'busy');
  session.handleHook('stop', { turn_id: 'first', last_assistant_message: 'First result' });
  assert.equal(session.status, 'working');
  appendFileSync(path, line('task_complete', 'continuation', { last_agent_message: 'Final result' }));
  for (let i = 0; i < 200 && session.status !== 'idle'; i++) await tick();
  assert.equal(session.status, 'idle');
  assert.equal(availableAskSession(entry, sessions, coordinator).session, session);
  assert.deepEqual(events.filter(e => e.type === 'agent.final').map(e => e.text), ['First result', 'Final result']);
  assert.deepEqual(events.filter(e => e.type === 'turn.user').map(e => e.text), ['Investigate']);
});
