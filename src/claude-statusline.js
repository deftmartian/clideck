const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { claudeContextUsage } = require('./context-usage');

// CliDeck's --settings statusLine reports context usage, and --settings outranks the user's own
// statusLine. Run theirs (same precedence as Claude: local, project, user) so it still shows.
function userStatusLine(payload, env = process.env) {
  const cwd = payload?.workspace?.project_dir || payload?.cwd || '';
  const profile = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  const files = [
    ...(cwd ? [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json')] : []),
    join(profile, 'settings.json'),
  ];
  for (const file of files) {
    let statusLine;
    try { statusLine = JSON.parse(readFileSync(file, 'utf8'))?.statusLine; } catch { continue; }
    if (statusLine?.type !== 'command' || typeof statusLine.command !== 'string') continue;
    if (statusLine.command.includes('claude-hook.js')) continue;
    return { command: statusLine.command, cwd: payload?.workspace?.current_dir || cwd || undefined };
  }
  return null;
}

function defaultStatusLine(payload) {
  const model = payload?.model?.display_name || payload?.model?.id || '';
  const usage = claudeContextUsage(payload);
  const parts = [model, usage && Number.isFinite(usage.percent) ? `${Math.round(usage.percent)}% context` : ''];
  return parts.filter(Boolean).join(' · ');
}

function renderStatusLine(input, env = process.env, run = spawnSync) {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch {}
  const custom = userStatusLine(payload, env);
  if (custom) {
    const result = run(custom.command, { shell: true, cwd: custom.cwd, input, encoding: 'utf8', timeout: 3000, env });
    // A command that ignores stdin can exit before the payload is written; EPIPE still leaves valid output.
    const failed = result.error && result.error.code !== 'EPIPE';
    if (!failed && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()) return result.stdout;
  }
  return defaultStatusLine(payload);
}

module.exports = { userStatusLine, defaultStatusLine, renderStatusLine };
