const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { claudeProvider } = require('../src/claude-provider');
const { renderStatusLine, userStatusLine } = require('../src/claude-statusline');

const payload = {
  model: { display_name: 'Opus' },
  context_window: { context_window_size: 200000, used_percentage: 41.6, current_usage: { input_tokens: 83000 } },
};

test('fresh Claude launches choose their conversation id; explicit selections are left alone', () => {
  const launches = [
    claudeProvider.createLaunch({ port: 1, sessionId: 's' }),
    claudeProvider.createLaunch({ port: 1, sessionId: 's', resumeHandle: 'native' }),
    claudeProvider.createLaunch({ port: 1, sessionId: 's', extraArgs: ['--continue'] }),
    claudeProvider.createLaunch({ port: 1, sessionId: 's', command: 'claude --session-id=x' }),
  ];
  try {
    const [fresh, resumed, continued, explicit] = launches;
    const at = fresh.args.indexOf('--session-id');
    assert.match(fresh.args[at + 1], /^[0-9a-f-]{36}$/);
    assert.equal(fresh.resumeHandle, fresh.args[at + 1]);
    assert.deepEqual(resumed.args.slice(-2), ['--resume', 'native']);
    for (const launch of [resumed, continued, explicit]) {
      assert.equal(launch.args.includes('--session-id'), false);
      assert.equal(launch.resumeHandle, undefined);
    }
  } finally {
    for (const launch of launches) launch.cleanup();
  }
});

test('Claude settings route permission and elicitation notifications to menu detection', () => {
  const launch = claudeProvider.createLaunch({ port: 1, sessionId: 's' });
  try {
    const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf('--settings') + 1], 'utf8'));
    const routes = Object.fromEntries(settings.hooks.Notification.map(entry => [entry.matcher, entry.hooks[0].command.split(' ')[4]]));
    assert.deepEqual(routes, { idle_prompt: 'idle', permission_prompt: 'menu', elicitation_dialog: 'menu' });
  } finally {
    launch.cleanup();
  }
});

test('the status line shows model and context, or runs the user statusLine instead', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-statusline-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const project = join(root, 'project');
  mkdirSync(profile); mkdirSync(join(project, '.claude'), { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profile };

  assert.equal(renderStatusLine(JSON.stringify(payload), env), 'Opus · 42% context');

  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user-line' } }));
  assert.equal(renderStatusLine(JSON.stringify(payload), env).trim(), 'user-line');

  // Project settings win over the profile, and CliDeck's own hook is never chained to itself.
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node claude-hook.js 1 s context' } }));
  assert.equal(userStatusLine({ cwd: project }, env).command, 'echo user-line');
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'cat >/dev/null; echo local-line' } }));
  assert.equal(renderStatusLine(JSON.stringify({ ...payload, cwd: project }), env).trim(), 'local-line');

  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'exit 1' } }));
  assert.equal(renderStatusLine(JSON.stringify({ ...payload, cwd: project }), env), 'Opus · 42% context');
});
