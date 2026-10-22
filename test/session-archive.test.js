const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { SessionArchive, nativeProfile, MAX_QUEUE_BYTES } = require('../src/session-archive');
const { ArchiveSource, LINE_BYTES } = require('../src/archive-source');
const { isValidConfigPatch } = require('../src/config-store');

async function files(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
async function records(root) {
  const result = [];
  for (const path of (await files(root)).filter(path => path.endsWith('.jsonl'))) {
    for (const line of (await fs.readFile(path, 'utf8')).trim().split('\n')) result.push({ ...JSON.parse(line), file: path });
  }
  return result;
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'clideck-archive-'));
  const directory = join(root, 'archive');
  const home = join(root, 'profile');
  await fs.mkdir(home);
  let now = '2026-10-13T05:00:00.000Z';
  const statuses = [];
  const archive = new SessionArchive({ dataDir: root, now: () => now, pollMs: 60_000,
    onStatus: status => statuses.push(status) });
  const session = {};
  const info = { sessionId: 'session-id', name: 'Session', projectId: 'project-id', projectName: 'Project',
    provider: 'codex', profileRoot: home, nativeId: '', transcriptPath: '' };
  t.after(async () => { await archive.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, home, archive, session, info, statuses, setTime: value => { now = value; },
    enable: async () => { archive.configure({ enabled: true, directory }); await archive.flush(); },
    start: async () => { archive.start(session, info); await archive.flush(); },
    read: () => records(directory),
    poll: async () => { archive.poll(); await archive.flush(); } };
}

test('archive validates explicit opt-in and absolute directory; disabled performs no writes', async t => {
  const f = await fixture(t);
  for (const archive of [{ enabled: true, directory: '' }, { enabled: true, directory: '../x' },
    { enabled: 1, directory: '/tmp' }, { enabled: false, directory: '/tmp\0' }]) {
    assert.equal(isValidConfigPatch({ archive }), false);
  }
  assert.equal(isValidConfigPatch({ archive: { enabled: false, directory: '' } }), true);
  assert.equal(isValidConfigPatch({ archive: { enabled: true, directory: f.directory } }), true);
  await f.start(); f.archive.event(f.session, { type: 'turn.user', text: 'not recorded' });
  await f.archive.flush();
  assert.deepEqual(await files(f.directory), []);
  assert.equal(f.archive.snapshot().state, 'off');
});

test('lifecycle archives exact text, does not record draft bytes or terminal repaints', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  f.archive.event(f.session, { type: 'turn.user', text: '  hello\nworld  ' });
  f.archive.event(f.session, { type: 'output', data: 'screen not a message' });
  f.archive.event(f.session, { type: 'agent.update', text: 'intermediate' });
  f.archive.event(f.session, { type: 'agent.final', text: 'final' });
  await f.archive.flush();
  const rows = await f.read();
  assert.deepEqual(rows.filter(r => r.type === 'clideck.event').map(r => r.data.text), ['  hello\nworld  ', 'intermediate', 'final']);
  assert.equal(rows.find(r => r.type === 'run.started').data.coverage.historicalImport, false);
  assert.equal((await fs.stat(rows[0].file)).mode & 0o777, 0o600);
});

test('native records retain tools, results, thinking and compaction; initial discovery excludes history', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  const path = join(f.home, 'native.jsonl');
  const old = JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'message', text: 'old history' });
  const tool = JSON.stringify({ timestamp: '2026-10-13T05:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{"cmd":"pwd"}' } });
  await fs.writeFile(path, `${old}\n${tool}\n`);
  f.archive.hook(f.session, 'start', { turn_id: 'turn-1', prompt: 'go' }, { handle: 'native-1', transcriptPath: path });
  await f.archive.flush(); await f.poll();
  const intermediate = [
    { type: 'response_item', payload: { type: 'reasoning', summary: ['available summary'], encrypted_content: 'opaque' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'result' } },
    { type: 'compacted', text: 'summary' },
  ];
  await fs.appendFile(path, intermediate.map(JSON.stringify).join('\n') + '\n'); await f.poll();
  const rows = await f.read();
  assert.deepEqual(rows.filter(r => r.type === 'native.record').map(r => r.data.raw), [tool, ...intermediate.map(JSON.stringify)]);
  assert.equal(rows.filter(r => r.type === 'run.started').length, 1);
  assert.equal(rows.find(r => r.type === 'source.history-skipped').data.records, 1);
});

test('enable mid-session and resume baseline at EOF, preserving split UTF-8 only after attachment', async t => {
  const f = await fixture(t);
  const path = join(f.home, 'native.jsonl');
  await fs.writeFile(path, '{"type":"old"}\n{"partial":');
  f.info.transcriptPath = path; f.info.nativeId = 'resumed';
  f.archive.configure({ enabled: true, directory: f.directory }, [{ session: f.session, info: f.info }]);
  await f.archive.flush();
  await fs.appendFile(path, '"old tail"}\n'); await f.poll();
  const line = Buffer.from('{"type":"thinking","text":"שלום 🚀"}\n');
  const split = line.indexOf(Buffer.from('🚀')) + 1;
  await fs.appendFile(path, line.subarray(0, split)); await f.poll();
  assert.equal((await f.read()).filter(r => r.type === 'native.record').length, 0);
  await fs.appendFile(path, line.subarray(split)); await f.poll();
  assert.equal((await f.read()).find(r => r.type === 'native.record').data.raw, line.toString().trimEnd());
});

test('oversized native records are losslessly fragmented instead of truncated', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  const path = join(f.home, 'native.jsonl'); await fs.writeFile(path, '');
  f.archive.hook(f.session, 'start', {}, { transcriptPath: path }); await f.archive.flush();
  // Include timestamp for discovery and a >1MiB tool result. Later records need no timestamp.
  const raw = JSON.stringify({ timestamp: '2026-10-13T05:00:01Z', type: 'tool_result', data: '🚀'.repeat(LINE_BYTES) });
  await fs.appendFile(path, `${raw}\n`);
  for (let i = 0; i < 20; i++) await f.poll();
  const fragments = (await f.read()).filter(r => r.type === 'native.fragment');
  assert(fragments.length > 1);
  assert.equal(fragments.at(-1).data.final, true);
  assert.equal(fragments.at(-1).data.totalFragments, fragments.length);
  assert.equal(fragments.at(-1).data.byteLength, Buffer.byteLength(raw));
  assert.equal(fragments.at(-1).data.sha256, require('node:crypto').createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(fragments.map(r => r.data.index), fragments.map((_, i) => i));
  assert.equal(Buffer.concat(fragments.map(r => Buffer.from(r.data.bytes, 'base64'))).toString(), raw);
  assert.equal(new Set(fragments.map(r => r.data.source.byteOffset)).size, 1);
});

test('profile boundaries reject outside files and symlink escape; actual custom env determines roots', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  const outside = join(f.root, 'secret.jsonl'); await fs.writeFile(outside, '{"secret":true}\n');
  const path = join(f.home, 'escape.jsonl'); await fs.symlink(outside, path);
  f.archive.hook(f.session, 'start', {}, { transcriptPath: path }); await f.archive.flush(); await f.poll();
  const rows = await f.read();
  assert(rows.some(r => r.type === 'source.unavailable'));
  assert(!rows.some(r => r.type === 'native.record'));
  assert.equal(nativeProfile('codex', { HOME: f.root, CODEX_HOME: f.home }, '/'), f.home);
  assert.equal(nativeProfile('claude-code', { HOME: f.root, CLAUDE_CONFIG_DIR: 'custom' }, f.root), join(f.root, 'custom'));
  assert.equal(nativeProfile('shell', { HOME: f.root }, '/'), '');
});

test('process restart and clear create linked runs; compaction without identity change does not', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  f.archive.hook(f.session, 'session-start', { source: 'compact' }, { handle: 'a' });
  f.archive.hook(f.session, 'session-start', { source: 'clear' }, { handle: 'b' });
  f.archive.event(f.session, { type: 'session.closed', restarting: true });
  await f.archive.flush();
  f.info.nativeId = 'b'; f.info.name = 'Renamed'; f.info.projectName = 'Renamed project';
  await f.start();
  const starts = (await f.read()).filter(r => r.type === 'run.started').sort((a,b) => a.sequence - b.sequence);
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map(r => dirname(dirname(r.file)))).size, 1);
  assert.equal(starts.filter(r => r.data.previousRunId).length, 2);
  assert.deepEqual(new Set(starts.filter(r => r.data.previousRunId).map(r => r.data.previousRunId)), new Set(starts.map(r => r.runId).filter(id => starts.some(r => r.data.previousRunId === id))));
});

test('midnight segments keep run identity and handle queued older timestamps without overwriting', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  f.setTime('2026-10-14T05:00:00Z'); f.archive.event(f.session, { type: 'turn.user', text: 'tomorrow' });
  await f.archive.flush();
  f.setTime('2026-10-13T05:00:10Z'); f.archive.event(f.session, { type: 'agent.final', text: 'late old event' });
  await f.archive.flush();
  const rows = await f.read();
  assert.equal(new Set(rows.map(r => r.file)).size, 2);
  assert.equal(new Set(rows.map(r => r.runId)).size, 1);
  assert.equal(rows.filter(r => r.type === 'segment.started').length, 2);
  assert.equal(rows.filter(r => r.type === 'clideck.event').length, 2);
  assert.equal(f.archive.snapshot().state, 'recording');
});

test('assets copied independently, hashed and retained after original deletion', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  const path = join(f.root, 'upload.png'); const bytes = Buffer.from([0, 1, 2, 255]); await fs.writeFile(path, bytes);
  f.archive.asset(f.session, { path, name: 'upload.png', origin: 'upload' });
  await f.archive.flush(); await fs.unlink(path);
  const saved = (await f.read()).find(r => r.type === 'asset.saved');
  assert(saved.data.sha256.length === 64);
  assert.deepEqual(await fs.readFile(join(dirname(saved.file), saved.data.path)), bytes);
  f.archive.event(f.session, { type: 'session.closed' }); await f.archive.flush();
  assert((await f.read()).some(r => r.type === 'run.ended'));
});

test('disable stops recording and changing destination starts a new archive', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  f.archive.configure({ enabled: false, directory: f.directory }); await f.archive.flush();
  f.archive.event(f.session, { type: 'turn.user', text: 'off' }); await f.archive.flush();
  assert(!(await f.read()).some(r => r.data.text === 'off'));
  const next = join(f.root, 'next');
  f.archive.configure({ enabled: true, directory: next }, [{ session: f.session, info: f.info }]);
  await f.archive.flush();
  assert((await records(next)).some(r => r.type === 'run.started'));
  assert((await f.read()).some(r => r.type === 'run.ended'));
});

test('write failure and queue overflow are visible, nonthrowing, and leave source files alone', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  const row = (await f.read())[0]; await fs.unlink(row.file); await fs.mkdir(row.file);
  f.archive.event(f.session, { type: 'turn.user', text: 'cannot append to directory' }); await f.archive.flush();
  assert.equal(f.archive.snapshot().state, 'error');
  assert.match(f.archive.snapshot().error, /Agents keep running/);
  assert.equal(f.statuses.filter(s => s.state === 'error').length, 1);
  // Retry resets error, and a bounded backlog cannot grow without limit.
  f.archive.configure({ enabled: false, directory: f.directory }); await f.archive.flush();
  f.archive.configure({ enabled: true, directory: f.directory }); await f.archive.flush();
  f.archive.enqueue(async () => {}, MAX_QUEUE_BYTES + 1);
  assert.equal(f.archive.snapshot().state, 'error');
});

test('missing source can appear later; reset is explicit; malformed appended data is preserved', async t => {
  const f = await fixture(t); const path = join(f.home, 'late.jsonl'); const got = [];
  const source = new ArchiveSource({ path, root: f.home, since: '2026-10-13T05:00:00Z', emit: async (type, data) => got.push({ type, data }) });
  await source.attach(); assert.equal(got[0].type, 'source.unavailable');
  await fs.writeFile(path, '{"timestamp":"2026-10-13T05:00:01Z","type":"first"}\n'); await source.read();
  await fs.appendFile(path, 'bad-json\n'); await source.read();
  assert.equal(got.find(r => r.data.malformed).data.raw, 'bad-json');
  await fs.writeFile(path, ''); await source.read();
  assert(got.some(r => r.type === 'source.reset'));
  // No historical bytes exist after truncation: an undated appended record is
  // new data and must not accidentally be treated as unknown old history.
  await fs.appendFile(path, '{"type":"tool_result","output":"new"}\n'); await source.read();
  assert(got.some(r => r.type === 'native.record' && r.data.raw.includes('tool_result')));
});

test('identity index survives engine restart and renames', async t => {
  const f = await fixture(t); await f.enable(); await f.start(); await f.archive.close();
  const before = (await f.read()).find(r => r.type === 'run.started');
  const second = new SessionArchive({ dataDir: f.root, pollMs: 60_000 });
  t.after(() => second.close());
  second.configure({ enabled: true, directory: f.directory }); await second.flush();
  second.start({}, { ...f.info, name: 'Completely new label', projectName: 'Also renamed' }); await second.flush();
  const after = (await f.read()).filter(r => r.type === 'run.started').find(r => r.runId !== before.runId);
  assert.equal(dirname(dirname(after.file)), dirname(dirname(before.file)));
  assert.equal(after.data.previousRunId, before.runId);
  await second.close();
});

test('server captures hooks/events/uploads through a fake native process; reconnect and deletion preserve archive', async t => {
  const { HeadlessServer } = require('../src/server');
  const { getProvider } = require('../src/providers');
  const root = await fs.mkdtemp(join(tmpdir(), 'clideck-archive-server-'));
  const profile = join(root, 'profile'); await fs.mkdir(profile);
  const directory = join(root, 'archive');
  const server = new HeadlessServer({ dataDir: join(root, 'data'), cwd: root, port: 0, autoSaveMs: 0 });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const address = await server.listen();
  server.updateConfig({ archive: { enabled: true, directory } }); await server.archive.flush();
  const session = server.startSession({ name: 'Fixture only', cwd: root, port: server.port,
    provider: { ...getProvider('codex'), closeInput: '\x04', closeSubmit: undefined,
      createLaunch: () => ({ command: process.execPath,
        args: ['-e', 'process.stdin.setRawMode(true);process.stdin.on("data",d=>{if(d.includes(4))process.exit(0)});process.stdin.resume()'],
        env: { HOME: root, CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile } }) } }, true);
  await server.archive.flush();
  const path = join(profile, 'fixture.jsonl'); await fs.writeFile(path, '');
  const hook = async (route, payload, token = session.hookToken) => {
    const response = await fetch(`${address.httpUrl}/hooks/${session.id}/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clideck-Launch': token }, body: JSON.stringify(payload) });
    assert.equal(response.status, 204);
  };
  await hook('start', { prompt: 'native user', session_id: 'n1', turn_id: 't1', transcript_path: path });
  await hook('menu', { tool_name: 'exec', tool_input: { cmd: 'pwd' } });
  await hook('start', { prompt: 'wrong old launch' }, 'old-token');
  await fs.appendFile(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'tool-1', output: 'tool output' } }) + '\n');
  await server.archive.flush(); server.archive.poll(); await server.archive.flush();
  // Bracketed-paste mode changes re-emit session.created snapshots, not spawns.
  session.handleOutput('\x1b[?2004h'); session.handleOutput('\x1b[?2004l');
  session.flushPending();
  await server.archive.flush();
  const sockets = [];
  for (let i = 0; i < 2; i++) {
    const events = [];
    const socket = { readyState: 1, send: raw => events.push(JSON.parse(raw)), on() {}, close() {} };
    sockets.push(socket); server.handleConnection(socket);
    assert(events.some(e => e.type === 'archive.status' && e.state === 'recording'));
  }
  const upload = await fetch(`${address.httpUrl}/upload?sessionId=${session.id}&name=fixture.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'uploaded content' });
  // The same publishContent path is used by file and payload previews.
  const content = server.contentStore.addPayload(session.id, 'artifact', 'text', 'artifact.txt');
  server.publishContent(session.id, content);
  await hook('stop', { turn_id: 't1', last_assistant_message: 'finished' });
  session.removePersistenceOnClose = true;
  session.close(); await session.waitForClose(); await server.archive.flush();
  for (const socket of sockets) server.clients.delete(socket);
  const rows = await records(directory);
  assert.equal(rows.filter(r => r.type === 'run.started').length, 1);
  assert(rows.some(r => r.type === 'native.hook' && r.data.payload.tool_name === 'exec'));
  assert(rows.some(r => r.type === 'native.record' && r.data.raw.includes('tool output')));
  assert(rows.some(r => r.type === 'clideck.event' && r.data.type === 'turn.user' && r.data.text === 'native user'));
  assert(!rows.some(r => JSON.stringify(r).includes('wrong old launch')));
  assert(rows.some(r => r.type === 'asset.saved' && r.data.origin === 'content.show'));
  assert(rows.some(r => r.type === 'run.ended'));
  assert.equal(server.persistence.get(session.id), null);
  assert.equal(upload.status, 200);
  assert(rows.some(r => r.type === 'asset.saved' && r.data.origin === 'upload'));
});

test('unavailable asset warns without stopping conversation recording for any session', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  f.archive.asset(f.session, { path: join(f.root, 'missing.png'), name: 'missing.png', origin: 'content.show' });
  f.archive.event(f.session, { type: 'turn.user', text: 'still recording' });
  await f.archive.flush();
  const rows = await f.read();
  assert(rows.some(r => r.type === 'asset.unavailable'));
  assert(rows.some(r => r.data.text === 'still recording'));
  assert.equal(f.archive.snapshot().state, 'recording');
  assert.match(f.archive.snapshot().warning, /continues/);
});
