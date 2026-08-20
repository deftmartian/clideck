const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { PassThrough } = require('stream');
const { createClipboardImageStore } = require('../clipboard-images');

const IMAGES = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
  'image/webp': Buffer.from('RIFF0000WEBP'),
  'image/gif': Buffer.from('GIF89a'),
};

async function withStore(options, run) {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-images-'));
  try {
    return await run({
      directory,
      store: createClipboardImageStore({ directory, ...options }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function request(body) {
  const req = new PassThrough();
  process.nextTick(() => req.end(body));
  return req;
}

async function save(store, mime = 'image/png', body = IMAGES[mime], extra = {}) {
  return store.saveRequest(request(body), {
    id: extra.id || 'session-a', mime,
    contentLength: extra.contentLength ?? body.length,
  });
}

test('streams every supported image type into private collision-resistant files', async () => {
  await withStore({}, async ({ directory, store }) => {
    const saved = [];
    for (const [mime, body] of Object.entries(IMAGES)) saved.push(await save(store, mime, body));
    assert.ok(saved.every(result => result.success));
    assert.equal(new Set(saved.map(result => result.path)).size, saved.length);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.ok(saved.every(result => (statSync(result.path).mode & 0o777) === 0o600));
  });
});

test('rejects MIME mismatches, empty bodies, and over-limit streams without residue', async () => {
  await withStore({ maxImageBytes: 8 }, async ({ directory, store }) => {
    assert.equal((await save(store, 'image/png', Buffer.from('GIF89a'))).status, 415);
    assert.equal((await save(store, 'image/png', Buffer.alloc(0))).status, 400);
    const over = Buffer.concat([IMAGES['image/png'], Buffer.from('x')]);
    assert.equal((await save(store, 'image/png', over, { contentLength: null })).status, 413);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('accepts the exact stream limit and rejects a declared byte beyond it', async () => {
  await withStore({ maxImageBytes: 12 }, async ({ directory, store }) => {
    const exact = Buffer.concat([IMAGES['image/png'], Buffer.alloc(4)]);
    assert.equal((await save(store, 'image/png', exact)).success, true);
    const req = request(Buffer.alloc(0));
    const over = await store.saveRequest(req, {
      id: 'session-a', mime: 'image/png', contentLength: 13,
    });
    assert.equal(over.status, 413);
    assert.equal(readdirSync(directory).filter(name => name.startsWith('.upload-')).length, 0);
  });
});

test('aborted streams delete their unique temporary file', async () => {
  await withStore({}, async ({ directory, store }) => {
    const req = new PassThrough();
    const pending = store.saveRequest(req, {
      id: 'session-a', mime: 'image/png', contentLength: null,
    });
    req.write(IMAGES['image/png']);
    req.emit('aborted');
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('prunes expired and oldest images, and reports an impossible store quota', async () => {
  await withStore({ maxAgeMs: 1000, maxTotalBytes: 16 }, async ({ directory, store }) => {
    const expired = await save(store, 'image/png', IMAGES['image/png'], { id: 'expired' });
    const old = new Date(Date.now() - 5000);
    utimesSync(expired.path, old, old);
    assert.equal((await save(store, 'image/png', IMAGES['image/png'], { id: 'first' })).success, true);
    assert.equal((await save(store, 'image/png', IMAGES['image/png'], { id: 'second' })).success, true);
    assert.equal((await save(store, 'image/png', IMAGES['image/png'], { id: 'third' })).success, true);
    assert.equal(readdirSync(directory).length, 2);
    assert.ok(!readdirSync(directory).some(name => name.includes('expired')));
  });

  await withStore({ maxTotalBytes: 7 }, async ({ directory, store }) => {
    const full = await save(store);
    assert.equal(full.status, 507);
    assert.deepEqual(readdirSync(directory), []);
  });
});
