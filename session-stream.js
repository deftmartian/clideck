'use strict';

const crypto = require('crypto');
const { splitUtf8Chunks } = require('./replay-ring');
const { normalizeTerminalSize } = require('./terminal-size');

const BATCH_DELAY_MS = 16;
const BATCH_MAX_BYTES = 32 * 1024;
const APPLICATION_CREDIT_BYTES = 128 * 1024;
const FAST_DELTA_BYTES = 64 * 1024;
const MAX_DELTA_BYTES = 256 * 1024;
const BACKLOG_HIGH_WATER = 1024 * 1024;
const BACKLOG_RECOVERY = 256 * 1024;
const ACK_STALL_MS = 30 * 1000;
const HEARTBEAT_MS = 25 * 1000;
const RECOVERY_BUDGET_MS = 300;
const CONSUMPTION_SAFETY_FACTOR = 2;
const LARGE_SNAPSHOT_RATIO = 0.5;
const CONTROL_COMPRESSION_MIN_BYTES = 16 * 1024;

function bufferedSlice(session, startSeq, endSeq = session.outputSeq) {
  return session.replayRing.slice(startSeq, endSeq);
}

function createMetrics() {
  return {
    maximumBacklog: 0,
    maximumUnackedBytes: 0,
    controlFrames: 0,
    controlBytes: 0,
    liveFrames: 0,
    liveBytes: 0,
    replayFrames: 0,
    replayBytes: 0,
    snapshotFrames: 0,
    snapshotBytes: 0,
    syncCurrent: 0,
    syncDelta: 0,
    syncSnapshot: 0,
    snapshotCaptureMs: 0,
    backpressurePauses: 0,
    staleAcks: 0,
    invalidAcks: 0,
    forcedResyncs: 0,
  };
}

function createSessionStream({ clients, getSession, snapshot, applyResize }) {
  const resizeOwners = new Map();
  let recoveryTimer = null;
  let heartbeatTimer = null;
  let nextStreamId = 1;

  function stateFor(ws) {
    if (!ws._clideckStream) {
      ws._clideckStream = {
        sessionId: null,
        generation: null,
        sentSeq: null,
        nextSeq: null,
        ackedSeq: null,
        phase: 'idle',
        token: null,
        streamId: 0,
        resizeOwner: false,
        inFlight: [],
        inFlightBytes: 0,
        lastAckAt: Date.now(),
        consumptionBytesPerMs: null,
        syncTargetSeq: null,
        snapshot: null,
        missedPongs: 0,
        metrics: createMetrics(),
      };
    }
    return ws._clideckStream;
  }

  function ready(ws) {
    return ws?.readyState === 1;
  }

  function projectedBacklog(ws, raw) {
    return Number(ws.bufferedAmount || 0) + Buffer.byteLength(raw);
  }

  function noteBacklog(ws, state, projected = Number(ws.bufferedAmount || 0)) {
    state.metrics.maximumBacklog = Math.max(
      state.metrics.maximumBacklog,
      Number(ws.bufferedAmount || 0),
      projected,
    );
  }

  function terminateOverloaded(ws, state) {
    state.phase = 'awaiting-resubscribe';
    try {
      if (typeof ws.close === 'function') ws.close(1013, 'control backlog');
      else ws.terminate?.();
    } catch {
      try { ws.terminate?.(); } catch {}
    }
  }

  function accountFrame(state, kind, bytes) {
    if (kind === 'control') {
      state.metrics.controlFrames += 1;
      state.metrics.controlBytes += bytes;
    } else if (kind === 'live') {
      state.metrics.liveFrames += 1;
      state.metrics.liveBytes += bytes;
    } else if (kind === 'replay') {
      state.metrics.replayFrames += 1;
      state.metrics.replayBytes += bytes;
    } else if (kind === 'snapshot') {
      state.metrics.snapshotFrames += 1;
      state.metrics.snapshotBytes += bytes;
    }
  }

  function sendRaw(ws, raw, kind) {
    if (!ready(ws)) return false;
    const state = stateFor(ws);
    const bytes = Buffer.byteLength(raw);
    const projected = projectedBacklog(ws, raw);
    noteBacklog(ws, state, projected);
    if (projected > BACKLOG_HIGH_WATER) {
      if (kind !== 'control') {
        if (state.phase !== 'network-backpressured') state.metrics.backpressurePauses += 1;
        state.phase = 'network-backpressured';
      } else {
        terminateOverloaded(ws, state);
      }
      return false;
    }
    try {
      ws.send(raw, { compress: shouldCompressFrame(kind, bytes) });
      accountFrame(state, kind, bytes);
      noteBacklog(ws, state);
      return true;
    } catch {
      return false;
    }
  }

  function sendSerialized(ws, message, kind = 'control') {
    return sendRaw(ws, JSON.stringify(message), kind);
  }

  function sendControl(ws, message) {
    return sendSerialized(ws, message, 'control');
  }

  function releaseResize(ws, id = stateFor(ws).sessionId) {
    if (id && resizeOwners.get(id) === ws) resizeOwners.delete(id);
    stateFor(ws).resizeOwner = false;
  }

  function resetDelivery(state) {
    state.generation = null;
    state.sentSeq = null;
    state.nextSeq = null;
    state.ackedSeq = null;
    state.inFlight = [];
    state.inFlightBytes = 0;
    state.syncTargetSeq = null;
    state.snapshot = null;
  }

  function unsubscribe(ws, requestedId) {
    const state = stateFor(ws);
    if (requestedId && state.sessionId !== requestedId) return false;
    releaseResize(ws, state.sessionId);
    state.sessionId = null;
    state.phase = 'idle';
    state.token = null;
    state.streamId = 0;
    resetDelivery(state);
    return true;
  }

  function claimResize(ws, id) {
    const state = stateFor(ws);
    if (!id || state.sessionId !== id || !getSession(id)) return false;
    const previous = resizeOwners.get(id);
    if (previous && previous !== ws) stateFor(previous).resizeOwner = false;
    resizeOwners.set(id, ws);
    state.resizeOwner = true;
    return true;
  }

  function resize(ws, message) {
    const id = String(message.id || '');
    if (resizeOwners.get(id) !== ws) return false;
    const size = normalizeTerminalSize(message.cols, message.rows);
    if (!size.ok) return false;
    applyResize(id, size.cols, size.rows);
    return true;
  }

  function isCurrent(state, token, id) {
    return state.token === token && state.sessionId === id && ready(token.ws);
  }

  function allocateStreamId() {
    const id = nextStreamId;
    nextStreamId = nextStreamId >= 0xffffffff ? 1 : nextStreamId + 1;
    return id;
  }

  function commitSubscription(ws, id, { claim, cols, rows }) {
    const state = stateFor(ws);
    releaseResize(ws, state.sessionId);
    state.sessionId = id;
    state.phase = 'planning';
    state.token = { ws, value: crypto.randomUUID() };
    state.streamId = allocateStreamId();
    state.lastAckAt = Date.now();
    resetDelivery(state);
    if (claim) {
      claimResize(ws, id);
      applyResize(id, cols, rows);
    }
    return { state, token: state.token };
  }

  function noteInFlight(state, frame) {
    state.inFlight.push(frame);
    state.inFlightBytes += frame.bytes;
    state.metrics.maximumUnackedBytes = Math.max(
      state.metrics.maximumUnackedBytes,
      state.inFlightBytes,
    );
  }

  function availableCredit(state) {
    return Math.max(0, APPLICATION_CREDIT_BYTES - state.inFlightBytes);
  }

  function requestResubscribe(ws, state, id, reason) {
    if (state.phase === 'awaiting-resubscribe') return false;
    state.phase = 'awaiting-resubscribe';
    state.metrics.forcedResyncs += 1;
    sendControl(ws, { type: 'session.resyncRequired', id, reason });
    return false;
  }

  function announceSync(ws, state, session, id, mode, targetSeq, detail = {}) {
    state.syncTargetSeq = targetSeq;
    state.metrics[`sync${mode[0].toUpperCase()}${mode.slice(1)}`] += 1;
    sendControl(ws, {
      type: 'session.sync',
      id,
      streamId: state.streamId,
      generation: session.outputGeneration,
      mode,
      targetSeq,
      ...detail,
    });
    return sendControl(ws, {
      type: 'session.subscribed',
      id,
      streamId: state.streamId,
      generation: session.outputGeneration,
      atSeq: targetSeq,
      mode,
      ...(detail.reason ? { reason: detail.reason } : {}),
    });
  }

  function sendRangeFrame(ws, state, id, segment, replay) {
    if (segment.bytes > availableCredit(state)) return false;
    const kind = replay ? 'replay' : 'live';
    const accepted = sendSerialized(ws, {
      type: 'output',
      id,
      streamId: state.streamId,
      data: segment.data,
      replay,
      generation: state.generation,
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
    }, kind);
    if (!accepted) return false;
    noteInFlight(state, {
      kind: 'range',
      bytes: segment.bytes,
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
      sentAt: Date.now(),
    });
    state.sentSeq = segment.endSeq;
    state.nextSeq = state.sentSeq;
    return true;
  }

  function pumpRange(ws, state, session, endSeq = session.outputSeq, replay = false) {
    if (!ready(ws) || state.phase !== 'streaming') return false;
    if (!Number.isSafeInteger(state.sentSeq) || state.sentSeq >= endSeq) return true;
    if (!session.replayRing.contains(state.sentSeq, endSeq)) {
      return requestResubscribe(ws, state, state.sessionId, 'buffer-gap');
    }
    while (state.sentSeq < endSeq) {
      const credit = availableCredit(state);
      if (credit < 1) return true;
      const maxBytes = Math.min(BATCH_MAX_BYTES, credit);
      const rangeEnd = Number.isSafeInteger(state.syncTargetSeq)
        && state.sentSeq < state.syncTargetSeq
        ? Math.min(endSeq, state.syncTargetSeq)
        : endSeq;
      const iterator = session.replayRing.segments(state.sentSeq, rangeEnd, maxBytes);
      const next = iterator.next();
      if (next.done) break;
      const isReplay = replay || state.sentSeq < state.syncTargetSeq;
      if (!sendRangeFrame(ws, state, state.sessionId, next.value, isReplay)) return false;
    }
    return true;
  }

  function pumpSnapshot(ws, state) {
    const pending = state.snapshot;
    if (!pending || state.phase !== 'snapshotting') return false;
    while (pending.nextPart < pending.parts.length) {
      const chunk = pending.parts[pending.nextPart];
      if (chunk.bytes > availableCredit(state)) return true;
      const part = pending.nextPart;
      const accepted = sendSerialized(ws, {
        type: 'session.snapshot',
        id: state.sessionId,
        streamId: state.streamId,
        generation: state.generation,
        atSeq: pending.atSeq,
        cols: pending.cols,
        rows: pending.rows,
        data: chunk.data,
        part,
        parts: pending.parts.length,
      }, 'snapshot');
      if (!accepted) return false;
      noteInFlight(state, {
        kind: 'snapshot',
        bytes: chunk.bytes,
        part,
        sentAt: Date.now(),
      });
      pending.nextPart += 1;
    }
    return true;
  }

  function beginCurrent(ws, state, session, id, targetSeq) {
    state.generation = session.outputGeneration;
    state.sentSeq = targetSeq;
    state.nextSeq = targetSeq;
    state.ackedSeq = targetSeq;
    state.phase = 'streaming';
    announceSync(ws, state, session, id, 'current', targetSeq, { deltaBytes: 0 });
    return true;
  }

  function beginDelta(ws, state, session, id, cursorSeq, targetSeq, deltaBytes) {
    state.generation = session.outputGeneration;
    state.sentSeq = cursorSeq;
    state.nextSeq = cursorSeq;
    state.ackedSeq = cursorSeq;
    state.phase = 'streaming';
    announceSync(ws, state, session, id, 'delta', targetSeq, { deltaBytes });
    return pumpRange(ws, state, session, session.outputSeq, true);
  }

  function beginSnapshot(ws, state, session, id, captured, reason, snapshotBytes, deltaBytes = null) {
    const parts = splitUtf8Chunks(captured.data, BATCH_MAX_BYTES);
    if (!parts.length) parts.push({ data: '', bytes: 0 });
    state.generation = session.outputGeneration;
    state.sentSeq = captured.atSeq;
    state.nextSeq = captured.atSeq;
    state.ackedSeq = null;
    state.phase = 'snapshotting';
    state.snapshot = {
      parts,
      nextPart: 0,
      ackedPart: -1,
      atSeq: captured.atSeq,
      cols: captured.cols,
      rows: captured.rows,
    };
    announceSync(ws, state, session, id, 'snapshot', captured.atSeq, {
      reason,
      snapshotBytes,
      cols: captured.cols,
      rows: captured.rows,
      ...(Number.isFinite(deltaBytes) ? { deltaBytes } : {}),
    });
    return pumpSnapshot(ws, state);
  }

  async function captureSnapshot(ws, state, token, id, atSeq, reason, deltaBytes = null) {
    const started = Date.now();
    let captured;
    try {
      captured = await snapshot(id, atSeq);
    } catch (error) {
      if (isCurrent(state, token, id)) {
        requestResubscribe(ws, state, id, error.message || 'snapshot-failed');
      }
      return null;
    }
    const captureMs = Math.max(0, Date.now() - started);
    state.metrics.snapshotCaptureMs += captureMs;
    if (!isCurrent(state, token, id)) return null;
    const session = getSession(id);
    if (!session || captured.atSeq !== atSeq) {
      requestResubscribe(ws, state, id, 'snapshot-sequence-mismatch');
      return null;
    }
    const snapshotBytes = Buffer.byteLength(captured.data || '');
    return { captured, session, reason, snapshotBytes, deltaBytes, captureMs };
  }

  async function subscribe(ws, message) {
    const id = String(message.id || '');
    const session = getSession(id);
    const size = normalizeTerminalSize(message.cols, message.rows);
    if (!size.ok) {
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'invalid-size' });
      return false;
    }
    if (!session) {
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'session-missing' });
      return false;
    }

    const { state, token } = commitSubscription(ws, id, {
      claim: !!message.claimResize,
      cols: size.cols,
      rows: size.rows,
    });
    session.outputGeneration = session.outputGeneration || crypto.randomUUID();
    const targetSeq = session.outputSeq;
    const cursor = message.cursor;
    const wantsAuto = message.strategy === 'auto' || message.replay === 'resume';
    const validCursor = wantsAuto
      && cursor
      && cursor.generation === session.outputGeneration
      && Number.isSafeInteger(cursor.seq)
      && session.replayRing.contains(cursor.seq, targetSeq);

    if (!validCursor) {
      const reason = wantsAuto
        ? (cursor?.generation !== session.outputGeneration ? 'generation-changed' : 'buffer-gap')
        : undefined;
      const result = await captureSnapshot(ws, state, token, id, targetSeq, reason);
      if (!result) return false;
      return beginSnapshot(
        ws, state, result.session, id, result.captured,
        result.reason, result.snapshotBytes,
      );
    }
    if (cursor.seq === targetSeq) return beginCurrent(ws, state, session, id, targetSeq);

    const deltaBytes = session.replayRing.byteLengthBetween(cursor.seq, targetSeq);
    if (deltaBytes <= FAST_DELTA_BYTES) {
      return beginDelta(ws, state, session, id, cursor.seq, targetSeq, deltaBytes);
    }

    const result = await captureSnapshot(
      ws, state, token, id, targetSeq,
      deltaBytes > MAX_DELTA_BYTES ? 'large-delta' : 'snapshot-cheaper',
      deltaBytes,
    );
    if (!result) return false;
    let snapshotWins = deltaBytes > MAX_DELTA_BYTES
      ? result.snapshotBytes < deltaBytes
      : result.snapshotBytes <= deltaBytes * 0.75;
    if (state.consumptionBytesPerMs > 0) {
      // Per-frame ACK samples can overstate sustained drain rate because later
      // credit-window turns also pay scheduling and network latency. Apply a
      // conservative safety factor before using the EWMA for a larger gap.
      const deltaDrainMs = deltaBytes / state.consumptionBytesPerMs
        * CONSUMPTION_SAFETY_FACTOR;
      const snapshotDrainMs = result.captureMs
        + result.snapshotBytes / state.consumptionBytesPerMs
          * CONSUMPTION_SAFETY_FACTOR;
      snapshotWins = deltaDrainMs > RECOVERY_BUDGET_MS
        ? snapshotDrainMs <= deltaDrainMs * 0.75
        : deltaBytes > MAX_DELTA_BYTES
          && result.snapshotBytes <= deltaBytes * LARGE_SNAPSHOT_RATIO;
    }
    if (snapshotWins) {
      return beginSnapshot(
        ws, state, result.session, id, result.captured,
        result.reason, result.snapshotBytes, deltaBytes,
      );
    }
    if (!result.session.replayRing.contains(cursor.seq, targetSeq)) {
      return beginSnapshot(
        ws, state, result.session, id, result.captured,
        'buffer-gap', result.snapshotBytes, deltaBytes,
      );
    }
    return beginDelta(ws, state, result.session, id, cursor.seq, targetSeq, deltaBytes);
  }

  function freeRangeCredit(state, seq) {
    let bytes = 0;
    let oldest = null;
    const retained = [];
    for (const frame of state.inFlight) {
      if (frame.kind === 'range' && frame.endSeq <= seq) {
        bytes += frame.bytes;
        oldest = oldest === null ? frame.sentAt : Math.min(oldest, frame.sentAt);
      } else {
        retained.push(frame);
      }
    }
    state.inFlight = retained;
    state.inFlightBytes = Math.max(0, state.inFlightBytes - bytes);
    return { bytes, oldest };
  }

  function freeSnapshotCredit(state, part) {
    let bytes = 0;
    let oldest = null;
    const retained = [];
    for (const frame of state.inFlight) {
      if (frame.kind === 'snapshot' && frame.part <= part) {
        bytes += frame.bytes;
        oldest = oldest === null ? frame.sentAt : Math.min(oldest, frame.sentAt);
      } else {
        retained.push(frame);
      }
    }
    state.inFlight = retained;
    state.inFlightBytes = Math.max(0, state.inFlightBytes - bytes);
    return { bytes, oldest };
  }

  function noteConsumption(state, bytes, oldest) {
    state.lastAckAt = Date.now();
    if (!bytes || oldest === null) return;
    const elapsed = Math.max(1, state.lastAckAt - oldest);
    const rate = bytes / elapsed;
    state.consumptionBytesPerMs = state.consumptionBytesPerMs === null
      ? rate
      : state.consumptionBytesPerMs * 0.8 + rate * 0.2;
  }

  function acknowledge(ws, message) {
    const state = stateFor(ws);
    if (Number(message.streamId) !== state.streamId
      || String(message.id || '') !== state.sessionId
      || String(message.generation || '') !== state.generation) {
      state.metrics.staleAcks += 1;
      return false;
    }
    const session = getSession(state.sessionId);
    if (!session) return false;

    if (state.phase === 'snapshotting') {
      const part = Number(message.part);
      const pending = state.snapshot;
      if (!pending || !Number.isSafeInteger(part)
        || part < pending.ackedPart || part >= pending.nextPart) {
        state.metrics.invalidAcks += 1;
        return false;
      }
      pending.ackedPart = part;
      const released = freeSnapshotCredit(state, part);
      noteConsumption(state, released.bytes, released.oldest);
      if (part === pending.parts.length - 1) {
        state.ackedSeq = pending.atSeq;
        state.snapshot = null;
        state.phase = 'streaming';
        return pumpRange(ws, state, session, session.outputSeq, false);
      }
      return pumpSnapshot(ws, state);
    }

    if (state.phase !== 'streaming') return false;
    const seq = Number(message.seq);
    if (!Number.isSafeInteger(seq) || seq < state.ackedSeq || seq > state.sentSeq) {
      state.metrics.invalidAcks += 1;
      if (Number.isSafeInteger(seq) && seq > state.sentSeq) {
        requestResubscribe(ws, state, state.sessionId, 'invalid-ack');
      }
      return false;
    }
    if (seq === state.ackedSeq) return true;
    if (!state.inFlight.some(frame => frame.kind === 'range' && frame.endSeq === seq)) {
      state.metrics.invalidAcks += 1;
      return false;
    }
    const released = freeRangeCredit(state, seq);
    state.ackedSeq = seq;
    noteConsumption(state, released.bytes, released.oldest);
    return pumpRange(ws, state, session, session.outputSeq, false);
  }

  function deliverOutput(id) {
    const session = getSession(id);
    if (!session) return;
    for (const ws of clients) {
      const state = stateFor(ws);
      if (state.sessionId !== id || state.phase !== 'streaming') continue;
      if (state.generation !== session.outputGeneration || !Number.isSafeInteger(state.sentSeq)) {
        requestResubscribe(ws, state, id, 'generation-changed');
        continue;
      }
      pumpRange(ws, state, session, session.outputSeq, false);
    }
  }

  function flush(session, id) {
    const batch = session._networkBatch;
    if (!batch) return;
    clearTimeout(batch.timer);
    session._networkBatch = null;
    deliverOutput(id);
  }

  function queueSegment(session, id, segment, startSeq, endSeq) {
    let batch = session._networkBatch;
    if (!batch || batch.endSeq !== startSeq || batch.bytes + segment.bytes > BATCH_MAX_BYTES) {
      if (batch) flush(session, id);
      batch = session._networkBatch = {
        bytes: 0, startSeq, endSeq: startSeq, timer: null,
      };
      batch.timer = setTimeout(() => flush(session, id), BATCH_DELAY_MS);
      batch.timer.unref?.();
    }
    batch.bytes += segment.bytes;
    batch.endSeq = endSeq;
    if (batch.bytes >= BATCH_MAX_BYTES) flush(session, id);
  }

  function queueOutput(id, data, startSeq, endSeq) {
    const session = getSession(id);
    if (!session) return;
    let segmentStart = startSeq;
    for (const segment of splitUtf8Chunks(data, BATCH_MAX_BYTES)) {
      const segmentEnd = segmentStart + segment.data.length;
      queueSegment(session, id, segment, segmentStart, segmentEnd);
      segmentStart = segmentEnd;
    }
    if (segmentStart !== endSeq) throw new RangeError('output sequence does not match data');
  }

  function clearSession(id) {
    const session = getSession(id);
    if (session?._networkBatch) flush(session, id);
    resizeOwners.delete(id);
    for (const ws of clients) {
      if (stateFor(ws).sessionId === id) unsubscribe(ws, id);
    }
  }

  function register(ws) {
    clients.add(ws);
    const state = stateFor(ws);
    state.missedPongs = 0;
    ws.on('pong', () => { state.missedPongs = 0; });
  }

  function unregister(ws) {
    unsubscribe(ws);
    clients.delete(ws);
    delete ws._clideckStream;
  }

  function start() {
    if (!recoveryTimer) {
      recoveryTimer = setInterval(() => {
        const now = Date.now();
        for (const ws of clients) {
          const state = stateFor(ws);
          if (state.phase === 'network-backpressured'
            && ready(ws)
            && Number(ws.bufferedAmount || 0) <= BACKLOG_RECOVERY) {
            requestResubscribe(ws, state, state.sessionId, 'backpressure');
            continue;
          }
          if ((state.phase === 'streaming' || state.phase === 'snapshotting')
            && state.inFlightBytes > 0
            && now - state.lastAckAt >= ACK_STALL_MS) {
            requestResubscribe(ws, state, state.sessionId, 'ack-stall');
          }
        }
      }, 100);
      recoveryTimer.unref?.();
    }
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        for (const ws of clients) {
          const state = stateFor(ws);
          if (!ready(ws)) continue;
          if (state.missedPongs >= 2) {
            try { ws.terminate(); } catch {}
            continue;
          }
          state.missedPongs += 1;
          try { ws.ping(); } catch {}
        }
      }, HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    }
  }

  function stop() {
    clearInterval(recoveryTimer);
    clearInterval(heartbeatTimer);
    recoveryTimer = null;
    heartbeatTimer = null;
  }

  return {
    acknowledge,
    claimResize,
    clearSession,
    queueOutput,
    register,
    resize,
    sendControl,
    stats: ws => {
      const state = stateFor(ws);
      return {
        ...state.metrics,
        currentUnackedBytes: state.inFlightBytes,
        consumptionBytesPerSecond: Number.isFinite(state.consumptionBytesPerMs)
          ? Math.round(state.consumptionBytesPerMs * 1000)
          : 0,
      };
    },
    start,
    stop,
    subscribe,
    unsubscribe,
    unregister,
    _stateFor: stateFor,
    _resizeOwner: id => resizeOwners.get(id),
    _flush: id => { const session = getSession(id); if (session) flush(session, id); },
  };
}

function shouldCompressFrame(kind, bytes) {
  return kind === 'replay'
    || kind === 'snapshot'
    || (kind === 'control' && bytes >= CONTROL_COMPRESSION_MIN_BYTES);
}

module.exports = {
  ACK_STALL_MS,
  APPLICATION_CREDIT_BYTES,
  BACKLOG_HIGH_WATER,
  BACKLOG_RECOVERY,
  BATCH_DELAY_MS,
  BATCH_MAX_BYTES,
  CONTROL_COMPRESSION_MIN_BYTES,
  FAST_DELTA_BYTES,
  HEARTBEAT_MS,
  MAX_DELTA_BYTES,
  RECOVERY_BUDGET_MS,
  bufferedSlice,
  createSessionStream,
  shouldCompressFrame,
};
