# Transport v4 baseline

Measured on 2026-08-19 from `feature/mobile-transport-foundation` at
`26db96238c8679c48d28f114237f4adfa9e3cb7a`, before the foreground lifecycle,
parse-credit, HTTP image-upload, binary-frame, or compression changes.
Everything ran under the isolated provider-test home and port; the live
CliDeck service was not contacted.

## Existing automated gate

`npm test` passed all 105 tests in 12.6 seconds.

## Existing transport probe

`node tools/measure-transport.js --browser` used the existing ten-session
fixture and its 100 ms latency / 10 Mbps Chromium profile.

| Metric | Baseline |
| --- | ---: |
| Idle control bytes | 33,641 |
| Idle terminal replay bytes | 0 |
| Idle WebSocket frames | 11 |
| Maximum server send backlog | 20,773 bytes |
| Browser WebSocket-open to `session.subscribed` | 232.2 ms |
| Browser long tasks | 4 |
| Browser long-task duration | 504 ms |
| Browser WebSocket frames received | 21 |
| Browser WebSocket bytes received | 26,496 |
| Cold critical requests | 8 |
| Cold critical encoded bytes | 187,774 |
| Existing terminal-usable marker | 891.3 ms |

The existing `session.subscribed` and terminal-usable markers record protocol
dispatch, not completion of xterm parsing or a subsequent paint. They are
therefore a lower bound, not a truthful foreground-to-current measurement.
The v4 work must retain this baseline for comparison while replacing those
markers with applied and painted terminal-state measurements.

## Protocol v4 comparison

Measured on 2026-08-20 with the same fixture and browser profile after the v4
implementation:

| Metric | Protocol v4 |
| --- | ---: |
| Idle control bytes | 21,177 |
| Idle terminal replay bytes | 0 |
| Idle WebSocket frames | 8 |
| Maximum server send backlog | 7,556 bytes |
| Browser WebSocket-open to parsed-and-painted terminal | 102.6 ms |
| Browser long tasks | 1 |
| Browser long-task duration | 70 ms |
| Browser WebSocket frames received | 32 |
| Browser WebSocket bytes received | 28,531 |
| Cold critical requests | 5 |
| Cold critical encoded bytes | 162,253 |
| Truthful cold terminal usable | 681.2 ms |

Three full-payload samples of the five-second quiet foreground return reused
the existing WebSocket, selected `current`, transferred zero terminal bytes,
and painted current state in a median 57.6 ms (54.4–62.1 ms). The subsequent
32 KiB hidden-output case also reused the socket, selected `delta`, and painted
current state in a median 71.7 ms (45.8–95.5 ms). It received 32,846–32,861
terminal bytes. The largest observed unparsed queue was 32,861 bytes and the
maximum xterm write-queue depth was three.

These were early protocol-v4 comparison samples. The final cross-browser
matrix, conservative after-paint marker, five-minute hidden run, renderer
qualification, and operational limits are recorded in `transport-v4.md`.
