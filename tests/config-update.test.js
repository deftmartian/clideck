const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeClientUpdate } = require('../config');

function config(commands) {
  return {
    commands,
    projects: [],
    prompts: [],
    defaultPath: '/tmp',
    defaultShell: '/bin/bash',
  };
}

test('stale filtered updates preserve shipped launchers and hidden commands', () => {
  const current = config([
    {
      id: 'codex-current',
      presetId: 'codex',
      label: 'My Codex',
      command: 'codex --profile local',
      enabled: true,
      isAgent: true,
      env: {},
    },
    {
      id: 'shell-current',
      presetId: 'shell',
      label: 'Shell',
      command: '/bin/bash',
      enabled: true,
      isAgent: false,
      env: {},
    },
    {
      id: 'claude-hidden',
      presetId: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      enabled: true,
      isAgent: true,
      env: {},
    },
    {
      id: 'custom-visible',
      label: 'Temporary custom command',
      command: 'custom-command',
      enabled: true,
      isAgent: false,
      env: {},
    },
  ]);

  const merged = mergeClientUpdate(
    current,
    { commands: [] },
    new Set(['codex-current', 'shell-current', 'custom-visible']),
  );

  const codex = merged.commands.filter(c => c.presetId === 'codex');
  const shell = merged.commands.filter(c => c.presetId === 'shell');
  assert.equal(codex.length, 1);
  assert.equal(codex[0].id, 'codex-current');
  assert.equal(codex[0].command, 'codex --profile local');
  assert.equal(shell.length, 1);
  assert.equal(shell[0].id, 'shell-current');
  assert.ok(merged.commands.some(c => c.id === 'claude-hidden'));
  assert.ok(!merged.commands.some(c => c.id === 'custom-visible'));
});

test('an incoming shipped launcher replaces the prior entry without duplication', () => {
  const current = config([
    {
      id: 'codex-old',
      presetId: 'codex',
      label: 'Old Codex',
      command: 'codex',
      enabled: true,
      isAgent: true,
      env: {},
    },
  ]);
  const replacement = {
    id: 'codex-new',
    presetId: 'codex',
    label: 'New Codex',
    command: 'codex --profile new',
    enabled: true,
    isAgent: true,
    env: {},
  };

  const merged = mergeClientUpdate(
    current,
    { commands: [replacement] },
    new Set(['codex-old']),
  );

  const codex = merged.commands.filter(c => c.presetId === 'codex');
  assert.equal(codex.length, 1);
  assert.equal(codex[0].id, 'codex-new');
  assert.equal(codex[0].command, 'codex --profile new');
});
