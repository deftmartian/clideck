# Local CliDeck maintenance

## Base and objective

`refactor/upstream-isolation` is merged through upstream `af11255` (CliDeck
1.33.1 plus the `http-util` smoke wiring) as of 2026-08-18. Its objective is to
keep the fork's behavior while minimizing edits to upstream-owned files.

The integration baseline was `241b07f1`. Compared with the same upstream
commit, it changed 71 paths (7,526 insertions and 223 deletions). This branch
changes 79 paths (7,945 insertions and 260 deletions), but moves policy out of
upstream files: modified upstream paths fell from 33 to 29. The added paths are
deliberate modules, tests, and assets rather than additional merge hotspots.

## Isolation boundaries

| Upstream-owned entry point | Fork-owned interface | Responsibility moved out |
| --- | --- | --- |
| `config.js` | `config-local.js` | gated presets, Grok launcher migration, and stale-client merge policy |
| `server.js` | `server-http-local.js`, `server-protocol-gate.js`, `server-static.js` | local HTTP routes, WebSocket compatibility, and PWA/static response policy |
| `public/js/terminals.js` | `public/js/terminal-local.js` | WebGL fallback, clipboard behavior, recovery sequencing, and mobile terminal controls |
| `public/js/app.js` | `public/js/clipboard-client.js`, `public/js/compact-navigation.js`, `public/js/connection-client.js`, `public/js/terminal-recovery-client.js` | clipboard upload, compact navigation, connection/PWA lifecycle, and terminal replay |
| `handlers.js` | `grok-hooks.js`, `clipboard-images.js`, `protocol.js`, `client-build.js` | Grok configuration, image persistence, and compatibility metadata |
| upstream spawn/ask helpers | `session-spawn.js`, `clideck-spawn-cli.js` | worker creation, prompt validation, and worktree setup |

The upstream copies of `http-util.js`, `session-ask.js`, and
`public/js/hotkeys.js` are now byte-for-byte unchanged. The current upstream
merge initially conflicted in `http-util.js`, `session-ask.js`, and
`tests/http-util.test.js`; none remains a fork divergence.

## Conflict-surface result

Changed lines are additions plus deletions against `upstream/main`. A hunk is a
separate `git diff --unified=0` edit region.

| Hotspot | Integration baseline | Isolated branch | Changed-line reduction |
| --- | ---: | ---: | ---: |
| `public/js/app.js` | 439 | 122 | 72.2% |
| `public/js/terminals.js` | 239 | 79 | 66.9% |
| `server.js` | 145 | 46 | 68.3% |
| `config.js` | 98 | 21 | 78.6% |
| `handlers.js` | 132 | 57 | 56.8% |
| **Total** | **1,053** | **325** | **69.1%** |

Across the four requested primary hotspots, changed lines fell from 921 to 268
(70.9%) and hunks fell from 72 to 52 (27.8%). Including `handlers.js`, hunks
fell from 82 to 61 (25.6%). Total fork lines grew slightly because extracted
modules and their regression tests remain explicit; the merge-sensitive edits
are the maintenance metric.

## Divergence classification

The classification below is exhaustive for `git diff --name-status
upstream/main..HEAD`. Each of the 79 divergent paths appears exactly once. A
mixed file is assigned by its dominant remaining responsibility.

- **Upstreamable** means a narrow generic bug fix or lifecycle invariant that
  fits upstream core.
- **Configurable** means provider or site policy that should be enabled through
  data/environment and kept behind a narrow adapter.
- **Plugin/module candidate** means a substantial optional capability that is
  now internally modular and should move to an upstream extension seam or a
  separately reviewable feature series.
- **Necessarily local** means fork-only maintenance or release documentation,
  not runtime behavior.

<!-- divergence-inventory:start -->
| Primary disposition | Divergent paths | Rationale / next move |
| --- | --- | --- |
| Upstreamable | `bin/codex-hook.js`<br>`bin/notify-helper.js`<br>`claude-session.js`<br>`public/js/creator.js`<br>`resume-readiness.js`<br>`single-instance.js`<br>`telemetry-receiver.js`<br>`tests/claude-session.test.js`<br>`tests/config-update.test.js`<br>`tests/resume-readiness.test.js` | Split into narrow PRs: lifecycle hooks honoring the advertised server URL; hook-authoritative Claude IDs; stale launcher preservation; reboot-safe locks; and durable Codex IDs after the current CLI timing is captured. The hook URL work should converge with the existing upstream PR rather than be duplicated here. |
| Configurable | `agent-presets.json`<br>`agent-session-guide.js`<br>`bin/grok-hook.js`<br>`config-local.js`<br>`config.js`<br>`grok-hooks.js`<br>`public/img/grok.svg`<br>`tests/agent-session-guide.test.js`<br>`tests/config-grok-migrate.test.js`<br>`tests/grok-hooks.test.js` | Grok remains gated by preset/environment data. Shared config owns only calls into config-local.js; shared handlers call the standalone hook adapter. Promote upstream only if Grok becomes a supported core provider. |
| Plugin/module candidate | `bin/clideck.js`<br>`clideck-spawn-cli.js`<br>`client-build.js`<br>`clipboard-images.js`<br>`handlers.js`<br>`package-lock.json`<br>`package.json`<br>`plugins/trim-clip/clideck-plugin.json`<br>`plugins/trim-clip/client.js`<br>`protocol.js`<br>`public/addon-webgl.js`<br>`public/icons/clideck-192.png`<br>`public/icons/clideck-512.png`<br>`public/icons/clideck-apple-180.png`<br>`public/icons/clideck-maskable-512.png`<br>`public/index.html`<br>`public/js/app.js`<br>`public/js/clipboard-client.js`<br>`public/js/compact-navigation.js`<br>`public/js/connection-client.js`<br>`public/js/mobile-composer.js`<br>`public/js/mobile-selection.js`<br>`public/js/mobile-touch-scroll.js`<br>`public/js/prompts.js`<br>`public/js/pwa.js`<br>`public/js/settings.js`<br>`public/js/state.js`<br>`public/js/terminal-clipboard.js`<br>`public/js/terminal-local.js`<br>`public/js/terminal-recovery-client.js`<br>`public/js/terminal-recovery.js`<br>`public/js/terminals.js`<br>`public/js/touch-ui.js`<br>`public/js/viewport.js`<br>`public/manifest.webmanifest`<br>`public/offline.html`<br>`public/sw.js`<br>`public/tailwind.css`<br>`server-http-local.js`<br>`server-protocol-gate.js`<br>`server-static.js`<br>`server.js`<br>`session-spawn.js`<br>`sessions.js`<br>`src/input.css`<br>`tests/browser-recovery.js`<br>`tests/clipboard-images.test.js`<br>`tests/mobile-viewport.test.js`<br>`tests/output-sequence.test.js`<br>`tests/protocol-gate.test.js`<br>`tests/providers/client.js`<br>`tests/providers/sandbox.js`<br>`tests/pwa.test.js`<br>`tests/server-http-contract.test.js`<br>`tests/session-spawn.test.js`<br>`tools/generate-pwa-icons.js` | Four bounded feature families: mobile/viewport UI; protocol-aware PWA recovery; clipboard/OSC 52/WebGL terminal integration; and clideck spawn. Keep the adapters internal until upstream exposes suitable client/server plugin seams. Propose spawn in a Discussion and split it from the browser stack. |
| Necessarily local | `.npmignore`<br>`LOCAL-MAINTENANCE.md`<br>`README.md` | The maintenance ledger and fork-facing feature/release documentation must describe the branch actually shipped. Runtime behavior has no item classified as necessarily local. |
<!-- divergence-inventory:end -->

## Preserved behavior and regression owners

- Mobile composer, selection, touch scroll, safe-area layout, and compact
  navigation: `tests/mobile-viewport.test.js` and both browser engines.
- PWA install/update/offline/auth behavior and foreground WebSocket recovery:
  `tests/pwa.test.js`, `tests/protocol-gate.test.js`,
  `tests/output-sequence.test.js`, and `tests/browser-recovery.js`.
- Clipboard image upload, terminal clipboard trimming, and OSC 52 fallback:
  `tests/clipboard-images.test.js`, terminal module assertions in
  `tests/mobile-viewport.test.js`, and browser clipboard scenarios.
- Session-agent lifecycle and recovery: provider smoke suites,
  `tests/claude-session.test.js`, `tests/resume-readiness.test.js`, and
  `tests/session-spawn.test.js`.
- HTTP/PWA response contracts: `tests/server-http-contract.test.js` was added
  before server routing was split.

## Verify and package

Run from this checkout:

```bash
npm ci
npm test
npm run test:browser
npm run test:browser -- chromium
npm run smoke:menu
npm run smoke:capture
npm run smoke:menu-status
npm run smoke:codex-config
npm run smoke:codex-hooks
npm run smoke:http-util
npm audit --omit=dev --audit-level=high
npm pack --ignore-scripts --pack-destination /an/explicit/staging/directory
```

The tarball is the deployment artifact. Verify its file list and run it with an
isolated data directory and port before replacing an installed service. A
service restart terminates its child PTYs, so inspect active sessions and retain
a rollback artifact before any live cutover.

The installed PWA always loads application code from the live CliDeck server.
Its service worker caches only `offline.html`, never terminal content, app
JavaScript, API responses, or authentication pages. Keep application assets
network-first and preserve the manual update prompt; a worker must never reload
an active terminal automatically. Bump `OFFLINE_CACHE` in `public/sw.js` when
the offline fallback changes.

After an upgrade, test the mobile endpoint on a real phone: launch from the home
screen, background and foreground once, verify the same session reattaches, and
send one command exactly once. Also verify that expired authentication reaches
sign-in rather than the offline fallback.

Protocol v2 deliberately rejects protocol-v1 and queryless browser tabs because
sequence-aware terminal replay is mandatory for safe foreground recovery. An
already-open tab must use the explicit Reload action after this upgrade or a
rollback. Keep the client connection in `public/js/connection-client.js`
aligned with `protocol.js`, and bump the protocol only for a breaking
browser/server message change.
