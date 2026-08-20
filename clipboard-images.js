'use strict';

const {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

const DEFAULT_DIRECTORY = join(DATA_DIR, 'uploads', 'images');
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_MIME_EXT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const MANAGED_IMAGE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-zA-Z0-9-]{1,8}-[0-9a-f]{8}\.(?:png|jpg|webp|gif)$/;

function normalizeImageMime(value) {
  return String(value || '').toLowerCase().split(';')[0].trim();
}

function looksLikeImage(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return false;
  if (mime === 'image/png') {
    return buf.length >= 8 && buf.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/webp') {
    return buf.length >= 12
      && buf.subarray(0, 4).toString('ascii') === 'RIFF'
      && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime === 'image/gif') {
    const header = buf.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  return false;
}

function bracketedPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

function createClipboardImageStore(options = {}) {
  const directory = options.directory || DEFAULT_DIRECTORY;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let commitTail = Promise.resolve();

  function ensureDirectory() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  function managedEntries() {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && MANAGED_IMAGE.test(entry.name))
      .flatMap(entry => {
        try {
          const path = join(directory, entry.name);
          const stat = statSync(path);
          return [{ path, size: stat.size, mtimeMs: stat.mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  function prune(incomingBytes, now = Date.now()) {
    ensureDirectory();
    let entries = managedEntries();
    for (const entry of entries.filter(file => now - file.mtimeMs > maxAgeMs)) {
      try { unlinkSync(entry.path); } catch {}
    }
    entries = managedEntries();
    let total = entries.reduce((sum, file) => sum + file.size, 0);
    for (const entry of entries) {
      if (total + incomingBytes <= maxTotalBytes) break;
      try {
        unlinkSync(entry.path);
        total -= entry.size;
      } catch {}
    }
    return total + incomingBytes <= maxTotalBytes;
  }

  function withCommitLock(task) {
    const result = commitTail.then(task, task);
    commitTail = result.then(() => {}, () => {});
    return result;
  }

  function saveRequest(req, { id, mime, contentLength }) {
    const normalizedMime = normalizeImageMime(mime);
    const ext = IMAGE_MIME_EXT.get(normalizedMime);
    if (!ext) {
      req.resume?.();
      return Promise.resolve({
        success: false,
        status: 415,
        error: `Unsupported clipboard image type: ${normalizedMime || 'unknown'}.`,
      });
    }
    if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
      req.resume?.();
      return Promise.resolve({ success: false, status: 413, error: 'Clipboard image is too large.' });
    }

    ensureDirectory();
    const tempPath = join(directory, `.upload-${crypto.randomUUID()}.tmp`);
    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    let complete = false;

    return new Promise(resolve => {
      function removeTemp() {
        try { unlinkSync(tempPath); } catch {}
      }

      function finish(result, { drain = false } = {}) {
        if (complete) return;
        complete = true;
        if (drain) req.resume?.();
        try { output.destroy(); } catch {}
        removeTemp();
        resolve(result);
      }

      req.on('aborted', () => finish({ success: false, aborted: true, status: 499 }));
      req.on('error', error => finish({
        success: false,
        status: 400,
        error: `Clipboard image upload failed: ${error.message || 'request error'}`,
      }));
      output.on('error', error => finish({
        success: false,
        status: 500,
        error: `Clipboard image could not be stored: ${error.message || 'filesystem error'}`,
      }, { drain: true }));
      output.on('drain', () => req.resume?.());
      req.on('data', chunk => {
        if (complete) return;
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxImageBytes) {
          req.pause?.();
          finish({ success: false, status: 413, error: 'Clipboard image is too large.' }, { drain: true });
          return;
        }
        if (prefix.length < 12) prefix = Buffer.concat([prefix, data.subarray(0, 12 - prefix.length)]);
        if (!output.write(data)) req.pause?.();
      });
      req.on('end', () => {
        if (!complete) output.end();
      });
      output.on('finish', async () => {
        if (complete) return;
        if (!bytes) {
          finish({ success: false, status: 400, error: 'Clipboard image was empty.' });
          return;
        }
        if (Number.isFinite(contentLength) && bytes !== contentLength) {
          finish({ success: false, status: 400, error: 'Clipboard image length did not match Content-Length.' });
          return;
        }
        if (!looksLikeImage(prefix, normalizedMime)) {
          finish({
            success: false,
            status: 415,
            error: `Clipboard data did not match ${normalizedMime}.`,
          });
          return;
        }
        const committed = await withCommitLock(() => {
          if (!prune(bytes)) return null;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const sessionPart = String(id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'session';
          const nonce = crypto.randomUUID().slice(0, 8);
          const path = join(directory, `${stamp}-${sessionPart}-${nonce}.${ext}`);
          renameSync(tempPath, path);
          chmodSync(path, 0o600);
          return path;
        }).catch(error => ({ error }));
        if (!committed) {
          finish({ success: false, status: 507, error: 'Clipboard image storage is full.' });
          return;
        }
        if (committed.error) {
          finish({
            success: false,
            status: 500,
            error: `Clipboard image could not be stored: ${committed.error.message || 'filesystem error'}`,
          });
          return;
        }
        complete = true;
        resolve({ success: true, path: committed, bytes });
      });
    });
  }

  return { directory, maxImageBytes, prune, saveRequest };
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  IMAGE_MIME_EXT,
  bracketedPaste,
  createClipboardImageStore,
  looksLikeImage,
  normalizeImageMime,
};
