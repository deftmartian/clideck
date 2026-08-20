const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { existsSync, readdirSync, statSync } = require('fs');
const { join } = require('path');
const { PassThrough } = require('stream');
const { Sandbox } = require('./providers/sandbox');
const { Client } = require('./providers/client');
const { CLIENT_PROTOCOL_VERSION } = require('../protocol');
const { DEFAULT_MAX_IMAGE_BYTES } = require('../clipboard-images');
const { createClipboardImageUploadHandler } = require('../clipboard-image-http');
const { createOriginPolicy } = require('../origin-policy');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createShell(box, port) {
  const client = new Client(port);
  await client.connect();
  await client.waitFor('config');
  client.send({
    type: 'create',
    commandId: client.commandIdFor('shell'),
    name: 'http-image-test',
    cwd: box.workDir('http-image-test'),
    cols: 80,
    rows: 24,
  });
  const created = await client.waitFor('created');
  await client.waitFor(msg => msg.type === 'session.subscribed' && msg.id === created.id);
  return { client, id: created.id };
}

function uploadHeaders(baseUrl, contentType = 'image/png') {
  return {
    Origin: baseUrl,
    'Content-Type': contentType,
    'X-CliDeck-Protocol': String(CLIENT_PROTOCOL_VERSION),
  };
}

function beginUpload(url, headers) {
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const req = http.request(url, { method: 'POST', headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolveResponse({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  req.on('error', error => resolveResponse({ error }));
  return { req, response };
}

test('HTTP image uploads require same-origin protocol-v4 requests and paste one private path', async t => {
  const box = new Sandbox();
  let client;
  t.after(async () => {
    client?.close();
    await box.cleanup();
  });
  const port = await box.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const shell = await createShell(box, port);
  client = shell.client;
  const endpoint = `${baseUrl}/api/session/${encodeURIComponent(shell.id)}/clipboard-image`;

  const missingOrigin = await fetch(endpoint, {
    method: 'POST', headers: {
      'Content-Type': 'image/png',
      'X-CliDeck-Protocol': String(CLIENT_PROTOCOL_VERSION),
    }, body: PNG,
  });
  assert.equal(missingOrigin.status, 403);

  const wrongOrigin = await fetch(endpoint, {
    method: 'POST', headers: { ...uploadHeaders(baseUrl), Origin: 'https://attacker.invalid' }, body: PNG,
  });
  assert.equal(wrongOrigin.status, 403);

  const staleProtocol = await fetch(endpoint, {
    method: 'POST', headers: { ...uploadHeaders(baseUrl), 'X-CliDeck-Protocol': '3' }, body: PNG,
  });
  assert.equal(staleProtocol.status, 409);

  const missingSession = await fetch(`${baseUrl}/api/session/missing/clipboard-image`, {
    method: 'POST', headers: uploadHeaders(baseUrl), body: PNG,
  });
  assert.equal(missingSession.status, 404);

  const mismatch = await fetch(endpoint, {
    method: 'POST', headers: uploadHeaders(baseUrl, 'image/jpeg'), body: PNG,
  });
  assert.equal(mismatch.status, 415);

  const empty = await fetch(endpoint, {
    method: 'POST', headers: uploadHeaders(baseUrl), body: Buffer.alloc(0),
  });
  assert.equal(empty.status, 400);

  const saved = await fetch(endpoint, {
    method: 'POST', headers: uploadHeaders(baseUrl), body: PNG,
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  const result = await saved.json();
  assert.equal(result.bytes, PNG.length);
  assert.equal(existsSync(result.path), true);
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
});

test('a successful HTTP commit bracket-pastes its path exactly once', async () => {
  const inputs = [];
  const sessions = {
    getSessions: () => new Map([['session-a', {}]]),
    input: message => inputs.push(message),
  };
  const handler = createClipboardImageUploadHandler({
    sessions,
    originPolicy: createOriginPolicy({ port: 3000, host: '127.0.0.1' }),
    store: { saveRequest: async () => ({ success: true, path: '/tmp/image.png', bytes: 8 }) },
  });
  const req = new PassThrough();
  Object.assign(req, {
    method: 'POST',
    url: '/api/session/session-a/clipboard-image',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'image/png',
      'content-length': '8',
      'x-clideck-protocol': String(CLIENT_PROTOCOL_VERSION),
    },
  });
  const response = { headersSent: false, destroyed: false, writeHead(status, headers) {
    this.status = status; this.headers = headers; this.headersSent = true; return this;
  }, end(body) { this.body = body; } };
  assert.equal(await handler.handle(req, response), true);
  assert.equal(response.status, 201);
  assert.deepEqual(inputs, [{
    id: 'session-a', data: '\x1b[200~/tmp/image.png\x1b[201~',
  }]);
});

test('maximum HTTP upload stays off WebSocket, enforces concurrency, and cleans aborted temps', async t => {
  const box = new Sandbox();
  let client;
  t.after(async () => {
    client?.close();
    await box.cleanup();
  });
  const port = await box.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const shell = await createShell(box, port);
  client = shell.client;
  const endpoint = `${baseUrl}/api/session/${encodeURIComponent(shell.id)}/clipboard-image`;

  const upload = beginUpload(endpoint, {
    ...uploadHeaders(baseUrl),
    'Content-Length': String(DEFAULT_MAX_IMAGE_BYTES),
  });
  upload.req.write(PNG);
  await new Promise(resolve => setTimeout(resolve, 100));
  client.messages.length = 0;
  client.send({ type: 'config.get' });
  await client.waitFor('config', { label: 'WebSocket control during maximum upload' });
  upload.req.end(Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES - PNG.length));
  const exact = await upload.response;
  assert.equal(exact.status, 201, exact.body);
  const exactResult = JSON.parse(exact.body);
  assert.equal(exactResult.bytes, DEFAULT_MAX_IMAGE_BYTES);

  const over = Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES + 1);
  PNG.copy(over);
  const rejected = await fetch(endpoint, {
    method: 'POST', headers: uploadHeaders(baseUrl), body: over,
  });
  assert.equal(rejected.status, 413);

  const held = [0, 1].map(() => beginUpload(endpoint, {
    ...uploadHeaders(baseUrl),
    'Content-Length': String(PNG.length),
  }));
  held.forEach(item => item.req.write(PNG.subarray(0, 4)));
  await new Promise(resolve => setTimeout(resolve, 100));
  const busy = await fetch(endpoint, {
    method: 'POST', headers: uploadHeaders(baseUrl), body: PNG,
  });
  assert.equal(busy.status, 429);
  held.forEach(item => item.req.destroy());
  await Promise.all(held.map(item => item.response));
  await new Promise(resolve => setTimeout(resolve, 100));
  const uploadDirectory = join(box.dataDir(), 'uploads', 'images');
  assert.equal(
    readdirSync(uploadDirectory).filter(name => name.startsWith('.upload-')).length,
    0,
  );
});
