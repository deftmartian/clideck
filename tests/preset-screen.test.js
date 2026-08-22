const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPresetScreenArgs } = require('../preset-screen');
const presets = require('../agent-presets.json');

const grok = presets.find(preset => preset.presetId === 'grok');
const claude = presets.find(preset => preset.presetId === 'claude-code');
const codex = presets.find(preset => preset.presetId === 'codex');

test('desktop Grok launches get --no-alt-screen; touch also gets --minimal', () => {
  assert.deepEqual(
    applyPresetScreenArgs(['grok'], grok, false),
    ['grok', '--no-alt-screen'],
  );
  assert.deepEqual(
    applyPresetScreenArgs(['grok'], grok, true),
    ['grok', '--no-alt-screen', '--minimal'],
  );
});

test('existing screen flags are not doubled and other presets are unchanged', () => {
  const yolo = ['grok', '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '--no-alt-screen'];
  assert.deepEqual(
    applyPresetScreenArgs(yolo, grok, true),
    [...yolo, '--minimal'],
  );
  assert.deepEqual(
    applyPresetScreenArgs(['grok', '--minimal'], grok, true),
    ['grok', '--minimal', '--no-alt-screen'],
  );
  assert.deepEqual(applyPresetScreenArgs(['claude'], claude, true), ['claude']);
  assert.deepEqual(applyPresetScreenArgs(['codex'], codex, true), ['codex']);
  assert.deepEqual(applyPresetScreenArgs(['grok'], null, true), ['grok']);
});
