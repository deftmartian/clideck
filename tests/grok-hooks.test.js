const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { dirname, join } = require('path');
const grokHooks = require('../grok-hooks');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clideck-grok-hooks-'));
  const helperPath = join(root, 'grok-hook.js');
  writeFileSync(helperPath, '#!/usr/bin/env node\n');
  return { root, helperPath };
}

test('Grok hook lifecycle preserves unrelated hooks and detects port drift', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = grokHooks.configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'third-party-stop' }] }],
      CustomEvent: [{ hooks: [{ type: 'command', command: 'third-party-custom' }] }],
    },
  }));

  assert.equal(grokHooks.hasAny(root), false);
  const installed = grokHooks.install(root, 4000, { nodePath: '/usr/bin/node', helperPath });
  assert.equal(installed.success, true);
  assert.match(installed.message, /Added CliDeck hooks to /);
  assert.match(installed.message, /page_flip_on_send = false/);
  assert.equal(grokHooks.healthy(root, 4000), true);
  assert.equal(grokHooks.healthy(root, 4100), false);
  assert.equal(grokHooks.hasAny(root), true);

  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.hooks.Stop[0].hooks[0].command, 'third-party-stop');
  assert.equal(saved.hooks.CustomEvent[0].hooks[0].command, 'third-party-custom');
  assert.equal(saved.hooks.PreToolUse[0].hooks[0].timeout, 5);

  grokHooks.remove(root);
  const cleaned = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(cleaned.hooks.Stop, [{ hooks: [{ type: 'command', command: 'third-party-stop' }] }]);
  assert.deepEqual(cleaned.hooks.CustomEvent, [{ hooks: [{ type: 'command', command: 'third-party-custom' }] }]);
});

test('Grok hook removal deletes a CliDeck-only file', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  grokHooks.install(root, 4000, { helperPath });
  const path = grokHooks.configPath(root);
  assert.equal(existsSync(path), true);
  grokHooks.remove(root);
  assert.equal(existsSync(path), false);
});

test('Grok setup writes page_flip_on_send = false only when unset', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tomlPath = grokHooks.grokConfigTomlPath(root);
  writeFileSync(tomlPath, '[ui]\ncompact_mode = true\nmax_thoughts_width = 120\n');

  const installed = grokHooks.install(root, 4000, { helperPath });
  assert.match(installed.message, /page_flip_on_send = false/);
  const once = readFileSync(tomlPath, 'utf8');
  assert.match(once, /^\[ui\]$/m);
  assert.match(once, /^page_flip_on_send = false # managed-by-clideck$/m);
  assert.match(once, /^compact_mode = true$/m);
  assert.match(once, /^max_thoughts_width = 120$/m);
  assert.equal(grokHooks.healthy(root, 4000), true);

  grokHooks.install(root, 4000, { helperPath });
  assert.equal(readFileSync(tomlPath, 'utf8'), once);

  writeFileSync(tomlPath, '[ui]\npage_flip_on_send = true\ncompact_mode = true\n');
  grokHooks.install(root, 4000, { helperPath });
  const userOwned = readFileSync(tomlPath, 'utf8');
  assert.match(userOwned, /^page_flip_on_send = true$/m);
  assert.doesNotMatch(userOwned, /^page_flip_on_send = false$/m);
  assert.match(userOwned, /^compact_mode = true$/m);
  assert.equal(grokHooks.healthy(root, 4000), true);
});

test('Grok hook removal reverses a canonical page_flip pref', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tomlPath = grokHooks.grokConfigTomlPath(root);
  writeFileSync(tomlPath, '[ui]\ncompact_mode = true\n');
  grokHooks.install(root, 4000, { helperPath });
  const removed = grokHooks.remove(root);
  assert.match(removed.message, /Removed CliDeck \[ui\] page_flip_on_send/);
  assert.doesNotMatch(readFileSync(tomlPath, 'utf8'), /page_flip_on_send/);
  assert.match(readFileSync(tomlPath, 'utf8'), /compact_mode = true/);
});

test('Grok hook removal preserves a pre-existing false page_flip preference', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tomlPath = grokHooks.grokConfigTomlPath(root);
  const original = '[ui]\npage_flip_on_send = false\ncompact_mode = true\n';
  writeFileSync(tomlPath, original);

  assert.equal(grokHooks.install(root, 4000, { helperPath }).success, true);
  assert.equal(grokHooks.remove(root).success, true);
  assert.equal(readFileSync(tomlPath, 'utf8'), original);
});

test('Grok hook setup does not partially install when config.toml is invalid', t => {
  const { root, helperPath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hookPath = grokHooks.configPath(root);
  const tomlPath = grokHooks.grokConfigTomlPath(root);
  writeFileSync(tomlPath, '[ui\n');

  const result = grokHooks.install(root, 4000, { helperPath });
  assert.equal(result.success, false);
  assert.equal(existsSync(hookPath), false);
  assert.equal(readFileSync(tomlPath, 'utf8'), '[ui\n');
});
