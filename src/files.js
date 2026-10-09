const fs = require('fs/promises');
const { constants } = require('fs');
const { basename, dirname, isAbsolute, join, resolve } = require('path');
const { createHash, randomUUID } = require('crypto');
const { TextDecoder } = require('util');
const { validUploadName } = require('./upload');

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const revision = data => createHash('sha256').update(data).digest('hex');
function fail(message, code = 'invalid_request') { throw Object.assign(new Error(message), { code }); }
function pathValue(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) fail('Choose an absolute path.');
  return resolve(value);
}
function child(parent, name) {
  if (!validUploadName(name)) fail('Use a single file or folder name.', 'invalid_name');
  return join(pathValue(parent), name);
}
async function readText(path) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('Only regular text files can be edited.', 'not_text');
    if (info.size > MAX_TEXT_BYTES) fail('Text editing is limited to 1 MiB.', 'too_large');
    // Bounded even when another process grows the file after stat.
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES) fail('Text editing is limited to 1 MiB.', 'too_large');
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('This file is not UTF-8 text.', 'not_text'); }
    if (text.includes('\0')) fail('This file contains binary data.', 'not_text');
    return { text, revision: revision(bytes), mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, links: info.nlink };
  } finally { await handle.close(); }
}
async function listFiles(path, showHidden) {
  const directory = await fs.realpath(path);
  const entries = [];
  const dir = await fs.opendir(directory);
  let truncated = false;
  for await (const entry of dir) {
    if (!showHidden && entry.name.startsWith('.')) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    let kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    if (entry.isSymbolicLink()) {
      try { kind = (await fs.stat(join(directory, entry.name))).isDirectory() ? 'directory' : 'link'; }
      catch { kind = 'link'; }
    }
    // One unreadable or vanished entry must not fail the whole listing.
    // Folders show no size; skipping them avoids touching a hung mount inside the listing.
    const info = kind === 'directory' && !entry.isSymbolicLink() ? null : await fs.stat(join(directory, entry.name)).catch(() => fs.lstat(join(directory, entry.name))).catch(() => null);
    entries.push({ name: entry.name, kind, symlink: entry.isSymbolicLink(),
      size: info?.isFile() ? info.size : null, modified: info ? info.mtimeMs : null });
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  return { path: directory, parent: dirname(directory), entries, truncated };
}

// Downloads follow symlinks (the user clicked a visible name, and listing already
// resolves links to folders) but only ever stream a regular file. The path is checked
// before open so devices are never opened and FIFOs never block, then rechecked on the handle.
async function openDownload(path) {
  let resolved, before;
  try { resolved = await fs.realpath(path); before = await fs.stat(resolved); }
  catch (error) { fail(error.code === 'ENOENT' ? 'That file no longer exists.' : error.message, error.code || 'download_failed'); }
  if (!before.isFile()) fail('Only regular files can be downloaded.', 'not_file');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('Only regular files can be downloaded.', 'not_file');
    return { handle, size: info.size, name: basename(path) };
  } catch (error) { await handle.close(); throw error; }
}
async function statDownload(path) {
  const { handle, size, name } = await openDownload(path);
  await handle.close();
  return { name, size };
}

class Files {
  constructor() { this.mutations = Promise.resolve(); }
  request(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Promise.reject(new Error('Invalid file request.'));
    if (body.action === 'list') return listFiles(pathValue(body.path), body.showHidden === true);
    if (body.action === 'read') return readText(pathValue(body.path));
    if (body.action === 'stat') return statDownload(pathValue(body.path));
    // Keep our own concurrent editors and rename/delete requests ordered.
    const pending = this.mutations.then(() => this.mutate(body));
    this.mutations = pending.catch(() => {});
    return pending;
  }
  async mutate(body) {
    const path = pathValue(body.path);
    if (body.action === 'create') {
      const target = child(path, body.name);
      if (body.kind === 'directory') await fs.mkdir(target);
      else if (body.kind === 'file') await (await fs.open(target, 'wx', 0o600)).close();
      else fail('Choose file or folder.');
      return { path: target };
    }
    if (body.action === 'save') {
      if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > MAX_TEXT_BYTES || body.text.includes('\0')) fail('Save requires UTF-8 text up to 1 MiB.');
      const current = await readText(path);
      if (current.links > 1) fail('Use another editor for hard-linked files to preserve their link relationships.', 'hard_link');
      if (body.revision !== current.revision) fail('The file changed on disk. Copy your edits, then reopen it before saving.', 'conflict');
      const temp = join(dirname(path), `.clideck-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, body.text, { flag: 'wx', mode: 0o600 });
        await fs.chown(temp, current.uid, current.gid);
        await fs.chmod(temp, current.mode);
        // Recheck immediately before replacement; a stale editor must not overwrite newer text.
        if ((await readText(path)).revision !== current.revision) fail('The file changed while saving. Reopen it before saving.', 'conflict');
        await fs.rename(temp, path);
      } finally { await fs.unlink(temp).catch(() => {}); }
      return { path, revision: revision(Buffer.from(body.text)) };
    }
    if (path === dirname(path)) fail('The filesystem root cannot be moved or deleted.');
    if (body.action === 'move') {
      const target = child(body.destination, body.name || basename(path));
      try { await fs.lstat(target); fail('A file or folder with that name already exists.', 'EEXIST'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(path, target);
      return { path: target };
    }
    if (body.action === 'delete') {
      if (body.confirmName !== basename(path)) fail('Type the exact name to confirm deletion.');
      const info = await fs.lstat(path);
      if (info.isDirectory()) {
        if (body.recursive === true) await fs.rm(path, { recursive: true });
        else await fs.rmdir(path);
      } else await fs.unlink(path); // Delete a symlink itself, never its target.
      return { path };
    }
    fail('Unknown file operation.');
  }
}
module.exports = { Files, MAX_TEXT_BYTES, MAX_ENTRIES, readText, openDownload, pathValue };
