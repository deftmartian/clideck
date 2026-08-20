'use strict';

const HEADER_BYTES = 28;
const MAGIC = [0x43, 0x44];
const FRAME_VERSION = 1;
const KIND_CODE = Object.freeze({ live: 1, replay: 2, snapshot: 3 });
const CODE_KIND = Object.freeze(Object.fromEntries(
  Object.entries(KIND_CODE).map(([kind, code]) => [code, kind]),
));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function safeInteger(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} is outside its safe integer range`);
  }
  return number;
}

function setSafeUint64(view, offset, value, name) {
  const number = safeInteger(name, value);
  view.setUint32(offset, Math.floor(number / 0x100000000), false);
  view.setUint32(offset + 4, number >>> 0, false);
}

function getSafeUint64(view, offset, name) {
  const value = view.getUint32(offset, false) * 0x100000000
    + view.getUint32(offset + 4, false);
  return safeInteger(name, value);
}

function encodeTerminalFrame(frame) {
  const kind = String(frame?.kind || '');
  const kindCode = KIND_CODE[kind];
  if (!kindCode) throw new TypeError('unknown terminal frame kind');
  const streamId = safeInteger('streamId', frame.streamId, { min: 1, max: 0xffffffff });
  const data = String(frame.data || '');
  const snapshot = kind === 'snapshot';
  const startSeq = snapshot ? 0 : safeInteger('startSeq', frame.startSeq);
  const endSeq = snapshot
    ? safeInteger('atSeq', frame.atSeq)
    : safeInteger('endSeq', frame.endSeq);
  if (!snapshot && (endSeq < startSeq || endSeq - startSeq !== data.length)) {
    throw new RangeError('terminal payload does not match its sequence range');
  }
  const parts = snapshot
    ? safeInteger('parts', frame.parts, { min: 1, max: 0xffff })
    : 1;
  const part = snapshot
    ? safeInteger('part', frame.part, { max: parts - 1 })
    : 0;
  const payload = encoder.encode(data);
  const raw = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(raw.buffer);
  raw.set([...MAGIC, FRAME_VERSION, kindCode]);
  view.setUint32(4, streamId, false);
  setSafeUint64(view, 8, startSeq, 'startSeq');
  setSafeUint64(view, 16, endSeq, snapshot ? 'atSeq' : 'endSeq');
  view.setUint16(24, part, false);
  view.setUint16(26, parts, false);
  raw.set(payload, HEADER_BYTES);
  return raw;
}

function decodeTerminalFrame(raw) {
  const bytes = ArrayBuffer.isView(raw)
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : new Uint8Array(raw);
  if (bytes.byteLength < HEADER_BYTES) throw new RangeError('terminal frame header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new TypeError('terminal frame magic is invalid');
  }
  if (bytes[2] !== FRAME_VERSION) throw new TypeError('unknown terminal frame version');
  const kind = CODE_KIND[bytes[3]];
  if (!kind) throw new TypeError('unknown terminal frame kind');
  const streamId = safeInteger('streamId', view.getUint32(4, false), {
    min: 1, max: 0xffffffff,
  });
  const startSeq = getSafeUint64(view, 8, 'startSeq');
  const endSeq = getSafeUint64(view, 16, kind === 'snapshot' ? 'atSeq' : 'endSeq');
  const part = view.getUint16(24, false);
  const parts = view.getUint16(26, false);
  const data = decoder.decode(bytes.subarray(HEADER_BYTES));
  if (kind === 'snapshot') {
    if (startSeq !== 0 || parts < 1 || part >= parts) {
      throw new RangeError('snapshot part metadata is invalid');
    }
    return { kind, streamId, atSeq: endSeq, part, parts, data };
  }
  if (part !== 0 || parts !== 1 || endSeq < startSeq || endSeq - startSeq !== data.length) {
    throw new RangeError('terminal payload does not match its sequence range');
  }
  return { kind, streamId, startSeq, endSeq, part, parts, data };
}

module.exports = {
  FRAME_VERSION,
  HEADER_BYTES,
  KIND_CODE,
  decodeTerminalFrame,
  encodeTerminalFrame,
};
