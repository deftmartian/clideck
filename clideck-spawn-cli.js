const http = require('http');
const https = require('https');

function usage() {
  return [
    'Usage:',
    '  clideck spawn --project <name|id> [--name <name>] --prompt <text> --wait [options]',
    '  cat task.md | clideck spawn --project <name|id> --name <name> --worktree',
    '',
    'Use from inside a CliDeck session to create a new peer agent session.',
    'A project is required (use --no-project to create one outside any project).',
    'The new session runs the same agent as the caller unless --preset overrides.',
    'Use --wait for bounded delegation: the first answer is returned on stdout and',
    'the worker session is closed automatically.',
    '',
    'Important for agents:',
    '  Do the work locally by default. Spawn one worker only when a bounded independent',
    '  task or review materially helps. The server permits at most three active spawned',
    '  workers, and a spawned worker cannot spawn another worker.',
    '  Without --wait, spawn remains fire-and-forget and the worker stays open. Use this',
    '  only when the user wants a visible long-running worker.',
    '  With --worktree the new session runs in a fresh git worktree of the current',
    '  repository, so parallel workers never touch each other\'s checkout. Worktrees',
    '  live under ~/.clideck/worktrees/<repo>/ and are not auto-removed; clean up',
    '  finished ones with `git worktree remove <path>`.',
    '  Give each worker a distinct --name; names are unique per project.',
    '',
    'Options:',
    '  -n, --name <name>        Session name. Default: a random name like the UI uses.',
    '  -m, --prompt <text>      Initial prompt typed into the new agent once it looks',
    '                           ready (first idle status, or after a short fallback',
    '                           delay). If omitted and stdin is piped, stdin is used.',
    '  -p, --project <name|id>  Project for the new session (required).',
    '      --no-project         Explicitly place the session outside any project.',
    '      --preset <presetId>  Agent preset to launch (claude-code, codex, gemini-cli,',
    '                           grok, opencode, pi, ...). Default: same agent as caller.',
    '      --command-id <id>    Exact config command id to launch (overrides --preset).',
    '      --cwd <dir>          Working directory. Default: project path, else caller cwd.',
    '  -w, --worktree           Create a git worktree from the resolved cwd and run there.',
    '      --branch <name>      Branch for --worktree. Default: clideck/<session-slug>.',
    '                           An existing branch is checked out; a new one is created.',
    '      --ready-timeout <d>  Max wait for the agent to look ready before submitting',
    '                           the prompt anyway. Examples: 10s, 30s. Default: 15s.',
    '      --wait               Wait for the first answer, print it, and close the worker.',
    '  -t, --timeout <d>        Result wait time with --wait. Default: 10m; maximum: 1h.',
    '      --keep               Keep the worker open after --wait returns its answer.',
    '      --url <url>          CliDeck server URL. Default: CLIDECK_URL or local port.',
    '      --json               Print the full spawn result as JSON.',
    '  -h, --help               Show this help.',
    '',
    'Examples:',
    '  clideck spawn -p kb -n Reviewer -m "Review the diff. Return findings only." --wait',
    '  clideck spawn -p kb --name "Worker 1" --worktree --prompt "Fix DO-123: ..." --wait',
    '  clideck spawn -p Website -n "Docs Writer" --cwd ~/repos/website',
  ].join('\n');
}

function parseDuration(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const scale = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return Math.max(1, Math.round(n * scale));
}

function parseArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = {
    url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}`,
    json: false,
    waitForResult: false,
    keepOpen: false,
    resultTimeoutMs: 10 * 60 * 1000,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg === '-n') out.name = args[++i];
    else if (arg === '--prompt' || arg === '-m' || arg === '--message') out.prompt = args[++i];
    else if (arg === '--project' || arg === '-p') out.project = args[++i];
    else if (arg === '--no-project') out.noProject = true;
    else if (arg === '--preset') out.presetId = args[++i];
    else if (arg === '--command-id') out.commandId = args[++i];
    else if (arg === '--cwd') out.cwd = args[++i];
    else if (arg === '--worktree' || arg === '-w') out.worktree = true;
    else if (arg === '--branch') out.branch = args[++i];
    else if (arg === '--ready-timeout') {
      const parsed = parseDuration(args[++i]);
      if (!parsed) throw new Error('Invalid --ready-timeout value');
      out.readyTimeoutMs = parsed;
    } else if (arg === '--wait') out.waitForResult = true;
    else if (arg === '--timeout' || arg === '-t') {
      const parsed = parseDuration(args[++i]);
      if (!parsed) throw new Error('Invalid --timeout value');
      out.resultTimeoutMs = Math.min(parsed, 60 * 60 * 1000);
    } else if (arg === '--keep') out.keepOpen = true;
    else if (arg === '--url') out.url = args[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown spawn argument: ${arg}`);
  }
  return out;
}

function readStdinIfAvailable() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/session/spawn', url);
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck spawn failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CliDeck spawn timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function formatResult(res) {
  const lines = [`Created "${res.name}" (${res.address}) id=${res.id}`];
  lines.push(`cwd: ${res.cwd}`);
  if (res.worktreePath) lines.push(`worktree: ${res.worktreePath} (branch ${res.branch})`);
  if (res.promptDelivered) {
    lines.push(res.promptDelivered === 'timeout'
      ? 'prompt: submitted after ready-timeout fallback; verify with `clideck ask status`.'
      : 'prompt: submitted.');
    lines.push('The dedicated worker remains open; follow up with `clideck ask` or close it when done.');
  }
  return lines.join('\n');
}

async function run(args) {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (!opts.prompt) {
      const stdin = (await readStdinIfAvailable()).trim();
      if (stdin) opts.prompt = stdin;
    }
    const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');
    if (!opts.project && !opts.noProject) {
      throw new Error('--project <name-or-id> is required (or pass --no-project). Run `clideck agents --all` to see project names.');
    }
    if (opts.waitForResult && !opts.prompt) throw new Error('--wait requires an initial prompt.');
    if (opts.keepOpen && !opts.waitForResult) throw new Error('--keep requires --wait.');

    // Worktree setup plus the ready-wait both happen server-side within this call.
    const httpTimeout = (opts.readyTimeoutMs || 15000)
      + (opts.waitForResult ? opts.resultTimeoutMs : 0)
      + 45000;
    const res = await postJson(opts.url, {
      callerSessionId,
      name: opts.name,
      prompt: opts.prompt,
      project: opts.project,
      noProject: opts.noProject,
      presetId: opts.presetId,
      commandId: opts.commandId,
      cwd: opts.cwd,
      worktree: opts.worktree,
      branch: opts.branch,
      readyTimeoutMs: opts.readyTimeoutMs,
      waitForResult: opts.waitForResult,
      resultTimeoutMs: opts.resultTimeoutMs,
      keepOpen: opts.keepOpen,
    }, httpTimeout);
    const output = opts.json
      ? JSON.stringify(res, null, 2)
      : (res.response != null ? String(res.response).trimEnd() : formatResult(res));
    process.stdout.write(output + '\n');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs, parseDuration, formatResult };
