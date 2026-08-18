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

// A local child connecting to a specific interface bind has matching source
// and destination addresses rather than a loopback source.
function isSameHost(req) {
  const normalize = addr => addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const remote = normalize(req.socket?.remoteAddress || '');
  const local = normalize(req.socket?.localAddress || '');
  return remote === '::1'
    || remote === '127.0.0.1'
    || remote.startsWith('127.')
    || (!!remote && !!local && remote === local);
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
