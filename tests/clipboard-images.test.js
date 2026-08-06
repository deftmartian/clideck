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
const { createClipboardImageStore } = require('../clipboard-images');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withStore(options, run) {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-images-'));
  try {
    return run({
      directory,
      store: createClipboardImageStore({ directory, ...options }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function image(id = 'session-a') {
  return { id, mime: 'image/png', data: PNG.toString('base64') };
}

test('stores validated images privately with collision-resistant names', () => {
  withStore({}, ({ directory, store }) => {
    const first = store.save(image());
    const second = store.save(image());
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.notEqual(first.path, second.path);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
  });
});

test('rejects invalid payloads before writing', () => {
  withStore({ maxImageBytes: 7 }, ({ directory, store }) => {
    assert.equal(store.save(image()).success, false);
    assert.equal(store.save({ id: 'x', mime: 'image/png', data: 'bm90LXBuZw==' }).success, false);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('prunes expired files and oldest files needed to stay under quota', () => {
  withStore({ maxAgeMs: 1000, maxTotalBytes: PNG.length * 2 }, ({ directory, store }) => {
    const expired = store.save(image('expired'));
    assert.equal(expired.success, true);
    const old = new Date(Date.now() - 5000);
    utimesSync(expired.path, old, old);

    const first = store.save(image('first'));
    const second = store.save(image('second'));
    const third = store.save(image('third'));
    assert.equal(first.success && second.success && third.success, true);
    assert.equal(readdirSync(directory).length, 2);
    assert.ok(!readdirSync(directory).some(name => name.includes('expired')));
  });
});
