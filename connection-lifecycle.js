'use strict';

function foregroundDisposition({ hidden = false, readyState = null, protocolReady = false } = {}) {
  if (hidden) return 'hidden';
  if (readyState === 1 && protocolReady) return 'reuse';
  if (readyState === 0 || readyState === 1) return 'wait';
  return 'connect';
}

module.exports = { foregroundDisposition };
