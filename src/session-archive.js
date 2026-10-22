const fs = require('fs/promises');
const { constants } = require('fs');
const { join, resolve, relative, basename } = require('path');
const { homedir } = require('os');
const { randomUUID, createHash } = require('crypto');
const { ArchiveSource } = require('./archive-source');
const { ENGINE_BUILD_VERSION } = require('./build-version');

const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function folder(name, id) {
  const label = String(name || 'Untitled').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 60) || 'Untitled';
  // IDs never become path components directly (custom/future providers too).
  return `${label}--${createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;
}

function nativeProfile(provider, env, cwd) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (provider === 'claude-code') return resolve(cwd, env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  if (provider === 'codex') return resolve(cwd, env.CODEX_HOME || join(home, '.codex'));
  return ''; // Other providers still contribute their existing hook/lifecycle data.
}

async function privateDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Archive subfolder must be a real directory.');
}

class SessionArchive {
  constructor({ dataDir, onStatus = () => {}, now = () => new Date().toISOString(), pollMs = 500 } = {}) {
    Object.assign(this, { dataDir, onStatus, now, pollMs });
    this.settings = { enabled: false, directory: '' };
    this.requested = this.settings;
    this.state = 'off';
    this.error = '';
    this.warning = '';
    this.runs = new Map();
    this.queue = Promise.resolve();
    this.queueBytes = 0;
    this.index = null;
    this.timer = null;
    this.pollPending = false;
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  snapshot() {
    return { type: 'archive.status', ...this.requested, state: this.state,
      ...(this.error && { error: this.error }), ...(this.warning && { warning: this.warning }) };
  }

  notify() { this.onStatus(this.snapshot()); }

  fail(error) {
    if (this.state === 'error') return;
    this.state = 'error';
    this.error = `Session archiving paused: ${error.message || error}. Turn archiving off and on to retry. Agents keep running.`;
    clearInterval(this.timer);
    this.timer = null;
    this.notify();
  }

  enqueue(work, bytes = 0, always = false) {
    if (!always && (!this.requested.enabled || this.state === 'error')) return;
    if (this.queueBytes + bytes > MAX_QUEUE_BYTES) {
      this.fail(new Error('The archive writer could not keep up; some records were not saved.'));
      return;
    }
    this.queueBytes += bytes;
    this.queue = this.queue.then(async () => {
      try { if (always || this.state !== 'error') await work(); }
      catch (error) { this.fail(error); }
      finally { this.queueBytes -= bytes; }
    });
  }

  configure(settings = {}, sessions = []) {
    const next = { enabled: settings.enabled === true, directory: settings.directory || '' };
    if (JSON.stringify(next) === JSON.stringify(this.requested)) return;
    this.requested = next;
    const capturedAt = this.now();
    this.enqueue(async () => {
      clearInterval(this.timer);
      this.timer = null;
      for (const run of this.runs.values()) {
        if (this.state !== 'error') await this.end(run, 'archive-setting-changed');
      }
      this.runs.clear();
      this.settings = next;
      this.error = '';
      this.warning = '';
      this.state = next.enabled ? 'recording' : 'off';
      if (next.enabled) {
        await privateDirectory(next.directory);
        await this.loadIndex();
        // Verify writable even when no session is currently running.
        const probe = join(next.directory, `.clideck-write-${randomUUID()}`);
        await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
        await fs.unlink(probe);
        for (const item of sessions) await this.begin(item.session, item.info, 'enabled', capturedAt, true);
        this.timer = setInterval(() => this.poll(), this.pollMs);
        this.timer.unref?.();
      }
      this.notify();
    }, 0, true);
  }

  async loadIndex() {
    if (this.index) return;
    try {
      this.index = JSON.parse(await fs.readFile(join(this.dataDir, 'archive-index.json'), 'utf8'));
      if (this.index.version !== 1 || !Array.isArray(this.index.roots)) throw new Error('invalid index');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Archive identity index could not be read. Existing archives were left untouched.');
      this.index = { version: 1, roots: [] };
    }
  }

  async saveIndex() {
    const path = join(this.dataDir, 'archive-index.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(this.index), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async begin(session, info, reason, capturedAt, fromEnd = false) {
    if (!this.settings.enabled) return null;
    if (this.runs.has(session)) await this.end(this.runs.get(session), 'run-replaced');
    let root = this.index.roots.find(item => item.path === this.settings.directory);
    if (!root) { root = { path: this.settings.directory, projects: [], sessions: [] }; this.index.roots.push(root); }
    const projectId = info.projectId || 'unassigned';
    let project = root.projects.find(item => item.id === projectId);
    if (!project) { project = { id: projectId, folder: folder(info.projectName || 'Personal', projectId) }; root.projects.push(project); }
    let entry = root.sessions.find(item => item.id === info.sessionId);
    if (!entry) {
      entry = { id: info.sessionId, project: project.folder, folder: folder(info.name, info.sessionId), previousRunId: null };
      root.sessions.push(entry);
    }
    if ([entry.project, entry.folder].some(part => typeof part !== 'string' || basename(part) !== part || part === '.' || part === '..')) {
      throw new Error('Invalid archive identity path.');
    }
    const directory = join(root.path, entry.project, entry.folder);
    await privateDirectory(join(root.path, entry.project));
    await privateDirectory(directory);
    const run = { id: randomUUID(), info, reason, capturedAt, directory, root: root.path,
      previousRunId: entry.previousRunId, sequence: 0, segment: '', previousSegment: null,
      nativeId: info.nativeId || '', transcriptPath: '', source: null, days: new Set() };
    entry.previousRunId = run.id;
    await this.saveIndex();
    this.runs.set(session, run);
    await this.write(run, 'run.started', { reason, previousRunId: run.previousRunId, ...info,
      engineVersion: ENGINE_BUILD_VERSION, timezone: this.timezone,
      coverage: { startsAt: capturedAt, historicalImport: false,
        nativeRecords: info.profileRoot ? 'waiting-for-session-reported-jsonl' : 'unsupported-provider',
        thinking: 'Only provider-exposed records; hidden reasoning is unavailable.',
        instructions: 'Only the supplied CliDeck guide and instructions exposed in native records.',
        attachments: 'CliDeck uploads/previews copied; native embedded content preserved. Other external references are not copied.',
        rawTerminal: false, trainingReady: false } }, capturedAt);
    if (info.transcriptPath && info.profileRoot) await this.attach(run, info.transcriptPath, fromEnd);
    return run;
  }

  start(session, info) {
    const at = this.now();
    // session.created also carries terminal-mode snapshots. The session object
    // owns one process; only a new object/spawn starts another run.
    this.enqueue(() => this.runs.has(session) ? null
      : this.begin(session, info, 'process-started', at, Boolean(info.nativeId)));
  }

  async attach(run, path, fromEnd = false) {
    run.transcriptPath = path;
    run.source = new ArchiveSource({ path, root: run.info.profileRoot, since: run.capturedAt, fromEnd,
      emit: (type, data) => this.write(run, type, data) });
    await run.source.attach();
  }

  event(session, event) {
    // Terminal repaint bytes are not messages; input may contain passwords and
    // draft edits. Neither is a substitute for a native conversation record.
    if (event.type === 'output') return;
    const raw = JSON.stringify(event);
    const at = this.now();
    this.enqueue(async () => {
      const run = this.runs.get(session);
      if (!run) return;
      await this.write(run, 'clideck.event', JSON.parse(raw), at);
      if (event.type === 'session.closed') {
        await this.end(run, event.restarting ? 'process-restarted' : 'process-exited');
        this.runs.delete(session);
      }
    }, Buffer.byteLength(raw));
  }

  hook(session, route, payload, metadata = {}) {
    const raw = JSON.stringify(payload);
    const at = this.now();
    this.enqueue(async () => {
      let run = this.runs.get(session);
      if (!run) return;
      const handle = String(metadata.handle || '');
      const path = String(metadata.transcriptPath || '');
      const clear = route === 'session-start' && payload.source === 'clear';
      const changed = (handle && run.nativeId && handle !== run.nativeId)
        || (path && run.transcriptPath && path !== run.transcriptPath);
      if (clear || changed) {
        await this.end(run, clear ? 'conversation-cleared' : 'native-conversation-changed');
        this.runs.delete(session);
        run = await this.begin(session, { ...run.info, nativeId: handle, transcriptPath: '' },
          clear ? 'conversation-cleared' : 'native-conversation-changed', at);
      }
      if (handle) run.nativeId = handle;
      await this.write(run, 'native.hook', { route, payload: JSON.parse(raw), nativeId: run.nativeId }, at);
      if (path && path !== run.transcriptPath && run.info.profileRoot) await this.attach(run, path);
    }, Buffer.byteLength(raw));
  }

  async write(run, type, data, at = this.now()) {
    try {
      const parts = Object.fromEntries(this.dayFormat.formatToParts(new Date(at)).map(p => [p.type, p.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const directory = join(run.directory, day);
      if (run.day !== day) {
        await privateDirectory(directory);
        run.previousSegment = run.segment || null;
        run.segment = relative(run.root, join(directory, `${run.id}.jsonl`));
        run.file = join(run.root, run.segment);
        run.day = day;
        if (!run.days.has(day)) {
          const header = this.line(run, 'segment.started', { previousSegment: run.previousSegment,
            previousRunId: run.previousRunId, timezone: this.timezone }, at);
          await fs.writeFile(run.file, header, { flag: 'wx', mode: 0o600 });
          run.days.add(day);
        }
      }
      await fs.appendFile(run.file, this.line(run, type, data, at), { flag: 'a', mode: 0o600 });
    } catch (error) { error.archiveWrite = true; throw error; }
  }

  line(run, type, data, at) {
    return `${JSON.stringify({ schemaVersion: 1, type, capturedAt: at, sequence: run.sequence++,
      projectId: run.info.projectId || null, sessionId: run.info.sessionId, runId: run.id,
      provider: run.info.provider, nativeId: run.nativeId || null, data })}\n`;
  }

  poll() {
    if (this.pollPending || this.state !== 'recording') return;
    this.pollPending = true;
    this.enqueue(async () => {
      try { for (const run of this.runs.values()) await run.source?.read(); }
      finally { this.pollPending = false; }
    });
  }

  asset(session, asset) {
    const at = this.now();
    this.enqueue(async () => {
      const run = this.runs.get(session);
      if (!run) return;
      await this.write(run, 'asset.referenced', { name: asset.name, path: asset.path || null,
        kind: asset.kind || null, origin: asset.origin }, at);
      let input, output, destination;
      try {
        const bytes = asset.data;
        if (bytes && bytes.length > MAX_ASSET_BYTES) throw new Error('Asset exceeds 100 MiB.');
        if (!bytes) {
          input = await fs.open(asset.path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error('Asset is not a regular file under 100 MiB.');
        }
        const directory = join(run.directory, run.day, 'assets');
        await privateDirectory(directory);
        destination = join(directory, `${randomUUID()}-${folder(asset.name, asset.name)}`);
        output = await fs.open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        let size = 0;
        const append = async buffer => {
          size += buffer.length;
          if (size > MAX_ASSET_BYTES) throw new Error('Asset grew beyond 100 MiB.');
          hash.update(buffer);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset);
            if (!bytesWritten) throw new Error('Could not write archive asset.');
            offset += bytesWritten;
          }
        };
        if (bytes) await append(bytes);
        else {
          const buffer = Buffer.allocUnsafe(256 * 1024);
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            await append(buffer.subarray(0, bytesRead));
          }
        }
        await output.close(); output = null;
        await this.write(run, 'asset.saved', { name: asset.name, path: relative(join(run.directory, run.day), destination),
          size, sha256: hash.digest('hex'), origin: asset.origin }, at);
      } catch (error) {
        await output?.close().catch(() => {}); output = null;
        if (destination) await fs.unlink(destination).catch(() => {});
        await this.write(run, 'asset.unavailable', { name: asset.name, reason: error.message }, at);
        // Losing one source asset does not stop conversation recording.
        this.warning = `An attachment could not be archived: ${error.message} Conversation recording continues.`;
        this.notify();
      } finally { await input?.close(); await output?.close(); }
    }, asset.data?.length || 1024);
  }

  async end(run, reason) {
    await run.source?.finish();
    await this.write(run, 'run.ended', { reason });
  }

  async flush() { await this.queue; }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.requested = { ...this.requested, enabled: false };
    this.enqueue(async () => {
      if (this.state !== 'error') for (const run of this.runs.values()) await this.end(run, 'engine-stopped');
      this.runs.clear();
    }, 0, true);
    await this.flush();
  }
}

module.exports = { SessionArchive, nativeProfile, folder, MAX_ASSET_BYTES, MAX_QUEUE_BYTES };
