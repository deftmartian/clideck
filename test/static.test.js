const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');

test('server exposes the app and xterm runtime assets', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-static-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { httpUrl } = await server.listen();

  const app = await fetch(`${httpUrl}/`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /^text\/html/);

  const xterm = await fetch(`${httpUrl}/vendor/xterm.js`);
  assert.equal(xterm.status, 200);
  assert.match(xterm.headers.get('content-type'), /^text\/javascript/);

  const unicode = await fetch(`${httpUrl}/vendor/addon-unicode11.js`);
  assert.equal(unicode.status, 200);
  assert.match(unicode.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await unicode.text(), readFileSync(require.resolve('@xterm/addon-unicode11'), 'utf8'));
  const html = await app.text();
  const addonScript = html.indexOf('src="/vendor/addon-unicode11.js"');
  assert.ok(addonScript > html.indexOf('src="/vendor/xterm.js"'));
  assert.ok(addonScript < html.indexOf('src="/js/app.js"'));

  const mermaid = await fetch(`${httpUrl}/vendor/mermaid.js`);
  assert.equal(mermaid.status, 200);
  assert.match(mermaid.headers.get('content-type'), /^text\/javascript/);

  const sound = await fetch(`${httpUrl}/fx/default-beep.mp3`);
  assert.equal(sound.status, 200);
  assert.equal(sound.headers.get('content-type'), 'audio/mpeg');

  const lexicon = await fetch(`${httpUrl}/plugins/supertonic/public/tts_normalization_lexicon.txt`);
  assert.equal(lexicon.status, 200);
  assert.match(lexicon.headers.get('content-type'), /^text\/plain/);
  assert.match(await lexicon.text(), /^# input \| replacement \| language/m);

  const voicePreview = await fetch(`${httpUrl}/plugins/supertonic/public/voices/female-1-preview.mp3`);
  assert.equal(voicePreview.status, 200);
  assert.equal(voicePreview.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await voicePreview.arrayBuffer()).byteLength > 10_000);
});
