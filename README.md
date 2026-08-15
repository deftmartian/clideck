<p align="center">
  <img src="public/img/clideck-logo-icon.png" width="64" alt="clideck logo">
</p>

<h1 align="center">clideck</h1>

<p align="center">
  one screen for AI coding agents.
  <br><br>
  <a href="https://clideck.dev">Website</a> · <a href="https://docs.clideck.dev">Docs</a> · <a href="https://youtu.be/hICrtjGAeDk">Demo</a> · <a href="https://www.npmjs.com/package/clideck"><img src="https://img.shields.io/npm/v/clideck" alt="npm version"></a>
</p>

<!-- TODO: Replace with a ~10 second GIF showing: open clideck,
     sidebar with multiple agents across projects, click between them,
     one working one idle. No narration needed. -->

<p align="center">
  <img src="assets/clideck-themes.jpg" width="720" alt="clideck dashboard">
</p>

clideck is a local app for running multiple AI coding agents without juggling terminals. Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, and Pi all live in one browser window with a chat-style sidebar, live status, message previews, session resume, and projects to keep things organized. an autopilot routes work between agents automatically, and an E2E encrypted mobile relay gives full control over all agents from a phone.

the main problem with using multiple agents is not starting them. it is managing them. terminals pile up, finished work gets missed, good sessions disappear after a restart. clideck does not sit in the middle rewriting prompts or output - it only watches lightweight status signals from each agent so it can tell which agent is working, which is idle, and which is waiting. everything runs locally, no data leaves your machine.

## Why this exists

Terminal multiplexers are great at panes. clideck is about conversations.

A pane grid is flat. agent work usually is not. projects, previews, timestamps, notifications, resume, and sometimes a bit of routing between specialists all fit more naturally into a chat app layout. it also maps naturally to mobile, so the same mental model works on desktop and phone.

## Quick start

```bash
npm install -g clideck
clideck
```

Open [localhost:4000](http://localhost:4000). Click **+**, pick an agent, start working.

Or just run it once with `npx clideck`. Node 18+. Works on macOS, Linux, and Windows 10 1809+.

Linux ships prebuilt binaries for glibc x64 and arm64, so nothing compiles. Other Linux setups need to build node-pty from source:

```bash
# Debian/Ubuntu on an architecture with no prebuilt binary
sudo apt-get install -y build-essential python3 && npm install -g clideck --allow-scripts=node-pty

# Alpine/musl - a glibc prebuild does exist, so the source build has to be forced
apk add python3 make g++ && npm_config_build_from_source=true npm install -g clideck --allow-scripts=node-pty
```

Hit a problem on Linux? [open an issue](https://github.com/rustykuntz/clideck/issues).

If port `4000` is already in use:

```bash
clideck --port 4001
```

## What makes it useful

**Live status** - see which agent is working and which is waiting. Status detection for Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, and Pi.

**Session resume** - close the lid, reopen tomorrow, pick up where things left off. each agent's session ID is captured automatically.

**Ask another session** - from inside any CliDeck session, an agent can consult another session and get the answer back as command output:

<p align="center">
  <img src="assets/clideck-ask.png" width="720" alt="One agent asking another session and getting findings back">
</p>

```bash
clideck agents
clideck ask --session "Reviewer" --message "Review this output and return findings." --timeout 10m
```

CliDeck injects the message into the real target terminal, submits it, waits for the target session to finish, then returns the latest response to the caller.

By default, target lookup is limited to the caller's project. For cross-project asks, discover the full address first:

```bash
clideck agents --all
clideck ask "@website/Docs Writer" "Check if the docs mention the new CLI flags." --timeout 15m
```

If project or session names contain spaces, quote the whole target. The target is another LLM agent, not a fast CLI command, so callers should set both `clideck ask --timeout` and their own shell/tool timeout high enough. If the target session is busy, CliDeck does not queue the message; the caller gets a clear busy response and can retry later or ask another idle session.

Agents can also create their own workers. `clideck spawn` starts a new session in an explicitly named project (same agent as the caller by default, `--preset` to pick another), optionally in a fresh git worktree, and can hand it an initial prompt:

```bash
clideck spawn --project myproject --name "Worker 1" --worktree --prompt "Fix DO-123. Report when done."
```

Spawn is fire-and-forget: it returns once the worker exists and the prompt is submitted, and the orchestrating agent collects results later with `clideck ask`.

**Mobile remote** - the agents keep running on the local machine. status, prompts, history, and replies stay available from a phone while away. E2E encrypted, no account needed.

**Native terminals** - each session opens into its real terminal. keys go straight to the agent, nothing sits in the middle.

## Supported agents

Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, Pi, Shell, and any other terminal tool.

## Also

- **Projects** - group sessions, drag and drop
- **Prompt library** - save reusable prompts, type `//` to paste
- **Search** - find sessions or scroll through transcripts
- **Plugins** - server + client API. ships with Voice Input, Trim Clip, and Autopilot. build your own
- **15 themes** - dark, light, or make your own
- **Notifications** - browser + sound alerts when agents finish

## Docs

Guides, agent setup, plugin development: **[docs.clideck.dev](https://docs.clideck.dev)**

## Acknowledgments

Built with [xterm.js](https://xtermjs.org/).

## License

MIT - see [LICENSE](LICENSE).
