const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Sandbox } = require('./providers/sandbox');
const { CLIENT_PROTOCOL_PARAM, CLIENT_PROTOCOL_VERSION } = require('../protocol');

function collectUntilClose(url, onOpen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error('protocol gate did not close the socket'));
    }, 5000);
    ws.on('open', () => onOpen?.(ws));
    ws.on('message', raw => {
      try { messages.push(JSON.parse(raw)); } catch {}
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, messages, reason: reason.toString() });
    });
    ws.on('error', reject);
  });
}

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== type) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.on('error', reject);
  });
}

test('WebSocket protocol gate accepts the current client and rejects stale clients before actions', async t => {
  const box = new Sandbox();
  t.after(async () => box.cleanup());
  const port = await box.start();

  const validUrl = new URL(`ws://127.0.0.1:${port}`);
  validUrl.searchParams.set(CLIENT_PROTOCOL_PARAM, String(CLIENT_PROTOCOL_VERSION));
  const valid = new WebSocket(validUrl);
  t.after(() => {
    try { valid.close(); } catch {}
  });
  const config = await waitForMessage(valid, 'config');
  assert.equal(config.config.protocolVersion, CLIENT_PROTOCOL_VERSION);

  const staleProtocol = CLIENT_PROTOCOL_VERSION - 1;
  const staleUrl = new URL(`ws://127.0.0.1:${port}`);
  staleUrl.searchParams.set(CLIENT_PROTOCOL_PARAM, String(staleProtocol));
  const stale = await collectUntilClose(staleUrl, ws => {
    ws.send(JSON.stringify({
      type: 'create',
      commandId: 'shell',
      name: 'stale-must-not-be-created',
    }));
  });
  assert.equal(stale.code, 1008);
  assert.equal(stale.reason, 'unsupported CliDeck client protocol');
  assert.deepEqual(
    stale.messages.find(msg => msg.type === 'protocol.incompatible'),
    {
      type: 'protocol.incompatible',
      expectedProtocolVersion: CLIENT_PROTOCOL_VERSION,
      receivedProtocolVersion: staleProtocol,
      version: config.config.version,
      buildId: config.config.buildId,
    },
  );

  const queryless = await collectUntilClose(`ws://127.0.0.1:${port}`, ws => {
    ws.send(JSON.stringify({
      type: 'create',
      commandId: 'shell',
      name: 'queryless-must-not-be-created',
    }));
  });
  assert.equal(queryless.code, 1008);
  assert.equal(queryless.reason, 'unsupported CliDeck client protocol');
  assert.deepEqual(
    queryless.messages.find(msg => msg.type === 'protocol.incompatible'),
    {
      type: 'protocol.incompatible',
      expectedProtocolVersion: CLIENT_PROTOCOL_VERSION,
      receivedProtocolVersion: null,
      version: config.config.version,
      buildId: config.config.buildId,
    },
  );

  const futureProtocol = CLIENT_PROTOCOL_VERSION + 1;
  const futureUrl = new URL(`ws://127.0.0.1:${port}`);
  futureUrl.searchParams.set(CLIENT_PROTOCOL_PARAM, String(futureProtocol));
  const future = await collectUntilClose(futureUrl);
  assert.equal(future.code, 1008);
  assert.deepEqual(
    future.messages.find(msg => msg.type === 'protocol.incompatible'),
    {
      type: 'protocol.incompatible',
      expectedProtocolVersion: CLIENT_PROTOCOL_VERSION,
      receivedProtocolVersion: futureProtocol,
      version: config.config.version,
      buildId: config.config.buildId,
    },
  );

  await new Promise(resolve => setTimeout(resolve, 100));
  await box.stop(true);
  assert.equal(
    box.readSavedSessions().some(session => (
      session.name === 'stale-must-not-be-created'
      || session.name === 'queryless-must-not-be-created'
    )),
    false,
    'a rejected client action must never reach the session handler',
  );
});
