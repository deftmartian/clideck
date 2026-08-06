// Filesystem-isolated CliDeck instance for provider smoke tests.
//
// CONTRACT (enforced here): the harness writes ONLY under a throwaway tmpHome.
// The real machine is read-only. We never patch real ~/.clideck, ~/.claude,
// ~/.codex, ~/.gemini, ~/.pi, or repo source. Provider configs are COPIED into
// tmpHome and only the copies are ever patched; if a copy is not enough to
// authenticate a provider, the caller skips it rather than touching the real one.
//
// Isolation works because os.homedir() honors $HOME, and every path CliDeck
// uses derives from it: DATA_DIR (~/.clideck), the single-instance lock, and
// each agent's config dir (~/.claude, ~/.codex, ...). Spawning server.js with
// HOME=tmpHome therefore relocates all of them into the sandbox.

const { spawn } = require('child_process');
const { mkdtempSync, rmSync, cpSync, existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { join, dirname } = require('path');
const os = require('os');
const net = require('net');

const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'server.js');
// Capture the REAL home before anyone overrides HOME. All copies read from here.
const REAL_HOME = process.env.HOME || os.homedir();

// Env vars that could redirect CliDeck or a spawned agent back to the real
// machine's config/data. Stripped from the child env so everything keys off
// HOME=tmpHome. Critical: if THIS process runs inside a CliDeck-spawned agent
// session, CLAUDE_CONFIG_DIR / CODEX_HOME / etc. may point at the real config —
// inheriting them would make the test server patch the real machine.
const REDIRECT_ENV = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'CLIDECK_SESSION_ID', 'CLIDECK_URL', 'CLIDECK_PORT', 'PORT',
];

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function childEnv(tmpHome, port) {
  const env = { ...process.env };
  for (const k of REDIRECT_ENV) delete env[k];
  env.HOME = tmpHome;
  env.CLIDECK_PORT = String(port);
  return env;
}

class Sandbox {
  constructor() {
    this.tmpHome = mkdtempSync(join(os.tmpdir(), 'clideck-smoke-'));
    chmodSync(this.tmpHome, 0o700);
    mkdirSync(join(this.tmpHome, 'work'), { recursive: true });
    this.port = null;
    this.proc = null;
    this.logs = [];
  }

  // Copy a real config path (file or dir) into tmpHome at the same relative
  // location. Returns true if it existed and was copied. Read-only on the real
  // machine — only the copy under tmpHome is ever patched.
  copyRealPath(relPath) {
    const src = join(REAL_HOME, relPath);
    if (!existsSync(src)) return false;
    const dest = join(this.tmpHome, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      cpSync(src, dest, { recursive: true, errorOnExist: false, force: true });
      return true;
    } catch {
      return false;
    }
  }

  // A per-session working directory inside the sandbox, so any file an agent
  // writes during a turn lands in tmpHome, never a real project.
  workDir(name) {
    const d = join(this.tmpHome, 'work', name);
    mkdirSync(d, { recursive: true });
    return d;
  }

  // Seed a minimal config.json so CliDeck's migrate() runs and auto-populates
  // the shipped agent presets (claude-code, codex, gemini-cli, opencode, pi) as
  // commands. On a fresh HOME with no config file, load() returns Shell-only and
  // skips migration. defaultPath points sessions at the sandbox work dir.
  //
  // `overrides` lets a provider pin its command/resumeCommand/env (e.g. Codex
  // needs `codex --dangerously-bypass-hook-trust` and CODEX_HOME). migrate()
  // keeps non-default command strings intact and backfills the rest, then adds
  // any presets not listed here. No-op if a config already exists.
  seedConfig(overrides = []) {
    mkdirSync(this.dataDir(), { recursive: true });
    const cfgPath = join(this.dataDir(), 'config.json');
    if (existsSync(cfgPath)) return;
    const commands = overrides.map((o, i) => ({
      id: `seed-${o.presetId}-${i}`,
      presetId: o.presetId,
      command: o.command,
      enabled: true,
      ...(o.resumeCommand ? { resumeCommand: o.resumeCommand } : {}),
      ...(o.env ? { env: o.env } : {}),
    }));
    writeFileSync(cfgPath, JSON.stringify({ defaultPath: join(this.tmpHome, 'work'), commands }, null, 2));
  }

  dataDir() { return join(this.tmpHome, '.clideck'); }
  sessionsJsonPath() { return join(this.dataDir(), 'sessions.json'); }
  lockPath() { return join(this.dataDir(), 'server.lock'); }

  readSavedSessions() {
    try { return JSON.parse(readFileSync(this.sessionsJsonPath(), 'utf8')); }
    catch { return []; }
  }

  recentLogs(n = 40) { return this.logs.join('').split('\n').slice(-n).join('\n'); }

  async start() {
    this.seedConfig();
    if (!this.port) this.port = await pickFreePort();
    const env = childEnv(this.tmpHome, this.port);
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => this.logs.push(d.toString()));
    this.proc.stderr.on('data', (d) => this.logs.push(d.toString()));
    let exited = null;
    this.proc.once('exit', (code, sig) => { exited = { code, sig }; });
    await this._waitForListening(() => exited);
    return this.port;
  }

  _waitForListening(getExit, timeoutMs = 20000) {
    const port = this.port;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tryOnce = () => {
        const exit = getExit();
        if (exit) {
          return reject(new Error(`server exited before listening (code=${exit.code} sig=${exit.sig})\n${this.recentLogs()}`));
        }
        if (Date.now() > deadline) {
          return reject(new Error(`server did not listen within ${timeoutMs}ms\n${this.recentLogs()}`));
        }
        const sock = net.connect(port, '127.0.0.1');
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error', () => { sock.destroy(); setTimeout(tryOnce, 200); });
      };
      tryOnce();
    });
  }

  // Stop the server. graceful=true sends SIGTERM so server.js runs its shutdown
  // path (saveSessions writes tmpHome/.clideck/sessions.json) before exit.
  stop(graceful = true) {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let killTimer;
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      proc.once('exit', done);
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 8000);
      proc.kill(graceful ? 'SIGTERM' : 'SIGKILL');
    });
  }

  // Positive evidence the server used the sandbox data dir (not the real one).
  sandboxWasUsed() { return existsSync(this.lockPath()) || existsSync(this.dataDir()); }

  async cleanup() {
    if (this.proc) await this.stop(false);
    try { rmSync(this.tmpHome, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { Sandbox, REAL_HOME, REDIRECT_ENV };
