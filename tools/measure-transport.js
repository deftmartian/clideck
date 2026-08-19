#!/usr/bin/env node

const { Sandbox } = require('../tests/providers/sandbox');
const { Client } = require('../tests/providers/client');
const { chromium } = require('playwright-core');
const { existsSync } = require('fs');

async function main() {
  const box = new Sandbox();
  const producer = new Client();
  const reconnect = new Client(undefined, { perf: true });
  try {
    const port = await box.start();
    producer.port = port;
    reconnect.port = port;
    await producer.connect();
    await producer.waitFor('config');
    const commandId = producer.commandIdFor('shell');
    const sessions = [];
    for (let i = 0; i < 10; i++) {
      producer.send({
        type: 'create',
        commandId,
        name: `transport-${i + 1}`,
        cwd: box.workDir(`transport-${i + 1}`),
        cols: 80,
        rows: 24,
      });
      const created = await producer.waitFor(
        msg => msg.type === 'created' && msg.name === `transport-${i + 1}`,
        { label: `create fixture ${i + 1}` },
      );
      sessions.push(created.id);
      producer.send({
        type: 'input',
        id: created.id,
        data: `printf 'fixture-${i + 1}-%04096d\\n' 0\r`,
      });
      await producer.waitFor(
        msg => msg.type === 'output' && msg.id === created.id && String(msg.data).includes(`fixture-${i + 1}-`),
        { label: `fixture output ${i + 1}` },
      );
    }

    reconnect.autoSubscribe = false;
    await reconnect.connect();
    await reconnect.waitFor(msg => msg.type === 'sessions' && msg.list.length === sessions.length);
    await new Promise(resolve => setTimeout(resolve, 100));
    reconnect.send({ type: 'transport.stats.request' });
    await reconnect.waitFor('transport.stats');
    const output = {
      fixture: { sessions: sessions.length, payloadCharactersPerSession: 4096 },
      accounting: JSON.parse(JSON.stringify(reconnect.accounting)),
    };
    if (output.accounting.snapshotReplayBytes !== 0) throw new Error('idle reconnect unexpectedly received terminal state');
    if (output.accounting.initialControlBytes > 50 * 1024) {
      throw new Error(`idle reconnect used ${output.accounting.initialControlBytes} control bytes`);
    }
    if (process.argv.includes('--browser')) {
      const executablePath = process.env.CLIDECK_BROWSER_PATH
        || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      try {
        const context = await browser.newContext({
          viewport: { width: 412, height: 915 },
          hasTouch: true,
          isMobile: true,
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 100,
          downloadThroughput: 10 * 1024 * 1024 / 8,
          uploadThroughput: 10 * 1024 * 1024 / 8,
        });
        await page.goto(`http://127.0.0.1:${port}/?clideckPerf=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.__clideckPerfSnapshot
          && window.__clideckPerfSnapshot().counters.renderersCreated === 1);
        await page.waitForTimeout(500);
        output.browser = await page.evaluate(() => window.__clideckPerfSnapshot());
        const critical = output.browser.criticalResources;
        if (critical.terminalUsableAt > 2000) throw new Error(`cold terminal usable at ${critical.terminalUsableAt}ms`);
        if (critical.count > 8) throw new Error(`cold terminal needed ${critical.count} requests`);
        if (critical.encodedBytes > 350 * 1024) {
          throw new Error(`cold terminal used ${critical.encodedBytes} encoded bytes: ${JSON.stringify(critical.items)}`);
        }
        if (output.browser.timings.webSocketToTerminalMs > 500) {
          throw new Error(`terminal recovery used ${output.browser.timings.webSocketToTerminalMs}ms after WebSocket open`);
        }
        await context.close();
      } finally {
        await browser.close();
      }
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    producer.close();
    reconnect.close();
    await box.cleanup();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
