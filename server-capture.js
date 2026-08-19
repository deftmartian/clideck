'use strict';

// Experimental xterm packages are deliberately contained in this adapter.
// The rest of the server deals only in ordered writes, plain screen lines, and
// bounded serialized snapshots.
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { requireTerminalSize } = require('./terminal-size');

const SCROLLBACK_LINES = 5000;
const SNAPSHOT_SCROLLBACK_LINES = 1000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function integer(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

class ServerCapture {
  constructor({ cols, rows, onReply } = {}) {
    const size = requireTerminalSize(cols, rows);
    this.terminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: false,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.processedSeq = 0;
    this.pending = Promise.resolve();
    this.disposed = false;
    this.onReply = typeof onReply === 'function' ? onReply : () => {};
    this.replyDisposable = this.terminal.onData(data => this.onReply(data));
  }

  write(data, atSeq) {
    if (this.disposed) return Promise.resolve();
    const text = String(data || '');
    const targetSeq = Number(atSeq);
    this.pending = this.pending.then(() => new Promise(resolve => {
      if (this.disposed) return resolve();
      this.terminal.write(text, () => {
        if (Number.isSafeInteger(targetSeq)) this.processedSeq = targetSeq;
        resolve();
      });
    }));
    return this.pending;
  }

  resize(cols, rows) {
    if (this.disposed) return Promise.resolve();
    const size = requireTerminalSize(cols, rows);
    this.pending = this.pending.then(() => {
      if (!this.disposed) this.terminal.resize(size.cols, size.rows);
    });
    return this.pending;
  }

  async lines() {
    await this.pending;
    if (this.disposed) return [];
    const buffer = this.terminal.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines;
  }

  async snapshot(requestedScrollback = SNAPSHOT_SCROLLBACK_LINES) {
    await this.pending;
    if (this.disposed) throw new Error('terminal capture is disposed');
    let scrollback = Math.min(
      SNAPSHOT_SCROLLBACK_LINES,
      Math.max(0, integer(requestedScrollback, SNAPSHOT_SCROLLBACK_LINES)),
    );
    while (true) {
      const data = this.serializer.serialize({ scrollback });
      const bytes = Buffer.byteLength(data);
      if (bytes <= MAX_SNAPSHOT_BYTES) {
        return {
          data,
          bytes,
          scrollback,
          atSeq: this.processedSeq,
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        };
      }
      if (scrollback === 0) throw new Error('terminal snapshot exceeds 1 MiB without scrollback');
      scrollback = Math.floor(scrollback / 2);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.replyDisposable?.dispose(); } catch {}
    try { this.serializer.dispose(); } catch {}
    try { this.terminal.dispose(); } catch {}
  }
}

module.exports = {
  MAX_SNAPSHOT_BYTES,
  SCROLLBACK_LINES,
  SNAPSHOT_SCROLLBACK_LINES,
  ServerCapture,
};
