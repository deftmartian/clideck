const http = require('http');
const { readFileSync, existsSync, statSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');
const { PORT, HOST, localUrl } = require('./runtime');
const { updateClaudeSessionToken } = require('./claude-session');
const {
  CLIENT_PROTOCOL_VERSION,
  clientProtocolVersionFromUrl,
  isClientProtocolCompatible,
} = require('./protocol');
const { CLIENT_BUILD_ID } = require('./client-build');

function terminalLink(url, text = url) {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

function openUrlHint() {
  return process.platform === 'darwin' ? 'Cmd+click to open' : 'Ctrl+click to open';
}

// --- Self-update check (runs before server starts) ---
const currentVersion = require('./package.json').version;
const { execFile, execSync } = require('child_process');
const shellOpt = process.platform === 'win32';

function checkSelfUpdate() {
  return new Promise(ok => {
    // Skip in non-interactive or local dev contexts
    if (!process.stdin.isTTY || !process.stdout.isTTY) return ok();
    if (!__dirname.includes(join('node_modules', 'clideck'))) return ok();
    execFile('npm', ['view', 'clideck', 'version'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
      if (err) return ok();
      const latest = stdout.trim();
      if (!latest || latest === currentVersion) return ok();
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n\x1b[38;5;105m  Update available:\x1b[0m \x1b[38;5;245m${currentVersion}\x1b[0m → \x1b[38;5;44m${latest}\x1b[0m\n\n  \x1b[38;5;252mUpdate now? [Y/n]\x1b[0m `, answer => {
        rl.close();
        if (answer.trim().toLowerCase() === 'n') return ok();
        console.log('\n  \x1b[38;5;245mUpdating...\x1b[0m\n');
        try {
          execSync('npm install -g clideck', { stdio: 'inherit', shell: true });
          console.log('\n  \x1b[38;5;44mUpdated to v' + latest + '. Restarting...\x1b[0m\n');
          const { spawn } = require('child_process');
          spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', shell: shellOpt }).on('close', code => process.exit(code));
          return;
        } catch {
          console.log('\n  \x1b[38;5;196mUpdate failed.\x1b[0m Continuing with v' + currentVersion + '.\n');
          ok();
        }
      });
    });
  });
}

checkSelfUpdate().then(() => {

const { acquireServerLock, removeLockIfOwned } = require('./single-instance');
const serverLock = acquireServerLock();
if (!serverLock.ok) {
  const url = serverLock.lock?.url || `http://127.0.0.1:${serverLock.lock?.port || PORT}`;
  const hint = terminalLink(url);
  console.log(`CliDeck is already running at ${hint}`);
  process.exit(0);
}

const { onConnection } = require('./handlers');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const plugins = require('./plugin-loader');

ensurePtyHelper();
sessions.loadSessions();
transcript.init(sessions.broadcast, new Set(sessions.getResumable().map(s => s.id)), (...args) => plugins.notifyTranscript(...args));
telemetry.init(sessions.broadcast, sessions.getSessions);
require('./opencode-bridge').init(sessions.broadcast, sessions.getSessions);
require('./pi-bridge').init(sessions.broadcast, sessions.getSessions);
const config = require('./config');
plugins.init(sessions.broadcast, sessions.getSessions, () => require('./handlers').getConfig(), (cfg) => config.save(cfg), sessions.input, sessions.createProgrammatic, sessions.close);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
};
const ALIASES = {
  '/xterm.css':    require.resolve('@xterm/xterm/css/xterm.css'),
  '/xterm.js':     require.resolve('@xterm/xterm/lib/xterm.js'),
  '/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');
const geminiMenuPoll = new Map();

function staticHeaders(filePath) {
  const stats = statSync(filePath);
  const headers = {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'ETag': `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
    'X-Content-Type-Options': 'nosniff',
  };
  if (filePath === join(PUBLIC_ROOT, 'sw.js')) headers['Service-Worker-Allowed'] = '/';
  return headers;
}

function startGeminiMenuPoll(id) {
  const prev = geminiMenuPoll.get(id);
  if (prev) clearInterval(prev);
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > 3000) {
      clearInterval(timer);
      geminiMenuPoll.delete(id);
      return;
    }
    sessions.broadcast({ type: 'terminal.capture', id });
  }, 500);
  geminiMenuPoll.set(id, timer);
}

const server = http.createServer((req, res) => {
  // OTLP telemetry endpoint — receives JSON from CLI agents
  // Some agents (Gemini) POST to / instead of /v1/logs
  if (req.method === 'POST' && (req.url === '/v1/logs' || req.url === '/')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); return; }
    });
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      try { req.body = JSON.parse(body); } catch {
        console.log(`OTLP: failed to parse body (content-type: ${contentType}, ${body.length} bytes)`);
        req.body = null;
      }
      telemetry.handleLogs(req, res);
    });
    return;
  }

  // Codex lifecycle hooks. Silent hooks call start/stop directly; legacy notify still arms a stop.
  if (req.method === 'POST' && req.url.startsWith('/hook/codex/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/codex/'.length);
        const clideckId = payload.clideck_id;
        const threadId = payload['thread-id'] || payload.session_id;
        const allSessions = sessions.getSessions();
        let matchedId = null;
        if (clideckId && allSessions.has(clideckId)) {
          matchedId = clideckId;
        } else if (threadId) {
          for (const [id, s] of allSessions) {
            if (s.sessionToken === threadId) {
              matchedId = id;
              break;
            }
          }
        }
        if (matchedId) {
          const sess = allSessions.get(matchedId);
          if (sess && threadId && !sess.sessionToken) sess.sessionToken = threadId;
          const telemetry = require('./telemetry-receiver');
          if (route === 'start') telemetry.markCodexStart(matchedId, 'hook');
          else if (route === 'stop') telemetry.armCodexStop(matchedId);
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Claude Code hook endpoints — deterministic start/stop/idle signals
  if (req.method === 'POST' && req.url.startsWith('/hook/claude/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/claude/'.length);
        const sessionId = payload.session_id;
        const allSessions = sessions.getSessions();
        const clideckId = payload.clideck_id && allSessions.has(payload.clideck_id)
          ? payload.clideck_id
          : sessionId
            ? [...allSessions].find(([, s]) => s.sessionToken === sessionId)?.[0]
            : null;
        if (clideckId) {
          const sess = allSessions.get(clideckId);
          if (route !== 'session-end') {
            updateClaudeSessionToken(sess, sessionId, clideckId, { label: 'Claude', source: `hook:${route}`, origin: 'hook' });
          }
          if (route === 'start') {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: true, source: 'hook' });
          } else if (route === 'stop' || route === 'idle' || route === 'session-end') {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
            // Stop, idle, and SessionEnd all mean Claude is settled enough to
            // snapshot the visible transcript. Resume/clear flows can emit
            // SessionEnd without a normal Stop event.
            setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId }), 500);
          } else if (route === 'session-start') {
            const source = String(payload.source || '').toLowerCase();
            // Startup/resume/clear SessionStart means Claude is back at an
            // interactive prompt. Compact can happen around active work, so do
            // not use it as an idle signal.
            if (source !== 'compact') {
              sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
              setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId }), 500);
            }
          } else if (route === 'menu') {
            // PreToolUse: trigger terminal capture — detectMenu will set idle if a choice menu is visible
            const menuVersion = sess ? ((sess._menuVersion || 0) + 1) : 1;
            if (sess) sess._menuVersion = menuVersion;
            setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId, menuVersion }), 500);
          }
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Gemini hook endpoints — deterministic start/stop/menu signals
  if (req.method === 'POST' && req.url.startsWith('/hook/gemini/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/gemini/'.length);
        const allSessions = sessions.getSessions();
        const clideckId = payload.clideck_id && allSessions.has(payload.clideck_id)
          ? payload.clideck_id
          : [...allSessions].find(([, s]) => s.sessionToken === payload.session_id)?.[0];
        if (clideckId) {
          const s = allSessions.get(clideckId);
          if (s && payload.session_id && !s.sessionToken) s.sessionToken = payload.session_id;
          if (route === 'menu') {
            startGeminiMenuPoll(clideckId);
          } else {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: route === 'start', source: 'hook' });
          }
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Grok Build hook endpoints — Claude-shaped lifecycle events (camelCase on wire)
  if (req.method === 'POST' && req.url.startsWith('/hook/grok/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/grok/'.length);
        const sessionId = payload.session_id || '';
        const allSessions = sessions.getSessions();
        const clideckId = payload.clideck_id && allSessions.has(payload.clideck_id)
          ? payload.clideck_id
          : sessionId
            ? [...allSessions].find(([, s]) => s.sessionToken === sessionId)?.[0]
            : null;
        if (clideckId) {
          const sess = allSessions.get(clideckId);
          if (sess && sessionId && route !== 'session-end') {
            if (sess.sessionToken !== sessionId) {
              const prev = sess.sessionToken;
              sess.sessionToken = sessionId;
              sess.sessionTokenOrigin = 'hook';
              const previous = prev ? `${prev.slice(0, 12)}... -> ` : '';
              console.log(`Grok: updated session ID for ${clideckId.slice(0, 8)} via hook:${route}: ${previous}${sessionId.slice(0, 12)}...`);
            }
          }
          if (route === 'start') {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: true, source: 'hook' });
          } else if (route === 'stop' || route === 'session-end') {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
            setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId }), 500);
          } else if (route === 'session-start') {
            const source = String(payload.source || '').toLowerCase();
            // Compact can fire mid-turn; only treat interactive starts as idle.
            if (source !== 'compact') {
              sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
              setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId }), 500);
            }
          } else if (route === 'menu') {
            const menuVersion = sess ? ((sess._menuVersion || 0) + 1) : 1;
            if (sess) sess._menuVersion = menuVersion;
            setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId, menuVersion }), 500);
          }
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // OpenCode plugin bridge events
  if (req.method === 'POST' && req.url === '/opencode-events') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { require('./opencode-bridge').handleEvent(JSON.parse(body)); } catch (e) { console.error('[opencode-bridge] handleEvent error:', e); }
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Pi extension bridge events
  if (req.method === 'POST' && req.url === '/hook/pi') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { require('./pi-bridge').handleEvent(JSON.parse(body)); } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Session-to-session ask bridge used by the `clideck ask` CLI command.
  if (req.method === 'POST' && req.url === '/api/session/ask') {
    require('./session-ask').handleHttp(req, res, sessions, () => config.load());
    return;
  }

  // Agent discovery bridge used by the `clideck agents` CLI command.
  if (req.method === 'GET' && req.url.startsWith('/api/session/agents')) {
    require('./session-agents').handleHttp(req, res, sessions, () => config.load());
    return;
  }

  // Programmatic session creation used by the `clideck spawn` CLI command.
  if (req.method === 'POST' && req.url === '/api/session/spawn') {
    require('./session-spawn').handleHttp(req, res, sessions, () => config.load());
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({
      ok: true,
      version: currentVersion,
      buildId: CLIENT_BUILD_ID,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
    }));
    return;
  }

  // DEBUG: log any POST (agents might use /v1/traces, /v1/metrics, or other paths)
  if (req.method === 'POST') {
    // console.log(`OTLP: received POST ${req.url} (not handled)`);
    return res.writeHead(200).end('{}');
  }

  // Plugin static files (/plugins/<id>/client.js, /plugins/<id>/public/*)
  if (req.url.startsWith('/plugins/')) {
    const pluginFile = plugins.resolveFile(req.url);
    if (pluginFile) {
      res.writeHead(200, {
        'Content-Type': MIME[extname(pluginFile)] || 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(readFileSync(pluginFile));
    }
    return res.writeHead(404).end();
  }

  let requestPath;
  try { requestPath = new URL(req.url, 'http://clideck.local').pathname; }
  catch { return res.writeHead(400).end(); }

  const filePath = ALIASES[requestPath]
    || resolve(PUBLIC_ROOT, (requestPath === '/' ? 'index.html' : requestPath).replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_ROOT) && !ALIASES[requestPath]) return res.writeHead(403).end();
  if (!existsSync(filePath)) return res.writeHead(404).end();
  try {
    const headers = staticHeaders(filePath);
    if (req.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(readFileSync(filePath));
  } catch { res.writeHead(500).end(); }
});

const allowedOrigins = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`, `http://${HOST}:${PORT}`,
]);
function isAllowedWsOrigin(origin, hostHeader) {
  if (!origin) return true; // non-browser clients
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === hostHeader) return true;
    return allowedOrigins.has(origin);
  } catch {
    return false;
  }
}
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => {
    return isAllowedWsOrigin(req.headers.origin, req.headers.host);
  },
});
wss.on('connection', (ws, req) => {
  const receivedProtocolVersion = clientProtocolVersionFromUrl(req.url);
  if (!isClientProtocolCompatible(receivedProtocolVersion)) {
    const payload = JSON.stringify({
      type: 'protocol.incompatible',
      expectedProtocolVersion: CLIENT_PROTOCOL_VERSION,
      receivedProtocolVersion: receivedProtocolVersion ?? null,
      version: currentVersion,
      buildId: CLIENT_BUILD_ID,
    });
    const close = () => {
      try { ws.close(1008, 'unsupported CliDeck client protocol'); } catch {}
    };
    try { ws.send(payload, close); } catch { close(); }
    return;
  }
  onConnection(ws);
});

sessions.startAutoSave(() => require('./handlers').getConfig());

// Graceful shutdown: persist sessions before exit
const { getConfig } = require('./handlers');
function onShutdown() {
  plugins.shutdown();
  sessions.shutdown(getConfig());
  removeLockIfOwned();
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);
process.on('exit', removeLockIfOwned);

server.listen(PORT, HOST, () => {
  const v = require('./package.json').version;
  const url = localUrl();
  const clickableUrl = terminalLink(url);
  const urlHint = openUrlHint();
  console.log(`
\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;239m   ██████╗\x1b[38;5;242m██╗     \x1b[38;5;245m██╗\x1b[38;5;105m██████╗ \x1b[38;5;141m███████╗\x1b[38;5;147m ██████╗\x1b[38;5;183m██╗  ██╗\x1b[0m
\x1b[38;5;239m  ██╔════╝\x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██╔══██╗\x1b[38;5;141m██╔════╝\x1b[38;5;147m██╔════╝\x1b[38;5;183m██║ ██╔╝\x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m█████╗  \x1b[38;5;147m██║     \x1b[38;5;183m█████╔╝ \x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m██╔══╝  \x1b[38;5;147m██║     \x1b[38;5;183m██╔═██╗ \x1b[0m
\x1b[38;5;239m  ╚██████╗\x1b[38;5;242m███████╗\x1b[38;5;245m██║\x1b[38;5;105m██████╔╝\x1b[38;5;141m███████╗\x1b[38;5;147m╚██████╗\x1b[38;5;183m██║  ██╗\x1b[0m
\x1b[38;5;239m   ╚═════╝\x1b[38;5;242m╚══════╝\x1b[38;5;245m╚═╝\x1b[38;5;105m╚═════╝ \x1b[38;5;141m╚══════╝\x1b[38;5;147m ╚═════╝\x1b[38;5;183m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${v}\x1b[0m

\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${clickableUrl}\x1b[38;5;245m (${urlHint})\x1b[0m
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m
${HOST !== '127.0.0.1' ? '\x1b[38;5;208m  ▸ Warning: listening on ' + HOST + ' — no authentication, anyone on the network can connect\x1b[0m\n' : ''}`);
});

}); // checkSelfUpdate
