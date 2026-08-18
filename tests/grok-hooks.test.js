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
  assert.deepEqual(
    grokHooks.install(root, 4000, { nodePath: '/usr/bin/node', helperPath }),
    { success: true, message: `Added CliDeck hooks to ${path}` },
  );
  assert.equal(grokHooks.healthy(root, 4000), true);
  assert.equal(grokHooks.healthy(root, 4100), false);
  assert.equal(grokHooks.hasAny(root), true);

  const installed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'third-party-stop');
  assert.equal(installed.hooks.CustomEvent[0].hooks[0].command, 'third-party-custom');
  assert.equal(installed.hooks.PreToolUse[0].hooks[0].timeout, 5);

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
