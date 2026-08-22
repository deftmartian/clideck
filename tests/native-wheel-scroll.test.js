const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STEAL_PRIMARY_WHEEL_STORAGE_KEY,
  isPrimaryWheelStealEnabled,
  shouldStealNativeWheel,
  accumulateWheelLines,
} = require('../native-wheel-policy');

function memoryStorage(value) {
  const store = {};
  if (value !== undefined) store[STEAL_PRIMARY_WHEEL_STORAGE_KEY] = value;
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, next) { store[key] = String(next); },
  };
}

function term({ mode = 'any', type = 'normal', baseY = 12 } = {}) {
  return {
    modes: { mouseTrackingMode: mode },
    buffer: { active: { type, baseY } },
  };
}

function wheel({ deltaY = -120, deltaMode = 0, ctrlKey = false } = {}) {
  return { deltaY, deltaMode, ctrlKey };
}

test('native wheel steal only when primary-buffer tracking has scrollback', () => {
  assert.equal(shouldStealNativeWheel(term(), wheel()), true);
  assert.equal(shouldStealNativeWheel(null, wheel()), false);
  assert.equal(shouldStealNativeWheel(term(), null), false);
  assert.equal(shouldStealNativeWheel(term(), wheel({ ctrlKey: true })), false);
  assert.equal(shouldStealNativeWheel(term(), wheel({ deltaY: 0 })), false);
  assert.equal(shouldStealNativeWheel(term({ mode: 'none' }), wheel()), false);
  assert.equal(shouldStealNativeWheel(term({ type: 'alternate' }), wheel()), false);
  assert.equal(shouldStealNativeWheel(term({ baseY: 0 }), wheel()), false);
  assert.equal(isPrimaryWheelStealEnabled(memoryStorage()), true);
  assert.equal(isPrimaryWheelStealEnabled(memoryStorage('0')), false);
  assert.equal(shouldStealNativeWheel(term(), wheel(), memoryStorage('false')), false);
  assert.equal(shouldStealNativeWheel(term(), wheel(), memoryStorage('1')), true);
});

test('native wheel accumulation converts pixel, line, and page deltas', () => {
  assert.deepEqual(
    accumulateWheelLines(wheel({ deltaY: -34, deltaMode: 0 }), 17, 24, 0),
    { lines: -2, accumulator: 0 },
  );
  assert.deepEqual(
    accumulateWheelLines(wheel({ deltaY: -1, deltaMode: 1 }), 17, 24, 0),
    { lines: -1, accumulator: 0 },
  );
  assert.deepEqual(
    accumulateWheelLines(wheel({ deltaY: 1, deltaMode: 2 }), 17, 10, 0),
    { lines: 10, accumulator: 0 },
  );
  const partial = accumulateWheelLines(wheel({ deltaY: 8, deltaMode: 0 }), 17, 24, 0);
  assert.equal(partial.lines, 0);
  assert.ok(partial.accumulator > 0);
  const next = accumulateWheelLines(wheel({ deltaY: 9, deltaMode: 0 }), 17, 24, partial.accumulator);
  assert.equal(next.lines, 1);
});
