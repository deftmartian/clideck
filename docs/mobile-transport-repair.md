# Mobile transport repair closeout

> Historical report: this records the isolated acceptance state that became
> archived commit `cebff72`. The public-fork candidate subsequently rewrote the
> unpublished commit identities, merged newer upstream, extracted renderer and
> capture coordination, and reran the release gates. Current ownership and
> validation live in `LOCAL-MAINTENANCE.md`.

Completed on 2026-08-19 on `feature/mobile-transport-foundation` as seven
additive commits. Existing commits were not rewritten, protocol remains v3,
and package version remains `1.33.1`. All server and browser checks used
throwaway homes, ports, and data directories; `clideck-agent.service` was not
installed, restarted, or otherwise contacted.

## Repaired invariants

- A successful restart gives each active viewer exactly one fresh snapshot.
  Invalid restart inputs preserve the PTY; a post-kill spawn failure removes
  the dead session instead of leaving a renderer ghost. Stale output callbacks
  from a replaced PTY cannot enter the replacement session.
- Inactive sessions receive throttled activity metadata but no terminal
  output. Per-browser activity cursors own unread state, and selection clears
  it. Transcript-cache state is `idle`, `loading`, or `loaded` and refreshes
  after reconnect.
- One size normalizer owns every terminal ingress. Headless xterm is the sole
  terminal-query responder.
- A 2 MiB Unicode-safe replay ring, 32 KiB frame bound, serialized send
  preflight, one connection phase, and cursor advancement after accepted sends
  make delivery lossless and bounded. Recoverable batch gaps replay from the
  ring; terminal pressure snapshots, while control pressure closes with 1013.
- Capture is coalesced and sequence-barriered, with PTY pause/resume at the
  1 MiB/256 KiB thresholds. `clideck ask` waits for committed capture through
  the internal `session.output` event rather than a fixed delay.
- Touch retains one renderer. Desktop retains four by LRU and rehydrates an
  evicted session from one snapshot. Diagnostics report live renderer/WebGL
  counts, evictions, and rehydrations.
- Runtime client output is staged only in untracked `dist/public`. The source
  HTML remains a template, builds are deterministic, compression negotiation
  honors quality values and 406, and the npm package contains only runtime
  server files, plugins, and staged assets.

## Automated acceptance

- `npm ci`, `build:client`, and `check:client` passed; two temporary client
  builds were byte-identical and the current stage matched.
- `npm test` passed 100 tests.
- Chromium and Firefox passed restart, offline/reconnect, transcript-only
  filtering, inactive unread, query replay, OSC 52, ten-session touch, desktop
  LRU, and renderer/resource checks.
- Provider lifecycle passed for installed Codex; unavailable Claude, Gemini,
  OpenCode, and Pi executables were reported as skips. Capture, menu,
  menu-status, Codex config/hooks, and HTTP utility smoke suites passed.
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- The final `clideck-1.33.1.tgz` contained 117 files and excluded `public/`,
  `src/`, `tests/`, `tools/`, Tailwind config, and the lockfile. From an
  extracted install on an isolated port and `CLIDECK_DATA_DIR`, health reported
  version `1.33.1`, protocol 3, and the staged build identifier; compression,
  provider metadata, one DSR reply, one restart snapshot, the touch browser,
  the trim plugin, and post-restart output all passed.

Real Android acceptance and any live cutover remain release gates.
