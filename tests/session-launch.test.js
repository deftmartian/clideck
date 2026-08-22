const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const { sessionLaunchParts } = require('../session-launch');
const { GUIDE } = require('../agent-session-guide');
const presets = require('../agent-presets.json');

const grok = presets.find(preset => preset.presetId === 'grok');
const claude = presets.find(preset => preset.presetId === 'claude-code');

function grokCmd(command = 'grok', resumeCommand = 'grok --resume {{sessionId}}') {
  return { command, resumeCommand };
}

test('create resume and restart Grok argv include screen flags and the CliDeck guide', () => {
  const created = sessionLaunchParts(grokCmd(), grok, { touchUi: false });
  assert.deepEqual(created, ['grok', '--rules', GUIDE, '--no-alt-screen']);

  const touchCreate = sessionLaunchParts(grokCmd(), grok, { touchUi: true });
  assert.deepEqual(touchCreate, ['grok', '--rules', GUIDE, '--no-alt-screen', '--minimal']);

  const resumed = sessionLaunchParts(grokCmd(), grok, {
    touchUi: false,
    commandText: 'grok --resume 01a029f1-c994-71e1-b6d5-d6f35ee8fc8d',
  });
  assert.deepEqual(resumed, [
    'grok', '--rules', GUIDE, '--resume', '01a029f1-c994-71e1-b6d5-d6f35ee8fc8d', '--no-alt-screen',
  ]);

  const restarted = sessionLaunchParts(grokCmd(), grok, {
    touchUi: true,
    commandText: 'grok --resume 01a029f1-c994-71e1-b6d5-d6f35ee8fc8d',
  });
  assert.deepEqual(restarted, [
    'grok', '--rules', GUIDE, '--resume', '01a029f1-c994-71e1-b6d5-d6f35ee8fc8d',
    '--no-alt-screen', '--minimal',
  ]);
});

test('create resume and restart do not double flags or inject over user rules', () => {
  const yolo = grokCmd('grok --permission-mode bypassPermissions --sandbox off --no-alt-screen');
  assert.deepEqual(
    sessionLaunchParts(yolo, grok, { touchUi: true }),
    [
      'grok', '--rules', GUIDE, '--permission-mode', 'bypassPermissions',
      '--sandbox', 'off', '--no-alt-screen', '--minimal',
    ],
  );
  assert.deepEqual(
    sessionLaunchParts(grokCmd('grok --rules custom'), grok, { touchUi: false }),
    ['grok', '--rules', 'custom', '--no-alt-screen'],
  );
  assert.deepEqual(
    sessionLaunchParts({ command: 'claude' }, claude, { touchUi: true }),
    ['claude', '--append-system-prompt', GUIDE],
  );
});

test('sessions create resume restart and programmatic spawn share sessionLaunchParts', () => {
  const source = readFileSync(join(__dirname, '../sessions.js'), 'utf8');
  assert.equal([...source.matchAll(/sessionLaunchParts\(/g)].length, 4);
  assert.doesNotMatch(source, /withCliDeckGuide\(/);
  assert.match(source, /function create\(/);
  assert.match(source, /function resume\(/);
  assert.match(source, /function restart\(/);
  assert.match(source, /function createProgrammatic\(/);
});
