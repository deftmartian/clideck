#!/usr/bin/env node
const args = process.argv.slice(2);

function usage() {
  const version = require('../package.json').version;
  return [
    `CliDeck v${version}`,
    '',
    'Usage:',
    '  clideck [--host <host>] [--port <port>]',
    '  clideck agents [--json] [--all]',
    '  clideck ask status [--json] [--all]',
    '  clideck ask --session <name-or-id> --message <text> [--timeout 10m]',
    '  clideck spawn --project <name|id> --prompt <text> --wait [--worktree]',
    '',
    'Options:',
    '  --host <host>     Host to bind. Default: 127.0.0.1. Use 0.0.0.0 for LAN access.',
    '  --port <port>     Port to use. Default: 4000. Can also use CLIDECK_PORT.',
    '  -h, --help        Show this help.',
    '  -v, --version     Show version.',
    '',
    'Agent tools:',
    '  clideck agents',
    '    Lists active sessions in the same project as the caller session.',
    '    Add --all to list sessions across projects.',
    '',
    '  clideck ask',
    '    Sends a follow-up to a worker this session spawned. Existing sessions are protected',
    '    unless --interrupt-existing is supplied on the user\'s explicit request.',
    '',
    '  clideck spawn',
    '    Creates a dedicated worker without interrupting another conversation. --wait returns',
    '    the first answer and closes the worker. Spawned workers are capped at three active',
    '    sessions and cannot recursively spawn. Run `clideck spawn --help` for details.',
    '',
    'Ask behavior:',
    '  Unscoped target lookup is limited to the same project as the caller session.',
    '  Cross-project asks must use an explicit @project/session target.',
    '  Use the target exactly as shown by `clideck agents`; quote it if it contains spaces.',
    '  CliDeck sends the message into the real target terminal, presses Enter, waits for the',
    '  target to finish, then prints the target agent response to stdout.',
    '  The target is another LLM agent. It may need minutes to think, read files, and use tools.',
    '  Keep the `clideck ask` shell command running until it exits. stdout is the response channel.',
    '  Waiting progress goes to stderr; the target response goes to stdout.',
    '  Set both `--timeout` and your shell/tool-call timeout high enough, or the target may keep',
    '  working while the caller loses the response.',
    '  CliDeck only sends to idle targets and does not queue asks. Wait for the dedicated',
    '  worker rather than selecting an unrelated idle session.',
    '',
    'Examples:',
    '  clideck agents',
    '  clideck agents --json',
    '  clideck agents --all',
    '  clideck ask status',
    '  clideck ask status --all',
    '  clideck spawn -p website -n Reviewer -m "Review this diff. Return findings." --wait',
    '  clideck ask --session "Reviewer" --message "Clarify finding 2."',
    '  clideck ask --interrupt-existing "Docs Writer" "User-requested handoff." --timeout 15m',
    '',
    'Notes for agents:',
    '  Work locally by default. For materially useful independent review, spawn one bounded',
    '  worker with --wait. Do not repurpose an existing user conversation as a worker.',
    '  Run `clideck ask --help` for the explicit existing-session escape hatch.',
  ].join('\n');
}

if (args[0] === 'agents') {
  require('../clideck-agents-cli').run(args.slice(1));
} else if (args[0] === 'ask') {
  require('../clideck-ask-cli').run(args.slice(1));
} else if (args[0] === 'spawn') {
  require('../clideck-spawn-cli').run(args.slice(1));
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
} else {
  require('../server.js');
}
