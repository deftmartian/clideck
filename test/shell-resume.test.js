const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('fs');
const { homedir, tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');

function shellEntry(id, cwd, fields = {}) {
  return { id, provider: { id: 'shell' }, cwd, cols: 80, rows: 24, ...fields };
}

test('shells running at shutdown restart in their last folder with the old output above a marker', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-shell-resume-'));
  const created = join(dataDir, 'created');
  const moved = join(dataDir, 'moved');
  mkdirSync(created); mkdirSync(moved);
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();

  server.persistence.register(shellEntry('was-running', created));
  server.persistence.update('was-running', { shellCwd: moved, resumeOnStart: true });
  server.persistence.appendHistory('was-running', 'output from before the reboot\r\n');
  server.persistence.register(shellEntry('user-exited', created));

  assert.deepEqual(server.resumeShellsOnStart(), ['was-running']);
  const session = server.sessions.get('was-running');
  assert.equal(session.cwd, moved);
  const replay = session.replayRing.slice(0);
  assert.match(replay, /output from before the reboot[\s\S]*shell restarted/);
  assert.match(server.persistence.historyTail('was-running'), /output from before the reboot[\s\S]*shell restarted/);
  assert.equal(server.sessions.has('user-exited'), false);
});

test('shell resume falls back to home when its folders are gone, and reports spawn failures', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-shell-fallback-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  const errors = [];
  server.broadcastSessionError = (id, error) => errors.push({ id, error });
  const started = [];
  server.startSession = (options) => { started.push(options); return { id: options.id }; };

  server.persistence.register(shellEntry('gone', join(dataDir, 'missing')));
  server.persistence.update('gone', { shellCwd: join(dataDir, 'also-missing') });
  server.resumeSession('gone');
  assert.equal(started[0].cwd, homedir());
  assert.equal(started[0].seedHistory, true);

  server.startSession = () => { throw new Error('spawn failed'); };
  assert.equal(server.resumeSession('gone'), null);
  assert.equal(errors[0].error.code, 'resume_failed');
  assert.match(errors[0].error.message, /spawn failed/);
});

test('the resume seed leaves the alternate screen only when the old output ended inside it', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-shell-seed-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  const seeds = [];
  server.forkTransport.output = (session, data) => seeds.push(data);
  server.persistence.register(shellEntry('plain', dataDir));
  server.persistence.appendHistory('plain', 'ls\r\n\x1b[?1049hvim\x1b[?1049l$ ');
  server.persistence.register(shellEntry('in-vim', dataDir));
  server.persistence.appendHistory('in-vim', '$ vim\r\n\x1b[?1049h~\r\n~');
  server.seedShellHistory({ id: 'plain', cwd: dataDir });
  server.seedShellHistory({ id: 'in-vim', cwd: dataDir });
  const tail = seed => seed.slice(seed.lastIndexOf('$'));
  assert.equal(tail(seeds[0]).includes('\x1b[?1049l'), false);
  assert.match(seeds[1], /\x1b\[\?1049h~\r\n~\x1b\[\?1049l/);
});
