'use strict';

const { CLIENT_PROTOCOL_VERSION } = require('./protocol');
const {
  bracketedPaste,
  createClipboardImageStore,
} = require('./clipboard-images');

const ROUTE = /^\/api\/session\/([^/?#]+)\/clipboard-image(?:\?.*)?$/;

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function createClipboardImageUploadHandler(options) {
  const sessions = options.sessions;
  const originPolicy = options.originPolicy;
  const store = options.store || createClipboardImageStore();
  const maxConcurrent = options.maxConcurrent ?? 2;
  let active = 0;

  async function handle(req, res) {
    const match = ROUTE.exec(String(req.url || ''));
    if (req.method !== 'POST' || !match) return false;
    let id;
    try { id = decodeURIComponent(match[1]); } catch { id = ''; }
    if (!originPolicy.allows(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { error: 'A same-origin browser request is required.' });
      req.resume?.();
      return true;
    }
    if (!id || !sessions.getSessions().has(id)) {
      sendJson(res, 404, { error: 'Session not found.' });
      req.resume?.();
      return true;
    }
    if (String(req.headers['x-clideck-protocol'] || '') !== String(CLIENT_PROTOCOL_VERSION)) {
      sendJson(res, 409, { error: `CliDeck protocol ${CLIENT_PROTOCOL_VERSION} is required.` });
      req.resume?.();
      return true;
    }
    if (active >= maxConcurrent) {
      sendJson(res, 429, { error: 'Too many image uploads are already in progress.' });
      req.resume?.();
      return true;
    }
    const rawLength = req.headers['content-length'];
    const contentLength = rawLength === undefined ? null : Number(rawLength);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      sendJson(res, 400, { error: 'Invalid Content-Length.' });
      req.resume?.();
      return true;
    }

    active += 1;
    try {
      const result = await store.saveRequest(req, {
        id,
        mime: req.headers['content-type'],
        contentLength,
      });
      if (result.aborted) return true;
      if (!result.success) {
        sendJson(res, result.status || 400, { error: result.error });
        return true;
      }
      sessions.input({ id, data: bracketedPaste(result.path) });
      sendJson(res, 201, { path: result.path, bytes: result.bytes });
      return true;
    } finally {
      active = Math.max(0, active - 1);
    }
  }

  return { handle, activeUploads: () => active };
}

module.exports = { ROUTE, createClipboardImageUploadHandler, sendJson };
