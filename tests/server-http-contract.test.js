const test = require('node:test');
const assert = require('node:assert/strict');
const { Sandbox } = require('./providers/sandbox');
const { CLIENT_PROTOCOL_VERSION } = require('../protocol');

test('HTTP health and static asset contracts survive server routing changes', async t => {
  const box = new Sandbox();
  t.after(async () => box.cleanup());
  const port = await box.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const status = await health.json();
  assert.deepEqual(Object.keys(status).sort(), [
    'buildId',
    'ok',
    'protocolVersion',
    'version',
  ]);
  assert.equal(status.ok, true);
  assert.equal(status.protocolVersion, CLIENT_PROTOCOL_VERSION);
  assert.match(status.version, /^\d+\.\d+\.\d+/);
  assert.match(status.buildId, /^[0-9a-f]{16}$/);

  const manifest = await fetch(`${baseUrl}/manifest.webmanifest?build=regression`);
  assert.equal(manifest.status, 200, 'asset routing must ignore the query string');
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  assert.equal(manifest.headers.get('cache-control'), 'no-cache');
  assert.equal(manifest.headers.get('x-content-type-options'), 'nosniff');
  const etag = manifest.headers.get('etag');
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal((await manifest.json()).start_url, '/');

  const unchanged = await fetch(`${baseUrl}/manifest.webmanifest`, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');

  const worker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.equal(worker.headers.get('content-type'), 'application/javascript; charset=utf-8');
});
