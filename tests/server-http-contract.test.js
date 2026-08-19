const test = require('node:test');
const assert = require('node:assert/strict');
const { Sandbox } = require('./providers/sandbox');
const { CLIENT_PROTOCOL_VERSION } = require('../protocol');

function builtEntrypoints(html) {
  return {
    app: html.match(/<script type="module" src="([^"]+)"><\/script>/)?.[1],
    styles: html.match(/<link rel="stylesheet" href="([^"]+)">/)?.[1],
  };
}

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

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  const entries = builtEntrypoints(await index.text());
  assert.match(entries.app, /^\/build\/app-[A-Z0-9]+\.js$/);
  assert.match(entries.styles, /^\/build\/styles-[A-Z0-9]+\.css$/);

  const compressed = await fetch(`${baseUrl}${entries.app}`, {
    headers: { 'Accept-Encoding': 'br' },
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'br');
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.equal(compressed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(compressed.headers.get('etag'), /^"[0-9a-f]{64}"$/);
  const compressedEtag = compressed.headers.get('etag');
  await compressed.arrayBuffer();

  const gzip = await fetch(`${baseUrl}${entries.app}`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(gzip.status, 200);
  assert.equal(gzip.headers.get('content-encoding'), 'gzip');
  assert.notEqual(gzip.headers.get('etag'), compressedEtag, 'ETags must describe the selected encoding');
  await gzip.arrayBuffer();

  const unchangedBuild = await fetch(`${baseUrl}${entries.app}`, {
    headers: { 'Accept-Encoding': 'br', 'If-None-Match': compressedEtag },
  });
  assert.equal(unchangedBuild.status, 304);
  assert.equal(await unchangedBuild.text(), '');

  const staleBuild = await fetch(`${baseUrl}/build/app-STALE000.js`);
  assert.equal(staleBuild.status, 404);
  const directSidecar = await fetch(`${baseUrl}${entries.app}.br`);
  assert.equal(directSidecar.status, 404);

  const manifest = await fetch(`${baseUrl}/manifest.webmanifest?build=regression`);
  assert.equal(manifest.status, 200, 'asset routing must ignore the query string');
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  assert.equal(manifest.headers.get('cache-control'), 'no-cache');
  assert.equal(manifest.headers.get('x-content-type-options'), 'nosniff');
  const etag = manifest.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{64}"$/);
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
