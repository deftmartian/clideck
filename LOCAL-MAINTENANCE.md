# Local CliDeck maintenance

## Base and objective

`feature/mobile-transport-foundation` is the public-fork candidate. It includes
the earlier `refactor/upstream-isolation` work and is merged through upstream
`da845b0` (CliDeck 1.33.1 plus the short-reply fix) as of 2026-08-19. Its
objective is to keep the fork's behavior while making each divergence either a
narrow upstream fix, a bounded feature series, configurable provider policy,
or explicitly fork-only documentation.

Against that upstream commit, the branch changes 112 paths: 38 modified
upstream paths, 73 added paths, and one deleted generated asset. New modules,
tests, and build assets account for most of the growth. The merge-sensitive
core files remain adapter entry points rather than owners of transport,
renderer, capture, static-delivery, or local-policy implementations.

## Isolation boundaries

| Upstream-owned entry point | Fork-owned interface | Responsibility moved out |
| --- | --- | --- |
| `config.js` | `config-local.js` | gated presets, Grok launcher migration, and stale-client merge policy |
| `server.js` | `server-http-local.js`, `server-protocol-gate.js`, `server-static.js` | local HTTP routes, WebSocket compatibility, and PWA/static response policy |
| `public/js/terminals.js` | `public/js/terminal-local.js`, `public/js/terminal-renderer.js` | WebGL fallback, clipboard behavior, recovery sequencing, mobile controls, renderer retention, and subscription lifecycle |
| `public/js/app.js` | `public/js/clipboard-client.js`, `public/js/compact-navigation.js`, `public/js/connection-client.js`, `public/js/terminal-recovery-client.js` | clipboard upload, compact navigation, connection/PWA lifecycle, and terminal replay |
| `handlers.js` | `grok-hooks.js`, `clipboard-images.js`, `protocol.js`, `client-build.js` | Grok configuration, image persistence, and compatibility metadata |
| `sessions.js` | `server-capture.js`, `session-capture.js`, `session-stream.js` | bounded headless terminal state, capture/menu coordination, active-session subscriptions, cursor recovery, resize ownership, batching, backpressure, and heartbeat policy |
| `server-static.js` | `tools/build-client.js`, `public/build/` | deterministic ESM bundling, lazy WebGL, compressed representations, immutable hashes, and build identity |
| upstream spawn/ask helpers | `session-ask.js`, `session-spawn.js`, `clideck-spawn-cli.js` | existing-session protection, bounded worker creation, prompt validation, and worktree setup |

The upstream copies of `http-util.js` and `public/js/hotkeys.js` are now
byte-for-byte unchanged. `session-ask.js` retains a narrow local policy that
prevents agents from interrupting user-owned sessions and exposes the shared
answer-wait helper used by bounded spawned workers. The current upstream merge
to `da845b0` applied cleanly. An earlier isolation merge conflicted in
`http-util.js`, `session-ask.js`, and `tests/http-util.test.js`; only the
intentional session safety policy remains a fork divergence.

## Mobile transport foundation (2026-08-19)

Protocol v3 makes terminal output an explicit per-connection subscription. A
connection starts with control state only; `session.subscribe` atomically
selects one terminal and restores it from a generation/sequence cursor or a
bounded server snapshot. `session.unsubscribe` stops terminal traffic without
dropping metadata. Inactive sessions receive throttled `session.activity`
metadata, never terminal output; the browser advances per-session activity
cursors to drive unread state. Transcript history is requested only when
transcript-backed search is first used and is refreshed after reconnect.
Protocol v2 and queryless tabs fail closed; mixed v2/v3 operation is
unsupported.

Each live PTY owns an in-memory `@xterm/headless` twin behind
`server-capture.js`; `session-capture.js` owns the asynchronous capture, menu,
preview, and activity coordination around it. The twin keeps 5,000 scrollback
lines, serializes snapshots at no more than 1,000 lines and 1 MiB, inspects only
the latest 80 lines for menus, and supplies transcript/preview/ask/Autopilot
capture without browser uploads.
Capture writes coalesce; 1 MiB of capture lag pauses the PTY and draining below
256 KiB resumes it without dropping input. Snapshots and `clideck ask` wait on
sequence barriers, and capture requests are single-flight with one merged
follow-up. The headless twin is the sole DSR/DA responder; recognized browser
query replies are discarded.

Raw PTY output remains memory-only in a Unicode-safe 2 MiB replay ring.
WebSocket output is split into at most 32 KiB UTF-8 segments, sequenced by
JavaScript string offsets, and batched for 16 ms. Slow clients stop at a 1 MiB
send backlog and recover below 256 KiB; control-plane overflow closes with
1013. Cursors advance only after a frame is accepted, and a recoverable gap
between network batches is filled directly from the replay ring.

Resize ownership belongs to the most recently interacting subscribed client.
Selection or input claims ownership, resize traffic alone cannot, and only
20-500 columns by 5-300 rows are accepted. Create, restart, resume, subscribe,
resize, and server capture share the same size authority. Touch clients keep
one renderer; desktop retains the four most recently used renderers and
rehydrates evicted sessions from a snapshot. `public/js/terminal-renderer.js`
owns renderer creation, eviction, fit, and subscription behavior, while
`public/js/terminals.js` keeps navigation and session orchestration. Only the
visible renderer is fit, and PTY resize follows 120 ms of stable dimensions.

The release client is generated by `npm run build:client`. It bundles the app,
xterm core, Fit addon, and CSS as ES2020 ESM under the untracked
`dist/public/build/`; WebGL is a lazy content-hashed chunk. The build copies an
explicit static allowlist, rewrites staged HTML, and creates deterministic
Brotli/gzip sidecars without changing the source template. `check:client`
compares two temporary builds and the current stage. Hashed assets are
immutable; HTML, the service worker, offline fallback, plugin clients, APIs,
and auth stay network-first. The npm tarball includes runtime server files,
plugins, and `dist/public`, but excludes source browser modules, templates,
build tools, tests, and legacy generated assets.
For packaged preflight, `CLIDECK_DATA_DIR` selects an explicit isolated state
directory and disables migrations from the normal home or package directory.

### Measured result

The standard fixture is ten 80x24 shells with 4,096 printable characters each.
The comparison uses `docs/mobile-transport-baseline.md` and
`node tools/measure-transport.js --browser`; the post-change browser run used
100 ms latency and 10 Mbps throughput.

| Metric | Before | After |
| --- | ---: | ---: |
| Idle reconnect control bytes | 21,657 | 19,995 |
| Automatic terminal replay bytes | 40,293 | 0 |
| WebSocket frames during measured reconnect | 18 | 8 |
| Maximum server send backlog | not exposed | 19,931 bytes |
| Touch renderers / WebGL contexts | 10 / 10 | 1 / 1 |
| Terminal fits / PTY resizes | 11 / 11 | 2 / 1 |
| Cold critical requests | 35 local modules | 6 |
| Cold critical compressed bytes | 227,403 Brotli | 164,762 encoded |
| Cold terminal usable | not profiled | 677 ms |
| WebSocket-open to terminal subscribed | not profiled | 90 ms |
| Long tasks / duration (representative run) | 4 / 1,696 ms | 1 / 268 ms |

Cold critical delivery is below the eight-request/350 KiB budget, idle
reconnect is below 50 KiB without a terminal snapshot, and the measured
WebSocket recovery is below 500 ms. Browser checks also cover rapid switching,
offline and transcript-cache recovery, inactive unread activity, repeated
restart with one fresh snapshot, cursor gaps, OSC 52 replay suppression, ten
touch-session switches with one renderer, and desktop LRU eviction and
rehydration at four renderers. The archived `cebff72` closeout passed 100
unit/integration tests and the full Chromium and Firefox browser runs. These
isolated measurements do not replace the real Android acceptance pass
described below.

### Current candidate validation

After the upstream merge and maintenance-seam extraction on 2026-08-19, a
clean install, deterministic build/check, and all 105 unit/integration tests
passed. Chromium and Firefox passed the full recovery suites. Menu, capture,
menu-status, Codex config/hooks, HTTP utility, and upstream short-reply smokes
passed; the provider lifecycle passed for Codex, skipped unauthenticated Claude,
and skipped Gemini, OpenCode, and Pi because their executables were unavailable.
The production audit reported zero vulnerabilities. Live phone testing of the
deployed archived build was good so far; the refactored candidate remains
subject to the exact post-upgrade phone checklist after a future deployment.

## Conflict surface

Changed lines are additions plus deletions against the stated upstream commit.
A hunk is a separate `git diff --unified=0` edit region.

### Historical pre-transport isolation result

At `f6cbf19`, before the mobile transport work, extraction reduced the five
original merge hotspots from 1,053 changed lines to 325:

| Hotspot | Integration baseline | Isolated branch | Changed-line reduction |
| --- | ---: | ---: | ---: |
| `public/js/app.js` | 439 | 122 | 72.2% |
| `public/js/terminals.js` | 239 | 79 | 66.9% |
| `server.js` | 145 | 46 | 68.3% |
| `config.js` | 98 | 21 | 78.6% |
| `handlers.js` | 132 | 57 | 56.8% |
| **Total** | **1,053** | **325** | **69.1%** |

Across the four primary hotspots, changed lines fell from 921 to 268 (70.9%)
and hunks from 72 to 52 (27.8%). Including `handlers.js`, hunks fell from 82 to
61 (25.6%). This table is retained as historical evidence, not a description
of the current transport branch.

### Current post-transport surface

Against upstream `da845b0`, the current feature branch has this core-file
surface after extracting renderer and capture coordination:

| Upstream-owned hotspot | Changed lines | Hunks | Extracted owner |
| --- | ---: | ---: | --- |
| `public/js/app.js` | 209 | 29 | connection, recovery, clipboard, and compact-navigation clients |
| `public/js/terminals.js` | 384 | 32 | terminal-local and terminal-renderer modules |
| `server.js` | 63 | 14 | HTTP, static-delivery, and protocol-gate modules |
| `config.js` | 21 | 7 | config-local provider policy |
| `handlers.js` | 153 | 14 | protocol, build, clipboard, and Grok adapters |
| `sessions.js` | 257 | 46 | server-capture, session-capture, and session-stream modules |
| **Total** | **1,087** | **142** | |

The larger total is expected because protocol v3 is a substantial cross-stack
feature, not because the earlier isolation regressed. The implementation-heavy
owners are new fork files: `public/js/terminal-local.js` (297 lines),
`public/js/terminal-renderer.js` (185), `server-capture.js` (257),
`session-capture.js` (151), and `session-stream.js` (437). Treat the transport
stack as an upstream design/feature series, never as one opportunistic bug-fix
PR.

## Current divergence classification

This is the exhaustive inventory against upstream `da845b0`. Each of the 112
divergent paths appears exactly once; mixed files are assigned by their dominant
remaining responsibility. Regenerate the inventory and metrics after every
upstream merge.

- **Narrow upstreamable fix** is generic and independently reviewable.
- **Configurable provider policy** should remain data/environment gated unless
  upstream adopts that provider or policy.
- **Upstream feature series** needs design agreement and multiple cohesive PRs.
- **Plugin/module candidate** is optional behavior suited to an extension seam.
- **Fork-only** is maintenance, release, or measurement documentation.

<!-- divergence-inventory:start -->
| Primary disposition | Divergent paths | Rationale / next move |
| --- | --- | --- |
| Narrow upstreamable fix (12) | `bin/codex-hook.js`<br>`bin/notify-helper.js`<br>`claude-session.js`<br>`paths.js`<br>`public/js/creator.js`<br>`resume-readiness.js`<br>`single-instance.js`<br>`telemetry-receiver.js`<br>`tests/claude-session.test.js`<br>`tests/config-update.test.js`<br>`tests/paths.test.js`<br>`tests/resume-readiness.test.js` | Split by invariant: advertised hook URL, hook-authoritative Claude IDs, stale-launcher preservation, explicit isolated data roots, reboot-safe locks, and durable resume IDs. Reconcile with an existing upstream PR before opening a duplicate. |
| Configurable provider policy (10) | `agent-presets.json`<br>`agent-session-guide.js`<br>`bin/grok-hook.js`<br>`config-local.js`<br>`config.js`<br>`grok-hooks.js`<br>`public/img/grok.svg`<br>`tests/agent-session-guide.test.js`<br>`tests/config-grok-migrate.test.js`<br>`tests/grok-hooks.test.js` | Grok and local agent-session guidance remain gated policy. Shared entry points call narrow adapters; promote only with upstream provider/policy agreement. |
| Upstream feature series: mobile transport, renderer, PWA, and build (70) | `.gitignore`<br>`client-build.js`<br>`handlers.js`<br>`package-lock.json`<br>`package.json`<br>`pi-bridge.js`<br>`protocol.js`<br>`public/client.css`<br>`public/icons/clideck-192.png`<br>`public/icons/clideck-512.png`<br>`public/icons/clideck-64.png`<br>`public/icons/clideck-apple-180.png`<br>`public/icons/clideck-maskable-512.png`<br>`public/index.html`<br>`public/js/app.js`<br>`public/js/compact-navigation.js`<br>`public/js/connection-client.js`<br>`public/js/mobile-composer.js`<br>`public/js/mobile-selection.js`<br>`public/js/mobile-touch-scroll.js`<br>`public/js/nav.js`<br>`public/js/perf.js`<br>`public/js/prompts.js`<br>`public/js/pwa.js`<br>`public/js/settings.js`<br>`public/js/state.js`<br>`public/js/terminal-local.js`<br>`public/js/terminal-recovery-client.js`<br>`public/js/terminal-recovery.js`<br>`public/js/terminal-renderer.js`<br>`public/js/terminals.js`<br>`public/js/test-surface.js`<br>`public/js/touch-ui.js`<br>`public/js/viewport.js`<br>`public/manifest.webmanifest`<br>`public/offline.html`<br>`public/sw.js`<br>`public/tailwind.css`<br>`replay-ring.js`<br>`server-capture.js`<br>`server-http-local.js`<br>`server-protocol-gate.js`<br>`server-static.js`<br>`server.js`<br>`session-capture.js`<br>`session-stream.js`<br>`sessions.js`<br>`src/input.css`<br>`terminal-size.js`<br>`tests/browser-recovery.js`<br>`tests/client-build.test.js`<br>`tests/mobile-viewport.test.js`<br>`tests/output-sequence.test.js`<br>`tests/protocol-gate.test.js`<br>`tests/providers/antigravity-capture.test.js`<br>`tests/providers/client.js`<br>`tests/providers/sandbox.js`<br>`tests/pwa.test.js`<br>`tests/replay-ring.test.js`<br>`tests/server-capture.test.js`<br>`tests/server-http-contract.test.js`<br>`tests/session-capture.test.js`<br>`tests/session-stream.test.js`<br>`tests/subscriptions.test.js`<br>`tests/terminal-size.test.js`<br>`tests/transport-diagnostics.test.js`<br>`tools/build-client.js`<br>`tools/generate-pwa-icons.js`<br>`tools/measure-transport.js`<br>`transcript.js` | Start with protocol and ownership design. Proposed slices are headless capture/replay, subscription transport, renderer lifecycle, mobile input/viewport, PWA recovery, and deterministic packaging. Preserve protocol-v3 tests across every slice. |
| Upstream feature series: bounded spawn and safe handoff (9) | `bin/clideck.js`<br>`clideck-agents-cli.js`<br>`clideck-ask-cli.js`<br>`clideck-spawn-cli.js`<br>`session-agents.js`<br>`session-ask.js`<br>`session-spawn.js`<br>`tests/session-ask.test.js`<br>`tests/session-spawn.test.js` | Propose the capability and user-session ownership rule before code. Keep bounded spawn separate from the browser/transport series. |
| Plugin/module candidate (6) | `clipboard-images.js`<br>`plugins/trim-clip/clideck-plugin.json`<br>`plugins/trim-clip/client.js`<br>`public/js/clipboard-client.js`<br>`public/js/terminal-clipboard.js`<br>`tests/clipboard-images.test.js` | Keep optional clipboard behavior behind the existing plugin/module seams; upstream the smallest missing seam before the feature. |
| Fork-only maintenance and evidence (5) | `.npmignore`<br>`LOCAL-MAINTENANCE.md`<br>`README.md`<br>`docs/mobile-transport-baseline.md`<br>`docs/mobile-transport-repair.md` | Describe the fork branch, its provenance, measured budgets, and release gates. These paths are not upstream PR candidates. |
<!-- divergence-inventory:end -->

## Public branch hygiene

Fork-authored commits after `f6cbf19` use
`deftmartian <165921376+deftmartian@users.noreply.github.com>`. Preserve the
logical feature/fix sequence; do not squash the transport work into an opaque
fork commit. Keep archived pre-cleanup history and deployment artifacts outside
the public feature branch. Publishing, opening PRs, and advancing the public
integration branch are separate release actions.

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
  `tests/session-spawn.test.js`; capture/menu coordination is isolated in
  `session-capture.js` and covered by `tests/session-capture.test.js`.
- HTTP/PWA response contracts: `tests/server-http-contract.test.js` was added
  before server routing was split.

## Verify and package

Run from this checkout:

```bash
npm ci
npm run build:client
npm run check:client
npm test
npm run test:browser -- chromium
npm run test:browser -- firefox
npm run smoke:providers
npm run smoke:menu
npm run smoke:capture
npm run smoke:menu-status
npm run smoke:codex-config
npm run smoke:codex-hooks
npm run smoke:http-util
npm run smoke:transcript
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

Protocol v3 deliberately rejects protocol-v2 and queryless browser tabs because
sequence-aware terminal replay is mandatory for safe foreground recovery. Keep
the client connection in `public/js/connection-client.js` aligned with
`protocol.js`, and bump the protocol only for a breaking browser/server message
change.
