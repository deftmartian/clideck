const test = require('node:test');
const assert = require('node:assert/strict');
const { ReplayRing, splitUtf8Chunks } = require('../replay-ring');

test('replay ring trims by UTF-8 bytes without splitting Unicode', () => {
  const ring = new ReplayRing(10);
  ring.append('ab🙂界cd', 0);
  assert.ok(ring.byteLength <= 10);
  assert.equal(ring.endSeq, 'ab🙂界cd'.length);
  const retained = ring.slice(ring.startSeq);
  assert.equal(Buffer.byteLength(retained), ring.byteLength);
  assert.equal(retained.includes('\ufffd'), false);
  assert.equal(retained.startsWith('\ude00'), false);
});

test('replay ring finds current cursors and returns bounded suffixes without a full join', () => {
  const ring = new ReplayRing(1024);
  ring.append('alpha', 0);
  ring.append('beta', 5);
  assert.equal(ring.contains(9, 9), true);
  assert.equal(ring.slice(9, 9), '');
  assert.equal(ring.slice(5, 9), 'beta');
  assert.equal(ring.suffix(4), 'beta');
  assert.equal(ring.slice(10), null);
});

test('replay ring measures UTF-8 range bytes without joining the range', () => {
  const ring = new ReplayRing(1024);
  ring.append('ab🙂cd', 0);
  assert.equal(ring.byteLengthBetween(0, 6), 8);
  assert.equal(ring.byteLengthBetween(2, 4), 4);
  assert.equal(ring.byteLengthBetween(4, 6), 2);
  assert.equal(ring.byteLengthBetween(7, 8), null);
});

test('replay ring coalesces adjacent source chunks into bounded network segments', () => {
  const ring = new ReplayRing(1024);
  ring.append('ab', 0);
  ring.append('cd', 2);
  ring.append('\u{1f642}e', 4);
  assert.deepEqual([...ring.segments(0, 7, 5)], [
    { data: 'abcd', bytes: 4, startSeq: 0, endSeq: 4 },
    { data: '\u{1f642}e', bytes: 5, startSeq: 4, endSeq: 7 },
  ]);
});

test('replay ring reports gaps after byte-cap trimming', () => {
  const ring = new ReplayRing(5);
  ring.append('abcdef', 0);
  assert.equal(ring.startSeq, 1);
  assert.equal(ring.slice(0), null);
  assert.equal(ring.slice(1), 'bcdef');
});

test('UTF-8 chunk splitting preserves JS sequence offsets and byte limits', () => {
  const text = `${'🙂'.repeat(10)}abc界`;
  const chunks = splitUtf8Chunks(text, 9);
  assert.equal(chunks.map(item => item.data).join(''), text);
  assert.ok(chunks.every(item => item.bytes <= 9));
  assert.ok(chunks.every(item => Buffer.byteLength(item.data) === item.bytes));
});
