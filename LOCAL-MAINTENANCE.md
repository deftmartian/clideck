# CliDeck v2 fork maintenance

This branch ports the retained fork features onto upstream `e3418ee`
(CliDeck 2.1.1). The old `integration/full-stack` history is preserved separately.
The v2 engine and plugin SDK replace v1; Autopilot is retired.

## Retained behavior

- Grok is a native provider with lifecycle hooks, canonical transcript replies,
  resume, preserved launcher flags, and `--minimal` for touch launches.
  Custom Grok rules merge once with integration rules. Codex model recovery reads
  bounded native transcript metadata after resume. Native model/context counters
  follow atomic metadata updates and compaction;
  missing or stale launch tokens are ignored. Hook repair preserves unrelated hooks
  in shared entries. Native launchers use provider marks unless a custom icon is set.
- Mobile navigation, multiline prompt composition, touch selection/copy,
  keyboard controls, PWA installation and an offline fallback remain available.
- Keyboard input, voice and clipboard images share one session-bound draft.
  Stop dictation returns text for review; only Send submits. Pending image uploads
  block Send, late results stay with their original session, and failed/offline
  submissions preserve the draft. Per-session localStorage recovers text after reload
  or tab closure, imports v1/fork.4 drafts and retains distinct recovery alternatives. Storage
  failures retain the in-memory draft and warn once. Reloading an unfinished image
  upload recovers text and asks the user to attach the image again.
- Mobile input follows visual viewport resize and pan events. Compact keyboard
  layouts keep the composer and 44px controls reachable; the terminal canvas is
  clipped to prevent its minimum row count from intercepting the mobile bar.
  The default is a persistent tools/text/Send composer; accessories expand on demand.
  Direct explicitly hands input to xterm through the terminal component’s input-owner API. The composition component owns its placement and focus; layouts register a slot. Send/Paste and special keys preserve an open
  keyboard. Dictation uses the same area. Offline and voice-owned controls are gated.
  Header actions fit one row; Git opens a full-width read-only workspace with file
  navigation, folding, wrapped code and worktree selection. Terminal drafts stay
  saved while reading Git. An explicit discard clears only the current draft;
  recovered alternatives remain available. Permanent session deletion retains
  browser recovery records rather than silently deleting unsent text.
- Clipboard images use a raw HTTP upload: 25 MiB per image, two concurrent
  uploads, validated image headers, private files, a 256 MiB store and 30-day
  retention. Attach uses the same service as paste. PNG/JPEG/WebP preparation
  reduces large images to 2048 pixels on the longest side when smaller; PNG alpha
  is preserved and GIFs stay untouched. Trim & Copy remains on F8 and the terminal toolbar.
- Voice Input uses native v2 server and microphone APIs, with no v1 adapter. It retains local/OpenAI backends, language, replacement rules
  and shortcuts. Audio is bounded to ten minutes; cancellation aborts requests or inference.
  Local startup errors and recording expiry are surfaced to the user.
  Legacy `pluginSettings` migrate to v2 settings and API keys remain server-side.
  Local voice uses Linux faster-whisper; the private Mac/MLX engine is retired.
  Recognized words are preserved, including short replies and trailing thanks;
  only explicitly configured replacement rules change words. Setup installs the
  pinned direct dependencies and downloads the model using `clideck-voice-setup`.
  Runtime stays offline and never creates a venv or invokes pip. Missing local
  dependencies/model files produce an actionable setup error. OpenAI transcription
  remains available, including on platforms without local voice support.
- Agent calls to existing user conversations require `--interrupt-existing`.
  `spawn --project ... --wait` creates a dedicated worker, waits for readiness,
  returns its first answer and closes it. Three active workers maximum; workers
  cannot spawn more workers. Optional Git worktrees are kept for review.

## Terminal and transport

Core `6.1.0-beta.304`, headless `6.1.0-beta.303`, serialize
`0.15.0-beta.301` and WebGL `0.20.0-beta.300` all come from xterm commit
`c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2`. Keep this family pinned together.
Stable 6.0 fails the mobile touch-drag regression and must not replace these pins.

The headless terminal owns terminal-query replies. Browser replies, including
XTVERSION, are filtered so refresh/replay cannot paste a second reply into the
agent prompt. One shared browser renderer uses lazy WebGL with DOM fallback.

Protocol `fork-v6` carries only the selected terminal. Hidden tabs unsubscribe;
reconnect uses an acknowledged cursor or a bounded snapshot. Application credit
is 128 KiB, replay ring 2 MiB, frames 32 KiB, capture scrollback 5,000 lines and
live snapshots at most 1,000 lines/1 MiB. Dormant history loads only on selection.
The transport adapter owns history/inventory/replay dispatch. Dormant history
requests run one at a time per socket, retaining only the newest selection.
Unparsed terminal output invalidates the reconnect cursor and cannot send stale ACKs. Snapshot and session resets use parser-queued RIS so an older pending write cannot cross the reset boundary.

The upstream synchronous `Screen` remains the provider readiness/menu source;
async xterm remains the replay and terminal-query source. The stream sends engine batches directly; its redundant second queue and timer have been removed. Replay-ring segmentation still bounds UTF-8 frames and credit. Screen lines are cached
between writes, and output reuses the engine batch instead of adding a second
16 ms delay. `node tools/benchmark-screen.js` compares identical screens against
`32bb23c`: a five-run median for 500 progress writes and five reads per write was
811 ms before versus 172 ms after. This is a targeted benchmark, not overall app speed.

One WebSocket owner handles retry and health diagnostics, including expired login,
offline and incompatible clients. PWA code owns only installation/update/offline assets.
Protocol v6 rejects older clients because image uploads now attach to drafts; reload
existing tabs after deployment. `/api/health` reports version and protocol without caching.

Terminal dimensions are consistently bounded to 20–500 columns and 5–300 rows.
The visible browser claims resize ownership when subscribing so agent input and
replayed cursor positions use the same dimensions. F8 Trim & Copy is registered
in xterm’s key pipeline before selection clearing or PTY forwarding.

The app is bundled and release assets have deterministic Brotli/gzip sidecars.
Only hashed build assets are immutable; application HTML, APIs, plugin clients,
authentication responses and service-worker navigation remain network-first.

## Verification and packaging

```sh
npm ci
npm run build:client
npm run check:client
npm test
python3 -m unittest discover -s test/fork -p '*_test.py'
npx playwright-core install chromium firefox
npm run test:browser:fork
BROWSER=firefox npm run test:browser:fork
npm run test:browser:mobile
BROWSER=firefox npm run test:browser:mobile
# Install WebKit and its platform libraries before this lane:
BROWSER=webkit npm run test:browser:mobile
npm audit --omit=dev --audit-level=high
npm pack --ignore-scripts --pack-destination /tmp/clideck-release
# After installing the tarball into a throwaway prefix:
node tools/preflight-package.js /path/to/prefix/node_modules/clideck
CLIDECK_PACKAGE_ROOT=/path/to/prefix/node_modules/clideck node test-ui/fork-integration-browser.mjs
```

`test-ui/*-it.mjs` contains upstream UI checks. The fork browser suite exercises
real xterm reports, mobile touch scrolling, scrollback clearing, multiline input
and full-page refresh, shared voice/image drafts, delayed uploads, offline Send
and hidden-tab recovery. `tools/smoke-grok-v2.js` requires existing working Grok
hooks and tests a separate native conversation through mobile restart/resume.
`smoke-codex.js` uses a temporary native config and server data directory.

The xterm 6.0 and beta.292 comparison tests are negative controls: 6.0 does not
move on touch drag; beta.292 reproduces the scrollback-clear pinned-viewport bug.
The current beta passes both. Chromium uses browser-injected touch input; Firefox
uses synthetic DOM touch events. Emulation does not replace a physical-phone check.
Native local Whisper was verified with a real recorded audio sample on the VM.
Physical-phone microphone permission and end-to-end recording still need acceptance;
unit checks cover exact PCM/WAV encoding, provider requests, bounds, cancellation and migration.

The mobile restoration suite covers 31 scenarios per browser: ten viewport sizes
(including 320x210), visual-viewport pan/zoom, five-point obstruction checks,
draft/legacy recovery, storage denial, explicit discard, IME, duplicate Send,
Paste without submit, Direct, special keys, selection, valid PNG downscaling,
attachment completion, offline/reconnect, voice review/cancel/late messages,
read-only Git with two worktrees, theme and reversible layout overrides.
It replaces assertions tied to the retired fork.4 Write/Keys toolbar. Existing
fork draft, transport, cursor, clipboard and backend checks remain in place.
Artifacts are under `/tmp/clideck-restoration-evidence`. Build before running:
the static server prefers `dist/public` over source assets. The optional
`CLIDECK_WEBKIT_EXECUTABLE` sets a WebKit executable with local platform libraries.
Browser emulation and synthetic IME/viewport events do not validate a native phone
keyboard, OS dictation, safe-area insets or microphone permission prompts.

The xterm application-mouse drag regression still emits NaN coordinates without
`mobile-touch-scroll.js`. The restored adapter emits bounded SGR wheel positions;
Grok launches with `--minimal` advertise `nativeScroll` so they use xterm history
instead. Selection has priority, multitouch yields, and switching/hidden tabs stop
momentum. Non-tracking terminals retain native xterm touch behavior. The old
opt-in primary-buffer wheel-stealing policy is not enabled by this release.

Codex can swallow Enter when it shares a PTY write with a pasted draft. The server
separates submission using its existing paste delay, bounds queued follow-up input
and cancels delayed Enter on interrupt/close. Paste-only input is unchanged.
`SMOKE_PROVIDER=codex node tools/smoke-native-mobile-input.js` checks a fresh
isolated native conversation and resume; `SMOKE_PROVIDER=grok` selects Grok.
These use real model access and require valid credentials/hooks. The fixture waits
for startup to settle before testing input. `SMOKE_COMBINED_WRITE=1` bypasses the
new sequencer as a negative control: the old transaction leaves Codex idle with
unsent text, while the separated transaction produces a reply and resumes.

### fork.5 parity disposition

| Area | Disposition and evidence |
| --- | --- |
| v1 mobile composer, accessories, Direct, selection | Restored on the v2 session/draft APIs; three-engine browser matrix. |
| Persistent drafts, picker, PNG preparation | Restored, including migration alternatives, tab reopen and storage failure; browser checks. |
| Phone Git | Existing read-only v2 plugin adapted; two-worktree fixture leaves index/worktree unchanged. |
| Grok rules and model/context | Custom rules merge once; existing provider/hook regression suite retained. |
| Codex model after resume | Bounded transcript model reader; metadata-only recovery test. |
| Codex paste/Enter | Native negative control and corrected reply/resume check; cancellation/order unit test. |
| Application-mouse scrolling | NaN regression reproduced; restored adapter passes native-history and app-wheel routing checks. |
| Primary-buffer wheel stealing | Previous opt-in workaround remains omitted; normal xterm wheel handling retained. |
| Voice, copying, transport, protected workers | Existing v2 APIs retained; backend and fork browser suites cover them. |
| Actual phone / public route | Physical keyboard, microphone, safe-area and final phone acceptance pending. Host-side HTTPS probe still fails; loopback is healthy. |
| Host native Grok fixture | Did not become ready; VM native fixture is a separate deployment check, not a claimed host pass. |

The Git workspace embeds its shared theme/diff CSS so opaque-origin stylesheet
requests cannot leave it unreadable behind an authenticated gateway. Regenerate
with `node tools/sync-git-styles.js` after changing shared theme/diff rules; client
builds reject stale generated styles. The mobile suite denies external CSS to
plugin frames and checks dark/light text contrast, monospace code and diff layout.

## Deployment boundary

Deployment status belongs in the operational runbook. Keep the current installed
package and data for rollback. A spare-port tarball preflight must use an
explicit throwaway `--data-dir`; never reuse live data for a trial. The default v2 migration imports v1 data
into a separate directory and preserves the original files.

The engine defaults to loopback. A TLS/authenticated reverse proxy whose public
Host is not loopback must set `CLIDECK_ALLOWED_ORIGINS` to its exact public origin
(comma-separated for multiple origins). Host must still match Origin. This does
not add authentication; keep the existing gateway and firewall boundaries.

For package upgrades, do not overwrite the live package while it is serving pages.
Use the maintained `clideck-update` entry point below; its independent systemd
unit survives the dashboard restart. Do not stop the service directly from a user
conversation. Run the same updater through SSH on a VM only when deployment is
requested. Keep historical migration scripts with their backups for recovery;
release-specific installers are retired for future upgrades.
A narrowly scoped plugin HTML/CSS repair can be published as one verified atomic
asset replacement over SSH without restarting agents. Preserve the original file
and both hashes, and record the hotfix commit alongside the installed package
version; the next full package must include that source change.

Before stopping, record the currently live session IDs and validate saved native
resume handles against actual transcripts. ID preservation alone is insufficient:
the first v2 cutover carried three already-invalid v1 Codex pointers. Those v2
pointers were repaired; preserve the repaired v2 registry on later deployments.
After restart, resume the previously live sessions and check their actual provider
readiness without injecting prompts. Retain existing proxy-origin settings.


## Maintained v2 updater and voice setup

Use the same updater implementation for the host and VM. Python 3.12+, user
systemd with a persistent service, and Node with adjacent npm are required. It preserves the service unit,
listener, gateway origin settings and existing provider configuration.

```sh
# Run from the installed release, or give source-bin/clideck-update.py an
# explicit --installed-root /absolute/path/to/node_modules/clideck.
# Default: stage, verify the SHA, install into an isolated prefix, exercise PTY,
# assets/protocol, validate native handles and prepare backup. No service stop.
clideck-update /absolute/path/clideck-release.tgz --sha256 EXPECTED_SHA256
# Same checks, followed by independent systemd installation and verification:
clideck-update /absolute/path/clideck-release.tgz --sha256 EXPECTED_SHA256 --apply
# Reuse the recorded package/data backup after checking live native inventory:
clideck-update --rollback /absolute/path/to/recorded/update-directory

# Explicit local voice installation/model download; never runs during startup:
clideck-voice-setup
# Offline dependency and model readiness check; no installation/download:
clideck-voice-setup --check
```

Use `--data-dir`, `--service`, `--installed-root`, `--node` or `--url` only for a
nondefault installation. The updater checks service PID/ExecStart against the
selected data directory and package. It refuses v1 installations (use the
retained one-time migration), unknown live providers, missing/stale native
handles, working peers and executable collisions. Only the invoking conversation
may be interrupted by its requested update. Codex/Grok are the supported native
resume checks; fresh panes without handles must be resolved before an update.

Each private directory under `~/.local/state/clideck-builds/updates/` records the
release, package hashes, previous package, native inventory, data snapshot,
`update.log` and `result.json`. The installer copies the exact preflighted tree,
so no second dependency resolution occurs while the dashboard is stopped.
Verification covers health/protocol, native resume, Git asset identity, local
voice readiness and unexpected restarts. Failure restores the previous package,
registry and executable links and resumes the same conversations. Failed-version
data remains archived for recovery; plugin runtime data and native provider
transcripts remain in place. Manual rollback refuses changed pane/native
inventories. Browser/physical-phone acceptance remains separate from these
operational checks.
