const test = require('node:test');
const assert = require('node:assert/strict');
const { foregroundDisposition } = require('../connection-lifecycle');

test('foreground lifecycle reuses only a compatible open socket', () => {
  assert.equal(foregroundDisposition({ readyState: 1, protocolReady: true }), 'reuse');
  assert.equal(foregroundDisposition({ readyState: 1, protocolReady: false }), 'wait');
  assert.equal(foregroundDisposition({ readyState: 0, protocolReady: false }), 'wait');
});

test('foreground lifecycle connects only when no viable socket exists', () => {
  assert.equal(foregroundDisposition({ readyState: null }), 'connect');
  assert.equal(foregroundDisposition({ readyState: 2 }), 'connect');
  assert.equal(foregroundDisposition({ readyState: 3 }), 'connect');
  assert.equal(foregroundDisposition({ hidden: true, readyState: 3 }), 'hidden');
});
