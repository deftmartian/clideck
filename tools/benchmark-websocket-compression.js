#!/usr/bin/env node
'use strict';

const http = require('http');
const { once } = require('events');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const noContext = {
  threshold: 1024,
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
};

const configurations = [
  { name: 'current-1k', perMessageDeflate: noContext },
  { name: 'disabled', perMessageDeflate: false },
  { name: 'selective', perMessageDeflate: noContext, selective: true },
  { name: 'threshold-8k', perMessageDeflate: { ...noContext, threshold: 8 * 1024 } },
  { name: 'threshold-16k', perMessageDeflate: { ...noContext, threshold: 16 * 1024 } },
  {
    name: 'level1-16k',
    perMessageDeflate: {
      ...noContext,
      threshold: 16 * 1024,
      zlibDeflateOptions: { level: 1 },
    },
  },
];

function payload(kind, size, index) {
  const seed = kind === 'interactive'
    ? `echo-${index}-`
    : `\u001b[2J\u001b[Hrow-${index % 80}-STATE-`;
  return JSON.stringify({
    type: 'output', id: 'session-id', streamId: 17,
    generation: '00000000-0000-4000-8000-000000000000',
    replay: kind === 'recovery', startSeq: 0, endSeq: size,
    data: seed.repeat(Math.ceil(size / seed.length)).slice(0, size),
  });
}

async function runWorkload(configuration, workload) {
  global.gc?.();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: configuration.perMessageDeflate });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
  const [serverSocket] = await Promise.all([
    once(wss, 'connection').then(([socket]) => socket),
    once(client, 'open'),
  ]);
  let received = 0;
  let resolveReceived;
  const complete = new Promise(resolve => { resolveReceived = resolve; });
  client.on('message', raw => {
    JSON.parse(raw);
    received += 1;
    if (received === workload.frames) resolveReceived();
  });
  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  eventLoop.enable();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wireBefore = serverSocket._socket.bytesWritten;
  const started = performance.now();
  for (let index = 0; index < workload.frames; index += 1) {
    const raw = payload(workload.kind, workload.payloadBytes, index);
    const compress = configuration.selective ? workload.kind === 'recovery' : undefined;
    serverSocket.send(raw, compress === undefined ? undefined : { compress });
  }
  await complete;
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const wireBytes = serverSocket._socket.bytesWritten - wireBefore;
  eventLoop.disable();
  client.close();
  await once(client, 'close');
  wss.close();
  server.close();
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    elapsedMs,
    wireBytes,
    cpuMs: (cpu.user + cpu.system) / 1000,
    maximumEventLoopDelayMs: eventLoop.max / 1e6,
    heapDeltaBytes: heapAfter - heapBefore,
  };
}

async function main() {
  const repetitions = 5;
  const workloads = [
    { kind: 'interactive', payloadBytes: 64, frames: 2000 },
    { kind: 'recovery', payloadBytes: 32 * 1024, frames: 256 },
    { kind: 'live-redraw', payloadBytes: 32 * 1024, frames: 256 },
  ];
  const results = [];
  for (const configuration of configurations) {
    const measurements = {};
    for (const workload of workloads) {
      const samples = [];
      for (let repeat = 0; repeat < repetitions; repeat += 1) {
        samples.push(await runWorkload(configuration, workload));
      }
      measurements[workload.kind] = summarize(samples);
    }
    results.push({ name: configuration.name, measurements });
  }
  process.stdout.write(`${JSON.stringify({ runtime: process.version, repetitions, workloads, results }, null, 2)}\n`);
}

function summarize(samples) {
  const result = {};
  for (const key of Object.keys(samples[0])) {
    const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
    result[key] = {
      median: values[Math.floor(values.length / 2)],
      p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
      min: values[0],
      max: values.at(-1),
    };
  }
  return result;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
