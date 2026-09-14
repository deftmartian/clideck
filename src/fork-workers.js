const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { mkdir } = require('fs/promises');
const { join } = require('path');
const { resolveProject } = require('./ask');
const { getProvider } = require('./providers');
const { resolveLiveCaller } = require('./session-agents');

const exec = promisify(execFile);
const MAX_WORKERS = 3;
const MAX_PROMPT = 256 * 1024;

function workerMetadata(value = {}) {
  if (typeof value.spawnedBySessionId !== 'string' || !value.spawnedBySessionId) return {};
  return {
    spawnedBySessionId: value.spawnedBySessionId,
    ...(value.workerWorktree && { workerWorktree: String(value.workerWorktree) }),
  };
}

function canAskSession(caller, target, interruptExisting = false) {
  return !caller || target.spawnedBySessionId === caller.id || interruptExisting === true;
}

function parseSpawn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (key, max) => typeof value[key] === 'string' && value[key].trim()
    && value[key].length <= max && !value[key].includes('\0');
  if (!text('callerSessionId', 200) || !text('prompt', MAX_PROMPT)) return null;
  if (value.noProject !== true && !text('project', 200)) return null;
  if (value.noProject === true && value.project !== undefined) return null;
  if (value.name !== undefined && !text('name', 200)) return null;
  if (value.preset !== undefined && !text('preset', 100)) return null;
  if (['wait', 'worktree', 'noProject'].some(k => value[k] !== undefined && typeof value[k] !== 'boolean')) return null;
  const timeoutMs = value.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) return null;
  return { ...value, timeoutMs };
}

function waitUntilReady(session, timeoutMs) {
  return new Promise((resolve) => {
    const ready = () => !session.closed && session.sessionStarted && session.status === 'idle'
      && !session.turnOpen && !session.menu.length && !session.closeRequested;
    const finish = (result) => { clearTimeout(timer); clearInterval(poll); session.off('event', check); resolve(result); };
    const check = () => { if (session.closed) finish(false); else if (ready()) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poll = setInterval(check, 100);
    session.on('event', check);
    check();
  });
}

class WorkerManager {
  constructor(server) { this.server = server; this.reservations = 0; }

  async spawn(raw) {
    const request = parseSpawn(raw);
    if (!request) return { ok: false, error: 'invalid_request' };
    const server = this.server;
    const caller = resolveLiveCaller(server.persistence.list(), server.sessions, request.callerSessionId);
    if (!caller) return { ok: false, error: 'unknown_caller' };
    if (caller.entry.spawnedBySessionId) return { ok: false, error: 'recursive_spawn_forbidden' };
    const active = [...server.sessions.values()].filter(s => s.spawnedBySessionId && !s.closed).length;
    if (active + this.reservations >= MAX_WORKERS) return { ok: false, error: 'worker_limit' };
    const project = request.noProject ? null : resolveProject(server.configStore.get().projects, request.project);
    if (project?.error) return { ok: false, error: project.error };
    const providerId = request.preset === 'claude' ? 'claude-code' : request.preset || caller.entry.provider;
    const provider = request.preset ? getProvider(providerId) : caller.session.provider;
    if (!provider?.supportsAsk) return { ok: false, error: 'unsupported_provider' };
    let cwd = project?.project?.path || project?.project?.cwd || caller.entry.cwd;
    if (!cwd) return { ok: false, error: 'missing_working_directory' };
    const name = request.name?.trim() || `Worker ${randomUUID().slice(0, 8)}`;
    const projectId = project?.project?.id || null;
    if (server.findNameConflict(name, { cwd, projectId })) return { ok: false, error: 'name_conflict' };
    this.reservations++;
    let session;
    let workerWorktree;
    const deadline = Date.now() + request.timeoutMs;
    try {
      if (request.worktree) {
        const id = randomUUID();
        const parent = join(server.persistence.dataDir, 'worktrees');
        await mkdir(parent, { recursive: true });
        workerWorktree = join(parent, id);
        await exec('git', ['worktree', 'add', '-b', `clideck/worker-${id}`, workerWorktree, 'HEAD'],
          { cwd, timeout: Math.min(30_000, request.timeoutMs), maxBuffer: 256 * 1024 });
        cwd = workerWorktree;
      }
      if (caller.session.closed || caller.session.closeRequested) throw new Error('Caller closed before worker launch.');
      if (Date.now() >= deadline) throw new Error('Worker setup timed out.');
      if (server.findNameConflict(name, { cwd, projectId })) throw new Error('Worker name was taken during setup.');
      // Only this server-owned path can assign worker ownership; browser input cannot spoof it.
      session = server.startSession({
        provider, command: request.preset ? server.commands[providerId] : caller.session.command, name, cwd, projectId,
        commandId: request.preset ? undefined : caller.entry.commandId,
        commandLabel: request.preset ? undefined : caller.entry.commandLabel,
        cols: caller.session.cols, rows: caller.session.rows, port: server.port,
        providerOptions: server.providerLaunchOptions(providerId),
        spawnedBySessionId: caller.entry.id, workerWorktree,
      }, true, {}, true);
    } catch (error) {
      return { ok: false, error: 'spawn_failed', message: error.message, ...(workerWorktree && { worktree: workerWorktree }) };
    } finally {
      this.reservations--;
    }
    const identity = { sessionId: session.id, name, ...(workerWorktree && { worktree: workerWorktree }) };
    let closeWorker = request.wait === true;
    try {
      if (!await waitUntilReady(session, Math.max(1, Math.min(60_000, deadline - Date.now())))) {
        closeWorker = true;
        return { ok: false, error: 'worker_not_ready', ...identity };
      }
      const text = `Dedicated CliDeck worker. Do only this bounded task. Do not spawn workers.\n\n${request.prompt}`;
      const result = server.askCoordinator.ask(session, text, Math.max(1, deadline - Date.now()),
        { fromId: caller.entry.id, fromName: caller.entry.name });
      if (!request.wait) {
        // A visible worker stays open, but failures remain visible as session errors.
        result.then(value => { if (!value.ok) server.broadcastSessionError(session.id, {
          code: value.error, operation: 'session.spawn', message: `Worker ended without a result: ${value.error}`,
        }); });
        return { ok: true, ...identity };
      }
      return { ...await result, ...identity };
    } finally {
      if (closeWorker) {
        session.removePersistenceOnClose = true;
        session.close();
        await session.waitForClose();
      }
    }
  }
}

module.exports = { WorkerManager, canAskSession, workerMetadata, parseSpawn, MAX_WORKERS };
