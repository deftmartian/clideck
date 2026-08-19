const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('./providers/client');

test('isolated client accounts for control, replay, live, frames, and backlog deterministically', () => {
  const client = new Client(0);
  client._onMessage(Buffer.from(JSON.stringify({ type: 'config', config: {} })));
  client._onMessage(Buffer.from(JSON.stringify({ type: 'output', id: 'a', data: 'old', replay: true })));
  client._onMessage(Buffer.from(JSON.stringify({ type: 'output', id: 'a', data: 'new' })));

  assert.equal(client.accounting.frameCount, 3);
  assert.ok(client.accounting.initialControlBytes > 0);
  assert.ok(client.accounting.snapshotReplayBytes > 0);
  assert.ok(client.accounting.liveBytesBySession.a > 0);
  assert.ok(client.accounting.maximumBacklog > 0);
  assert.equal(
    client.accounting.totalBytes,
    client.accounting.initialControlBytes
      + client.accounting.snapshotReplayBytes
      + client.accounting.liveBytesBySession.a,
  );
});

test('browser diagnostics are opt-in and remain in memory', () => {
  const perf = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'perf.js'), 'utf8');
  assert.match(perf, /clideckPerf/);
  assert.match(perf, /__clideckPerfSnapshot/);
  assert.doesNotMatch(perf, /localStorage|sessionStorage|fetch\s*\(/);
});
