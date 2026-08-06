function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function jsonError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readJson(req, maxBody = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBody) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function resolveProject(projects, nameOrId) {
  const text = String(nameOrId || '').trim();
  const byId = projects.filter(p => p.id === text);
  if (byId.length === 1) return byId[0];
  const exact = projects.filter(p => p.name === text);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw jsonError(`Multiple projects named "${text}". Use the project id.`, 409);
  const lower = text.toLowerCase();
  const insensitive = projects.filter(p => String(p.name || '').toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];
  if (insensitive.length > 1) throw jsonError(`Multiple projects named "${text}". Use the project id.`, 409);
  throw jsonError(`No project named "${text}"`, 404);
}

// CliDeck may bind only to a VM/VPN interface, so a child process on this host
// can reach it with the same source and destination address rather than 127/8.
function isSameHost(req) {
  const remote = req.socket?.remoteAddress || '';
  const local = req.socket?.localAddress || '';
  const normalize = (addr) => addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const remoteAddr = normalize(remote);
  const localAddr = normalize(local);
  return remoteAddr === '::1'
    || remoteAddr === '127.0.0.1'
    || remoteAddr.startsWith('127.')
    || (!!remoteAddr && !!localAddr && remoteAddr === localAddr);
}

function sameProject(a, b) {
  return (a.projectId || null) === (b.projectId || null);
}

function projectName(projects, projectId) {
  if (!projectId) return 'No project';
  return projects.find(p => p.id === projectId)?.name || projectId;
}

function sessionAddress(session, id, projects) {
  const name = session.name || id.slice(0, 8);
  return session.projectId ? `@${projectName(projects, session.projectId)}/${name}` : name;
}

module.exports = { sendJson, jsonError, readJson, resolveProject, isSameHost, sameProject, projectName, sessionAddress };
