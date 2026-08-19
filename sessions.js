const pty = require('node-pty');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const { parseCommand, resolveValidDir, defaultShell, binName } = require('./utils');
const activity = require('./activity');
const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const opencodeBridge = require('./opencode-bridge');
const piBridge = require('./pi-bridge');
const plugins = require('./plugin-loader');
const { presetForCommand, menuStartsWork } = require('./preset-utils');
const { lineageOf } = require('./lineage');
const { stripAnsi } = require('./ansi-utils');
const { withCliDeckGuide } = require('./agent-session-guide');
const { initialResumeReady, hasUsableResumeToken } = require('./resume-readiness');
const { ServerCapture } = require('./server-capture');
const { createSessionStream } = require('./session-stream');
const { normalizeTerminalSize } = require('./terminal-size');
const { ReplayRing } = require('./replay-ring');

const THEMES = require('./themes');
const MAX_BUFFER = 2 * 1024 * 1024;
const { PORT, localUrl } = require('./runtime');
const PRESETS = JSON.parse(require('fs').readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;
const { DATA_DIR } = require('./paths');
const SAVED_PATH = join(DATA_DIR, 'sessions.json');
const sessions = new Map();
const clients = new Set();

function clearActivityTimer(session) {
  clearTimeout(session?._activityTimer);
  if (session) session._activityTimer = null;
}

function terminalReplyKind(data) {
  const value = String(data || '');
  if (/^\x1b\[\??\d+(?:;\d+)*R$/.test(value)) return 'cursor-position';
  if (/^\x1b\[(?:\?|>)?[\d;]*c$/.test(value)) return 'device-attributes';
  return '';
}

function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  session.pty.resize(cols, rows);
  session.capture.resize(cols, rows);
  return true;
}

const stream = createSessionStream({
  clients,
  getSession: id => sessions.get(id),
  snapshot: id => {
    const session = sessions.get(id);
    if (!session) throw new Error('session is not available');
    return session.capture.snapshot();
  },
  applyResize: resizeSession,
});
stream.start();

// Persisted sessions awaiting resume (loaded on startup, cleared as they're resumed)
let resumable = [];

const broadcastListeners = [];

function addBroadcastListener(fn) {
  broadcastListeners.push(fn);
  return () => {
    const idx = broadcastListeners.indexOf(fn);
    if (idx >= 0) broadcastListeners.splice(idx, 1);
  };
}

function broadcast(msg) {
  for (const client of clients) stream.sendControl(client, msg);
  if (msg.type === 'session.status') {
    // Status broadcasts currently also apply the local state transition. This is
    // intentional for now but couples transport with session state; if this area
    // changes, split it into a dedicated setSessionStatus() transition first.
    const s = sessions.get(msg.id);
    if (s) {
      s.working = !!msg.working;
      if (msg.working && msg.source === 'hook') {
        s._resolvedMenuKey = '';
      }
      // Codex approval flows can pause on a menu and then continue into a normal
      // reply; keep idle finalization enabled there so the completed post-menu
      // answer is not lost. Other agents still suppress transcript finalization on menu.
      s._finalizeOnIdle = !msg.working && msg.source !== 'esc' && (msg.source !== 'menu' || s.presetId === 'codex');
      if (!msg.working && msg.source !== 'menu') scheduleCapture(msg.id, 300);
      // if (s.presetId === 'claude-code') {
      //   console.log(`[claude] broadcast status session=${msg.id.slice(0,8)} working=${!!msg.working} source=${msg.source} finalizeOnIdle=${!!s._finalizeOnIdle}`);
      // }
      // if (s.presetId === 'codex') console.log(`[codex] status session=${msg.id.slice(0,8)} working=${!!msg.working} source=${msg.source}`);
    }
    plugins.notifyStatus(msg.id, msg.working, msg.source);
  }
  for (const fn of broadcastListeners) try { fn(msg); } catch {}
}

function emitSessionActivity(id, session) {
  if (sessions.get(id) !== session) return;
  const now = Date.now();
  const elapsed = now - (session._activitySentAt || 0);
  if (elapsed < 1000) {
    if (!session._activityTimer) {
      session._activityTimer = setTimeout(() => {
        session._activityTimer = null;
        emitSessionActivity(id, session);
      }, 1000 - elapsed);
      session._activityTimer.unref?.();
    }
    return;
  }
  session._activitySentAt = now;
  broadcast({
    type: 'session.activity', id,
    generation: session.outputGeneration,
    atSeq: session.outputSeq,
    timestamp: new Date(now).toISOString(),
  });
}

function scheduleCapture(id, delay = 0, options = {}) {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session._captureTimer);
  session._captureTimer = setTimeout(() => capture(id, options), delay);
}

async function capture(id, { menuVersion, settled = false } = {}) {
  const session = sessions.get(id);
  if (!session) return false;
  const captureRef = session.capture;
  const lines = await captureRef.lines();
  if (sessions.get(id) !== session || session.capture !== captureRef) return false;

  const rawChoices = transcript.detectMenu(lines, session.presetId);
  let choices = rawChoices;
  if (choices && session.presetId === 'codex') {
    const last = telemetry.getLastEvent(id);
    if (!last.startsWith('codex.sse_event:response.completed')) choices = null;
  }
  if (choices && session.presetId === 'claude-code' && menuVersion
    && (session._menuConsumedVersion || 0) >= menuVersion) choices = null;
  let key = choices ? JSON.stringify(choices) : '';
  if (choices && session.presetId === 'claude-code' && key === (session._resolvedMenuKey || '')) {
    choices = null;
    key = '';
  }
  const candidateLines = (choices || (rawChoices && session.presetId === 'claude-code'))
    ? transcript.stripMenu(lines, session.presetId)
    : lines;
  transcript.updateAgentCandidate(id, session.presetId, candidateLines);

  if (!session.working && session._finalizeOnIdle) {
    session._finalizeOnIdle = false;
    transcript.commitAgentCandidate(id, session.presetId);
  } else if (session._finalizeOnCapture && settled) {
    transcript.commitAgentCandidate(id, session.presetId);
  }
  if (choices && plugins.shouldAutoApproveMenu(id)) {
    setTimeout(() => input({ id, data: '\r' }), 500);
  }
  if (choices) transcript.commitAgentCandidate(id, session.presetId);
  if (key !== (session._menuKey || '')) {
    session._menuKey = key;
    session._menuStartsWork = menuStartsWork(session.presetId, !!menuVersion, session._finalizeOnCapture);
    broadcast({ type: 'session.menu', id, choices: choices || [] });
    if (choices) {
      if (session.presetId === 'claude-code' && menuVersion) session._menuActiveVersion = menuVersion;
      plugins.notifyMenu(id, choices);
      if (session.presetId === 'codex') telemetry.cancelCodexMenuPoll(id);
      broadcast({ type: 'session.status', id, working: false, source: 'menu' });
    }
  }

  const candidate = transcript.getAgentCandidate(id);
  const preview = String(candidate || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || '';
  if (preview && preview !== session.lastPreview) {
    session.lastPreview = preview;
    session.lastActivityAt = new Date().toISOString();
    broadcast({ type: 'session.preview', id, text: preview });
  }
  return true;
}

// --- Spawn a PTY and wire up a session ---

function matchPreset(cmd) { return presetForCommand(cmd, PRESETS); }

function commandEnv(cmd) {
  const env = {};
  if (!cmd?.env || typeof cmd.env !== 'object' || Array.isArray(cmd.env)) return env;
  for (const [key, value] of Object.entries(cmd.env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(value ?? '');
  }
  return env;
}

function buildTelemetryEnv(id, cmd) {
  const preset = matchPreset(cmd);
  const telemetryEnabled = cmd.telemetryEnabled ?? (preset?.presetId === 'claude-code');
  const env = { CLIDECK_SESSION_ID: id, CLIDECK_PORT: String(PORT), CLIDECK_URL: localUrl() };
  if (!preset?.telemetryEnv || !telemetryEnabled) return env;
  for (const [k, v] of Object.entries(preset.telemetryEnv)) {
    env[k] = v.replace('{{port}}', String(PORT));
  }
  // Tag events with our session ID so the receiver can map them
  const existing = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  env.OTEL_RESOURCE_ATTRIBUTES = (existing ? existing + ',' : '') + `clideck.session_id=${id}`;
  return env;
}

function isLightTheme(themeId) {
  const t = THEMES.find(th => th.id === themeId);
  if (!t) return false;
  const bg = t.theme.background;
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function spawnSession(id, cmd, parts, cwd, name, themeId, commandId, savedToken, projectId, cols, rows) {
  const preset = matchPreset(cmd);
  const launchParts = withCliDeckGuide(parts, preset?.presetId);
  const telemetryEnv = buildTelemetryEnv(id, cmd);
  const colorEnv = isLightTheme(themeId) ? { COLORFGBG: '0;15' } : { COLORFGBG: '15;0' };
  const extraEnv = commandEnv(cmd);
  let term;
  try {
    term = pty.spawn(launchParts[0], launchParts.slice(1), {
      name: 'xterm-256color', cols, rows, cwd,
      env: { ...process.env, ...extraEnv, ...telemetryEnv, ...colorEnv },
    });
  } catch (e) {
    return e;
  }

  const sessionIdRe = cmd.sessionIdPattern ? new RegExp(cmd.sessionIdPattern, 'i') : null;
  const session = {
    name,
    themeId,
    commandId,
    cwd,
    pty: term,
    replayRing: new ReplayRing(MAX_BUFFER),
    outputGeneration: crypto.randomUUID(),
    outputSeq: 0,
    sessionToken: savedToken || null,
    _resumeReady: initialResumeReady(preset?.presetId || 'shell', savedToken),
    projectId: projectId || null,
    presetId: preset?.presetId || 'shell',
    working: undefined,
    _finalizeOnCapture: !!preset?.finalizeOnCapture,
  };
  session.capture = new ServerCapture({
    cols,
    rows,
    onReply: data => term.write(data),
  });
  sessions.set(id, session);
  transcript.setFinalizeOnIdle(id, ['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi', 'clideck-agent', 'grok'].includes(lineageOf(session.presetId)) ? session.presetId : null);

  // Always watch telemetry-backed agents so OTLP fallback matching can attach
  // early events to this session even when the agent omits clideck.session_id.
  // The receiver itself decides whether to surface a setup prompt.
  if (preset?.telemetryEnv) telemetry.watchSession(id, binName(cmd.command));
  if (preset?.bridge === 'opencode') opencodeBridge.watchSession(id, cwd);

  term.onData((data) => {
    const startSeq = session.outputSeq;
    session.outputSeq += data.length;
    session.replayRing.append(data, startSeq);
    // Capture session ID from output
    if (sessionIdRe && !session.sessionToken) {
      const recentOutput = session.replayRing.suffix(64 * 1024);
      const match = recentOutput.match(sessionIdRe) || stripAnsi(recentOutput).match(sessionIdRe);
      if (match) {
        session.sessionToken = match[1];
        console.log(`Session ${id.slice(0, 8)}: captured token via output regex: ${match[1].slice(0, 12)}…`);
      }
    }
    activity.trackOut(id, data);
    transcript.trackOutput(id, data);
    session.capture.write(data, session.outputSeq);
    emitSessionActivity(id, session);
    scheduleCapture(id, 2000, { settled: true });
    plugins.notifyOutput(id, data);
    stream.queueOutput(id, data, startSeq, session.outputSeq);
  });

  term.onExit(() => {
    // Skip cleanup if this PTY was replaced by a restart
    const s = sessions.get(id);
    if (s?.pty !== term) return;
    activity.clear(id);
    telemetry.clear(id);
    opencodeBridge.clear(id);
    piBridge.clear(id);
    plugins.clearStatus(id);
    clearTimeout(s._captureTimer);
    clearActivityTimer(s);
    stream.clearSession(id);
    s.capture?.dispose();
    const canPersist = !s.ephemeral && cmd.canResume && cmd.resumeCommand && hasUsableResumeToken(s);
    // If resumable and a durable token was captured, move to resumable list.
    if (canPersist) {
      resumable.push({
        id, name: s.name, commandId: s.commandId, presetId: s.presetId || 'shell', cwd: s.cwd,
        themeId: s.themeId, sessionToken: s.sessionToken, projectId: s.projectId, muted: !!s.muted,
        lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
        savedAt: new Date().toISOString(),
      });
      console.log(`Session ${id.slice(0, 8)}: moved to resumable on exit (token: ${s.sessionToken.slice(0, 12)}…)`);
    } else {
      transcript.clear(id);
    }
    sessions.delete(id);
    broadcast({ type: 'closed', id });
    if (canPersist) {
      broadcast({ type: 'sessions.resumable', list: getResumable() });
    }
  });

  return null;
}

// --- Create a new session ---

function normalizeSessionName(name) {
  return String(name || '').trim().toLowerCase();
}

function sessionNameExistsInScope(name, projectId, exceptId = null) {
  const wanted = normalizeSessionName(name);
  if (!wanted) return false;
  const scope = projectId || null;
  for (const [id, s] of sessions) {
    if (id === exceptId) continue;
    if ((s.projectId || null) !== scope) continue;
    if (normalizeSessionName(s.name) === wanted) return true;
  }
  return false;
}

function create(msg, ws, cfg) {
  const id = crypto.randomUUID();
  const cmd = cfg.commands.find(c => c.id === msg.commandId)
    || cfg.commands[0]
    || { label: 'Shell', command: defaultShell };
  const parts = parseCommand(cmd.command);
  const cwd = resolveValidDir(msg.cwd || cmd.defaultPath || cfg.defaultPath);
  const themeId = msg.themeId || cfg.defaultTheme || 'default';
  const name = msg.name || cmd.label;

  const projectId = msg.projectId || null;
  const size = normalizeTerminalSize(msg.cols, msg.rows);
  if (!size.ok) {
    ws.send(JSON.stringify({ type: 'error', message: size.error }));
    return;
  }
  if (sessionNameExistsInScope(name, projectId)) {
    ws.send(JSON.stringify({ type: 'error', message: `Agent name "${name}" is already taken in this project.` }));
    return;
  }
  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id, null, projectId, size.cols, size.rows);
  if (err) {
    console.error('Failed to spawn pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  const createdPresetId = matchPreset(cmd)?.presetId || 'shell';
  const installId = msg.installId || undefined;
  broadcast({ type: 'created', id, name, themeId, commandId: cmd.id, presetId: createdPresetId, projectId, installId });

  // Immediate setup notification if config not detected
  const preset = matchPreset(cmd);
  if (preset && (preset.telemetrySetup || preset.bridge) && !(cmd.telemetryEnabled && cmd.telemetryStatus?.ok)) {
    broadcast({ type: 'session.needsSetup', id });
  }
}

// --- Programmatic session creation (for plugins / internal use) ---

function createProgrammatic(opts, cfg) {
  const id = crypto.randomUUID();
  let cmd;
  if (opts.presetId) cmd = cfg.commands.find(c => c.presetId === opts.presetId);
  else if (opts.commandId) cmd = cfg.commands.find(c => c.id === opts.commandId);
  if (!cmd) return { error: 'Command not found' };

  const parts = parseCommand(cmd.command);
  const cwd = resolveValidDir(opts.cwd || cmd.defaultPath || cfg.defaultPath);
  const themeId = opts.themeId || cfg.defaultTheme || 'default';
  const name = opts.name || cmd.label;
  const projectId = opts.projectId || null;
  const size = normalizeTerminalSize(opts.cols, opts.rows);
  if (!size.ok) return { error: size.error };
  if (sessionNameExistsInScope(name, projectId)) {
    return { error: `Agent name "${name}" is already taken in this project.` };
  }

  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id, null, projectId, size.cols, size.rows);
  if (err) return { error: err.message };

  const s = sessions.get(id);
  if (s) {
    if (opts.ephemeral) s.ephemeral = true;
    if (opts.spawnedBySessionId) {
      s.spawnedBySessionId = opts.spawnedBySessionId;
      s.spawnRootSessionId = opts.spawnRootSessionId || opts.spawnedBySessionId;
      s.spawnDepth = Number(opts.spawnDepth) || 1;
    }
  }

  const presetId = matchPreset(cmd)?.presetId || 'shell';
  broadcast({
    type: 'created', id, name, themeId, commandId: cmd.id, presetId, projectId,
    spawnedBySessionId: s?.spawnedBySessionId || null,
    spawnRootSessionId: s?.spawnRootSessionId || null,
    spawnDepth: s?.spawnDepth || 0,
  });
  return { id };
}

// --- Resume a persisted session ---

function resume(msg, ws, cfg) {
  const saved = resumable.find(s => s.id === msg.id);
  if (!saved) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found in resumable list' }));
    return;
  }

  const cmd = cfg.commands.find(c => c.id === saved.commandId);
  if (!cmd || !cmd.canResume || !cmd.resumeCommand) {
    ws.send(JSON.stringify({ type: 'error', message: 'Command does not support resume' }));
    return;
  }
  const size = normalizeTerminalSize(msg.cols, msg.rows);
  if (!size.ok) {
    ws.send(JSON.stringify({ type: 'error', message: size.error }));
    return;
  }

  // Build the resume command, substituting {{sessionId}} if present
  const cwd = resolveValidDir(saved.cwd || cfg.defaultPath);
  let resumeStr = cmd.resumeCommand;
  if (resumeStr.includes('{{sessionId}}')) {
    if (!saved.sessionToken) {
      ws.send(JSON.stringify({ type: 'error', message: 'No session ID captured — cannot resume' }));
      return;
    }
    resumeStr = resumeStr.replace('{{sessionId}}', saved.sessionToken);
  }

  const parts = parseCommand(resumeStr);
  const id = saved.id;

  const err = spawnSession(id, cmd, parts, cwd, saved.name, saved.themeId || saved.profileId || 'default', saved.commandId, saved.sessionToken, saved.projectId, size.cols, size.rows);
  if (err) {
    console.error('Failed to resume pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  const s = sessions.get(id);
  if (s) {
    if (saved.muted) s.muted = true;
  }

  // Remove from resumable list and notify all clients
  resumable = resumable.filter(s => s.id !== id);
  broadcast({ type: 'sessions.resumable', list: getResumable(cfg) });

  const resumePresetId = matchPreset(cmd)?.presetId || saved.presetId || 'shell';
  broadcast({ type: 'created', id, name: saved.name, themeId: saved.themeId || saved.profileId || 'default', commandId: saved.commandId, presetId: resumePresetId, projectId: saved.projectId || null, muted: !!saved.muted, resumed: true, lastPreview: saved.lastPreview || '' });
}

// --- Standard session operations ---

function writeSessionInput(id, data) {
  transcript.trackInput(id, data);
  sessions.get(id)?.pty.write(data);
}

function input(msg, ws) {
  const s = sessions.get(msg.id);
  if (!s) return;
  if (ws && terminalReplyKind(msg.data)) return;
  if (ws) stream.claimResize(ws, msg.id);
  const data = plugins.transformInput(msg.id, msg.data);
  activity.trackIn(msg.id, data.length);
  // Menu choice selected → back to working (Enter or digit keys only)
  if (s._menuKey && !s.working && (data === '\r' || /^[1-9]$/.test(data))) {
    // Approval/denial menus can leave a transient tool line as the latest
    // parsed candidate; clear it before the next real reply starts.
    transcript.clearAgentCandidate(msg.id);
    s.pty.write(data);
    // Autopilot may need to retry the same approval menu if the first Enter
    // does not actually take, so only suppress same-menu re-detection for
    // manual flows.
    if (!plugins.shouldAutoApproveMenu(msg.id)) s._resolvedMenuKey = s._menuKey;
    if (s._menuActiveVersion) s._menuConsumedVersion = s._menuActiveVersion;
    const menuStartsWork = s._menuStartsWork !== false;
    s._menuKey = '';
    s._menuStartsWork = undefined;
    broadcast({ type: 'session.menu', id: msg.id, choices: [] });
    if (menuStartsWork) {
      broadcast({ type: 'session.status', id: msg.id, working: true, source: 'menu-input' });
    }
    return;
  }
  writeSessionInput(msg.id, data);
  if (data === '\x1b' && s.working) {
    transcript.clearAgentCandidate(msg.id);
    broadcast({ type: 'session.status', id: msg.id, working: false, source: 'esc' });
  }
}
function resize(msg, ws) { return ws ? stream.resize(ws, msg) : false; }

function rename(msg) {
  const s = sessions.get(msg.id);
  if (!s) return;
  const name = String(msg.name || '').trim();
  if (!name) return;
  if (sessionNameExistsInScope(name, s.projectId, msg.id)) {
    broadcast({ type: 'session.renameRejected', id: msg.id, name: s.name, message: `Agent name "${name}" is already taken in this project.` });
    return;
  }
  s.name = name;
  broadcast({ type: 'renamed', id: msg.id, name });
}

function setTheme(id, themeId) {
  const s = sessions.get(id);
  if (s) { s.themeId = themeId; return true; }
  return false;
}

function setMute(id, muted) {
  const s = sessions.get(id);
  if (s) { s.muted = !!muted; return true; }
  return false;
}

function close(msg, cfg) {
  const s = sessions.get(msg.id);
  if (s) {
    clearTimeout(s._captureTimer);
    clearActivityTimer(s);
    stream.clearSession(msg.id);
    s.capture?.dispose();
    s.pty.kill();
    telemetry.clear(msg.id);
    opencodeBridge.clear(msg.id);
    piBridge.clear(msg.id);
    transcript.clear(msg.id);
    plugins.clearStatus(msg.id);
    sessions.delete(msg.id);
    broadcast({ type: 'closed', id: msg.id });
  }
  // Also remove from resumable list if present
  const before = resumable.length;
  resumable = resumable.filter(r => r.id !== msg.id);
  if (resumable.length !== before) broadcast({ type: 'sessions.resumable', list: getResumable(cfg) });
}

// Restart a live session's PTY with updated env (e.g. after polarity flip).
// Uses resume command if available, otherwise re-launches the original command.
function restart(msg, ws, cfg) {
  const id = msg.id;
  // console.log('[restart] received', { id, themeId: msg.themeId });
  const s = sessions.get(id);
  if (!s) { ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'not found' })); return; }
  const cmd = cfg.commands.find(c => c.id === s.commandId);
  if (!cmd) { ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'command missing' })); return; }
  const size = normalizeTerminalSize(msg.cols, msg.rows);
  if (!size.ok) {
    ws.send(JSON.stringify({ type: 'session.restarted', id, error: size.error, retained: true }));
    return;
  }

  const themeId = msg.themeId || s.themeId;
  const canResume = cmd.canResume && cmd.resumeCommand && hasUsableResumeToken(s);

  let parts;
  if (canResume) {
    parts = parseCommand(cmd.resumeCommand.replace('{{sessionId}}', s.sessionToken));
  } else {
    parts = parseCommand(cmd.command);
  }

  const savedToken = canResume ? s.sessionToken : null;
  const { name, cwd, commandId, projectId, muted, lastPreview, lastActivityAt } = s;

  activity.clear(id);
  telemetry.clear(id);
  opencodeBridge.clear(id);
  piBridge.clear(id);
  transcript.clear(id);

  clearTimeout(s._captureTimer);
  clearActivityTimer(s);
  stream.clearSession(id);
  s.capture?.dispose();
  s.pty.kill();
  sessions.delete(id);

  const err = spawnSession(id, cmd, parts, cwd, name, themeId, commandId, savedToken, projectId, size.cols, size.rows);
  if (err) {
    console.error('[restart] spawn failed:', err.message);
    broadcast({ type: 'session.restarted', id, error: err.message });
    return;
  }

  const next = sessions.get(id);
  if (next) {
    next.muted = !!muted;
    next.lastPreview = lastPreview || '';
    next.lastActivityAt = lastActivityAt || null;
  }

  broadcast({ type: 'session.restarted', id, resumed: !!canResume });
}

function list() {
  return [...sessions].map(([id, s]) => ({
    id, name: s.name, themeId: s.themeId, commandId: s.commandId, presetId: s.presetId || 'shell', projectId: s.projectId, muted: !!s.muted,
    working: !!s.working,
    outputGeneration: s.outputGeneration,
    outputSeq: s.outputSeq,
    bufferStartSeq: s.replayRing.startSeq,
    // Last preview text for sidebar display on reconnect
    lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
    menu: s._menuKey ? JSON.parse(s._menuKey) : undefined,
  }));
}

// Store the latest preview text from the client (persisted by auto-save)
function setPreview(id, text, timestamp) {
  const s = sessions.get(id);
  if (!s) return false;
  s.lastPreview = (text || '').slice(0, 200);
  s.lastActivityAt = timestamp || new Date().toISOString();
  return true;
}

function setProject(id, projectId) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  const nextProjectId = projectId || null;
  if (sessionNameExistsInScope(s.name, nextProjectId, id)) {
    return { ok: false, error: `Agent name "${s.name}" is already taken in this project.` };
  }
  s.projectId = nextProjectId;
  return { ok: true };
}

function getResumable(cfg) {
  if (!cfg) return resumable;
  return resumable.map(s => {
    if (s.presetId) return s;
    const cmd = (cfg.commands || []).find(c => c.id === s.commandId);
    if (!cmd) return { ...s, presetId: 'shell' };
    const preset = matchPreset(cmd);
    return { ...s, presetId: preset?.presetId || 'shell' };
  });
}

// --- Persistence: save on shutdown, load on startup ---

function saveSessions(cfg) {
  // Only persist live sessions that are actually resumable
  let skippedNoToken = 0;
  let skippedNotReady = 0;
  const live = [...sessions]
    .filter(([, s]) => {
      if (s.ephemeral) return false;
      const cmd = cfg.commands.find(c => c.id === s.commandId);
      if (!cmd?.canResume || !cmd.resumeCommand) return false;
      // If resume needs a session ID, we must have captured one
      if (cmd.resumeCommand.includes('{{sessionId}}') && !s.sessionToken) {
        skippedNoToken++;
        return false;
      }
      if (cmd.resumeCommand.includes('{{sessionId}}') && !hasUsableResumeToken(s)) {
        skippedNotReady++;
        return false;
      }
      return true;
    })
    .map(([id, s]) => ({
      id, name: s.name, commandId: s.commandId, presetId: s.presetId || 'shell', cwd: s.cwd,
      themeId: s.themeId, sessionToken: s.sessionToken, projectId: s.projectId, muted: !!s.muted,
      lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
      savedAt: new Date().toISOString(),
    }));

  // Merge with still-pending resumables that were never resumed
  const liveIds = new Set(live.map(s => s.id));
  const pending = resumable.filter(s => !liveIds.has(s.id));
  const data = [...live, ...pending];

  writeFileSync(SAVED_PATH, JSON.stringify(data, null, 2));
  if (skippedNoToken > 0 && skippedNoToken !== lastSkippedNoTokenWarn) {
    console.warn(`Skipped ${skippedNoToken} resumable session(s): no session token captured`);
  }
  if (skippedNotReady > 0 && skippedNotReady !== lastSkippedNotReadyWarn) {
    console.warn(`Skipped ${skippedNotReady} resumable session(s): token is not durable yet`);
  }
  lastSkippedNoTokenWarn = skippedNoToken || null;
  lastSkippedNotReadyWarn = skippedNotReady || null;
  return data.length;
}

function loadSessions() {
  if (!existsSync(SAVED_PATH)) return;
  try {
    resumable = JSON.parse(readFileSync(SAVED_PATH, 'utf8'));
    console.log(`Loaded ${resumable.length} resumable session(s)`);
  } catch { resumable = []; }
}

let autoSaveInterval = null;
let getConfigFn = null;
let lastSkippedNoTokenWarn = null;
let lastSkippedNotReadyWarn = null;

function startAutoSave(getConfig) {
  getConfigFn = getConfig;
  if (autoSaveInterval) return;
  autoSaveInterval = setInterval(() => {
    const cfg = getConfigFn?.();
    if (!cfg) return;
    try {
      const count = saveSessions(cfg);
      if (count > 0) broadcast({ type: 'sessions.saved' });
    } catch (e) {
      console.error('Auto-save failed:', e.message);
    }
  }, 30000);
}

function shutdown(cfg) {
  clearInterval(autoSaveInterval);
  saveSessions(cfg);
  stream.stop();
  for (const [id, s] of sessions) {
    clearTimeout(s._captureTimer);
    clearActivityTimer(s);
    stream.clearSession(id);
    s.capture?.dispose();
    try { s.pty.kill(); } catch {}
  }
}

module.exports = {
  clients, broadcast, addBroadcastListener, getSessions: () => sessions,
  create, createProgrammatic, resume, restart, input, resize, rename, setTheme, setMute, setProject, setPreview, close,
  list, getResumable, capture,
  registerClient: stream.register,
  unregisterClient: stream.unregister,
  subscribe: stream.subscribe,
  unsubscribe: stream.unsubscribe,
  claimResize: stream.claimResize,
  sendControl: stream.sendControl,
  streamStats: stream.stats,
  stream,
  terminalReplyKind,
  loadSessions, startAutoSave, shutdown,
};
