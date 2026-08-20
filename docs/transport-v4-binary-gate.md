# Protocol v4 binary terminal-frame gate

Measured on 2026-08-20 with Node v24.18.0 using five repetitions per fixture:

```sh
node tools/benchmark-terminal-codec.js
```

The candidate retained the planned 28-byte header and raw UTF-8 payload. The
benchmark compares equal frame counts and performs encode plus decode for both
formats.

| Fixture | JSON median | Binary median | Result |
| --- | ---: | ---: | ---: |
| 63-byte interactive frame, 20,000 iterations | 18.14 ms | 37.71 ms | 108.86% regression |
| 28,686-byte recovery frame, 2,000 iterations | 132.74 ms | 44.52 ms | 66.45% improvement |
| Recovery wire bytes | 84,998,000 | 57,428,000 | 32.44% reduction |

The frozen gate allowed at most 5% regression for small interactive frames and
required at least 10% recovery improvement without increasing frame count.
Although the recovery and wire-size gates passed, the interactive gate failed.
Production protocol v4 therefore retains JSON terminal frames. The candidate
codec stays under `tools/` only so the decision can be reproduced if runtimes
change. Its focused test covers Unicode coordinates, snapshot-part metadata,
truncated and unknown headers, malformed sequence ranges and invalid UTF-8.
