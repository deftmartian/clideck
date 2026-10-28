const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { mkdir } = require('fs/promises');
const { join } = require('path');
const { resolveProject, unsuccessfulTurn } = require('./ask');
const { getProvider } = require('./providers');
const { createCustomCommandProvider } = require('./custom-command');
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
  if (value.commandId !== undefined && !text('commandId', 200)) return null;
  if (value.commandId !== undefined && value.preset !== undefined) return null;
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
  constructor(server) { this.server = server; this.reservations = 0; this.tasks = new Map(); }

  track(session, identity) {
    const task = { session, identity, result: null };
    task.completion = new Promise(resolve => {
      task.finish = result => {
        if (task.result) return;
        task.result = result;
        session.off('event', onEvent);
        resolve(result);
      };
      const onEvent = event => {
        if (event.type === 'agent.final') task.finish({ ok: true, answer: event.text });
        else if (event.type === 'turn.cancelled' || event.type === 'turn.failed') task.finish(unsuccessfulTurn(event.error));
        else if (event.type === 'session.closed') task.finish({ ok: false, error: 'target_closed' });
      };
      session.on('event', onEvent);
    });
    const onClose = event => {
      if (event.type !== 'session.closed') return;
      this.tasks.delete(session.id);
      session.off('event', onClose);
    };
    session.on('event', onClose);
    this.tasks.set(session.id, task);
    return task;
  }

  async closeWorker(session) {
    session.removePersistenceOnClose = true;
    session.close();
    await session.waitForClose();
  }

  async collect(task, timeoutMs) {
    let timer;
    const result = await Promise.race([
      task.completion,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!result) return { ok: false, error: 'timeout', ...task.identity,
      message: `Worker is still running. Collect its answer with clideck worker wait ${task.session.id}; stop it with clideck worker cancel ${task.session.id}.` };
    await this.closeWorker(task.session);
    return { ...result, ...task.identity };
  }

  list(caller) {
    const now = Date.now();
    const workers = [];
    for (const entry of this.server.persistence.list()) {
      if (!entry.spawnedBySessionId || entry.spawnedBySessionId !== caller.entry.id) continue;
      const liveSession = this.server.sessions.get(entry.id);
      const running = Boolean(liveSession && !liveSession.closed);
      const task = this.tasks.get(entry.id);
      const created = Date.parse(entry.createdAt || '');
      let collection = 'unavailable';
      if (task && !task.result) collection = 'pending';
      else if (task?.result) collection = 'ready';
      workers.push({
        sessionId: entry.id,
        name: entry.name || '',
        parentSessionId: entry.spawnedBySessionId,
        createdAt: entry.createdAt || null,
        ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
        state: running ? (task?.result ? 'finished' : 'working') : 'dormant',
        collection,
        live: running,
      });
    }
    return {
      ok: true,
      workers,
      restart: 'Pending result collection stays in this engine process. After a restart a retained worker remains saved, collection is unavailable, and listing does not stop it or reuse a user session. Resume the parent only when you still need that conversation; workers are not relaunched by listing.',
    };
  }

  async control(request) {
    if (!request || !['status', 'wait', 'cancel', 'list'].includes(request.action)
      || typeof request.callerSessionId !== 'string'
      || (request.action !== 'list' && typeof request.sessionId !== 'string')) {
      return { ok: false, error: 'invalid_request' };
    }
    const timeoutMs = request.timeoutMs ?? 600_000;
    if (request.action !== 'list' && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000)) {
      return { ok: false, error: 'invalid_request' };
    }
    const entries = this.server.persistence.list();
    let caller = resolveLiveCaller(entries, this.server.sessions, request.callerSessionId);
    if (!caller && request.action === 'list') {
      const entry = entries.find((value) => value.id === request.callerSessionId);
      // A dormant parent may inspect its own workers after restart. Workers
      // themselves, and every user session that is not the caller, stay hidden.
      if (entry && !entry.spawnedBySessionId) caller = { entry, session: null };
    }
    if (!caller) return { ok: false, error: 'unknown_caller' };
    if (request.action === 'list') {
      if (caller.entry.spawnedBySessionId) return { ok: false, error: 'unknown_caller' };
      return this.list(caller);
    }
    const session = this.server.sessions.get(request.sessionId);
    if (!session || session.closed || session.spawnedBySessionId !== caller.entry.id) {
      return { ok: false, error: 'unknown_worker' };
    }
    if (request.action === 'cancel') {
      await this.closeWorker(session);
      return { ok: true, sessionId: session.id, state: 'cancelled' };
    }
    const task = this.tasks.get(session.id);
    if (!task) return { ok: false, error: 'result_unavailable',
      message: 'No pending worker result in this engine. Open the session to inspect its saved conversation.' };
    if (request.action === 'status') return { ok: true, ...task.identity,
      state: task.result ? 'finished' : 'working' };
    return this.collect(task, timeoutMs);
  }

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
    const customCommand = request.commandId ? server.getCustomCommand(request.commandId) : null;
    if (request.commandId && !customCommand) return { ok: false, error: 'command_unavailable' };
    const providerId = customCommand?.providerId || (request.preset === 'claude' ? 'claude-code' : request.preset || caller.entry.provider);
    const provider = customCommand ? createCustomCommandProvider(customCommand)
      : request.preset ? getProvider(providerId) : caller.session.provider;
    const inheritCommand = !request.commandId && !request.preset;
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
        provider, command: customCommand?.command || (inheritCommand ? caller.session.command : server.commands[providerId]), name, cwd, projectId,
        commandId: customCommand?.id || (inheritCommand ? caller.entry.commandId : undefined),
        commandLabel: customCommand?.label || (inheritCommand ? caller.entry.commandLabel : undefined),
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
    if (!await waitUntilReady(session, Math.max(1, Math.min(60_000, deadline - Date.now())))) {
      await this.closeWorker(session);
      return { ok: false, error: 'worker_not_ready', ...identity };
    }
    const task = this.track(session, identity);
    const text = `Dedicated CliDeck worker. Do only this bounded task. Do not spawn workers.\n\n${request.prompt}`;
    const result = server.askCoordinator.ask(session, text, Math.max(1, deadline - Date.now()),
      { fromId: caller.entry.id, fromName: caller.entry.name });
    // Ask keeps its reservation until the actual final event, even after its caller times out.
    result.then(value => {
      if (value.error !== 'timeout') task.finish(value);
      if (!request.wait && !value.ok && value.error !== 'timeout') server.broadcastSessionError(session.id, {
        code: value.error, operation: 'session.spawn', message: `Worker ended without a result: ${value.error}`,
      });
    });
    if (request.wait) return this.collect(task, Math.max(1, deadline - Date.now()));
    return { ok: true, ...identity };
  }
}

module.exports = { WorkerManager, canAskSession, workerMetadata, parseSpawn, MAX_WORKERS };
