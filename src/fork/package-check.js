const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

async function preflight(root) {
  const { HeadlessServer } = require(join(root, 'src/server'));
  const version = require(join(root, 'package.json')).version;
  assert.equal(execFileSync(process.execPath, [join(root, 'bin/clideck.js'), '--version'], {encoding:'utf8'}).trim(), version);
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-package-check-'));
  const server = new HeadlessServer({ port:0, dataDir, cwd:dataDir, requireProtocol:true });
  try {
    const { httpUrl } = await server.listen();
    const WebSocket = require('node:module').createRequire(join(root, 'package.json'))('ws');
    const health = await fetch(httpUrl + '/api/health');
    assert.match(health.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await health.json(), {ok:true,version,protocol:'fork-v6'});
    for (const [protocol, accepted] of [['fork-v5',false],['fork-v6',true]]) {
      await new Promise((resolve,reject) => {
        const socket = new WebSocket(httpUrl.replace(/^http/, 'ws') + '/?protocol=' + protocol);
        const timer = setTimeout(() => {socket.terminate();reject(new Error('WebSocket preflight timed out'));},5000);
        const finish = error => {clearTimeout(timer);socket.terminate();error ? reject(error) : resolve();};
        socket.on('error', error => {if (accepted) finish(error);});
        socket.on('unexpected-response', (_request,response) => {response.resume();finish(!accepted && response.statusCode === 401 ? null : new Error('Unexpected protocol acceptance'));});
        socket.on('open', () => finish(accepted ? null : new Error('Obsolete client accepted')));
      });
    }
    const get = (path, encoding='identity') => fetch(httpUrl + path, {headers:{'Accept-Encoding':encoding}});
    const index = await get('/');
    assert.equal(index.status, 200);
    const html = await index.text();
    const asset = html.match(/src="(\/build\/app-[A-Z0-9]{8}\.js)"/)[1];
    const plain = await get(asset);
    assert.match(plain.headers.get('cache-control'), /immutable/);
    const body = await plain.text();
    for (const encoding of ['br', 'gzip']) {
      const compressed = await get(asset, encoding);
      assert.equal(compressed.headers.get('content-encoding'), encoding);
      assert.equal(await compressed.text(), body);
    }
    const disabled = await get(asset, 'br;q=0, gzip;q=0');
    assert.equal(disabled.headers.get('content-encoding'), null);
    await server.pluginManager.setEnabled('voice-input', true);
    for (const path of ['/manifest.webmanifest', '/sw.js', '/offline.html', '/vendor/xterm-webgl.js', '/plugins/voice-input/client.js']) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.arrayBuffer()).byteLength, path);
    }
    const shell = server.createSession({provider:'shell', cwd:dataDir});
    assert.ok(shell.terminal, 'native PTY launches from installed package');
    shell.close(); await shell.waitForClose();
    console.log(`PASS: installed ${version}: CLI, protocol gate, health, native PTY, hashed assets, compression and retained plugin assets`);
  } finally { await server.close(); rmSync(dataDir, {recursive:true, force:true}); }
}
module.exports = { preflight };
if (require.main === module) preflight(resolve(process.argv[2] || '.')).catch(error => { console.error(error); process.exitCode=1; });
