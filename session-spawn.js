const { execFile } = require('child_process');
const { mkdirSync, existsSync } = require('fs');
const { join, basename } = require('path');
const { sendJson, jsonError, readJson, resolveProject, isSameHost, projectName, sessionAddress } = require('./http-util');
const { submitAskInput } = require('./session-ask');
const { DATA_DIR } = require('./paths');

const DEFAULT_PROMPT_READY_MS = 15 * 1000;
const MAX_PROMPT_READY_MS = 2 * 60 * 1000;

// Same pool the browser creator uses; spawned workers get the same kind of
// names the user sees when creating sessions by hand.
const ADJECTIVES = ['Blue', 'Red', 'Green', 'Purple', 'Golden', 'Silver', 'Coral', 'Amber',
  'Mint', 'Crimson', 'Teal', 'Rose', 'Jade', 'Copper', 'Ivory', 'Rusty'];
const ANIMALS = ['Panda', 'Falcon', 'Fox', 'Wolf', 'Owl', 'Tiger', 'Bear', 'Eagle',
  'Dolphin', 'Lynx', 'Hawk', 'Raven', 'Otter', 'Panther', 'Crane', 'Bison'];

function randomSessionName(isTaken) {
  for (let i = 0; i < 32; i++) {
    const name = `${ADJECTIVES[Math.random() * ADJECTIVES.length | 0]} ${ANIMALS[Math.random() * ANIMALS.length | 0]}`;
    if (!isTaken(name)) return name;
  }
  const base = `${ADJECTIVES[Math.random() * ADJECTIVES.length | 0]} ${ANIMALS[Math.random() * ANIMALS.length | 0]}`;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!isTaken(name)) return name;
  }
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(jsonError(String(stderr || err.message).trim(), 400));
      else resolve(String(stdout).trim());
    });
  });
}

function branchExists(repoRoot, branch) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
    .then(() => true, () => false);
}

// Creates a git worktree for a spawned session under
// ~/.clideck/worktrees/<repo>/<slug>. Worktrees are not removed when the
// session closes; clean up with `git worktree remove` + `git worktree prune`.
async function setupWorktree(baseCwd, sessionName, branchArg) {
  let repoRoot;
  try {
    repoRoot = await git(['rev-parse', '--show-toplevel'], baseCwd);
  } catch {
    throw jsonError(`--worktree requires a git repository at ${baseCwd}`, 400);
  }

  const slug = slugify(sessionName);
  const root = join(DATA_DIR, 'worktrees', basename(repoRoot));
  mkdirSync(root, { recursive: true });
  let path = join(root, slug);
  for (let n = 2; existsSync(path); n++) path = join(root, `${slug}-${n}`);

  const branch = String(branchArg || '').trim() || `clideck/${basename(path)}`;
  if (await branchExists(repoRoot, branch)) {
    await git(['worktree', 'add', path, branch], repoRoot);
  } else {
    await git(['worktree', 'add', path, '-b', branch], repoRoot);
  }
  return { path, branch, repoRoot };
}

function removeWorktree(worktree) {
  if (!worktree) return Promise.resolve();
  return git(['worktree', 'remove', '--force', worktree.path], worktree.repoRoot).catch(() => {});
}

function normalizeReadyTimeout(ms) {
  const n = Number(ms || DEFAULT_PROMPT_READY_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROMPT_READY_MS;
  return Math.min(Math.round(n), MAX_PROMPT_READY_MS);
}

// Resolves once the new agent looks ready for input: the first idle
// session.status broadcast (agents with lifecycle hooks emit one when they
// reach their interactive prompt), or the timeout as a fallback for agents
// with no push status. Never rejects.
function waitForReady(sessionsApi, id, timeoutMs) {
  return new Promise((resolve) => {
    let removeListener = null;
    const timeout = setTimeout(() => {
      if (removeListener) removeListener();
      resolve('timeout');
    }, timeoutMs);
    removeListener = sessionsApi.addBroadcastListener((msg) => {
      if (msg.id !== id || msg.type !== 'session.status' || msg.working) return;
      clearTimeout(timeout);
      if (removeListener) removeListener();
      resolve(msg.source === 'hook' ? 'hook' : 'status');
    });
  });
}

function resolveCommand(payload, caller, cfg) {
  const commands = Array.isArray(cfg.commands) ? cfg.commands : [];
  if (payload.presetId) {
    const cmd = commands.find(c => c.presetId === String(payload.presetId) && c.enabled !== false);
    if (!cmd) throw jsonError(`No command configured for preset "${payload.presetId}"`, 404);
    return cmd;
  }
  if (payload.commandId) {
    const cmd = commands.find(c => c.id === String(payload.commandId));
    if (!cmd) throw jsonError(`No command with id "${payload.commandId}"`, 404);
    return cmd;
  }
  const inherited = commands.find(c => c.id === caller.commandId);
  if (inherited) return inherited;
  const firstAgent = commands.find(c => c.isAgent && c.enabled !== false);
  if (firstAgent) return firstAgent;
  throw jsonError('No agent command available to spawn', 404);
}

async function spawnForCaller(payload, sessionsApi, cfg) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(payload.callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) throw jsonError('Caller session is not active', 404);

  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  let projectId;
  let project = null;
  if (payload.noProject) {
    projectId = null;
  } else if (payload.project) {
    project = resolveProject(projects, payload.project);
    projectId = project.id;
  } else {
    // Deliberate: a spawning agent must say where the worker goes rather
    // than silently inheriting whatever project it happens to run in.
    throw jsonError('project is required: pass a project name or id, or set noProject', 400);
  }

  const cmd = resolveCommand(payload, caller, cfg);

  const name = String(payload.name || '').trim()
    || randomSessionName(n => [...sessions].some(([, s]) =>
      (s.projectId || null) === projectId && String(s.name || '').trim().toLowerCase() === n.toLowerCase()));

  const baseCwd = String(payload.cwd || '').trim() || project?.path || caller.cwd || cfg.defaultPath;

  let worktree = null;
  if (payload.worktree) {
    worktree = await setupWorktree(baseCwd, name, payload.branch);
  }

  const created = sessionsApi.createProgrammatic({
    commandId: cmd.id,
    cwd: worktree ? worktree.path : baseCwd,
    name,
    projectId,
  }, cfg);
  if (created.error) {
    await removeWorktree(worktree);
    throw jsonError(created.error, 400);
  }

  const spawned = sessions.get(created.id);
  console.log(`[spawn] ${caller.name || callerId.slice(0, 8)} -> "${name}"${worktree ? ` worktree ${worktree.path}` : ''}`);

  let promptDelivered = null;
  const prompt = String(payload.prompt || '').trim();
  if (prompt) {
    const readiness = await waitForReady(sessionsApi, created.id, normalizeReadyTimeout(payload.readyTimeoutMs));
    const injected = `[CliDeck spawn from ${sessionAddress(caller, callerId, projects)}]\n\n${prompt}`;
    submitAskInput(sessionsApi, created.id, injected);
    promptDelivered = readiness;
  }

  return {
    id: created.id,
    name,
    address: sessionAddress(spawned || { name, projectId }, created.id, projects),
    projectId,
    project: projectId ? projectName(projects, projectId) : null,
    cwd: spawned?.cwd || (worktree ? worktree.path : baseCwd),
    worktreePath: worktree?.path || null,
    branch: worktree?.branch || null,
    promptDelivered,
  };
}

async function handleHttp(req, res, sessionsApi, getConfig = () => ({})) {
  try {
    if (!isSameHost(req)) throw jsonError('CliDeck spawn only accepts same-host requests', 403);
    const payload = await readJson(req);
    const result = await spawnForCaller(payload, sessionsApi, getConfig() || {});
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck spawn failed' });
  }
}

module.exports = { handleHttp, spawnForCaller, randomSessionName, slugify, setupWorktree, waitForReady };
