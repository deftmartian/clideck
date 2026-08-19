#!/usr/bin/env node

const { Sandbox } = require('../tests/providers/sandbox');
const { Client } = require('../tests/providers/client');
const { chromium } = require('playwright-core');
const { existsSync } = require('fs');

async function main() {
  const box = new Sandbox();
  const producer = new Client();
  const reconnect = new Client();
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

    await reconnect.connect();
    await reconnect.waitFor(msg => msg.type === 'sessions' && msg.list.length === sessions.length);
    await reconnect.waitFor(
      () => sessions.every(id => reconnect.output.has(id)),
      { label: 'ten-session reconnect replay' },
    );
    const output = {
      fixture: { sessions: sessions.length, payloadCharactersPerSession: 4096 },
      accounting: reconnect.accounting,
    };
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
        await page.goto(`http://127.0.0.1:${port}/?clideckPerf=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(count => window.__clideckPerfSnapshot
          && window.__clideckPerfSnapshot().counters.renderersCreated === count, sessions.length);
        await page.waitForTimeout(500);
        output.browser = await page.evaluate(() => window.__clideckPerfSnapshot());
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
