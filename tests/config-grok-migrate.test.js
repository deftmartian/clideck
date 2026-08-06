const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');
const Module = require('module');

// Load config.js against an isolated DATA_DIR by stubbing paths before require.
test('migrate promotes shell-wrapped grok YOLO launcher to grok preset', () => {
  const dataDir = mkdtempSync(join(os.tmpdir(), 'clideck-grok-cfg-'));
  const pathsPath = require.resolve('../paths');
  const configPath = require.resolve('../config');
  delete require.cache[pathsPath];
  delete require.cache[configPath];

  const realPaths = require(pathsPath);
  require.cache[pathsPath].exports = { ...realPaths, DATA_DIR: dataDir };

  try {
    const config = require(configPath);
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      defaultPath: '/tmp',
      commands: [
        {
          id: 'shell',
          presetId: 'shell',
          label: 'Shell',
          icon: 'terminal',
          command: '/bin/bash',
          enabled: true,
          isAgent: false,
          canResume: false,
        },
        {
          id: 'grok-yolo',
          presetId: 'shell',
          label: 'Grok (VM YOLO)',
          icon: 'terminal',
          command: '/bin/bash -lc \'echo "Session ID: $CLIDECK_SESSION_ID"; exec grok --session-id "$CLIDECK_SESSION_ID" --permission-mode bypassPermissions --sandbox off\'',
          enabled: true,
          isAgent: true,
          canResume: true,
          resumeCommand: 'grok --permission-mode bypassPermissions --sandbox off --resume {{sessionId}}',
          sessionIdPattern: 'Session ID:\\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
          userAdded: true,
        },
        {
          id: 'grok-mention',
          presetId: 'shell',
          label: 'Documentation helper',
          icon: 'terminal',
          command: '/bin/bash -lc \'echo grok\'',
          enabled: true,
          isAgent: false,
          canResume: false,
        },
      ],
    }, null, 2));

    const cfg = config.load();
    const grok = cfg.commands.find(c => c.id === 'grok-yolo');
    assert.ok(grok, 'grok-yolo command retained');
    assert.equal(grok.presetId, 'grok');
    assert.equal(grok.isAgent, true);
    assert.equal(grok.canResume, true);
    assert.equal(grok.command, 'grok --permission-mode bypassPermissions --sandbox off');
    assert.equal(grok.resumeCommand, 'grok --permission-mode bypassPermissions --sandbox off --resume {{sessionId}}');
    assert.equal(grok.sessionIdPattern, null);
    assert.equal(grok.icon, '/img/grok.svg');
    const mention = cfg.commands.find(c => c.id === 'grok-mention');
    assert.equal(mention.presetId, 'shell');
    assert.equal(mention.isAgent, false);
    assert.equal(mention.command, '/bin/bash -lc \'echo grok\'');
    // A promoted YOLO entry already covers the grok preset, so migrate must
    // not inject a second plain `grok` launcher.
    assert.equal(cfg.commands.filter(c => c.presetId === 'grok').length, 1);
  } finally {
    delete require.cache[configPath];
    delete require.cache[pathsPath];
    require.cache[pathsPath] = undefined;
    // Restore real paths module for later tests in the same process.
    require(pathsPath);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
