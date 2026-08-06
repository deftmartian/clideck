const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { spawnSync } = require('child_process');
const {
  initialResumeReady,
  markCodexUserPrompt,
  hasUsableResumeToken,
} = require('../resume-readiness');

test('fresh Codex token is replaced by the durable prompt thread before resume is enabled', () => {
  const session = {
    sessionToken: null,
    _resumeReady: initialResumeReady('codex', null),
  };

  session.sessionToken = 'early-telemetry-token';
  assert.equal(hasUsableResumeToken(session), false);

  markCodexUserPrompt(session, 'codex_cli_rs', 'codex.response.completed', 'durable-thread');
  assert.equal(hasUsableResumeToken(session), false);

  markCodexUserPrompt(session, 'codex_cli_rs', 'codex.user_prompt', 'durable-thread');
  assert.equal(hasUsableResumeToken(session), true);
  assert.equal(session.sessionToken, 'durable-thread');
});

test('Codex prompt without a conversation ID cannot bless a provisional token', () => {
  const session = {
    sessionToken: 'early-telemetry-token',
    _resumeReady: false,
  };

  assert.equal(markCodexUserPrompt(session, 'codex_cli_rs', 'codex.user_prompt', ''), false);
  assert.equal(hasUsableResumeToken(session), false);
});

test('saved Codex token remains resumable without a new prompt', () => {
  const session = {
    sessionToken: 'saved-token',
    _resumeReady: initialResumeReady('codex', 'saved-token'),
  };
  assert.equal(hasUsableResumeToken(session), true);
});

test('non-Codex providers retain existing token behavior', () => {
  const session = {
    sessionToken: 'provider-token',
    _resumeReady: initialResumeReady('claude-code', null),
  };
  assert.equal(hasUsableResumeToken(session), true);
});

test('shutdown persists a ready Codex token and skips an early token', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'clideck-resume-ready-'));
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const sessions = require('./sessions');
      const map = sessions.getSessions();
      const common = {
        ephemeral: false,
        commandId: 'codex',
        presetId: 'codex',
        cwd: process.cwd(),
        themeId: 'default',
        projectId: null,
        muted: false,
        pty: { kill() {} },
      };
      map.set('early', {
        ...common,
        name: 'Early',
        sessionToken: 'early-token',
        _resumeReady: false,
      });
      map.set('ready', {
        ...common,
        name: 'Ready',
        sessionToken: 'ready-token',
        _resumeReady: true,
      });
      sessions.shutdown({
        commands: [{
          id: 'codex',
          canResume: true,
          resumeCommand: 'codex resume {{sessionId}}',
        }],
      });
    `], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, HOME: tempHome },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(readFileSync(join(tempHome, '.clideck', 'sessions.json'), 'utf8'));
    assert.deepEqual(saved.map(session => session.id), ['ready']);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
