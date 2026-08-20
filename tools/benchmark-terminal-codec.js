#!/usr/bin/env node
'use strict';

const { performance } = require('perf_hooks');
const {
  decodeTerminalFrame,
  encodeTerminalFrame,
} = require('./terminal-frame-candidate');

function runJson(data, iterations) {
  let bytes = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const raw = JSON.stringify({
      type: 'output', id: 'session-id', streamId: 17,
      generation: '00000000-0000-4000-8000-000000000000',
      replay: true, startSeq: 0, endSeq: data.length, data,
    });
    bytes += Buffer.byteLength(raw);
    const decoded = JSON.parse(raw);
    if (decoded.data.length !== data.length) throw new Error('JSON benchmark corrupted data');
  }
  return { ms: performance.now() - started, bytes };
}

function runBinary(data, iterations) {
  let bytes = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const raw = encodeTerminalFrame({
      kind: 'replay', streamId: 17, startSeq: 0, endSeq: data.length, data,
    });
    bytes += raw.byteLength;
    const decoded = decodeTerminalFrame(raw);
    if (decoded.data.length !== data.length) throw new Error('binary benchmark corrupted data');
  }
  return { ms: performance.now() - started, bytes };
}

function summarize(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    median: ordered[Math.floor(ordered.length / 2)],
    p95: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)],
    min: ordered[0],
    max: ordered.at(-1),
  };
}

function measure(name, bytes, iterations, repetitions = 5) {
  const data = `${'\u001b[38;5;44mREDRAW\u001b[0m '.repeat(Math.ceil(bytes / 24))}`.slice(0, bytes);
  runJson(data, Math.min(iterations, 20));
  runBinary(data, Math.min(iterations, 20));
  const samples = [];
  for (let repeat = 0; repeat < repetitions; repeat += 1) {
    const first = repeat % 2 ? runBinary : runJson;
    const second = repeat % 2 ? runJson : runBinary;
    const firstResult = first(data, iterations);
    const secondResult = second(data, iterations);
    const json = first === runJson ? firstResult : secondResult;
    const binary = first === runBinary ? firstResult : secondResult;
    samples.push({
      jsonMs: json.ms,
      binaryMs: binary.ms,
      overheadImprovementPercent: (json.ms - binary.ms) / json.ms * 100,
      binaryRegressionPercent: (binary.ms - json.ms) / json.ms * 100,
      jsonBytes: json.bytes,
      binaryBytes: binary.bytes,
    });
  }
  return {
    name,
    payloadBytes: Buffer.byteLength(data),
    iterations,
    repetitions,
    frames: { json: iterations, binary: iterations },
    jsonMs: summarize(samples.map(sample => sample.jsonMs)),
    binaryMs: summarize(samples.map(sample => sample.binaryMs)),
    overheadImprovementPercent: summarize(
      samples.map(sample => sample.overheadImprovementPercent),
    ),
    binaryRegressionPercent: summarize(
      samples.map(sample => sample.binaryRegressionPercent),
    ),
    wireBytes: {
      json: samples[0].jsonBytes,
      binary: samples[0].binaryBytes,
    },
    wireSavingsPercent: (
      (samples[0].jsonBytes - samples[0].binaryBytes) / samples[0].jsonBytes * 100
    ),
  };
}

const interactive = measure('interactive', 64, 20000);
const recovery = measure('recovery', 32 * 1024, 2000);
const gate = {
  recoveryOverheadImprovementAtLeast10Percent:
    recovery.overheadImprovementPercent.median >= 10,
  interactiveRegressionAtMost5Percent: interactive.binaryRegressionPercent.median <= 5,
  frameCountNotIncreased: recovery.frames.binary <= recovery.frames.json,
};
gate.accepted = Object.values(gate).every(Boolean);

process.stdout.write(`${JSON.stringify({
  runtime: process.version,
  interactive,
  recovery,
  gate,
}, null, 2)}\n`);
if (!gate.accepted) process.exitCode = 1;
