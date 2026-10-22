const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, appendFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { TranscriptStore } = require('../src/transcript-store');
const { hasValidControlFields } = require('../src/control');
const { HeadlessServer } = require('../src/server');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-search-'));
  const store = new TranscriptStore({ dataDir: directory, cacheLimit: 100 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store };
}

test('search finds old saved turns outside the sidebar cache and the newest page', async t => {
  const { store } = fixture(t);
  store.append('session', 'user', 'Ancient NEEDLE');
  for (let i = 0; i < 100; i++) store.append('session', 'agent', 'Unrelated reply '.repeat(100));
  assert(!store.getCache().session.includes('NEEDLE'));
  assert(!store.getPage('session').turns.some(turn => turn.text.includes('NEEDLE')));
  const page = await store.searchPage('session', 'needle');
  assert.deepEqual(page.turns.map(turn => turn.text), ['Ancient NEEDLE']);
  assert.equal(page.hasMore, false);
});

test('matching pages remain chronological with no missing repeated messages or new appends', async t => {
  const { store } = fixture(t);
  for (let i = 1; i <= 83; i++) store.append('session', i % 2 ? 'user' : 'agent', `repeated match ${' '.repeat(3000)}`, i);
  const first = await store.searchPage('session', 'match', undefined, 7);
  assert.deepEqual(first.turns.map(turn => turn.ts), [77, 78, 79, 80, 81, 82, 83]);
  store.append('session', 'agent', 'match new', 84);
  const seen = [...first.turns];
  let page = first;
  while (page.hasMore) {
    page = await store.searchPage('session', 'match', page.cursor, 7);
    seen.unshift(...page.turns);
  }
  assert.deepEqual(seen.map(turn => turn.ts), Array.from({ length: 83 }, (_, i) => i + 1));
});

test('search is literal and case-insensitive, preserving multiline Unicode and HTML-like text', async t => {
  const { store } = fixture(t);
  const text = 'X'.repeat(65000) + '\nשלום 🚀 [A.*B] <img src=x onerror=oops>\n' + 'Z'.repeat(2000);
  store.append('session', 'agent', text);
  assert.deepEqual((await store.searchPage('session', '[a.*b]')).turns.map(turn => turn.text), [text]);
  assert.equal((await store.searchPage('session', 'שלום 🚀')).turns.length, 1);
  assert.equal((await store.searchPage('session', 'a.*z')).turns.length, 0);
  assert.equal((await store.searchPage('session', '<img src=x')).turns.length, 1);
  store.append('session', 'user', 'Unicode \u212A temperature');
  assert.equal((await store.searchPage('session', 'unicode k')).turns.length, 1);
});

test('only complete canonical records count; malformed, foreign role and trailing partial are ignored', async t => {
  const { store } = fixture(t);
  writeFileSync(store.path('session'), [
    '{broken}', JSON.stringify({ role: 'tool', text: 'match wrong role' }),
    JSON.stringify({ role: 'user', text: 'match correct', ts: 1 }),
    '{"role":"agent","text":"match incomplete"}',
  ].join('\n'));
  let page = await store.searchPage('session', 'match');
  assert.deepEqual(page.turns.map(turn => turn.text), ['match correct']);
  appendFileSync(store.path('session'), '\n');
  page = await store.searchPage('session', 'match');
  assert.deepEqual(page.turns.map(turn => turn.text), ['match correct', 'match incomplete']);
});

test('empty, absent and unsafe session IDs do not read other files', async t => {
  const { store } = fixture(t);
  for (const [id, query, before] of [['missing', 'hello'], ['../outside', 'hello'], ['session', ' '], ['session', 'hello', 0]]) {
    assert.deepEqual(await store.searchPage(id, query, before), { turns: [], cursor: null, hasMore: false });
  }
});

test('page payload bound returns a cursor instead of dropping matching records', async t => {
  const { store } = fixture(t);
  for (let i = 1; i <= 5; i++) store.append('session', 'agent', 'needle ' + 'x'.repeat(1024 * 1024), i);
  const first = await store.searchPage('session', 'needle');
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.turns.map(turn => turn.ts), [3, 4, 5]);
  const second = await store.searchPage('session', 'needle', first.cursor);
  assert.deepEqual(second.turns.map(turn => turn.ts), [1, 2]);
  assert.equal(second.hasMore, false);
});

test('oversize match fails explicitly and aborted scans reject without a partial success', async t => {
  const { store } = fixture(t);
  store.append('session', 'agent', 'match ' + 'x'.repeat(4 * 1024 * 1024));
  await assert.rejects(store.searchPage('session', 'match'), /too large/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.searchPage('session', 'match', undefined, 30, controller.signal), { name: 'AbortError' });
});

test('query and request identity validation is bounded and preserves legacy paging', () => {
  const base = { type: 'transcript.page', sessionId: 'session' };
  assert(hasValidControlFields(base));
  assert(hasValidControlFields({ ...base, query: '', requestId: 'view-1' }));
  assert(hasValidControlFields({ ...base, query: 'abc', before: 0, limit: 1 }));
  for (const extra of [{ query: 7 }, { query: 'x'.repeat(257) }, { query: '\0' },
    { requestId: '' }, { requestId: 'x'.repeat(101) }, { before: -1 }]) {
    assert.equal(hasValidControlFields({ ...base, ...extra }), false);
  }
});

function socket() {
  const value = new EventEmitter(); value.messages = []; value.readyState = 1;
  value.send = raw => value.messages.push(JSON.parse(raw)); value.close = () => value.emit('close');
  return value;
}
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    const value = fn(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Search reply timed out in test.');
}

test('server search replies only to requester and echoes query/request tokens on success and error', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-search-server-'));
  const server = new HeadlessServer({ dataDir: directory, port: 0, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  await server.listen();
  server.persistence.register({ id: 'saved', provider: { id: 'test-agent' }, name: 'Saved', cwd: directory });
  server.transcriptStore.append('saved', 'user', 'old find-me');
  const requester = socket(), peer = socket();
  server.handleConnection(requester); server.handleConnection(peer);
  requester.messages = []; peer.messages = [];
  const request = { type: 'transcript.page', sessionId: 'saved', query: 'find-me', requestId: 'query-1' };
  server.handleControl(requester, Buffer.from(JSON.stringify(request)));
  const result = await waitFor(() => requester.messages.find(m => m.requestId === 'query-1'));
  assert.equal(result.query, 'find-me'); assert.equal(result.success, true);
  assert.equal(result.turns[0].text, 'old find-me'); assert.deepEqual(peer.messages, []);
  server.handleControl(requester, Buffer.from(JSON.stringify({ ...request, sessionId: 'absent', requestId: 'query-2' })));
  assert.equal(requester.messages.at(-1).success, false);
  assert.equal(requester.messages.at(-1).requestId, 'query-2');
  server.transcriptStore.searchPage = async () => { throw new Error('fixture read failure'); };
  server.handleControl(requester, Buffer.from(JSON.stringify({ ...request, requestId: 'query-3' })));
  assert.equal((await waitFor(() => requester.messages.find(m => m.requestId === 'query-3'))).error, 'fixture read failure');
});

test('new requests and socket closure cancel scans and suppress stale search replies', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-search-cancel-'));
  const server = new HeadlessServer({ dataDir: directory, port: 0, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  await server.listen();
  server.persistence.register({ id: 'saved', provider: { id: 'test-agent' }, name: 'Saved', cwd: directory });
  const requester = socket(); server.handleConnection(requester); requester.messages = [];
  const pending = [];
  server.transcriptStore.searchPage = (id, query, before, limit, signal) => new Promise(resolve => pending.push({ resolve, signal }));
  const send = (query, requestId) => server.handleControl(requester,
    Buffer.from(JSON.stringify({ type: 'transcript.page', sessionId: 'saved', query, requestId })));
  send('first', 'first'); send('', 'cleared');
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ turns: [{ text: 'stale' }], cursor: null, hasMore: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requester.messages.map(m => m.requestId), ['cleared']);
  send('second', 'second'); requester.close();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve({ turns: [], cursor: null, hasMore: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requester.messages.some(m => m.requestId === 'second'), false);
});
