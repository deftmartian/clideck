const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Sandbox } = require('./providers/sandbox');
const { CLIENT_PROTOCOL_PARAM, CLIENT_PROTOCOL_VERSION } = require('../protocol');
const {
  TERMINAL_INPUT_MAX_BYTES,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} = require('../transport-limits');

function connect(port) {
  return new Promise((resolve, reject) => {
    const url = new URL(`ws://127.0.0.1:${port}`);
    url.searchParams.set(CLIENT_PROTOCOL_PARAM, String(CLIENT_PROTOCOL_VERSION));
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', raw => {
      try { messages.push(JSON.parse(raw)); } catch {}
    });
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('WebSocket accepts its exact payload bound and closes one byte over', async t => {
  const box = new Sandbox();
  t.after(async () => box.cleanup());
  const port = await box.start();

  const exact = await connect(port);
  await waitFor(() => exact.messages.some(message => message.type === 'config'));
  exact.messages.length = 0;
  exact.ws.send(`{}${' '.repeat(WEBSOCKET_MAX_PAYLOAD_BYTES - 2)}`);
  exact.ws.send(JSON.stringify({ type: 'config.get' }));
  await waitFor(() => exact.messages.some(message => message.type === 'config'));
  exact.ws.close();

  const oversized = await connect(port);
  const closed = new Promise(resolve => oversized.ws.once('close', code => resolve(code)));
  oversized.ws.send(`{}${' '.repeat(WEBSOCKET_MAX_PAYLOAD_BYTES - 1)}`);
  assert.equal(await closed, 1009);
});

test('terminal input has a deliberate limit below the WebSocket bound', async t => {
  const box = new Sandbox();
  t.after(async () => box.cleanup());
  const port = await box.start();
  const { ws, messages } = await connect(port);
  await waitFor(() => messages.some(message => message.type === 'config'));
  messages.length = 0;

  ws.send(JSON.stringify({ type: 'input', id: 'missing', data: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES) }));
  ws.send(JSON.stringify({ type: 'config.get' }));
  await waitFor(() => messages.some(message => message.type === 'config'));
  assert.equal(messages.some(message => message.type === 'error'), false);
  ws.send(JSON.stringify({ type: 'input', id: 'missing', data: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) }));
  const error = await waitFor(() => messages.find(message => message.type === 'error'));
  assert.match(error.message, /512 KiB/);
  ws.close();
});
