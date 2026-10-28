'use strict';

const {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const { randomBytes } = require('crypto');
const { dirname } = require('path');
const { parse } = require('smol-toml');

const PAGE_FLIP_KEY = 'page_flip_on_send';
const PAGE_FLIP_LINE = 'page_flip_on_send = false # managed-by-clideck';

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') { out += line[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

function headerName(line) {
  const text = stripComment(line).trim();
  if (!text.startsWith('[') || !text.endsWith(']') || text.startsWith('[[')) return null;
  return text.slice(1, -1).trim();
}

function parseUiPageFlip(text) {
  try {
    const parsed = parse(text || '');
    const ui = parsed && typeof parsed === 'object' ? parsed.ui : undefined;
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) {
      return { ok: true, present: false, uiTable: false };
    }
    if (!Object.prototype.hasOwnProperty.call(ui, PAGE_FLIP_KEY)) {
      return { ok: true, present: false, uiTable: true };
    }
    return { ok: true, present: true, uiTable: true, value: ui[PAGE_FLIP_KEY] };
  } catch (err) {
    return { ok: false, error: err.message || 'invalid TOML' };
  }
}

function linesOf(text) {
  if (text === '') return [];
  return text.split('\n');
}

function findExplicitUiHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (headerName(lines[i]) === 'ui') return i;
  }
  return -1;
}

function withTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function readOptional(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, exists: false, path, writePath: path, text: '', mode: 0o600 };
    }
    return { ok: false, path, error: err.message || 'read failed' };
  }

  let writePath = path;
  if (info.isSymbolicLink()) {
    try {
      writePath = realpathSync(path);
    } catch (err) {
      return { ok: false, path, error: err.message || 'could not resolve symlink' };
    }
  }

  try {
    return {
      ok: true,
      exists: true,
      path,
      writePath,
      text: readFileSync(writePath, 'utf8'),
      mode: statSync(writePath).mode & 0o777,
    };
  } catch (err) {
    return { ok: false, path, error: err.message || 'read failed' };
  }
}

function managedPageFlipPresent(text) {
  let current = '';
  for (const line of linesOf(text)) {
    const header = headerName(line);
    if (header != null) current = header;
    if (current === 'ui' && line.trim() === PAGE_FLIP_LINE) return true;
  }
  return false;
}

function writeAtomic(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tmp = `${path}.${process.pid}.${suffix}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function applyPageFlipOff(path) {
  const file = readOptional(path);
  if (!file.ok) {
    return { success: false, changed: false, path, message: `Could not read ${path}: ${file.error}` };
  }
  const { text } = file;
  const parsed = parseUiPageFlip(text);
  if (!parsed.ok) {
    return { success: false, changed: false, path, message: `Could not parse ${path}: ${parsed.error}` };
  }
  if (parsed.present) {
    return { success: true, changed: false, path, owned: managedPageFlipPresent(text) };
  }

  const lines = linesOf(text);
  const uiIdx = findExplicitUiHeader(lines);
  if (uiIdx < 0 && parsed.uiTable) {
    return {
      success: false,
      changed: false,
      path,
      message: `Set [ui] ${PAGE_FLIP_LINE} in ${path} manually; [ui] exists only as a subtable`,
    };
  }
  if (uiIdx >= 0) lines.splice(uiIdx + 1, 0, PAGE_FLIP_LINE);
  else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('[ui]', PAGE_FLIP_LINE);
  }
  writeAtomic(file.writePath, withTrailingNewline(lines.join('\n')), file.mode);
  return { success: true, changed: true, path, owned: true };
}

function revertPageFlipOff(path) {
  const file = readOptional(path);
  if (!file.ok) {
    return { success: false, changed: false, path, message: `Could not read ${path}: ${file.error}` };
  }
  if (!file.exists) return { success: true, changed: false, path };
  const { text } = file;
  const parsed = parseUiPageFlip(text);
  if (!parsed.ok) {
    return { success: false, changed: false, path, message: `Could not parse ${path}: ${parsed.error}` };
  }
  if (!parsed.present || parsed.value !== false) {
    return { success: true, changed: false, path };
  }

  const lines = linesOf(text);
  let current = '';
  let removed = false;
  const next = [];
  for (const line of lines) {
    const header = headerName(line);
    if (header != null) current = header;
    if (current === 'ui' && line.trim() === PAGE_FLIP_LINE) {
      removed = true;
      continue;
    }
    next.push(line);
  }
  if (!removed) return { success: true, changed: false, path };
  writeAtomic(file.writePath, withTrailingNewline(next.join('\n')), file.mode);
  return { success: true, changed: true, path };
}

module.exports = {
  PAGE_FLIP_LINE,
  applyPageFlipOff,
  parseUiPageFlip,
  revertPageFlipOff,
};
