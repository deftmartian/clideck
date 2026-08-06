const { test } = require('node:test');
const assert = require('node:assert');
const { withCliDeckGuide, GUIDE } = require('../agent-session-guide');

test('claude and codex keep existing guide injection', () => {
  const claude = withCliDeckGuide(['claude'], 'claude-code');
  assert.deepEqual(claude.slice(0, 3), ['claude', '--append-system-prompt', GUIDE]);

  const codex = withCliDeckGuide(['codex'], 'codex');
  assert.equal(codex[0], 'codex');
  assert.equal(codex[1], '-c');
  assert.match(codex[2], /^developer_instructions=/);
});

test('grok injects CliDeck guide via --rules', () => {
  const parts = withCliDeckGuide(['grok', '--permission-mode', 'bypassPermissions'], 'grok');
  assert.deepEqual(parts, ['grok', '--rules', GUIDE, '--permission-mode', 'bypassPermissions']);
});

test('grok does not double-inject when rules or system prompt already set', () => {
  assert.deepEqual(
    withCliDeckGuide(['grok', '--rules', 'custom'], 'grok'),
    ['grok', '--rules', 'custom'],
  );
  assert.deepEqual(
    withCliDeckGuide(['grok', '--system-prompt-override', 'x'], 'grok'),
    ['grok', '--system-prompt-override', 'x'],
  );
});
