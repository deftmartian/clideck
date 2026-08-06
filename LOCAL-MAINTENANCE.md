# Local CliDeck maintenance

This branch is based on the upstream `v1.32.1` tag. Local behavior is kept in
small commits above that tag so it can be replayed onto a newer release.

The local commits cover:

- VM-aware CliDeck URLs, hooks, and same-host agent coordination.
- Clipboard image paste with validated, private, bounded scratch storage.
- Mobile navigation, terminal sizing, and autocomplete positioning that remain
  reachable across viewport, browser-chrome, and keyboard changes.
- Foreground WebSocket recovery without duplicate live sockets.
- An installable, foreground-first PWA shell with explicit connection states,
  a network-only application path, a minimal offline notice, and a strict
  browser/server protocol gate.
- GPU-accelerated terminal rendering with automatic DOM fallback when WebGL2
  is unavailable or its context is lost.
- Session-creator recovery when the browser has an empty or stale command list.
- Codex resume persistence only after an accepted user prompt, using that
  prompt's conversation ID as the canonical token. This prevents a
  telemetry-only startup ID from being saved and follows interactive thread
  switches made through Codex's resume picker.
- First-class Grok Build support: agent preset, lifecycle hooks
  (`~/.grok/hooks/clideck.json`), CliDeck session guide via `--rules`, and
  migration of shell-wrapped `grok` launchers onto the real preset. Resume
  uses hook-captured session IDs and reports provider failures directly.
- `clideck spawn`: agent-driven session creation (`/api/session/spawn`,
  `session-spawn.js`), with optional git worktrees under
  `~/.clideck/worktrees/<repo>/` and initial-prompt injection gated on the
  worker's first idle status.

## Verify and package

Run from this checkout:

```bash
npm ci
npm test
npm audit --audit-level=high
npx playwright-core install firefox
npm run test:browser
npm run test:browser -- chromium
npm run smoke:menu
npm run smoke:capture
npm run smoke:menu-status
node tools/generate-pwa-icons.js
npm pack --ignore-scripts --pack-destination "$HOME/.local/state/clideck-builds"
```

Install and restart from an SSH or local terminal outside CliDeck:

```bash
npm install -g --allow-scripts=node-pty "$HOME/.local/state/clideck-builds/clideck-1.32.1.tgz"
systemctl --user restart clideck.service
```

Restarting from a CliDeck session kills that session's PTY because the service
uses `KillMode=control-group`.

## Upgrade

Fetch the new upstream tag, create a branch from it, then cherry-pick the local
commits in order. Resolve only real upstream overlaps, rerun the checks above,
and install the resulting tarball. Do not install `clideck@latest` directly over
the live package; that discards the local commits.

The installed PWA always loads application code from the live CliDeck server.
Its service worker caches only `offline.html`, never terminal content, app
JavaScript, API responses, or authentication pages. Keep application assets
network-first and preserve the manual update prompt; a worker must never reload
an active terminal automatically. Bump `OFFLINE_CACHE` in `public/sw.js` when
the offline fallback changes.

After an upgrade, test the deployed mobile endpoint on a real phone: launch
from the home screen, background and foreground once, verify the same session
reattaches, and send one command exactly once. Also verify that an expired
authentication session reaches sign-in rather than the offline fallback.

Protocol v2 deliberately rejects protocol-v1 and queryless browser tabs because
sequence-aware terminal replay is mandatory for safe foreground recovery. An
already-open tab must use the explicit Reload action after this upgrade or a
rollback. Keep the client constant in `public/js/app.js` aligned with
`protocol.js`, and bump the protocol only for a breaking browser/server message
change.
