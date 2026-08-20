const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HEADER_BYTES,
  decodeTerminalFrame,
  encodeTerminalFrame,
} = require('../tools/terminal-frame-candidate');

test('binary candidate round-trips Unicode sequence coordinates and snapshot parts', () => {
  const data = 'A😀e\u0301界';
  const replay = decodeTerminalFrame(encodeTerminalFrame({
    kind: 'replay', streamId: 17, startSeq: 41, endSeq: 41 + data.length, data,
  }));
  assert.deepEqual(replay, {
    kind: 'replay', streamId: 17, startSeq: 41, endSeq: 41 + data.length,
    part: 0, parts: 1, data,
  });
  assert.ok(encodeTerminalFrame({
    kind: 'replay', streamId: 17, startSeq: 41, endSeq: 41 + data.length, data,
  }).byteLength > HEADER_BYTES + data.length);

  assert.deepEqual(decodeTerminalFrame(encodeTerminalFrame({
    kind: 'snapshot', streamId: 99, atSeq: Number.MAX_SAFE_INTEGER,
    part: 2, parts: 3, data,
  })), {
    kind: 'snapshot', streamId: 99, atSeq: Number.MAX_SAFE_INTEGER,
    part: 2, parts: 3, data,
  });
});

test('binary candidate rejects malformed headers, ranges, UTF-8, and parts', () => {
  assert.throws(() => encodeTerminalFrame({
    kind: 'replay', streamId: 1, startSeq: 0, endSeq: 1, data: '😀',
  }), /sequence range/);
  assert.throws(() => encodeTerminalFrame({
    kind: 'snapshot', streamId: 1, atSeq: 0, part: 1, parts: 1, data: '',
  }), /part/);
  assert.throws(() => decodeTerminalFrame(new Uint8Array(HEADER_BYTES - 1)), /truncated/);

  const valid = encodeTerminalFrame({
    kind: 'live', streamId: 1, startSeq: 3, endSeq: 6, data: 'abc',
  });
  for (const [index, value, pattern] of [
    [0, 0, /magic/],
    [2, 9, /version/],
    [3, 9, /kind/],
  ]) {
    const malformed = valid.slice();
    malformed[index] = value;
    assert.throws(() => decodeTerminalFrame(malformed), pattern);
  }
  const zeroStream = valid.slice();
  new DataView(zeroStream.buffer).setUint32(4, 0, false);
  assert.throws(() => decodeTerminalFrame(zeroStream), /streamId/);

  const wrongRange = valid.slice();
  new DataView(wrongRange.buffer).setUint32(20, 7, false);
  assert.throws(() => decodeTerminalFrame(wrongRange), /sequence range/);

  const invalidUtf8 = valid.slice(0, HEADER_BYTES + 2);
  invalidUtf8[HEADER_BYTES] = 0xc3;
  invalidUtf8[HEADER_BYTES + 1] = 0x28;
  assert.throws(() => decodeTerminalFrame(invalidUtf8));
});
