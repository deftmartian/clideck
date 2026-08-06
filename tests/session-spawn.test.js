const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { spawnForCaller, randomSessionName, slugify, waitForReady } = require('../session-spawn');

test('randomSessionName avoids taken names and falls back to numbered suffix', () => {
  const name = randomSessionName(() => false);
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);

  const taken = new Set();
  const first = randomSessionName(n => taken.has(n.toLowerCase()));
  taken.add(first.toLowerCase());
  const second = randomSessionName(n => taken.has(n.toLowerCase()));
  assert.notEqual(second.toLowerCase(), first.toLowerCase());

  // All base names taken: must still terminate with a numbered variant.
  const numbered = randomSessionName(n => !/ \d+$/.test(n));
  assert.match(numbered, / 2$/);
});

test('slugify produces safe worktree directory names', () => {
  assert.equal(slugify('Worker 1'), 'worker-1');
  assert.equal(slugify('  Rusty Panda!  '), 'rusty-panda');
  assert.equal(slugify(''), 'session');
  assert.equal(slugify('x'.repeat(80)).length, 40);
});

function fakeSessionsApi(overrides = {}) {
  const sessions = new Map(overrides.sessions || []);
  const listeners = [];
  return {
    getSessions: () => sessions,
    addBroadcastListener: (fn) => { listeners.push(fn); return () => {}; },
    emit: (msg) => listeners.forEach(fn => fn(msg)),
    createProgrammatic: overrides.createProgrammatic || ((opts) => {
      const id = 'new-session-id';
      sessions.set(id, { ...opts, name: opts.name });
      return { id };
    }),
    input: () => {},
  };
}

const CFG = {
  defaultPath: '/tmp',
  projects: [
    { id: 'proj-1', name: 'Alpha', path: '/tmp/alpha' },
    { id: 'proj-2', name: 'Beta' },
  ],
  commands: [
    { id: 'cmd-claude', presetId: 'claude-code', label: 'Claude Code', command: 'claude', isAgent: true },
    { id: 'cmd-grok', presetId: 'grok', label: 'Grok Build', command: 'grok', isAgent: true },
  ],
};

test('spawn requires an explicit project and inherits caller cwd and command', async () => {
  const api = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', projectId: 'proj-2', commandId: 'cmd-grok', cwd: '/tmp/work' }]],
  });
  const captured = [];
  api.createProgrammatic = (opts) => { captured.push(opts); api.getSessions().set('id-1', opts); return { id: 'id-1' }; };

  // No project given: rejected, even though the caller has one to inherit.
  await assert.rejects(
    spawnForCaller({ callerSessionId: 'caller-id', name: 'Worker' }, api, CFG),
    /project is required/,
  );

  const res = await spawnForCaller({ callerSessionId: 'caller-id', name: 'Worker', project: 'Beta' }, api, CFG);
  assert.equal(captured[0].commandId, 'cmd-grok');
  assert.equal(captured[0].projectId, 'proj-2');
  assert.equal(captured[0].cwd, '/tmp/work');
  assert.equal(res.name, 'Worker');
  assert.equal(res.project, 'Beta');
  assert.equal(res.promptDelivered, null);

  // Explicit opt-out still works.
  const outside = await spawnForCaller({ callerSessionId: 'caller-id', name: 'Loner', noProject: true }, api, CFG);
  assert.equal(outside.projectId, null);
  assert.equal(outside.project, null);
});

test('spawn resolves --project by name and prefers project path for cwd', async () => {
  const api = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', projectId: null, commandId: 'cmd-claude', cwd: '/tmp/work' }]],
  });
  const captured = [];
  api.createProgrammatic = (opts) => { captured.push(opts); return { id: 'id-2' }; };

  await spawnForCaller({ callerSessionId: 'caller-id', name: 'W', project: 'alpha' }, api, CFG);
  assert.equal(captured[0].projectId, 'proj-1');
  assert.equal(captured[0].cwd, '/tmp/alpha');
});

test('spawn rejects unknown callers, presets, and projects', async () => {
  const api = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', commandId: 'cmd-claude' }]],
  });
  await assert.rejects(spawnForCaller({ callerSessionId: 'nope' }, api, CFG), /Caller session is not active/);
  await assert.rejects(
    spawnForCaller({ callerSessionId: 'caller-id', presetId: 'no-such', noProject: true }, api, CFG),
    /No command configured for preset/,
  );
  await assert.rejects(
    spawnForCaller({ callerSessionId: 'caller-id', project: 'Gamma' }, api, CFG),
    /No project named/,
  );
});

test('spawn with prompt waits for readiness and injects it', async () => {
  const api = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', projectId: null, commandId: 'cmd-claude', cwd: '/tmp' }]],
  });
  const inputs = [];
  api.input = (msg) => inputs.push(msg);
  api.createProgrammatic = (opts) => { api.getSessions().set('id-3', { ...opts }); return { id: 'id-3' }; };

  const pending = spawnForCaller(
    { callerSessionId: 'caller-id', name: 'W', prompt: 'do the thing', readyTimeoutMs: 5000, noProject: true },
    api, CFG,
  );
  setTimeout(() => api.emit({ type: 'session.status', id: 'id-3', working: false, source: 'hook' }), 20);
  const res = await pending;
  assert.equal(res.promptDelivered, 'hook');
  assert.ok(inputs.length >= 1);
  assert.match(inputs[0].data, /\[CliDeck spawn from Master\]/);
  assert.match(inputs[0].data, /do the thing/);
});

test('waitForReady falls back to timeout when no status arrives', async () => {
  const api = fakeSessionsApi();
  const mode = await waitForReady(api, 'some-id', 50);
  assert.equal(mode, 'timeout');
});

test('setupWorktree creates a worktree and branch from a real repo', async () => {
  const repo = mkdtempSync(join(os.tmpdir(), 'clideck-spawn-repo-'));
  const dataDir = mkdtempSync(join(os.tmpdir(), 'clideck-spawn-data-'));
  const pathsPath = require.resolve('../paths');
  const spawnPath = require.resolve('../session-spawn');
  const realPaths = require(pathsPath);
  require.cache[pathsPath].exports = { ...realPaths, DATA_DIR: dataDir };
  delete require.cache[spawnPath];
  const { setupWorktree: setupWorktreeIsolated } = require(spawnPath);

  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git('add', '.');
    git('commit', '-m', 'init');

    const wt = await setupWorktreeIsolated(repo, 'Worker 1', null);
    assert.ok(wt.path.startsWith(join(dataDir, 'worktrees')));
    assert.equal(wt.branch, 'clideck/worker-1');
    assert.ok(existsSync(join(wt.path, 'a.txt')));

    // Same name again: distinct directory, distinct branch.
    const wt2 = await setupWorktreeIsolated(repo, 'Worker 1', null);
    assert.notEqual(wt2.path, wt.path);
    assert.ok(existsSync(join(wt2.path, 'a.txt')));

    // Non-repo cwd fails with a clear error.
    const notRepo = mkdtempSync(join(os.tmpdir(), 'clideck-spawn-norepo-'));
    await assert.rejects(setupWorktreeIsolated(notRepo, 'X', null), /requires a git repository/);
    rmSync(notRepo, { recursive: true, force: true });
  } finally {
    delete require.cache[spawnPath];
    require.cache[pathsPath].exports = realPaths;
    require(spawnPath);
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
