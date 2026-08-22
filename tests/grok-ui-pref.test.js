const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { parse } = require('smol-toml');
const {
  PAGE_FLIP_LINE,
  applyPageFlipOff,
  revertPageFlipOff,
} = require('../grok-ui-pref');

function tomlPath() {
  const root = mkdtempSync(join(tmpdir(), 'clideck-grok-ui-'));
  return { root, path: join(root, 'config.toml') };
}

test('page_flip writes under [ui] even when the file ends at [ui] with no newline', t => {
  const { root, path } = tomlPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, '[ui]');
  const result = applyPageFlipOff(path);
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  const text = readFileSync(path, 'utf8');
  assert.equal(text, `[ui]\n${PAGE_FLIP_LINE}\n`);
  assert.doesNotThrow(() => parse(text));
  assert.equal(parse(text).ui.page_flip_on_send, false);
});

test('page_flip under another table is not treated as the UI setting', t => {
  const { root, path } = tomlPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, '[other]\npage_flip_on_send = true\n');
  const result = applyPageFlipOff(path);
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  const parsed = parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.other.page_flip_on_send, true);
  assert.equal(parsed.ui.page_flip_on_send, false);
});

test('user-owned true and false page_flip settings are left byte-for-byte alone', t => {
  const { root, path } = tomlPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const value of ['true', 'false']) {
    const original = `[ui]\npage_flip_on_send = ${value}\ncompact_mode = true\n`;
    writeFileSync(path, original);
    assert.deepEqual(applyPageFlipOff(path), { success: true, changed: false, path, owned: false });
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(revertPageFlipOff(path).changed, false);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('uninstall removes only the managed false [ui] page_flip_on_send', t => {
  const { root, path } = tomlPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, '[ui]\ncompact_mode = true\n');
  applyPageFlipOff(path);
  const reverted = revertPageFlipOff(path);
  assert.equal(reverted.changed, true);
  const parsed = parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.ui.compact_mode, true);
  assert.equal(parsed.ui.page_flip_on_send, undefined);

  writeFileSync(path, '[ui]\npage_flip_on_send = true\n');
  assert.equal(revertPageFlipOff(path).changed, false);
  assert.match(readFileSync(path, 'utf8'), /page_flip_on_send = true/);
});

test('page_flip edits fail closed on unreadable files and preserve permissions', t => {
  if (process.platform === 'win32') return t.skip('POSIX mode semantics');
  const { root, path } = tomlPath();
  t.after(() => {
    try { chmodSync(path, 0o600); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const original = '[ui]\ncompact_mode = true\n';
  writeFileSync(path, original);
  chmodSync(path, 0);
  const unreadable = applyPageFlipOff(path);
  assert.equal(unreadable.success, false);
  assert.equal(unreadable.changed, false);
  chmodSync(path, 0o600);
  assert.equal(readFileSync(path, 'utf8'), original);

  const previousUmask = process.umask(0o022);
  try {
    applyPageFlipOff(path);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('atomic page_flip edits preserve a config symlink', t => {
  if (process.platform === 'win32') return t.skip('POSIX symlink semantics');
  const root = mkdtempSync(join(tmpdir(), 'clideck-grok-ui-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'managed-config.toml');
  const path = join(root, 'config.toml');
  writeFileSync(target, '[ui]\ncompact_mode = true\n');
  symlinkSync(target, path);

  assert.equal(applyPageFlipOff(path).changed, true);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(parse(readFileSync(target, 'utf8')).ui.page_flip_on_send, false);
  assert.equal(revertPageFlipOff(path).changed, true);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test('invalid TOML and implicit [ui] subtables are not rewritten', t => {
  const { root, path } = tomlPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, '[ui\n');
  const invalid = applyPageFlipOff(path);
  assert.equal(invalid.success, false);
  assert.equal(readFileSync(path, 'utf8'), '[ui\n');

  writeFileSync(path, '[ui.foo]\nbar = 1\n');
  const implicit = applyPageFlipOff(path);
  assert.equal(implicit.success, false);
  assert.equal(implicit.changed, false);
  assert.equal(readFileSync(path, 'utf8'), '[ui.foo]\nbar = 1\n');
});
