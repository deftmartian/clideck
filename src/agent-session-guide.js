const { join } = require('path');
const { profileContext } = require('./user-profile');
const { parseCommand } = require('./custom-command');

const cliPath = join(__dirname, '../bin/clideck.js');
const nodeCli = `"${process.execPath}" "${cliPath}"`;
const MAX_GUIDE_BYTES = 6 * 1024;

function createAgentSessionGuide(pluginCommands = [], about = {}) {
  const base = `CliDeck session tools (when CLIDECK_SESSION_ID is set):
Work locally by default. Existing sessions are the user's conversations: do not contact or repurpose one, even when idle, unless the user explicitly names that session. Use fresh discovery before choosing a peer: \`clideck agents\` for current-project sessions or \`clideck agents --all\` for other projects. A dormant saved session is not a required team role; refresh after a failed contact or team change. Use current exact addresses rather than old handoff names. Only stop test processes you started, using their exact child handles or verified PIDs; never broad process or port cleanup.
For a materially useful independent task, use one dedicated worker: \`clideck spawn --project "<name|id>" --name "<name>" --prompt "<bounded task>" --wait --timeout 10m\`. On success it returns the first answer on stdout and closes the worker. A timeout leaves dispatched work running: use \`clideck worker list\` for parent, age, state and collection, \`clideck worker status <session-id>\`, \`clideck worker wait <session-id> --timeout 10m\` to collect its answer without resending, or \`clideck worker cancel <session-id>\` to stop it. After an engine restart, collection is unavailable and listing does not relaunch or reuse sessions. Retained workers count toward the active limit. Keep the command running until it returns. Add \`--worktree\` only for isolated repository writes. Launchers default to the caller’s; \`--command-id <configured-id>\` explicitly selects an enabled CLI Agents command and preserves its flags on resume. \`--preset <provider>\` selects the stock provider instead. At most one worker unless the user asks for parallel work; the server caps active spawned workers at three and forbids recursive spawning. Omit --wait only when the user wants a visible long-running pane.
\`clideck ask "<worker>" "<message>"\` follows up with a worker you spawned. Use \`clideck ask status\` to check readiness. Existing user sessions are protected by default. Only use \`clideck ask --interrupt-existing "<exact session>" "<short question>"\` when the user explicitly asks you to contact that session. Working targets also require --steer; never use it to turn an unrelated conversation into a worker.
Render image/video/text/json/csv/markdown/html/pdf/mermaid/diff files in a preview tab: \`clideck show <path>\` or \`cat x.md | clideck show --stdin --kind markdown --name "Notes"\` (file kind by extension). Reusing a name replaces its open preview. HTML is a single file; embed its assets. Chart and testresults previews accept JSON through stdin with the corresponding kind. Use previews to show the user useful artifacts directly.
Ask the user a question in CliDeck: \`clideck prompt "<question>" --options "Choice A,Choice B" --timeout 10m\` (options are optional). Request visual feedback on a project image: \`clideck annotate <image-file> --timeout 10m\`. Both wait and print the user's answer to stdout; keep the command running until it answers.
Discover installed extensions at any time with \`clideck plugins\`.
Full command help: \`clideck --help\`; list peers/plugins as JSON with \`--json\`. If the global clideck command is missing or incompatible, use the session's exact CLI \`${nodeCli}\` for every command above. The session environment already supplies the server address and caller identity.
Keep a normal ask running for its stdout answer; busy asks are not queued. Give dedicated workers concrete tasks and enough context to act, then assess their findings before applying them.`;
  let guide = base;
  const profile = profileContext(about, MAX_GUIDE_BYTES - Buffer.byteLength(base) - 1);
  if (profile) guide += `\n${profile}`;
  for (const command of pluginCommands.slice(0, 24)) {
    const line = `Plugin ${command.pluginName}: \`clideck ${command.usage}\` — ${command.description}`
      .replace(/\s+/g, ' ');
    if (Buffer.byteLength(`${guide}\n${line}`) > MAX_GUIDE_BYTES) break;
    guide += `\n${line}`;
  }
  return guide;
}

const AGENT_SESSION_GUIDE = createAgentSessionGuide();

function hasClaudeSystemPrompt(command, extraArgs = []) {
  return [...parseCommand(command), ...extraArgs].some((arg) => (
    typeof arg === 'string' && /^--(?:append-)?system-prompt(?:=|$)/.test(arg)
  ));
}

function hasCodexDeveloperInstructions(command, extraArgs = []) {
  const args = [...parseCommand(command), ...extraArgs];
  return args.some((arg, index) => {
    if (typeof arg !== 'string') return false;
    if (arg === '-c' || arg === '--config') return /^\s*developer_instructions\s*=/.test(args[index + 1] || '');
    return /^(?:--config=|-c=?)[\s]*developer_instructions\s*=/.test(arg);
  });
}

module.exports = {
  AGENT_SESSION_GUIDE,
  createAgentSessionGuide,
  hasClaudeSystemPrompt,
  hasCodexDeveloperInstructions,
  MAX_GUIDE_BYTES,
};
