const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateTerminalSize,
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

test('provisional terminal sizes use touch bounds without weakening desktop defaults', () => {
  assert.deepEqual(estimateTerminalSize(390, 844, { touchUi: true }), { cols: 48, rows: 49 });
  assert.deepEqual(estimateTerminalSize(390, 844), { cols: 80, rows: 49 });
  assert.deepEqual(estimateTerminalSize(0, 0, { touchUi: true }), { cols: 20, rows: 5 });
  assert.deepEqual(estimateTerminalSize(100000, 100000, { touchUi: true }), { cols: 500, rows: 300 });
});
