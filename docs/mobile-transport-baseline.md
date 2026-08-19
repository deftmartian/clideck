# Mobile transport baseline

Measured on 2026-08-19 from `feature/mobile-transport-foundation` before the
transport, renderer-lifecycle, or static-delivery changes. The server ran under
the isolated provider-test home and port; the live service was not contacted.

## Standard fixture

`node tools/measure-transport.js` created ten 80x24 shell sessions with 4,096
printable payload characters per session, then connected a fresh WebSocket
client. A quiet run measured:

| Metric | Before |
| --- | ---: |
| Initial control bytes | 21,657 |
| Automatic replay bytes | 40,293 |
| Total reconnect bytes | 61,950 |
| WebSocket frames | 18 |
| Largest received frame | 7,556 bytes |

The reconnect automatically received terminal output for all ten sessions.
The metric called `maximumBacklog` in the isolated client is the largest frame
pending synchronous ingestion; the protocol did not yet expose a server-side
per-client send backlog.

## Mobile browser

`node tools/measure-transport.js --browser` loaded the same fixture in headless
Chromium at 412x915 with touch enabled and `?clideckPerf=1`:

| Metric | Before |
| --- | ---: |
| Terminal renderers created | 10 |
| WebGL contexts created | 10 |
| Terminal fits | 11 |
| PTY resize messages | 11 |
| Long tasks | 4 |
| Long-task duration | 1,696 ms |
| Local/external resource requests after navigation | 40 |
| Resource transfer bytes | 1,690,294 |

The browser probe is diagnostic rather than a benchmark: renderer, fit, resize,
and transport counts are deterministic acceptance signals; wall time and long
tasks vary by host load.

## Cold app shell

The pre-bundle dependency closure was 35 local critical files (HTML, CSS,
xterm core/addons, and the application ESM graph): 1,084,888 raw bytes, 276,926
bytes with gzip level 9, or 227,403 bytes with Brotli quality 11. The browser
also requested the manifest, favicon, and Google font resources. The favicon
was a 603x603, 310,294-byte PNG.

Run the probes again after implementation and record the comparable results in
`LOCAL-MAINTENANCE.md`.
