# CliDeck v2 fork maintenance

This branch ports the retained fork features onto upstream `70f6b9c`
(CliDeck 2.4.0 plus clipboard fixes). The old `integration/full-stack` history is preserved separately.
The v2 engine and plugin SDK replace v1; Autopilot is retired.

## Local upstream integration

`local/upstream-2.4` rebases the installed `2.1.1-fork.5` source (`ea4c003`)
onto upstream `70f6b9c`; the original restoration branch remains available.
The candidate is `2.4.0-fork.7`. Build and package it locally; this branch does
not describe a live deployment.

Upstream update checks remain available, but `clideckUpdatePolicy: local` in
the package disables registry installation, including direct installer calls.
The UI explains the manual fork deployment procedure instead of suggesting an
npm registry replacement. Keep that metadata in every fork tarball.

The browser and headless capture share the upstream CSI-S preservation helper,
loaded from the selected static asset tree. Build before testing or packaging
so both use the same code. Snapshot regressions check reply history and current
cursor; xterm serialization still does not retain a previously saved DEC cursor
for a later ESC-8 after reconnect. That pre-existing limitation remains separate
from the fixed CSI-S history loss.

File paste/drop while a composer owns input uses the same pending draft tickets
as images. Late uploads stay with their original draft, and rich clipboard text
keeps precedence over an image representation. Backups validate and retain
worker ownership/worktree fields, preserving Ask ownership and the recursive
spawn restriction after restore. Template generation resolves the packaged CSS.
The closed mobile sidebar is hidden so overflowing controls cannot intercept
composer taps on narrow screens.

`npm run test:ui` runs all upstream fake-DOM integration suites in isolated
processes; these are separate from `npm test` and the real-browser suites.

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
  Direct explicitly hands input to xterm. Send/Paste and special keys preserve an open
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
Unparsed terminal output invalidates the reconnect cursor and cannot send stale ACKs.

The upstream synchronous `Screen` remains the provider readiness/menu source;
async xterm remains the replay and terminal-query source. Screen lines are cached
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

Snapshots restore the terminal's mouse encoding as well as its tracking mode.
The pinned xterm serializer omits SGR/SGR-pixel encoding, which otherwise makes
mouse-tracking harnesses ignore wheel input after selection or reconnect.
Ordinary mouse dragging selects text; Alt-click/drag sends application mouse
events, and the wheel remains application-controlled when tracking is enabled.
`npm run test:browser:mouse` verifies selection and real PTY wheel input across
connect/reload, Alt-click, and SGR-pixel/legacy encoding transitions. Firefox is
also supported through `BROWSER=firefox`.

## Worker recovery and update notices (fork.2)

A timeout after dispatch stops waiting; it leaves the worker and its active ask
reservation intact. The timeout prints its exact session ID. Use
`clideck worker status <session-id>` to check, `clideck worker wait <session-id>
--timeout 10m` to collect the original answer and close it, or
`clideck worker cancel <session-id>` to stop it explicitly. These operations require
the original live parent session. Retained workers count toward the three-worker
limit. A worker that fails to become ready still closes without receiving a prompt.
Pending result collection is held in engine memory; after an engine restart,
inspect the saved conversation in its session instead.

`spawn --command-id <id>` selects an enabled command from CLI Agents settings,
including its configured flags and launcher identity for resume. It is mutually
exclusive with `--preset <provider>`, which selects the stock provider. Omitting
both inherits the parent's launcher. No configured command is selected implicitly.

`clideckUpstreamVersion` records the fork's upstream release base. Local fork update
checks compare against that stable version and display the full fork version.
Keep this metadata current when rebasing. Registry installation remains disabled;
a newer upstream release is a manual rebase notice.

## Files workspace (fork.3)

The terminal-header Files button opens a per-session workspace tab. On phones it
is under Session actions. Files starts at the session cwd and allows absolute-path
navigation throughout the guest filesystem, matching the existing folder picker.
Project folder pickers remain directory-only. The file list is capped at 5,000
entries and marks truncation rather than silently presenting a complete list.

Files uploads and drops go into the displayed folder. Phone Attach accepts all
file types and uses the open Files workspace's current folder; without a Files
workspace, existing image preparation remains in use and other attachments go
to session cwd. Terminal drops keep their existing destination and restrictions.
Uploads retain collision suffixes and the 100 MiB limit. Preview uses the existing
user-scoped content viewer. Insert path adds to the session draft without Send.

Select a row for rename, Move (the existing folder picker), delete, or text editing.
Deletion requires the exact name; a nonempty directory requires a second recursive
confirmation. There is no trash. New files use exclusive creation, moves reject
existing destinations, and symlink deletion removes the link itself. Text editing
accepts regular UTF-8 files up to 1 MiB, preserves CRLF and rejects stale saves using
a content revision. File mode and ownership are preserved; hard-linked files and
mixed-line-ending files require another editor. Source and extensionless UTF-8
files can preview as text. Saves use temporary-file replacement; the revision check is
optimistic and does not lock out external filesystem tools. Symlink/device editing
is refused. Dirty edits survive socket reconnect and prompt before closing the tab
or page. Removing a session with dirty edits opens a recovery window for copying
or downloading the unsaved text. A browser reload does not restore the Files tab
or unsaved editor text. Files uploads also work for dormant saved sessions.

All file actions use the existing loopback/origin boundary and an existing session.
They act with the engine user's filesystem permissions. No new chroot or separate
file-manager service is introduced. Public proxy upload limits and physical-phone
file pickers remain deployment acceptance checks; local browser emulation cannot
establish those.

Files rows are a keyboard listbox: click selects, Enter/double-click or Open opens.
Breadcrumbs, filtering, sizes and modification dates replace the old button list.
Filtering searches the loaded entries and retains the 5,000-entry limit warning.
Download streams a regular file (symlinks are followed, directories/devices/FIFOs are
refused) from `GET /api/files/download`; it requires a loopback or allowed Host and a
same-origin fetch, and the UI preflights with `stat` so failures show in the status line.
Downloads have no Range support, so interrupted transfers restart. A file removed
after the preflight appears as a failed browser download. Known gap, not
changed here: `/api/session/backup` and other GETs without an Origin accept any Host.

Run `npm run test:browser:files
npm run test:browser:hardening` (also `BROWSER=firefox` / `BROWSER=webkit`) for the
Files browser acceptance lane, after building the client. It covers desktop and
390/320px layouts, navigation, upload destination, preview, draft insertion,
phone Attach, edit conflicts, CRLF, creation, rename, Move, deletion confirmation,
unsaved editor protection/reconnect, binary/Unicode downloads, rejected special
files, cancelled streams, keyboard selection and truncated-list filtering.
Use the existing restoration lane to
check the original mobile composer and image behavior.

## Release-hardening behavior

These limits are local fork behavior on top of upstream 2.4.0. They do not change
the package version by themselves.

Invalid `config.json` stays on disk. A malformed file, a file that fails entry
validation, a file over the 256 KiB settings limit, or a non-file is not parsed
into a replacement and is not overwritten by a later settings change. CliDeck
keeps an empty in-memory document, blocks writes, and shows the recovery reason.
Recovery is explicit: `clideck config recover`, the Recover action, or
`POST /api/config/recover` copies the original bytes to
`config.json.rejected-<time>` and then writes a new default config. A missing
file on first install still seeds starter prompts and onboarding. A file at the
limit is not read into memory only to be rejected for size.

`clideck resume [session-id]` and `GET /api/session/resume` report the saved
handle, the cached transcript path and whether that path is a regular file, plus
`createdAt`, `lastActive` and `lastAgentAt` when present. The report is metadata.
It does not read conversation bodies, it does not prove the handle still
continues that conversation, and it does not repair a handle. Providers that
know how to resume (Claude, Codex, Gemini, Grok, OpenCode, Pi) refuse to launch
when no handle is saved, including Restart, so a fresh process is not attached
to the old row. Shell and Antigravity still launch. A custom command launches
without a handle when `canResume` is false and it has no native provider.
Native-provider launchers retain native resume behavior and use saved handles;
the generic custom-command flag does not override it. A generic custom command
with `canResume` true still requires a handle. A missing or stale cached
transcript path does not block a saved handle; the provider CLI may resolve it.
The UI warns once when that path is missing.

`lastActive` moves when the session is created and when input, output, a final
answer, resume metadata or a resize is recorded. Closing the engine records
columns and rows only. A shutdown does not make a dormant session look newly
used. This does not claim a new sidebar sort order.

`clideck worker list` shows workers spawned by the calling session: parent, age,
state (`working`, `finished`, `dormant`) and collection (`pending`, `ready`,
`unavailable`). A caller timeout leaves the worker listed. `status`, `wait` and
`cancel` still need the original live owner and a live worker. After an engine
restart the saved worker remains, collection is unavailable because pending
results live in that process, and listing does not stop the worker or reuse a
user session. There is no new idle timeout. A dormant parent can list; a worker
cannot list other workers. Resume the parent only when that conversation is
still needed. Listing does not relaunch workers.

Phone image picks keep two uploads active and eight waiting. A ninth waiting
image is refused with a distinct message. Each image is still limited to 25 MiB
before and after preparation. The queue holds the browser File objects; it does
not copy their bytes. The draft ticket is taken on the session that picked the
image, so a later session switch, clear or removal does not move that upload.
When a Files workspace is open, Attach sends every picked file, including
images, into the displayed folder and does not use the image queue. Failures
surface as toasts. This queues the pre-existing two-at-a-time rejection. It
does not raise the image size limit.

Terminal history remains capped at 2 MiB. Appending past the cap drops the
oldest bytes and sets `historyTruncated`. The terminal banner then says those
bytes are gone and that conversation History does not restore them. A history
file that is exactly at the cap and has no flag is reported as uncertain,
including a brand-new fill that landed exactly on the cap, because the file
alone cannot show whether older bytes were removed. An empty history does not
show the notice even if a stale flag is present. The notice is one banner,
replaced in place, for the active session, including a live session, a reload
and a dormant saved session. Reading an old file does not write the flag.
Backup files still omit terminal history. The newest-history loss seen after
the 8 October 2026 reboot is not explained by this cap and is not fixed here:
shutdown logs from that event looked normal, the tail keeps the newest 2 MiB,
and the affected session was not identified.

Snapshot replacement and session changes queue an RIS reset behind pending xterm writes.
A synchronous reset can let old queued bytes paint over the replacement. The browser
snapshot test delays parsing while two real WebSocket snapshots arrive.

## Verification and packaging

```sh
npm ci
npm run build:client
npm run check:client
npm test
npm run test:ui
npx playwright-core install chromium firefox
npm run test:browser:fork
BROWSER=firefox npm run test:browser:fork
npm run test:browser:mobile
BROWSER=firefox npm run test:browser:mobile
# Install WebKit and its platform libraries before this lane:
BROWSER=webkit npm run test:browser:mobile
npm audit --omit=dev --audit-level=high
npm pack --pack-destination /tmp/clideck-release
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
| Grok rules and model/context | Custom rules merge once on an isolated config root. Transcript answers and prompt correlation are HTTP tests. The context-file watcher has no remaining test. |
| Codex model after resume | Bounded transcript reader remains. The pure rollout-parser test was removed and is not replaced. |
| Codex paste/Enter | The delayed Enter stays in the session. A PTY echo coalesces it with the next write, so the split is not asserted on the wire. |
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
Installation and restart must be one coordinated SSH operation, with the old
package and data available for rollback. Never restart from inside CliDeck.
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

## Turn settlement verification

Run from this worktree, with `node` on PATH. Every test uses a private `/tmp`
directory and port 0. Do not point them at a live data directory, installed
service, or user hook config.

```
node --test test/fork/turn-settlement.test.js test/fork/workers-pty.test.js test/fork/stream-network.test.js test/fork/grok-hooks.test.js
npm test
npm run test:ui
npm run build:client
npm run check:client
node test-ui/photo-queue-browser.mjs
node test-ui/terminal-cursor-browser.mjs
node test-ui/xterm-scroll-browser.mjs
```

`npm test` and `npm run test:ui` are the regression lanes. The browser commands
cover the photo queue and the terminal behavior previously asserted with fake
DOM. The removal inventory is `FORK-TEST-CLEANUP.txt`.

Grok `complete()` checks that StopFailure, StopCancelled, and the idle_prompt
Notification entry exist. It does not compare ports. A different port still
reaches the helper through `CLIDECK_URL`. The Stop helper must exit 0. PreToolUse
stays installed. Claude and Codex hooks must send the current launch token
before any status or resume metadata changes. An ask timeout leaves the
reservation until a real final, cancellation, provider failure, or close.

Fork verification uses browser, CLI, HTTP, WebSocket, PTY and filesystem boundaries.
Fork-added unit suites have been removed; upstream unit suites remain. Grok setup
and removal reject malformed hook settings before changing hooks or UI preferences,
and removal preserves unrelated top-level settings. Grok session-wide idle notices
settle steered turns; known stale prompt IDs and subagent events are ignored.

Before deployment, back up the provider hook configuration as well as the package
and CliDeck data. The first Grok launch upgrades its hook events and helper path.
Restore the preserved hooks with the old package on rollback; do not rely on the
old installer removing newer events. Tests and native rehearsals use private profiles.

A failed saved-history read now holds that file unchanged and buffers new output
in the bounded in-memory tail. Subsequent reads/flushes retry and append the pending
output after the original tail once readable. A process exit before recovery can
lose that pending output; the unreadable original is still preserved.


## Draft attachments (fork.5)

Desktop Attach, phone Attach, terminal drops and file-only clipboard pastes share
a draft tray. Uploads stay with the initiating session; text remains editable.
The tray shows filenames, small in-memory image previews, queue/progress/error
state and Remove. Completed paths survive reload; interrupted uploads recover
as errors requiring removal and reattachment. Remove detaches a file and cancels
an active upload; it does not delete an already uploaded host file.

Send and Paste require every attachment to be ready. The server checks file
readability and acknowledges acceptance before the browser clears that draft.
A rejected or missing-file submission stays editable. If acknowledgement times
out, check the native terminal before retrying: delivery may have succeeded.

Codex, Claude Code and Grok receive one quoted image path per bracketed paste,
followed by the text/file references. The session spaces frames by 1700 ms because
native image decoding is asynchronous, and separates the final Enter. Paste
omits Enter. Escape/Ctrl-C cancels remaining frames and any delayed Enter.
Other providers receive quoted file references. Paths containing quotes,
backslashes or control characters use references rather than unproven native
image-parser escaping. Folder drops require choosing files inside the folder;
a browser-local folder path is not assumed accessible on the server.

The shared queue allows two uploads plus eight waiting, 32 attachments per draft,
25 MiB per supported image and 100 MiB per other file. PNG/JPEG/WebP images outside
Files are reduced to at most 2048 pixels when that saves bytes; PNG keeps alpha.
GIFs and Files-directory uploads retain their bytes. Ordinary documents remain
file references, not embedded model attachments. Native permissions still apply.

Verification:

- `npm run test:browser:attachments` exercises real HTTP uploads, WebSocket
  acceptance/rejection and a real PTY child on desktop and phone layouts. It
  covers reload, thumbnails, drop/Attach, missing files, cancellation, failure,
  rapid repeat Send, overflowing input and Escape during image insertion.
- `test-ui/draft-integration-browser.mjs` covers clipboard/voice composition,
  late uploads across session changes, offline/reconnect and exactly one Send.
- Photo queue, Files and mobile restoration suites cover bounds, directory
  destinations and keyboard-obstruction checks. No fork unit tests were added.
- Isolated native Codex 0.161, Claude 2.1.295 and Grok 1.0.50 recognized a real
  synthetic PNG through these session input methods. Claude/Grok read a text
  file with spaces in its path. Codex received the reference and attempted a
  read, but this host's sandbox failed with `bwrap: loopback: Failed RTM_NEWADDR:
  Operation not permitted`; Codex file consumption is not a verified pass.

Native checks used small PNGs and default composers, not every image format,
model or custom keymap. The 1700 ms spacing is conservative pacing, not a native
chip acknowledgement. Physical-phone keyboard checks remain outstanding.
