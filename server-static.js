const { createHash } = require('crypto');
const { readFileSync, existsSync } = require('fs');
const { join, extname, relative, resolve, sep } = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
};
const PUBLIC_ROOT = join(__dirname, 'public');
const BUILD_ROOT = join(PUBLIC_ROOT, 'build');

function etag(data, encoding) {
  return `"${createHash('sha256').update(encoding).update('\0').update(data).digest('hex')}"`;
}

function isWithin(root, filePath) {
  const pathFromRoot = relative(root, filePath);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

function representation(filePath, acceptEncoding = '') {
  if (isWithin(BUILD_ROOT, filePath)) {
    if (/\bbr\b/.test(acceptEncoding) && existsSync(`${filePath}.br`)) {
      return { filePath: `${filePath}.br`, encoding: 'br' };
    }
    if (/\bgzip\b/.test(acceptEncoding) && existsSync(`${filePath}.gz`)) {
      return { filePath: `${filePath}.gz`, encoding: 'gzip' };
    }
  }
  return { filePath, encoding: 'identity' };
}

function staticResponse(filePath, acceptEncoding) {
  const selected = representation(filePath, acceptEncoding);
  const data = readFileSync(selected.filePath);
  const immutable = isWithin(BUILD_ROOT, filePath);
  const headers = {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag(data, selected.encoding),
    'X-Content-Type-Options': 'nosniff',
  };
  if (immutable) headers.Vary = 'Accept-Encoding';
  if (selected.encoding !== 'identity') headers['Content-Encoding'] = selected.encoding;
  if (filePath === join(PUBLIC_ROOT, 'sw.js')) headers['Service-Worker-Allowed'] = '/';
  return { data, headers };
}

function servePluginFile(req, res, resolvePluginFile) {
  const pluginFile = resolvePluginFile(req.url);
  if (!pluginFile) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(pluginFile)] || 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(pluginFile));
}

function serveStatic(req, res, { resolvePluginFile }) {
  if (req.url.startsWith('/plugins/')) {
    servePluginFile(req, res, resolvePluginFile);
    return;
  }

  let requestPath;
  try { requestPath = new URL(req.url, 'http://clideck.local').pathname; }
  catch { res.writeHead(400).end(); return; }

  // Compressed sidecars are representations, never directly addressable files.
  if (/\.(?:br|gz)$/.test(requestPath)) {
    res.writeHead(404).end();
    return;
  }
  const filePath = resolve(PUBLIC_ROOT, (requestPath === '/' ? 'index.html' : requestPath).replace(/^\//, ''));
  if (!isWithin(PUBLIC_ROOT, filePath)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const { data, headers } = staticResponse(filePath, req.headers['accept-encoding'] || '');
    if (req.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(500).end();
  }
}

module.exports = { serveStatic, staticResponse };
