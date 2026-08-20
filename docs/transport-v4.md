# Protocol v4 transport and recovery

Protocol v4 is the fork's production transport design as of 2026-08-20. It
uses one long-lived WebSocket per browser tab for control and flow-controlled
terminal output, plus bounded same-origin HTTP for clipboard images. It does
not use a SharedWorker, BroadcastChannel, second WebSocket, WebRTC,
WebTransport, or hidden terminal streaming.

## Runtime model

- A hidden tab sends `session.unsubscribe`. The server continues sending
  control metadata but sends no terminal frames.
- A visible tab reuses an open, protocol-ready socket and subscribes the active
  terminal with its last applied cursor. It does not reconnect merely because
  it was hidden.
- The subscription response is a liveness probe. If an apparently open socket
  produces no valid response for two seconds, the client replaces it once.
- A subscription selects `current`, `delta`, or `snapshot`. `current` sends no
  terminal payload. Small deltas retain the browser's 10,000-line scrollback.
  A snapshot resets it to the bounded server capture, currently at most 1,000
  lines and 1 MiB.
- Every subscription has a numeric `streamId`. Delayed frames, snapshots, and
  xterm callbacks from an older stream cannot advance the new one.
- `receivedSeq` tracks contiguous WebSocket delivery. `appliedSeq` advances
  only from an xterm write callback, and only `appliedSeq` is resumable.
- The server sends at most 32 KiB per terminal frame and grants 128 KiB of
  application credit. ACKs are cumulative and release credit only after xterm
  applies the corresponding frame. The separate network emergency bound is
  1 MiB.
- Terminal ACK stalls request one bounded resubscription after 30 seconds;
  they do not create an unbounded application queue or reconnect loop.
- Resize ownership remains with the most recently interacting subscribed
  client. Replayed output retains the existing OSC 52 side-effect guard.

The adaptive policy begins with these thresholds:

| Decision | Initial rule |
| --- | --- |
| `current` | Applied cursor equals the server sequence |
| Fast delta | Missing range is at most 64 KiB |
| Moderate gap | Compare delta and snapshot; snapshot must be at least 25% smaller |
| Large gap | Above 256 KiB, prefer a snapshot when materially smaller |
| Observed refinement | Use a conservative 2x safety factor on the ACK-derived drain rate |
| Large-gap safeguard | Snapshot may replace an optimistic delta when it is at most half the size |

## Clipboard images and input limits

Clipboard and attachment images use:

```text
POST /api/session/{id}/clipboard-image
Content-Type: image/png | image/jpeg | image/webp | image/gif
X-CliDeck-Protocol: 4
Body: raw image bytes
```

The endpoint requires a same-origin request, a live session, matching protocol,
and valid file magic. It streams into a unique mode-0600 temporary file,
accepts at most 25 MiB, permits two concurrent uploads, atomically commits the
file, and bracket-pastes the path once. Aborts and failures remove temporary
files. The store remains mode 0700, 256 MiB total, and 30 days old at most.
Ambiguous upload failures are not retried automatically.

The WebSocket no longer carries clipboard images. Its inbound payload limit is
1 MiB, while terminal paste/input is deliberately limited to 512 KiB.

## Compression and framing decisions

Control messages and terminal frames remain JSON. The candidate 28-byte binary
terminal codec reduced recovery overhead and wire size but more than doubled
the representative small-frame codec time, so it failed the frozen interactive
gate. See `transport-v4-binary-gate.md`.

Per-message deflate keeps client and server no-context-takeover. Replay and
snapshot frames are compressed, live output is not, and control frames opt in
at 16 KiB. See `transport-v4-compression.md`.

## Cache and upgrade contract

The generated app and CSS use content-hashed filenames and immutable one-year
cache headers. HTML, the service worker, manifest, APIs, and plugin files remain
`no-cache` or `no-store` as appropriate.

Bundled plugins under the user data directory are app-owned persisted caches,
not independent source. Startup refreshes every packaged managed file whose
contents differ, even if the plugin author forgot to bump its version. It
preserves unmanaged extras and only clears dependency-install state when the
package install inputs changed. Each plugin payload includes a content-derived
`clientRevision`; the browser imports
`/plugins/{id}/client.js?v={clientRevision}`. Failed module imports are removed
from the in-page loaded set so a later plugin update can retry.

This is why a release needs cache busting for plugin clients as well as hashed
application assets. A normal reload is sufficient after upgrade. Protocol v4
rejects a mixed v3/v4 client and asks for a reload; rollback likewise requires
reloading the browser.

## Automated acceptance

The measurement tool exercises quiet, 32 KiB delta, redraw-heavy snapshot,
replay-ring gap, offline recovery, stale-open recovery, and 8-byte/2 MiB/25 MiB
image uploads. Five-sample results from 2026-08-20:

| Browser / layout / network | Quiet p95 | 32 KiB delta p95 | Redraw snapshot p95 | Ring-gap snapshot p95 |
| --- | ---: | ---: | ---: | ---: |
| Chromium desktop, hardware WebGL, LAN | 33.2 ms | 40.3 ms | 52.1 ms | 51.8 ms |
| Chromium touch, 100 ms / 10 Mbps | 64.3 ms | 108.2 ms | 117.5 ms | 113.6 ms |
| Firefox desktop, LAN | 43 ms | 35 ms | 65 ms | 65 ms |
| Firefox touch, LAN | 34 ms | 52 ms | 57 ms | 49 ms |

Chromium desktop LAN is measured with hardware Vulkan because headless
Chromium otherwise reports SwiftShader, whose CPU WebGL rasterization creates
73-91 ms renderer tasks unrelated to transport or xterm parsing. The hardware
profile identifies the actual WebGL vendor/renderer in its result and clears
the 50 ms recovery-long-task gate. A DOM-renderer diagnostic also clears that
gate. Do not silently waive it for an unidentified software renderer.

The five-minute healthy-hidden Chromium desktop run returned in 30 ms with
zero terminal bytes, zero new WebSocket handshakes, and no recovery long task.
Across the matrix, hidden terminal bytes, stale/invalid ACKs, forced resyncs,
and healthy-return reconnects were zero. Peak unacknowledged terminal data was
exactly 131,072 bytes. A throttled 25 MiB upload left control latency at 4.3 ms.

Run the frozen gates from the repository root:

```bash
npm test
npm run build:client
npm run check:client
npm run test:browser -- chromium
npm run test:browser -- firefox
node tools/measure-transport.js --browser
node tools/measure-transport.js --browser --desktop --lan --hardware-gl
node tools/measure-transport.js --browser=firefox --desktop --lan
node tools/measure-transport.js --browser=firefox --lan
```

Use `--samples=N` for one to ten samples, `--long-hidden` for the five-minute
case, and `--dom-renderer` only to distinguish transport/DOM work from a
headless software-WebGL limitation. Firefox Playwright does not expose
Chromium's network-emulation API, so the deterministic 100 ms/10 Mbps profile
is Chromium-only; Firefox is exercised in both layouts on LAN.

## Remaining real-device acceptance

The isolated suites cannot prove browser permission behavior, mobile OS
freeze/resume, or the authenticated reverse proxy's upload-body ceiling. After
each installed candidate, test in a real desktop browser and phone:

1. Reload once and confirm the scissors button is present.
2. Verify F8 and the scissors button, Ctrl+C selected copy, context-menu copy,
   mobile selection copy, and ordinary text paste.
3. Return after 5 seconds, 30 seconds, and 5 minutes with a quiet shell, normal
   hidden output, and a rapidly repainting TUI.
4. Confirm small-delta scrollback is retained; force a large snapshot and
   confirm the documented bounded replacement.
5. Switch sessions quickly; lose/restore network; restart the server while
   hidden; verify no missing or duplicated output.
6. Confirm live OSC 52 copies once and replay does not copy again.
7. Attach a small image and a maximum-size image through the public authenticated
   route; confirm each path is pasted once and the terminal remains responsive.

Deployment must use a content-addressed package artifact, verify
`/api/health` version/build/protocol identity, preserve the prior release for
rollback, and observe service restarts, OOMs, socket-close storms, logs, and
memory before promotion.

## Agent VM rollout evidence

The 2026-08-20 candidate is installed on Agent VM from the content-addressed
package artifact with SHA-256
`2fa548e8d704d99b8a673fcd6619aacf6dc7f3ce969c2ec87eea75081deef9ea`.
The live health contract reports CliDeck `1.33.1`, client build
`b906c6d1ba67c52d`, and protocol `4`. The service stayed active with zero
restarts, the pre-deployment configuration and resumable-session file hashes
were preserved, and the previous release remains available for rollback.

A direct live Chromium load requested the Trim Clip client as
`client.js?v=b8f2400ef66c8402` and showed no console errors. A uniquely named
temporary live shell session then proved F8, the scissors button, Ctrl+C, and
context-menu copy through the no-Clipboard-API fallback. The temporary session
was closed and the persisted session file returned byte-for-byte to its
pre-test hash. The secure authenticated origin's Clipboard API permission
behavior remains a real-browser acceptance item rather than an inference from
that fallback test.

The current source was rechecked after rollout: all 130 unit/integration tests,
the deterministic client build check, and both full Chromium and Firefox
browser suites pass. A fresh five-minute hardware-WebGL hidden-tab run returned
via `current` in 41.6 ms with zero hidden terminal bytes, zero new WebSocket
opens, zero recovery long tasks, and parse completion preceding the painted
marker. The run also recorded zero stale/invalid ACKs or forced resyncs.

Three acceptance items are deliberately still open:

- authenticated reverse-proxy-origin Clipboard API permissions;
- a physical phone's OS-level freeze/resume behavior;
- a 25 MiB upload through Authentik and Caddy, including proof that Caddy has
  an explicit bounded request-body policy above CliDeck's accepted maximum.

The versioned homelab documentation identifies Caddy and Authentik as the
public route but does not record a Caddy request-body ceiling. Anonymous
requests stop at the Authentik redirect. Do not claim the proxy upload gate
from the successful direct-LAN upload alone.
