const {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
const MANAGED_IMAGE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-zA-Z0-9-]{1,8}(?:-[0-9a-f]{8})?\.(?:png|jpg|webp|gif)$/;

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

  function save(msg) {
    const id = String(msg.id || '');
    const mime = String(msg.mime || '').toLowerCase().split(';')[0];
    const ext = IMAGE_MIME_EXT.get(mime);
    if (!ext) return { success: false, error: `Unsupported clipboard image type: ${mime || 'unknown'}.` };

    const base64 = String(msg.data || '')
      .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
      .replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return { success: false, error: 'Clipboard image data was not valid base64.' };
    }

    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) return { success: false, error: 'Clipboard image was empty.' };
    if (buf.length > maxImageBytes) {
      return {
        success: false,
        error: `Clipboard image is too large (${Math.ceil(buf.length / 1024 / 1024)} MB).`,
      };
    }
    if (!looksLikeImage(buf, mime)) {
      return { success: false, error: `Clipboard data did not match ${mime}.` };
    }

    try {
      if (!prune(buf.length)) {
        return { success: false, error: 'Clipboard image storage is full.' };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sessionPart = id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'session';
      const nonce = crypto.randomUUID().slice(0, 8);
      const filePath = join(directory, `${stamp}-${sessionPart}-${nonce}.${ext}`);
      writeFileSync(filePath, buf, { mode: 0o600 });
      return { success: true, path: filePath, bytes: buf.length };
    } catch (error) {
      return {
        success: false,
        error: `Clipboard image could not be stored: ${error.message || 'filesystem error'}`,
      };
    }
  }

  return { save, prune };
}

const defaultStore = createClipboardImageStore();

module.exports = {
  bracketedPaste,
  createClipboardImageStore,
  saveClipboardImage: defaultStore.save,
};
