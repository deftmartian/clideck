const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); })
      .on('error', reject);
  });
}

test('session-data GETs refuse a rebound Host name and accept loopback', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-host-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { port } = await server.listen();
  for (const path of ['/api/session/backup', '/api/session/resume', '/api/session/agents?callerSessionId=x', '/content/abc']) {
    assert.equal(await get(port, path, `attacker.example:${port}`), 403, path);
    assert.notEqual(await get(port, path, `127.0.0.1:${port}`), 403, path);
  }
});
