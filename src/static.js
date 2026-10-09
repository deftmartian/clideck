const { createReadStream, existsSync } = require('fs');
const { readFile, stat } = require('fs/promises');
const { dirname, extname, resolve, sep } = require('path');

const staged = resolve(__dirname, '../dist/public');
const PUBLIC_DIR = existsSync(resolve(staged, 'index.html')) ? staged : resolve(__dirname, '../public');
const XTERM_JS = require.resolve('@xterm/xterm');
const MERMAID_JS = resolve(
  dirname(require.resolve('mermaid/package.json')),
  'dist/mermaid.min.js',
);
const VENDOR_FILES = new Map([
  ['/vendor/xterm.js', XTERM_JS],
  ['/vendor/xterm-webgl.js', require.resolve('@xterm/addon-webgl')],
  ['/vendor/xterm.css', resolve(dirname(XTERM_JS), '../css/xterm.css')],
  ['/vendor/mermaid.js', MERMAID_JS],
]);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.wasm', 'application/wasm'],
  ['.onnx', 'application/octet-stream'],
  ['.bin', 'application/octet-stream'],
  ['.woff2', 'font/woff2'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.pdf', 'application/pdf'],
  ['.svg', 'image/svg+xml'],
]);

function publicFile(pathname) {
  const relativePath = pathname === '/' ? 'index.html' : `.${pathname}`;
  const filePath = resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) return null;
  return filePath;
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const stagedVendor = VENDOR_FILES.has(pathname) && publicFile(pathname);
  const filePath = (stagedVendor && existsSync(stagedVendor) ? stagedVendor : VENDOR_FILES.get(pathname)) || publicFile(pathname);
  const contentType = filePath && CONTENT_TYPES.get(extname(filePath));
  if (!filePath || !contentType) {
    res.writeHead(404).end();
    return;
  }

  try {
    const accepted = new Map(String(req.headers['accept-encoding'] || '').toLowerCase().split(',').map(part => {
      const [name, ...params] = part.trim().split(';');
      const quality = params.find(param => param.trim().startsWith('q='));
      return [name, quality ? Number(quality.trim().slice(2)) : 1];
    }));
    const quality = name => accepted.get(name) ?? accepted.get('*') ?? 0;
    const encoding = ['br', 'gzip'].filter(name => quality(name) > 0
      && existsSync(filePath + (name === 'br' ? '.br' : '.gz')))
      .sort((a, b) => quality(b) - quality(a))[0] || '';
    const body = await readFile(encoding ? filePath + (encoding === 'br' ? '.br' : '.gz') : filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': /^\/build\/[a-zA-Z0-9_-]+-[A-Z0-9]{8}\.js$/.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Vary': 'Accept-Encoding',
      ...(encoding && { 'Content-Encoding': encoding }),
      'X-Content-Type-Options': 'nosniff',
    }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}

async function servePluginStatic(req, res, pluginManager) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  const match = pathname.match(/^\/plugins\/([a-z][a-z0-9-]{0,62})\/(client\.js|public\/.+)$/);
  if (!match) return false;
  const filePath = pluginManager?.assetPath(match[1], match[2]);
  const contentType = filePath && CONTENT_TYPES.get(extname(filePath));
  if (!filePath || !contentType) {
    res.writeHead(404).end();
    return true;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file.');
    if (!info.size && !req.headers.range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        'Content-Length': 0,
      }).end();
      return true;
    }
    const range = req.headers.range && String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      if (!range || (!range[1] && !range[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return true;
      }
      if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Number(range[2]);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start >= info.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return true;
      }
      end = Math.min(end, info.size - 1);
    }
    const partial = Boolean(req.headers.range);
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(partial && { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
    });
    createReadStream(filePath, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(404).end();
    else res.destroy();
  }
  return true;
}

module.exports = { publicFile, CONTENT_TYPES, servePluginStatic, serveStatic };
