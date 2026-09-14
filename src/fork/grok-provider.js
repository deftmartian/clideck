const { homedir } = require('os');
const { join } = require('path');
const { openSync, readSync, fstatSync, closeSync } = require('fs');
const hooks = require('./grok-hooks');
const { watchGrokContext } = require('./grok-context');
const { AGENT_SESSION_GUIDE } = require('../agent-session-guide');
const menu = require('../menu-screen').createMenuParser({ selectionMarker: /[›❯]/u, turnMarker: /^\s*[›❯•]/u });

function transcriptPath(cwd, id, root = join(homedir(), '.grok')) {
  if (!/^[a-f0-9-]{36}$/i.test(id || '')) return '';
  return join(root, 'sessions', encodeURIComponent(cwd), id, 'chat_history.jsonl');
}

function latestReply(path) {
  if (!path) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 1024 * 1024);
    const bytes = Buffer.alloc(size - start);
    const length = readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, length).toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      let item; try { item = JSON.parse(line); } catch { continue; }
      if (item.type === 'user') return '';
      if (item.type === 'assistant' && !item.tool_calls?.length && typeof item.content === 'string') return item.content.trim();
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  return '';
}

const hasInputPrompt = lines => lines.slice(-10).some(line => /Enter\s*:\s*send/i.test(line) || /^\s*(?:[│┃║]\s*)?[›❯][\s\u00a0]*(?:[│┃║])?\s*$/u.test(line));
const grokProvider = {
  id: 'grok', command: 'grok', supportsAsk: true, requiresSessionStart: true,
  interruptInput: '\x03',
  watchContextUsage: watchGrokContext,
  model: payload => payload.model_id || payload.modelId || (typeof payload.model === 'string' ? payload.model : undefined),
  streamsAgentTextFromScreen: false, finalizeOnStop: true, screenFinalFallback: false,
  screen: { ...menu, latestAgentText: () => '', hasInputPrompt, hasSettledPrompt: hasInputPrompt },
  finalText: payload => String(payload.last_assistant_message || '').trim(),
  resumeMetadata: payload => ({ handle: String(payload.session_id || '').trim(), transcriptPath: String(payload.transcript_path || '') }),
  createLaunch({ command, port, resumeHandle, agentGuide, touchUi, extraArgs = [], hookToken, grokConfigRoot }) {
    const root = grokConfigRoot || join(homedir(), '.grok');
    // Existing v1 hooks honor CLIDECK_URL and remain valid while both installations coexist.
    if (!hooks.complete(root)) {
      const result = hooks.install(root, port);
      if (!result.success) throw new Error(result.message);
    }
    const args = [];
    if (touchUi && !extraArgs.includes('--minimal')) args.push('--minimal');
    if (resumeHandle) args.push('--resume', resumeHandle);
    const userRules = [], forwarded = [];
    for (let index = 0; index < extraArgs.length; index++) {
      const arg = extraArgs[index];
      if (arg === '--rules') {
        if (typeof extraArgs[index+1] !== 'string' || extraArgs[index+1].startsWith('--')) throw new Error('--rules requires a value');
        userRules.push(extraArgs[++index]);
      } else if (arg.startsWith('--rules=')) userRules.push(arg.slice(8));
      else forwarded.push(arg);
    }
    args.push('--rules', [...userRules, agentGuide || AGENT_SESSION_GUIDE].filter(Boolean).join('\n\n'));
    return { nativeScroll: [...forwarded, ...args].includes('--minimal'), command: command || this.command, args, extraArgs: forwarded, env: { CLIDECK_GROK_LAUNCH: hookToken } };
  },
};

async function handleLegacyHook(server, req, res, route, readJson) {
  if (!require('../security').isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, server.host)) { res.writeHead(403).end(); return; }
  try {
    const envelope = await readJson(req);
    const session = server.sessions.get(envelope.clideck_id);
    if (!session || session.closed || session.provider.id !== 'grok') { res.writeHead(404).end(); return; }
    const launch = req.headers['x-clideck-launch'];
    if (launch !== session.hookToken) { res.writeHead(204).end(); return; }
    let raw = {};
    try { raw = JSON.parse(envelope.payload || '{}'); } catch {}
    const id = envelope.session_id || raw.sessionId || raw.session_id;
    if (route !== 'session-start' && session.resumeHandle && id && id !== session.resumeHandle) { res.writeHead(204).end(); return; }
    const path = transcriptPath(session.cwd, id, session.launchOptions.grokConfigRoot);
    const payload = { ...raw, ...envelope, session_id: id, transcript_path: path,
      last_assistant_message: raw.last_assistant_message || raw.lastAssistantMessage || (route === 'stop' ? latestReply(path) : '') };
    session.handleHook(route, payload);
    if (id) {
      const metadata = grokProvider.resumeMetadata(payload);
      session.recordResumeMetadata(metadata);
      server.persistence.recordResumeMetadata(session.id, metadata);
    }
    res.writeHead(204).end();
  } catch { res.writeHead(400).end(); }
}
module.exports = { grokProvider, transcriptPath, latestReply, handleLegacyHook };
