const { binName } = require('./utils');

const GUIDE = `CliDeck session guide:
You are running inside CliDeck only when CLIDECK_SESSION_ID is set.
Existing sessions are user-owned conversations. Do not send work to one with clideck ask: it injects a prompt and interrupts that session even when it is idle.
Do the task yourself by default. If a bounded independent review would materially improve the result, create one dedicated worker with clideck spawn --project "<project>" --name "<name>" --prompt "<bounded task>" --wait --timeout 10m.
The waiting spawn command returns the worker's first answer on stdout and closes the worker. Add --worktree only when the worker needs isolated repository writes.
Do not spawn for routine or self-contained work. Use at most one worker unless the user explicitly requests parallel work, and never exceed the server cap of three active spawned workers. Spawned workers cannot spawn more workers.
Only use clideck ask --interrupt-existing when the user explicitly asks you to contact that exact existing session.
If CLIDECK_SESSION_ID is missing, ignore this guide.`;

function commandStart(parts) {
  if (process.platform === 'win32' && parts.length > 2 && /^cmd(?:\.exe)?$/i.test(binName(parts[0])) && parts[1].toLowerCase() === '/c') {
    return 2;
  }
  return 0;
}

function hasCodexDeveloperInstructions(parts) {
  return parts.some((part, idx) => {
    if (part === '-c' || part === '--config') return String(parts[idx + 1] || '').startsWith('developer_instructions=');
    return String(part || '').startsWith('-cdeveloper_instructions=')
      || String(part || '').startsWith('--config=developer_instructions=');
  });
}

function hasGrokRules(parts) {
  return parts.some((part) => {
    if (part === '--rules') return true;
    return String(part || '').startsWith('--rules=');
  });
}

function withCliDeckGuide(parts, presetId) {
  const next = [...parts];
  const idx = commandStart(next);

  if (presetId === 'claude-code') {
    if (next.includes('--system-prompt') || next.includes('--append-system-prompt')) return next;
    next.splice(idx + 1, 0, '--append-system-prompt', GUIDE);
  } else if (presetId === 'codex') {
    if (hasCodexDeveloperInstructions(next)) return next;
    next.splice(idx + 1, 0, '-c', `developer_instructions=${JSON.stringify(GUIDE)}`);
  } else if (presetId === 'grok') {
    // Grok appends --rules to the system prompt. Skip when the user already
    // supplies rules or a full system-prompt override.
    if (hasGrokRules(next) || next.includes('--system-prompt-override') || next.includes('--system-prompt')) {
      return next;
    }
    next.splice(idx + 1, 0, '--rules', GUIDE);
  }

  return next;
}

module.exports = { withCliDeckGuide, GUIDE };
