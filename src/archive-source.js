const fs = require('fs/promises');
const { constants } = require('fs');
const { createHash } = require('crypto');
const { isAbsolute, relative, extname, sep } = require('path');

const CHUNK_BYTES = 256 * 1024;
const LINE_BYTES = 1024 * 1024;

function within(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

// Independent of the status/context monitor. Only a session-reported path is
// followed; this reader never searches a provider's conversations directory.
class ArchiveSource {
  constructor({ path, root, since, fromEnd = false, emit }) {
    Object.assign(this, { path, root, since, fromEnd, emit });
    this.offset = 0;
    this.identity = '';
    this.pending = [];
    this.length = 0;
    this.lineOffset = 0;
    this.fragment = 0;
    this.skip = false;
    this.historical = !fromEnd;
    this.generation = 0;
    this.skipped = 0;
    this.unavailable = '';
  }

  async open() {
    if (!isAbsolute(this.path) || extname(this.path) !== '.jsonl' || !this.root) {
      throw new Error('Native JSONL path is unavailable or unsupported.');
    }
    const [root, path] = await Promise.all([fs.realpath(this.root), fs.realpath(this.path)]);
    if (!within(root, path)) throw new Error('Native transcript is outside the provider profile.');
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
      | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); throw new Error('Native transcript is not a regular file.'); }
    return { handle, stat };
  }

  async attach() {
    let handle;
    try {
      const opened = await this.open();
      ({ handle } = opened);
      const { stat } = opened;
      this.identity = `${stat.dev}:${stat.ino}`;
      if (this.fromEnd) {
        this.offset = stat.size;
        const last = Buffer.alloc(1);
        if (stat.size) await handle.read(last, 0, 1, stat.size - 1);
        this.skip = stat.size > 0 && last[0] !== 10;
      }
      this.lineOffset = this.offset;
      this.initialEnd = stat.size;
      this.historical = !this.fromEnd && stat.size > 0;
      await this.emit('source.attached', { path: this.path, offset: this.offset,
        policy: this.fromEnd ? 'appended-after-attachment' : 'timestamp-at-or-after-recording-start',
        since: this.since });
    } catch (error) {
      await this.reportUnavailable(error);
    } finally { await handle?.close(); }
  }

  async reportUnavailable(error) {
    const message = error.code || error.message;
    if (this.unavailable === message) return;
    this.unavailable = message;
    await this.emit('source.unavailable', { path: this.path, reason: message });
  }

  async read(ceiling = Infinity) {
    if (!this.identity) { await this.attach(); if (!this.identity) return false; }
    let handle;
    try {
      const opened = await this.open();
      ({ handle } = opened);
      const { stat } = opened;
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== identity || stat.size < this.offset) {
        await this.emit('source.reset', { path: this.path, previousOffset: this.offset,
          reason: 'replaced-or-truncated', possibleRepeatedRecords: true });
        this.identity = identity;
        this.offset = this.lineOffset = this.length = this.fragment = 0;
        this.pending = [];
        this.skip = false;
        this.historical = stat.size > 0;
        this.initialEnd = stat.size;
        this.generation++;
      }
      if (this.unavailable) {
        await this.emit('source.recovered', { path: this.path });
        this.unavailable = '';
      }
      const available = Math.min(stat.size, ceiling);
      const size = Math.min(CHUNK_BYTES, Math.max(0, available - this.offset));
      if (!size) return false;
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
      let start = 0;
      while (start < bytesRead) {
        const nl = buffer.subarray(0, bytesRead).indexOf(10, start);
        const end = nl < 0 ? bytesRead : nl;
        const piece = buffer.subarray(start, end);
        if (!this.skip) {
          this.pending.push(piece);
          this.length += piece.length;
          if (this.length >= LINE_BYTES) {
            // Large appended records are losslessly split, never truncated.
            // Old/undated records during initial discovery cannot be attributed
            // safely, so do not backfill them just because they are large.
            if (this.historical && !this.fragment) {
              const prefix = Buffer.concat(this.pending).toString('utf8');
              const timestamp = prefix.match(/"timestamp"\s*:\s*"([^"\n]+)"/);
              if (!timestamp || !(Date.parse(timestamp[1]) >= Date.parse(this.since))) {
                this.skip = true;
                this.skipped++;
              }
            }
            if (!this.skip) await this.emitFragment(false);
            this.pending = [];
            this.length = 0;
          }
        }
        const consumed = end - start + (nl < 0 ? 0 : 1);
        this.offset += consumed;
        if (nl >= 0) {
          if (!this.skip) await this.emitLine();
          this.pending = [];
          this.length = this.fragment = 0;
          this.skip = false;
          this.lineOffset = this.offset;
          if (this.offset >= this.initialEnd && this.historical) {
            this.historical = false;
            if (this.skipped) await this.emit('source.history-skipped', { path: this.path, records: this.skipped });
            this.skipped = 0;
          }
        }
        start = end + 1;
      }
      return this.offset < available;
    } catch (error) {
      // Archive write errors belong to the recorder, not a native-source warning.
      if (error.archiveWrite) throw error;
      await this.reportUnavailable(error);
      return false;
    } finally { await handle?.close(); }
  }

  provenance() {
    return { path: this.path, byteOffset: this.lineOffset, generation: this.generation };
  }

  async emitFragment(final) {
    if (!this.fragment) { this.hash = createHash('sha256'); this.lineBytes = 0; }
    const bytes = Buffer.concat(this.pending);
    this.hash.update(bytes);
    this.lineBytes += bytes.length;
    await this.emit('native.fragment', { source: this.provenance(), index: this.fragment++, final,
      encoding: 'base64', bytes: bytes.toString('base64'),
      ...(final && { totalFragments: this.fragment, byteLength: this.lineBytes, sha256: this.hash.digest('hex') }) });
  }

  async emitLine() {
    if (this.fragment) { await this.emitFragment(true); return; }
    const bytes = Buffer.concat(this.pending);
    if (!bytes.length) return;
    const raw = bytes.toString('utf8');
    let record;
    try { record = JSON.parse(raw); } catch {}
    if (this.historical && !(Date.parse(record?.timestamp) >= Date.parse(this.since))) {
      this.skipped++;
      return;
    }
    await this.emit('native.record', { source: this.provenance(), raw,
      ...(record ? { nativeType: record.type || null } : { malformed: true }),
      ...(!bytes.equals(Buffer.from(raw)) && { rawBase64: bytes.toString('base64') }) });
  }

  async finish() {
    let ceiling = this.offset;
    try {
      const { handle, stat } = await this.open();
      ceiling = stat.size;
      await handle.close();
    } catch (error) { await this.reportUnavailable(error); }
    while (await this.read(ceiling)) { /* drain a fixed snapshot, never chase a running writer */ }
    if (this.length || this.fragment || this.skip) {
      await this.emit('source.incomplete', { path: this.path, byteOffset: this.lineOffset,
        reason: 'Recording ended before a complete native line was available.' });
      if (!this.skip && (this.length || this.fragment)) await this.emitFragment(false);
    }
  }
}

module.exports = { ArchiveSource, within, CHUNK_BYTES, LINE_BYTES };
