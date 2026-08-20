# Protocol v4 compression decision

Measured on 2026-08-20 with Node v24.18.0 using five repetitions per fixture:

```sh
node --expose-gc tools/benchmark-websocket-compression.js
```

The comparison covered the existing 1 KiB threshold, disabled compression,
selective recovery compression, 8 and 16 KiB thresholds, and zlib level 1.
All compressed variants retained client and server no-context-takeover.

Selected policy:

- compress replay and snapshot frames;
- do not compress live terminal frames;
- compress stream control frames at 16 KiB and above;
- retain the negotiated 1 KiB extension threshold, so tiny recovery fragments
  are still left uncompressed by `ws`;
- retain both no-context-takeover options.

Representative medians from the five-run A/B:

| Policy/workload | Elapsed | CPU | Wire bytes |
| --- | ---: | ---: | ---: |
| Current, recovery | 68.30 ms | 109.44 ms | 72,727 |
| Selective, recovery | 52.49 ms | 79.86 ms | 72,727 |
| Disabled, recovery | 30.94 ms | 30.39 ms | 12,659,040 |
| Current, live redraw | 54.67 ms | 84.37 ms | 73,163 |
| Selective, live redraw | 30.41 ms | 29.12 ms | 12,659,296 |
| Current, interactive | 15.31 ms | 19.23 ms | 438,000 |
| Selective, interactive | 12.86 ms | 17.04 ms | 438,000 |

Recovery wire savings versus disabled compression are about 99.4%, well above
the frozen 20% WAN gate. Interactive frames remain below the negotiated
threshold and did not regress. Repeated forced-GC samples showed no sustained
heap increase, and maximum event-loop delay stayed below 6 ms. The live-redraw
trade-off is deliberate: more LAN bytes avoid spending compression CPU on
ephemeral output that does not participate in recovery.
