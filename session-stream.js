'use strict';

const crypto = require('crypto');
const { splitUtf8Chunks } = require('./replay-ring');
const { normalizeTerminalSize } = require('./terminal-size');

const BATCH_DELAY_MS = 16;
const BATCH_MAX_BYTES = 32 * 1024;
const BACKLOG_HIGH_WATER = 1024 * 1024;
const BACKLOG_RECOVERY = 256 * 1024;
const HEARTBEAT_MS = 25 * 1000;

function bufferStart(session) {
  return session.replayRing.startSeq;
}

function bufferedSlice(session, startSeq, endSeq = session.outputSeq) {
  return session.replayRing.slice(startSeq, endSeq);
}

function createSessionStream({ clients, getSession, snapshot, applyResize }) {
  const resizeOwners = new Map();
  let recoveryTimer = null;
  let heartbeatTimer = null;

  function stateFor(ws) {
    if (!ws._clideckStream) {
      ws._clideckStream = {
        sessionId: null,
        generation: null,
        nextSeq: null,
        phase: 'idle',
        token: null,
        resizeOwner: false,
        maximumBacklog: 0,
        missedPongs: 0,
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
    state.maximumBacklog = Math.max(
      state.maximumBacklog,
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

  function sendSerialized(ws, message, terminalFrame) {
    if (!ready(ws)) return false;
    const state = stateFor(ws);
    const raw = JSON.stringify(message);
    const projected = projectedBacklog(ws, raw);
    noteBacklog(ws, state, projected);
    if (projected > BACKLOG_HIGH_WATER) {
      if (terminalFrame) state.phase = 'backpressured';
      else terminateOverloaded(ws, state);
      return false;
    }
    try {
      ws.send(raw);
      noteBacklog(ws, state);
      return true;
    } catch {
      return false;
    }
  }

  function sendControl(ws, message) {
    return sendSerialized(ws, message, false);
  }

  function sendTerminal(ws, message) {
    const state = stateFor(ws);
    if (state.phase === 'backpressured' || state.phase === 'awaiting-resubscribe') return false;
    return sendSerialized(ws, message, true);
  }

  function releaseResize(ws, id = stateFor(ws).sessionId) {
    if (id && resizeOwners.get(id) === ws) resizeOwners.delete(id);
    stateFor(ws).resizeOwner = false;
  }

  function unsubscribe(ws, requestedId) {
    const state = stateFor(ws);
    if (requestedId && state.sessionId !== requestedId) return false;
    releaseResize(ws, state.sessionId);
    state.sessionId = null;
    state.generation = null;
    state.nextSeq = null;
    state.phase = 'idle';
    state.token = null;
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

  function commitSubscription(ws, id, { claim, cols, rows }) {
    const state = stateFor(ws);
    releaseResize(ws, state.sessionId);
    state.sessionId = id;
    state.generation = null;
    state.nextSeq = null;
    state.phase = 'snapshotting';
    const token = { ws, value: crypto.randomUUID() };
    state.token = token;
    if (claim) {
      claimResize(ws, id);
      applyResize(id, cols, rows);
    }
    return { state, token };
  }

  function sendRingRange(ws, state, session, id, startSeq, endSeq, replay) {
    if (!session.replayRing.contains(startSeq, endSeq)) return false;
    for (const segment of session.replayRing.segments(startSeq, endSeq, BATCH_MAX_BYTES)) {
      const accepted = sendTerminal(ws, {
        type: 'output', id, data: segment.data, replay,
        generation: session.outputGeneration,
        startSeq: segment.startSeq,
        endSeq: segment.endSeq,
      });
      if (!accepted) return false;
      state.nextSeq = segment.endSeq;
    }
    return true;
  }

  function waitForDrain(ws, stillCurrent, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise(resolve => {
      const poll = () => {
        if (!stillCurrent() || !ready(ws)) return resolve(false);
        if (Number(ws.bufferedAmount || 0) <= BACKLOG_RECOVERY) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  async function sendSnapshotFrames(ws, message, stillCurrent) {
    const chunks = splitUtf8Chunks(message.data, BATCH_MAX_BYTES);
    if (chunks.length <= 1) return sendTerminal(ws, message);
    for (let part = 0; part < chunks.length; part += 1) {
      if (!sendTerminal(ws, {
        ...message,
        data: chunks[part].data,
        part,
        parts: chunks.length,
      })) return false;
      if (Number(ws.bufferedAmount || 0) > BACKLOG_RECOVERY
        && !await waitForDrain(ws, stillCurrent)) return false;
    }
    return true;
  }

  async function sendSnapshot(ws, state, token, id, reason) {
    const session = getSession(id);
    if (!session) return false;
    let captured;
    try {
      captured = await snapshot(id, session.outputSeq);
    } catch (error) {
      if (isCurrent(state, token, id)) {
        state.phase = 'awaiting-resubscribe';
        sendControl(ws, { type: 'session.resyncRequired', id, reason: error.message || 'snapshot-failed' });
      }
      return false;
    }
    if (!isCurrent(state, token, id)) return false;
    session.outputGeneration = session.outputGeneration || crypto.randomUUID();
    if (!await sendSnapshotFrames(ws, {
      type: 'session.snapshot',
      id,
      generation: session.outputGeneration,
      atSeq: captured.atSeq,
      data: captured.data,
      cols: captured.cols,
      rows: captured.rows,
    }, () => isCurrent(state, token, id))) return false;
    state.generation = session.outputGeneration;
    state.nextSeq = captured.atSeq;
    const current = session.outputSeq;
    if (!session.replayRing.contains(state.nextSeq, current)) {
      state.phase = 'awaiting-resubscribe';
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'snapshot-catchup-gap' });
      return false;
    }
    if (!sendRingRange(ws, state, session, id, state.nextSeq, current, true)) return false;
    state.phase = 'streaming';
    return sendControl(ws, {
      type: 'session.subscribed', id, generation: session.outputGeneration,
      atSeq: state.nextSeq, mode: 'snapshot', ...(reason ? { reason } : {}),
    });
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
    const replay = message.replay === 'resume' ? 'resume' : 'snapshot';
    const cursor = message.cursor;
    if (replay !== 'resume'
      || !cursor
      || cursor.generation !== session.outputGeneration
      || !Number.isSafeInteger(cursor.seq)) {
      return sendSnapshot(ws, state, token, id, replay === 'resume' ? 'generation-changed' : undefined);
    }

    const endSeq = session.outputSeq;
    if (!session.replayRing.contains(cursor.seq, endSeq)) {
      return sendSnapshot(ws, state, token, id, 'buffer-gap');
    }
    if (!isCurrent(state, token, id)) return false;
    state.generation = session.outputGeneration;
    state.nextSeq = cursor.seq;
    state.phase = 'streaming';
    if (!sendRingRange(ws, state, session, id, cursor.seq, endSeq, true)) return false;
    return sendControl(ws, {
      type: 'session.subscribed', id, generation: session.outputGeneration,
      atSeq: state.nextSeq, mode: cursor.seq === endSeq ? 'current' : 'delta',
    });
  }

  function requestResubscribe(ws, state, id, reason) {
    state.phase = 'awaiting-resubscribe';
    sendControl(ws, { type: 'session.resyncRequired', id, reason });
  }

  function deliverOutput(id, message) {
    for (const ws of clients) {
      const state = stateFor(ws);
      if (state.sessionId !== id || state.phase !== 'streaming') continue;
      if (state.generation !== message.generation || !Number.isSafeInteger(state.nextSeq)) {
        requestResubscribe(ws, state, id, 'generation-changed');
        continue;
      }
      if (state.nextSeq >= message.endSeq) continue;
      if (state.nextSeq < message.startSeq) {
        requestResubscribe(ws, state, id, 'buffer-gap');
        continue;
      }
      const data = message.data.slice(state.nextSeq - message.startSeq);
      if (!data) continue;
      const startSeq = state.nextSeq;
      if (sendTerminal(ws, { ...message, data, startSeq })) state.nextSeq = message.endSeq;
    }
  }

  function flush(session, id) {
    const batch = session._networkBatch;
    if (!batch) return;
    clearTimeout(batch.timer);
    session._networkBatch = null;
    deliverOutput(id, {
      type: 'output', id, data: batch.data,
      generation: session.outputGeneration,
      startSeq: batch.startSeq, endSeq: batch.endSeq,
    });
  }

  function queueSegment(session, id, segment, startSeq, endSeq) {
    let batch = session._networkBatch;
    if (!batch || batch.endSeq !== startSeq || batch.bytes + segment.bytes > BATCH_MAX_BYTES) {
      if (batch) flush(session, id);
      batch = session._networkBatch = {
        data: '', bytes: 0, startSeq, endSeq: startSeq, timer: null,
      };
      batch.timer = setTimeout(() => flush(session, id), BATCH_DELAY_MS);
      batch.timer.unref?.();
    }
    batch.data += segment.data;
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
        for (const ws of clients) {
          const state = stateFor(ws);
          if (state.phase !== 'backpressured' || !ready(ws)
            || Number(ws.bufferedAmount || 0) > BACKLOG_RECOVERY) continue;
          state.phase = 'awaiting-resubscribe';
          sendControl(ws, { type: 'session.resyncRequired', id: state.sessionId, reason: 'backpressure' });
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
    claimResize,
    clearSession,
    queueOutput,
    register,
    resize,
    sendControl,
    stats: ws => {
      const state = stateFor(ws);
      return { maximumBacklog: state.maximumBacklog, phase: state.phase };
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

module.exports = {
  BACKLOG_HIGH_WATER,
  BACKLOG_RECOVERY,
  BATCH_DELAY_MS,
  BATCH_MAX_BYTES,
  HEARTBEAT_MS,
  bufferedSlice,
  createSessionStream,
};
