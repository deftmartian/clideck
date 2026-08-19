const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTerminalSize,
  requireTerminalSize,
} = require('../terminal-size');

test('terminal sizes default only when absent and accept inclusive bounds', () => {
  assert.deepEqual(normalizeTerminalSize(), { ok: true, cols: 80, rows: 24 });
  assert.deepEqual(normalizeTerminalSize(undefined, 300), { ok: true, cols: 80, rows: 300 });
  assert.deepEqual(normalizeTerminalSize(20, 5), { ok: true, cols: 20, rows: 5 });
  assert.deepEqual(normalizeTerminalSize(500, 300), { ok: true, cols: 500, rows: 300 });
});

test('terminal sizes reject supplied coercions, unsafe numbers, and out-of-range values', () => {
  for (const [cols, rows] of [
    [null, 24], ['80', 24], [80, null], [80, '24'],
    [19, 24], [501, 24], [80, 4], [80, 301],
    [Number.MAX_SAFE_INTEGER + 1, 24], [80, 5.5],
  ]) {
    assert.equal(normalizeTerminalSize(cols, rows).ok, false, `${cols} x ${rows}`);
    assert.throws(() => requireTerminalSize(cols, rows), RangeError);
  }
});
