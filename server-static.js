const { readFileSync, existsSync, statSync } = require('fs');
const { join, extname, resolve } = require('path');

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
  '/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
const PUBLIC_ROOT = join(__dirname, 'public');

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
  res.end(readFileSync(pluginFile));
}

function serveStatic(req, res, { resolvePluginFile }) {
  if (req.url.startsWith('/plugins/')) {
    servePluginFile(req, res, resolvePluginFile);
    return;
  }

  let requestPath;
  try { requestPath = new URL(req.url, 'http://clideck.local').pathname; }
  catch { res.writeHead(400).end(); return; }

  const filePath = ALIASES[requestPath]
    || resolve(PUBLIC_ROOT, (requestPath === '/' ? 'index.html' : requestPath).replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_ROOT) && !ALIASES[requestPath]) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const headers = staticHeaders(filePath);
    if (req.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(500).end();
  }
}

module.exports = { serveStatic };
