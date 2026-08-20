#!/usr/bin/env node

const { Sandbox } = require('../tests/providers/sandbox');
const { Client } = require('../tests/providers/client');
const { chromium, firefox } = require('playwright-core');
const { existsSync } = require('fs');

async function setPageVisibility(page, value) {
  await page.evaluate(next => {
    globalThis.__clideckMeasuredVisibility = next;
    if (!Object.prototype.hasOwnProperty.call(document, 'visibilityState')) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => globalThis.__clideckMeasuredVisibility,
      });
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

async function measureForegroundReturn(page, producer, sessionId, {
  output = '',
  minimumMissedCodeUnits = 0,
  hiddenMs = output ? 150 : 5000,
  activityTimeoutMs = 60000,
  label = 'foreground recovery',
} = {}) {
  const before = await page.evaluate(() => window.__clideckPerfSnapshot());
  const cursorBefore = await page.evaluate(id => (
    window.__clideckTest.state.terms.get(id)?.appliedSeq
  ), sessionId);
  await setPageVisibility(page, 'hidden');
  // A control response is an ordering barrier: the server must have processed
  // session.unsubscribe before this stats request. This prevents the fixture
  // from racing output against the hide transition and also proves that hidden
  // terminal bytes stay flat.
  await requestTransportStats(page);
  const hiddenBytesBefore = await page.evaluate(() => (
    window.__clideckPerfSnapshot().counters.terminalBytesReceived || 0
  ));
  await page.waitForTimeout(hiddenMs);
  if (output) {
    producer.messages.length = 0;
    producer.send({ type: 'input', id: sessionId, data: output });
    await producer.waitFor(
      message => message.type === 'session.activity'
        && message.id === sessionId
        && (!minimumMissedCodeUnits
          || message.atSeq >= cursorBefore + minimumMissedCodeUnits),
      { label: `${label} hidden-output activity`, timeout: activityTimeoutMs },
    );
  }
  const hiddenBytesAfter = await page.evaluate(() => (
    window.__clideckPerfSnapshot().counters.terminalBytesReceived || 0
  ));
  if (hiddenBytesAfter !== hiddenBytesBefore) {
    throw new Error(`${label} delivered ${hiddenBytesAfter - hiddenBytesBefore} terminal bytes while hidden`);
  }
  const paintedBefore = before.counters.terminalCurrentPainted || 0;
  const foregroundStartedAt = await page.evaluate(() => performance.now());
  await setPageVisibility(page, 'visible');
  await page.waitForFunction(count => (
    window.__clideckPerfSnapshot().counters.terminalCurrentPainted || 0
  ) > count, paintedBefore, { timeout: 60000 });
  const after = await page.evaluate(() => window.__clideckPerfSnapshot());
  const sync = [...after.events].reverse().find(event => event.name === 'terminalSyncStarted');
  const parsed = sync && after.events.find(event => (
    event.name === 'terminalParseComplete'
      && event.streamId === sync.streamId
      && event.at >= sync.at
  ));
  const painted = parsed && after.events.find(event => (
    event.name === 'terminalCurrentPainted'
      && event.streamId === sync.streamId
      && event.at >= parsed.at
  ));
  const recoveryLongTasks = after.events.filter(event => (
    event.name === 'browserLongTask'
      && event.startedAt >= foregroundStartedAt
      && event.startedAt <= after.measuredAt
  ));
  return {
    mode: sync?.mode,
    foregroundToCurrentMs: after.timings.foregroundToCurrentMs,
    parseToPaintMs: parsed && painted ? painted.at - parsed.at : null,
    foregroundStartedAt,
    parseCompleteAt: parsed?.at ?? null,
    currentPaintedAt: painted?.at ?? null,
    measuredThroughAt: after.measuredAt,
    newWebSocketOpens: (after.counters.healthySocketOpenCount || 0)
      - (before.counters.healthySocketOpenCount || 0),
    terminalBytesReceived: (after.counters.terminalBytesReceived || 0)
      - (before.counters.terminalBytesReceived || 0),
    terminalSyncs: (after.counters.terminalSyncStarted || 0)
      - (before.counters.terminalSyncStarted || 0),
    snapshotBytes: (after.counters.snapshotBytes || 0)
      - (before.counters.snapshotBytes || 0),
    deltaBytes: (after.counters.deltaBytes || 0)
      - (before.counters.deltaBytes || 0),
    maximumUnparsedBytes: after.counters.maximumUnparsedBytes || 0,
    maximumWriteQueueDepth: after.counters.maximumWriteQueueDepth || 0,
    hiddenTerminalBytes: hiddenBytesAfter - hiddenBytesBefore,
    maximumRecoveryLongTaskMs: recoveryLongTasks.reduce(
      (maximum, event) => Math.max(maximum, Number(event.durationMs) || 0), 0,
    ),
    recoveryLongTasks: recoveryLongTasks.map(event => ({
      startedAt: event.startedAt,
      durationMs: event.durationMs,
    })),
  };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function summarizeRecoverySamples(samples) {
  const timings = samples.map(sample => sample.foregroundToCurrentMs);
  const bytes = samples.map(sample => sample.terminalBytesReceived);
  return {
    samples: samples.length,
    modes: [...new Set(samples.map(sample => sample.mode))],
    foregroundToCurrentMs: {
      p50: percentile(timings, 0.5),
      p95: percentile(timings, 0.95),
      min: Math.min(...timings),
      max: Math.max(...timings),
    },
    terminalBytesReceived: {
      min: Math.min(...bytes),
      max: Math.max(...bytes),
    },
    maximumRecoveryLongTaskMs: Math.max(
      ...samples.map(sample => sample.maximumRecoveryLongTaskMs),
    ),
    maximumUnparsedBytes: Math.max(...samples.map(sample => sample.maximumUnparsedBytes)),
    maximumWriteQueueDepth: Math.max(...samples.map(sample => sample.maximumWriteQueueDepth)),
    maximumNewWebSocketOpens: Math.max(...samples.map(sample => sample.newWebSocketOpens)),
  };
}

async function requestTransportStats(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const ws = window.__clideckTest.state.ws;
    const timer = setTimeout(() => reject(new Error('transport stats timed out')), 5000);
    const listener = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'transport.stats') return;
      clearTimeout(timer);
      ws.removeEventListener('message', listener);
      resolve(message);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ type: 'transport.stats.request' }));
  }));
}

async function markerCount(page, sessionId, marker) {
  return page.evaluate(({ id, value }) => {
    const term = window.__clideckTest.state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    if (!buffer) return 0;
    let text = '';
    for (let index = 0; index < buffer.length; index += 1) {
      text += buffer.getLine(index)?.translateToString(true) || '';
    }
    return text.split(value).length - 1;
  }, { id: sessionId, value: marker });
}

async function measureOfflineRecovery(page, context, producer, sessionId) {
  const before = await page.evaluate(() => window.__clideckPerfSnapshot());
  const cursorBefore = await page.evaluate(id => (
    window.__clideckTest.state.terms.get(id)?.appliedSeq
  ), sessionId);
  const marker = `OFFLINE_DONE_${Date.now()}`;
  const markerSplit = Math.floor(marker.length / 2);
  const payloadCodeUnits = 16 * 1024 + marker.length;
  await context.setOffline(true);
  await page.waitForFunction(() => (
    window.__clideckTest.state.ws?.readyState !== WebSocket.OPEN
  ));
  producer.messages.length = 0;
  producer.send({
    type: 'input', id: sessionId,
    // Split the marker in the echoed command so the terminal contains it only
    // once when the program emits its recovered output.
    data: `node -e "process.stdout.write('O'.repeat(16384)+'${marker.slice(0, markerSplit)}'+'${marker.slice(markerSplit)}')"\r`,
  });
  await producer.waitFor(message => message.type === 'session.activity'
    && message.id === sessionId
    && message.atSeq >= cursorBefore + payloadCodeUnits, {
    label: 'offline hidden-output activity', timeout: 60000,
  });
  await context.setOffline(false);
  const paintedBefore = before.counters.terminalCurrentPainted || 0;
  await page.waitForFunction(count => (
    window.__clideckTest.state.ws?.readyState === WebSocket.OPEN
      && (window.__clideckPerfSnapshot().counters.terminalCurrentPainted || 0) > count
  ), paintedBefore, { timeout: 60000 });
  const after = await page.evaluate(() => window.__clideckPerfSnapshot());
  const copies = await markerCount(page, sessionId, marker);
  return {
    markerCopies: copies,
    newWebSocketOpens: (after.counters.healthySocketOpenCount || 0)
      - (before.counters.healthySocketOpenCount || 0),
    webSocketToTerminalMs: after.timings.webSocketToTerminalMs,
  };
}

async function measureStaleOpenRecovery(page) {
  const before = await page.evaluate(() => window.__clideckPerfSnapshot());
  await setPageVisibility(page, 'hidden');
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    // Model a route that still looks OPEN to JavaScript but never delivers the
    // foreground subscription response. The two-second liveness probe must be
    // the only mechanism that replaces it.
    window.__clideckTest.state.ws.onmessage = () => {};
  });
  await setPageVisibility(page, 'visible');
  const opensBefore = before.counters.healthySocketOpenCount || 0;
  const paintedBefore = before.counters.terminalCurrentPainted || 0;
  await page.waitForFunction(({ opens, paints }) => {
    const snapshot = window.__clideckPerfSnapshot();
    return (snapshot.counters.healthySocketOpenCount || 0) > opens
      && (snapshot.counters.terminalCurrentPainted || 0) > paints;
  }, { opens: opensBefore, paints: paintedBefore }, { timeout: 10000 });
  const after = await page.evaluate(() => window.__clideckPerfSnapshot());
  return {
    newWebSocketOpens: (after.counters.healthySocketOpenCount || 0) - opensBefore,
    foregroundToCurrentMs: after.timings.foregroundToCurrentMs,
  };
}

async function measureImageUploads(page, sessionId) {
  return page.evaluate(async id => {
    const protocol = 4;
    const endpoint = `/api/session/${encodeURIComponent(id)}/clipboard-image`;
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const upload = async (name, size, probeControl = false) => {
      const bytes = new Uint8Array(size);
      bytes.set(pngMagic);
      const started = performance.now();
      const pending = fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-CliDeck-Protocol': String(protocol),
        },
        body: new Blob([bytes], { type: 'image/png' }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      let controlLatencyMs = null;
      if (probeControl) {
        const ws = window.__clideckTest.state.ws;
        const controlStarted = performance.now();
        controlLatencyMs = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('control probe timed out')), 5000);
          const listener = event => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type !== 'transport.stats') return;
            clearTimeout(timer);
            ws.removeEventListener('message', listener);
            resolve(performance.now() - controlStarted);
          };
          ws.addEventListener('message', listener);
          ws.send(JSON.stringify({ type: 'transport.stats.request' }));
        });
      }
      const response = await pending;
      const body = await response.json().catch(() => ({}));
      return {
        name,
        requestBytes: size,
        status: response.status,
        committedBytes: Number(body.bytes || 0),
        elapsedMs: performance.now() - started,
        ...(controlLatencyMs === null ? {} : { controlLatencyMs }),
      };
    };
    return [
      await upload('small', pngMagic.length),
      await upload('typical', 2 * 1024 * 1024),
      await upload('maximum', 25 * 1024 * 1024, true),
    ];
  }, sessionId);
}

function assertRecovery(result, {
  mode,
  terminalBytesAtLeast = 0,
  terminalBytesAtMost = Infinity,
  newWebSocketOpens = 0,
} = {}) {
  if (result.mode !== mode
    || result.newWebSocketOpens !== newWebSocketOpens
    || result.terminalBytesReceived < terminalBytesAtLeast
    || result.terminalBytesReceived > terminalBytesAtMost
    || result.terminalSyncs !== 1
    || result.hiddenTerminalBytes !== 0
    || !Number.isFinite(result.parseToPaintMs)
    || result.parseToPaintMs < 0
    || result.maximumRecoveryLongTaskMs > 50) {
    throw new Error(`foreground recovery gate failed: ${JSON.stringify(result)}`);
  }
}

async function main() {
  const box = new Sandbox();
  const producer = new Client();
  const reconnect = new Client(undefined, { perf: true });
  try {
    const port = await box.start();
    producer.port = port;
    reconnect.port = port;
    await producer.connect();
    await producer.waitFor('config');
    const commandId = producer.commandIdFor('shell');
    const sessions = [];
    for (let i = 0; i < 10; i++) {
      producer.send({
        type: 'create',
        commandId,
        name: `transport-${i + 1}`,
        cwd: box.workDir(`transport-${i + 1}`),
        cols: 80,
        rows: 24,
      });
      const created = await producer.waitFor(
        msg => msg.type === 'created' && msg.name === `transport-${i + 1}`,
        { label: `create fixture ${i + 1}` },
      );
      sessions.push(created.id);
      producer.send({
        type: 'input',
        id: created.id,
        data: `printf 'fixture-${i + 1}-%04096d\\n' 0\r`,
      });
      await producer.waitFor(
        msg => msg.type === 'output' && msg.id === created.id && String(msg.data).includes(`fixture-${i + 1}-`),
        { label: `fixture output ${i + 1}` },
      );
    }

    reconnect.autoSubscribe = false;
    await reconnect.connect();
    await reconnect.waitFor(msg => msg.type === 'sessions' && msg.list.length === sessions.length);
    await new Promise(resolve => setTimeout(resolve, 100));
    reconnect.send({ type: 'transport.stats.request' });
    await reconnect.waitFor('transport.stats');
    const output = {
      fixture: { sessions: sessions.length, payloadCharactersPerSession: 4096 },
      accounting: JSON.parse(JSON.stringify(reconnect.accounting)),
    };
    if (output.accounting.snapshotReplayBytes !== 0) throw new Error('idle reconnect unexpectedly received terminal state');
    if (output.accounting.initialControlBytes > 50 * 1024) {
      throw new Error(`idle reconnect used ${output.accounting.initialControlBytes} control bytes`);
    }
    const browserArg = process.argv.find(arg => arg === '--browser' || arg.startsWith('--browser='));
    if (browserArg) {
      const browserName = browserArg.includes('=') ? browserArg.split('=')[1] : 'chromium';
      const engine = { chromium, firefox }[browserName];
      if (!engine) throw new Error(`unsupported browser: ${browserName}`);
      const desktop = process.argv.includes('--desktop');
      const lan = process.argv.includes('--lan');
      if (browserName !== 'chromium' && !lan) {
        throw new Error('the 100 ms/10 Mbps profile requires Chromium; pass --lan for Firefox');
      }
      const executablePath = process.env.CLIDECK_BROWSER_PATH
        || (browserName === 'chromium' && existsSync('/usr/bin/chromium')
          ? '/usr/bin/chromium'
          : undefined);
      const forceDomRenderer = process.argv.includes('--dom-renderer');
      const hardwareGl = process.argv.includes('--hardware-gl');
      const browser = await engine.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        ...(forceDomRenderer ? { args: ['--disable-webgl'] } : {}),
        ...(hardwareGl ? {
          args: ['--enable-gpu', '--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
        } : {}),
      });
      try {
        const context = await browser.newContext({
          viewport: desktop ? { width: 1440, height: 900 } : { width: 412, height: 915 },
          hasTouch: !desktop,
          isMobile: !desktop,
        });
        const page = await context.newPage();
        if (!lan) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 100,
            downloadThroughput: 10 * 1024 * 1024 / 8,
            uploadThroughput: 10 * 1024 * 1024 / 8,
          });
        }
        await page.goto(`http://127.0.0.1:${port}/?clideckPerf=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.__clideckPerfSnapshot
          && window.__clideckPerfSnapshot().counters.renderersCreated === 1);
        await page.waitForTimeout(500);
        output.browser = await page.evaluate(() => window.__clideckPerfSnapshot());
        const rendererProfile = await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const debug = gl?.getExtension('WEBGL_debug_renderer_info');
          return {
            xterm: document.querySelector('.term-wrap.active')?.dataset.renderer || null,
            webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
            webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          };
        });
        output.profile = {
          browser: browserName,
          layout: desktop ? 'desktop' : 'touch',
          network: lan ? 'localhost-lan' : '100ms-10mbps',
          ...rendererProfile,
        };
        const activeSessionId = await page.evaluate(() => window.__clideckTest.state.active);
        const repetitionsArg = process.argv.find(arg => arg.startsWith('--samples='));
        const repetitions = repetitionsArg ? Number(repetitionsArg.split('=')[1]) : 5;
        if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) {
          throw new Error('--samples must be an integer from 1 through 10');
        }
        const foregroundSamples = {
          quietAfterFiveSeconds: [],
          smallDelta: [],
          redrawHeavy: [],
          beyondReplayRing: [],
        };
        for (let sample = 0; sample < repetitions; sample += 1) {
          foregroundSamples.quietAfterFiveSeconds.push(await measureForegroundReturn(
            page, producer, activeSessionId,
            { label: `five-second quiet return sample ${sample + 1}` },
          ));
          foregroundSamples.smallDelta.push(await measureForegroundReturn(
            page, producer, activeSessionId, {
              output: `node -e "process.stdout.write('D'.repeat(32768))"\r`,
              minimumMissedCodeUnits: 32768,
              label: `small delta sample ${sample + 1}`,
            },
          ));
          foregroundSamples.redrawHeavy.push(await measureForegroundReturn(
            page, producer, activeSessionId, {
              output: `node -e "for(let i=0;i<30000;i++)process.stdout.write('\\x1b[H'+String(i).padStart(6,'0')+'\\x1b[K')"\r`,
              minimumMissedCodeUnits: 360000,
              label: `redraw-heavy snapshot sample ${sample + 1}`,
            },
          ));
          foregroundSamples.beyondReplayRing.push(await measureForegroundReturn(
            page, producer, activeSessionId, {
              // Exceed the 2 MiB ring without creating tens of thousands of
              // scrollback rows in the independent headless capture. Repeated
              // cursor-home redraws still advance the transport sequence and
              // evict the browser cursor while leaving a compact snapshot.
              output: `node -e "process.stdout.write('\\x1b[H'.repeat(720000)+'RING_GAP_DONE')"\r`,
              minimumMissedCodeUnits: 2160000,
              activityTimeoutMs: 90000,
              label: `replay-ring gap snapshot sample ${sample + 1}`,
            },
          ));
        }
        output.foregroundSamples = foregroundSamples;
        output.foreground = Object.fromEntries(Object.entries(foregroundSamples)
          .map(([name, samples]) => [name, summarizeRecoverySamples(samples)]));
        if (process.argv.includes('--long-hidden')) {
          output.foregroundSamples.quietAfterFiveMinutes = [await measureForegroundReturn(
            page, producer, activeSessionId,
            { hiddenMs: 5 * 60 * 1000, label: 'five-minute quiet return' },
          )];
          output.foreground.quietAfterFiveMinutes = summarizeRecoverySamples(
            output.foregroundSamples.quietAfterFiveMinutes,
          );
        }
        for (const result of foregroundSamples.quietAfterFiveSeconds) {
          assertRecovery(result, { mode: 'current', terminalBytesAtMost: 0 });
        }
        for (const result of foregroundSamples.smallDelta) {
          assertRecovery(result, {
            mode: 'delta', terminalBytesAtLeast: 4 * 1024, terminalBytesAtMost: 64 * 1024,
          });
        }
        for (const result of foregroundSamples.redrawHeavy) {
          assertRecovery(result, { mode: 'snapshot' });
        }
        for (const result of foregroundSamples.beyondReplayRing) {
          assertRecovery(result, { mode: 'snapshot' });
        }
        if (foregroundSamples.quietAfterFiveMinutes) {
          assertRecovery(foregroundSamples.quietAfterFiveMinutes[0], {
            mode: 'current', terminalBytesAtMost: 0,
          });
        }
        for (const [name, summary] of Object.entries(output.foreground)) {
          const smallGap = name === 'quietAfterFiveSeconds' || name === 'smallDelta';
          const budget = smallGap ? (desktop && lan ? 150 : 300) : 500;
          if (summary.foregroundToCurrentMs.p95 > budget) {
            throw new Error(`${name} p95 exceeded ${budget}ms: ${JSON.stringify(summary)}`);
          }
        }
        output.foregroundTransport = await requestTransportStats(page);
        if (output.foregroundTransport.maximumUnackedBytes > 128 * 1024
          || output.foregroundTransport.invalidAcks !== 0
          || output.foregroundTransport.staleAcks !== 0
          || output.foregroundTransport.forcedResyncs !== 0) {
          throw new Error(`foreground transport gate failed: ${JSON.stringify(output.foregroundTransport)}`);
        }
        output.offlineRecovery = await measureOfflineRecovery(
          page, context, producer, activeSessionId,
        );
        if (output.offlineRecovery.markerCopies !== 1
          || output.offlineRecovery.newWebSocketOpens !== 1
          || output.offlineRecovery.webSocketToTerminalMs > 500) {
          throw new Error(`offline recovery gate failed: ${JSON.stringify(output.offlineRecovery)}`);
        }
        output.staleOpenRecovery = await measureStaleOpenRecovery(page);
        if (output.staleOpenRecovery.newWebSocketOpens !== 1
          || output.staleOpenRecovery.foregroundToCurrentMs < 1900
          || output.staleOpenRecovery.foregroundToCurrentMs > 3500) {
          throw new Error(`stale-open recovery gate failed: ${JSON.stringify(output.staleOpenRecovery)}`);
        }
        output.imageUploads = await measureImageUploads(page, activeSessionId);
        if (output.imageUploads.some(upload => upload.status !== 201
          || upload.requestBytes !== upload.committedBytes)
          || output.imageUploads.at(-1).controlLatencyMs > 500) {
          throw new Error(`image-upload gate failed: ${JSON.stringify(output.imageUploads)}`);
        }
        const critical = output.browser.criticalResources;
        if (critical.terminalUsableAt > 2000) throw new Error(`cold terminal usable at ${critical.terminalUsableAt}ms`);
        // This timing-based set includes optional plugin/provider/WebGL resources
        // that happen to finish before the terminal on faster renderers. Keep a
        // ceiling on the complete startup set without treating those races as
        // transport dependencies.
        if (critical.networkCount > 12) {
          throw new Error(`cold startup exceeded ${critical.networkCount} network requests: ${JSON.stringify(critical.items)}`);
        }
        if (critical.encodedBytes > 350 * 1024) {
          throw new Error(`cold terminal used ${critical.encodedBytes} encoded bytes: ${JSON.stringify(critical.items)}`);
        }
        if (output.browser.timings.webSocketToTerminalMs > 500) {
          throw new Error(`terminal recovery used ${output.browser.timings.webSocketToTerminalMs}ms after WebSocket open`);
        }
        await context.close();
      } finally {
        await browser.close();
      }
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    producer.close();
    reconnect.close();
    await box.cleanup();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
