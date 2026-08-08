const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  spawnForCaller, randomSessionName, slugify, waitForReady, activeSpawnedCount, submitWithWorkingRetry,
} = require('../session-spawn');
const { parseArgs: parseSpawnArgs } = require('../clideck-spawn-cli');

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
    broadcast: () => {},
    close: overrides.close || ((msg) => sessions.delete(msg.id)),
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
  assert.equal(captured[0].ephemeral, true);
  assert.equal(captured[0].spawnedBySessionId, 'caller-id');
  assert.equal(captured[0].spawnRootSessionId, 'caller-id');
  assert.equal(captured[0].spawnDepth, 1);
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

test('spawn caps active workers and prevents recursive spawning', async () => {
  const active = [1, 2, 3].map(n => [
    `worker-${n}`,
    { name: `Worker ${n}`, spawnedBySessionId: 'another-root', spawnRootSessionId: 'another-root' },
  ]);
  const capped = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', commandId: 'cmd-claude' }], ...active],
  });
  await assert.rejects(
    spawnForCaller({ callerSessionId: 'caller-id', project: 'Alpha', prompt: 'review' }, capped, CFG),
    /Active spawned worker limit reached \(3\/3\)/,
  );
  assert.equal(activeSpawnedCount(capped.getSessions()), 3);

  const nested = fakeSessionsApi({
    sessions: [[
      'child-id',
      { name: 'Child', commandId: 'cmd-claude', spawnedBySessionId: 'root-id', spawnRootSessionId: 'root-id', spawnDepth: 1 },
    ]],
  });
  await assert.rejects(
    spawnForCaller({ callerSessionId: 'child-id', project: 'Alpha', prompt: 'delegate again' }, nested, CFG),
    /Spawned workers cannot spawn more workers/,
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

test('spawn --wait returns the first answer and closes the worker', async () => {
  const api = fakeSessionsApi({
    sessions: [['caller-id', { name: 'Master', projectId: null, commandId: 'cmd-claude', cwd: '/tmp' }]],
  });
  api.createProgrammatic = (opts) => {
    api.getSessions().set('wait-worker', { ...opts, working: undefined });
    return { id: 'wait-worker' };
  };

  const pending = spawnForCaller({
    callerSessionId: 'caller-id', name: 'Reviewer', prompt: 'review this', waitForResult: true,
    readyTimeoutMs: 5000, resultTimeoutMs: 5000, noProject: true,
  }, api, CFG);

  setTimeout(() => api.emit({ type: 'session.status', id: 'wait-worker', working: false, source: 'hook' }), 20);
  setTimeout(() => api.emit({ type: 'session.status', id: 'wait-worker', working: true, source: 'hook' }), 40);
  setTimeout(() => {
    const worker = api.getSessions().get('wait-worker');
    worker.working = false;
    worker.lastPreview = 'No findings.';
    worker.lastActivityAt = new Date().toISOString();
    api.emit({ type: 'session.status', id: 'wait-worker', working: false, source: 'hook' });
  }, 80);

  const res = await pending;
  assert.equal(res.response, 'No findings.');
  assert.equal(res.closed, true);
  assert.equal(api.getSessions().has('wait-worker'), false);
});

test('spawn CLI parses bounded wait options', () => {
  const opts = parseSpawnArgs([
    '--project', 'Alpha', '--name', 'Reviewer', '--prompt', 'review', '--wait', '--timeout', '12m', '--keep',
  ]);
  assert.equal(opts.waitForResult, true);
  assert.equal(opts.resultTimeoutMs, 12 * 60 * 1000);
  assert.equal(opts.keepOpen, true);
});

test('waitForReady falls back to timeout when no status arrives', async () => {
  const api = fakeSessionsApi();
  const mode = await waitForReady(api, 'some-id', 50);
  assert.equal(mode, 'timeout');
});

test('waiting prompt delivery retries only until a working acknowledgement', async () => {
  const retrying = fakeSessionsApi({ sessions: [['worker', { name: 'Worker', working: false }]] });
  let retryInputs = 0;
  retrying.input = () => { retryInputs++; };
  const delivery = submitWithWorkingRetry(retrying, 'worker', 'task', { retryMs: 15, maxAttempts: 3 });
  await new Promise(resolve => setTimeout(resolve, 42));
  delivery.cancel();
  assert.equal(delivery.attempts(), 3);
  assert.equal(retryInputs, 3);

  const acknowledged = fakeSessionsApi({ sessions: [['worker', { name: 'Worker', working: false }]] });
  let acknowledgedInputs = 0;
  acknowledged.input = () => { acknowledgedInputs++; };
  const one = submitWithWorkingRetry(acknowledged, 'worker', 'task', { retryMs: 15, maxAttempts: 3 });
  setTimeout(() => acknowledged.emit({ type: 'session.status', id: 'worker', working: true }), 5);
  await new Promise(resolve => setTimeout(resolve, 42));
  one.cancel();
  assert.equal(one.attempts(), 1);
  assert.equal(acknowledgedInputs, 1);
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
