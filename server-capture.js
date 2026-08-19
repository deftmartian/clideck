'use strict';

// Experimental xterm packages are deliberately contained in this adapter.
// The rest of the server deals only in ordered writes, plain screen lines, and
// bounded serialized snapshots.
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { requireTerminalSize } = require('./terminal-size');

const SCROLLBACK_LINES = 5000;
const MENU_LINES = 80;
const SNAPSHOT_SCROLLBACK_LINES = 1000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const CAPTURE_HIGH_WATER = 1024 * 1024;
const CAPTURE_RECOVERY = 256 * 1024;

function integer(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

class ServerCapture {
  constructor({ cols, rows, onReply, onPause, onResume } = {}) {
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
    this.enqueuedSeq = 0;
    this.queuedBytes = 0;
    this.queue = [];
    this.waiters = [];
    this.operationWaiters = [];
    this.enqueuedOperation = 0;
    this.processedOperation = 0;
    this.processing = false;
    this.drainScheduled = false;
    this.sourcePaused = false;
    this.writePasses = 0;
    this.disposed = false;
    this.onReply = typeof onReply === 'function' ? onReply : () => {};
    this.onPause = typeof onPause === 'function' ? onPause : () => {};
    this.onResume = typeof onResume === 'function' ? onResume : () => {};
    this.replyDisposable = this.terminal.onData(data => this.onReply(data));
  }

  _pauseIfNeeded() {
    if (this.sourcePaused || this.queuedBytes < CAPTURE_HIGH_WATER) return;
    this.sourcePaused = true;
    this.onPause();
  }

  _resumeIfReady() {
    if (!this.sourcePaused || this.queuedBytes >= CAPTURE_RECOVERY) return;
    this.sourcePaused = false;
    this.onResume();
  }

  _scheduleDrain() {
    if (this.processing || this.drainScheduled || this.disposed) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this._drain();
    });
  }

  _resolveWaiters() {
    const pending = [];
    for (const waiter of this.waiters) {
      if (this.disposed || waiter.atSeq <= this.processedSeq) waiter.resolve(!this.disposed);
      else pending.push(waiter);
    }
    this.waiters = pending;
    const operationPending = [];
    for (const waiter of this.operationWaiters) {
      if (this.disposed || waiter.operation <= this.processedOperation) waiter.resolve(!this.disposed);
      else operationPending.push(waiter);
    }
    this.operationWaiters = operationPending;
  }

  _drain() {
    if (this.processing || this.disposed) return;
    const first = this.queue.shift();
    if (!first) {
      this._resumeIfReady();
      return;
    }
    if (first.type === 'resize') {
      if (!this.disposed) this.terminal.resize(first.cols, first.rows);
      this.processedSeq = Math.max(this.processedSeq, first.atSeq);
      this.processedOperation = Math.max(this.processedOperation, first.operation);
      this._resolveWaiters();
      this._scheduleDrain();
      return;
    }

    const writes = [first];
    while (this.queue[0]?.type === 'write') writes.push(this.queue.shift());
    const data = writes.length === 1 ? first.data : writes.map(item => item.data).join('');
    const bytes = writes.reduce((total, item) => total + item.bytes, 0);
    const atSeq = writes[writes.length - 1].atSeq;
    this.processing = true;
    this.writePasses += 1;
    this.terminal.write(data, () => {
      this.processing = false;
      this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
      if (!this.disposed) this.processedSeq = Math.max(this.processedSeq, atSeq);
      this.processedOperation = Math.max(
        this.processedOperation,
        writes[writes.length - 1].operation,
      );
      this._resolveWaiters();
      this._resumeIfReady();
      this._scheduleDrain();
    });
  }

  barrier(atSeq = this.enqueuedSeq) {
    const target = Number(atSeq);
    if (!Number.isSafeInteger(target) || target < 0) {
      return Promise.reject(new RangeError('capture barrier sequence must be a non-negative safe integer'));
    }
    if (this.disposed || target <= this.processedSeq) return Promise.resolve(!this.disposed);
    return new Promise(resolve => {
      this.waiters.push({ atSeq: target, resolve });
      this._scheduleDrain();
    });
  }

  operationBarrier(operation = this.enqueuedOperation) {
    if (this.disposed || operation <= this.processedOperation) return Promise.resolve(!this.disposed);
    return new Promise(resolve => {
      this.operationWaiters.push({ operation, resolve });
      this._scheduleDrain();
    });
  }

  write(data, atSeq) {
    if (this.disposed) return Promise.resolve(false);
    const text = String(data || '');
    const targetSeq = Number(atSeq);
    if (!Number.isSafeInteger(targetSeq) || targetSeq < this.enqueuedSeq) {
      return Promise.reject(new RangeError('capture writes must have monotonic sequence numbers'));
    }
    this.enqueuedSeq = targetSeq;
    if (text) {
      const bytes = Buffer.byteLength(text);
      const operation = ++this.enqueuedOperation;
      const last = this.queue[this.queue.length - 1];
      if (last?.type === 'write') {
        last.data += text;
        last.bytes += bytes;
        last.atSeq = targetSeq;
        last.operation = operation;
      } else {
        this.queue.push({ type: 'write', data: text, bytes, atSeq: targetSeq, operation });
      }
      this.queuedBytes += bytes;
      this._pauseIfNeeded();
    } else {
      this.processedSeq = Math.max(this.processedSeq, targetSeq);
      this._resolveWaiters();
    }
    this._scheduleDrain();
    return this.barrier(targetSeq);
  }

  resize(cols, rows) {
    if (this.disposed) return Promise.resolve(false);
    const size = requireTerminalSize(cols, rows);
    const operation = ++this.enqueuedOperation;
    this.queue.push({ type: 'resize', ...size, atSeq: this.enqueuedSeq, operation });
    this._scheduleDrain();
    return this.operationBarrier(operation);
  }

  async lines({ atSeq = this.enqueuedSeq, limit = SCROLLBACK_LINES } = {}) {
    const operation = this.enqueuedOperation;
    await Promise.all([this.barrier(atSeq), this.operationBarrier(operation)]);
    if (this.disposed) return [];
    const buffer = this.terminal.buffer.active;
    const count = Math.min(SCROLLBACK_LINES, Math.max(1, integer(limit, SCROLLBACK_LINES)));
    const lines = [];
    for (let index = Math.max(0, buffer.length - count); index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines;
  }

  async snapshot(requestedScrollback = SNAPSHOT_SCROLLBACK_LINES, atSeq = this.enqueuedSeq) {
    const operation = this.enqueuedOperation;
    await Promise.all([this.barrier(atSeq), this.operationBarrier(operation)]);
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

  stats() {
    return {
      processedSeq: this.processedSeq,
      enqueuedSeq: this.enqueuedSeq,
      queuedBytes: this.queuedBytes,
      paused: this.sourcePaused,
      writePasses: this.writePasses,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.queuedBytes = 0;
    if (this.sourcePaused) {
      this.sourcePaused = false;
      this.onResume();
    }
    this._resolveWaiters();
    try { this.replyDisposable?.dispose(); } catch {}
    try { this.serializer.dispose(); } catch {}
    try { this.terminal.dispose(); } catch {}
  }
}

module.exports = {
  CAPTURE_HIGH_WATER,
  CAPTURE_RECOVERY,
  MAX_SNAPSHOT_BYTES,
  MENU_LINES,
  SCROLLBACK_LINES,
  SNAPSHOT_SCROLLBACK_LINES,
  ServerCapture,
};
