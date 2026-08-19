const { CLIENT_PROTOCOL_VERSION } = require('./protocol');
const { CLIENT_BUILD_ID } = require('./client-build');

function handleGrokHook(req, res, sessions) {
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
          ? [...allSessions].find(([, session]) => session.sessionToken === sessionId)?.[0]
          : null;
      if (clideckId) {
        const session = allSessions.get(clideckId);
        if (session && sessionId && route !== 'session-end' && session.sessionToken !== sessionId) {
          const previousToken = session.sessionToken;
          session.sessionToken = sessionId;
          session.sessionTokenOrigin = 'hook';
          const previous = previousToken ? `${previousToken.slice(0, 12)}... -> ` : '';
          console.log(`Grok: updated session ID for ${clideckId.slice(0, 8)} via hook:${route}: ${previous}${sessionId.slice(0, 12)}...`);
        }
        if (route === 'start') {
          sessions.broadcast({ type: 'session.status', id: clideckId, working: true, source: 'hook' });
        } else if (route === 'stop' || route === 'session-end') {
          sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
          setTimeout(() => sessions.capture(clideckId), 500);
        } else if (route === 'session-start') {
          // Compact can fire mid-turn; only treat interactive starts as idle.
          if (String(payload.source || '').toLowerCase() !== 'compact') {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
            setTimeout(() => sessions.capture(clideckId), 500);
          }
        } else if (route === 'menu') {
          const menuVersion = session ? ((session._menuVersion || 0) + 1) : 1;
          if (session) session._menuVersion = menuVersion;
          setTimeout(() => sessions.capture(clideckId, { menuVersion }), 500);
        }
      }
    } catch {}
    res.writeHead(200).end('{}');
  });
}

function sendHealth(res, version) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({
    ok: true,
    version,
    buildId: CLIENT_BUILD_ID,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
  }));
}

// Returns true when this fork-owned route has taken responsibility for the
// request. Core server routing can otherwise continue unchanged.
function handleLocalHttp(req, res, { sessions, loadConfig, version }) {
  if (req.method === 'POST' && req.url.startsWith('/hook/grok/')) {
    handleGrokHook(req, res, sessions);
    return true;
  }
  if (req.method === 'POST' && req.url === '/api/session/spawn') {
    require('./session-spawn').handleHttp(req, res, sessions, loadConfig);
    return true;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    sendHealth(res, version);
    return true;
  }
  return false;
}

module.exports = { handleLocalHttp };
