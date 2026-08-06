#!/usr/bin/env node
// Silent Grok Build lifecycle hook for CliDeck.
// Reads Grok hook JSON from stdin (camelCase envelope), posts to CliDeck.

const http = require('http');

const port = parseInt(process.argv[2], 10);
const route = String(process.argv[3] || '').replace(/[^a-z-]/g, '');
const clideckId = process.env.CLIDECK_SESSION_ID || '';
if (!port || !route) process.exit(0);

let endpoint;
try {
  endpoint = new URL(process.env.CLIDECK_URL || `http://localhost:${port}`);
} catch {
  endpoint = new URL(`http://localhost:${port}`);
}

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  body += chunk;
  if (body.length > 1e6) process.exit(0);
});
process.stdin.on('end', () => {
  let hook = {};
  try { hook = body.trim() ? JSON.parse(body) : {}; } catch {}

  // Grok uses camelCase; accept snake_case too for Claude-compat payloads.
  const sessionId = hook.sessionId
    || hook.session_id
    || process.env.GROK_SESSION_ID
    || '';
  const source = hook.source || '';
  const reason = hook.reason || '';
  const hookEventName = hook.hookEventName || hook.hook_event_name || '';

  const payload = JSON.stringify({
    clideck_id: clideckId || undefined,
    session_id: sessionId || undefined,
    source,
    reason,
    hook_event_name: hookEventName,
    payload: body.trim() || undefined,
  });

  const req = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port || port,
    path: `/hook/grok/${route}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 2000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(payload);
});
process.stdin.resume();
