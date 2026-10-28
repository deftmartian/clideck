import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright-core';
const browserType = process.env.BROWSER === 'firefox' ? firefox : chromium;
const launchOptions = { headless: true, ...(browserType === chromium ? {executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), args:['--no-sandbox']} : {}) };
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const server = createServer((req, res) => {
  if (req.url === '/xterm.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(process.env.XTERM_JS || require.resolve('@xterm/xterm'))); }
  else if (req.url === '/terminal-replies.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(new URL('public/js/terminal-replies.js', root))); }
  else res.end('<!doctype html><div id="term"></div><script src="/xterm.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserType.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const state of ['new session', 'refreshed session']) {
    if (state === 'refreshed session') await page.reload();
    const result = await page.evaluate(async () => {
      const { isTerminalReply } = await import('/terminal-replies.js');
      const terminal = new Terminal({ cols: 80, rows: 24 });
      terminal.open(document.getElementById('term'));
      const emitted = [], forwarded = [];
      terminal.onData(s => { emitted.push(s); if (!isTerminalReply(s)) forwarded.push(s); });
      const write = s => new Promise(resolve => terminal.write(s, resolve));
      await write('ready\r\n\x1b[>0q\x1b[6n\x1b[c');
      await write('\x1b[>0q'); // query present in replayed raw history
      terminal.input('actual user input');
      return { emitted, forwarded };
    });
    const expectedVersions = Number(process.env.EXPECT_VERSION_REPLIES ?? 2);
    assert.equal(result.emitted.filter(s => s.includes('xterm.js(')).length, expectedVersions, state);
    assert.equal(result.emitted.length, 3 + expectedVersions, state); // DSR, DA, user input
    assert.deepEqual(result.forwarded, ['actual user input'], state);
    console.log(`PASS: ${state}: real xterm emits query replies; only user input is forwarded`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
