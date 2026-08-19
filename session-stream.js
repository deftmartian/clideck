'use strict';

const crypto = require('crypto');
const { normalizeTerminalSize } = require('./terminal-size');

const BATCH_DELAY_MS = 16;
const BATCH_MAX_BYTES = 32 * 1024;
const BACKLOG_HIGH_WATER = 1024 * 1024;
const BACKLOG_RECOVERY = 256 * 1024;
const HEARTBEAT_MS = 25 * 1000;

function bufferStart(session) {
  return session.outputSeq - session.chunksSize;
}

function bufferedSlice(session, startSeq, endSeq = session.outputSeq) {
  const start = bufferStart(session);
  if (!Number.isSafeInteger(startSeq) || startSeq < start || startSeq > endSeq || endSeq > session.outputSeq) {
    return null;
  }
  const data = session.chunks.join('');
  return data.slice(startSeq - start, endSeq - start);
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
        recovering: false,
        paused: false,
        resyncPending: false,
        token: null,
        maximumBacklog: 0,
        missedPongs: 0,
      };
    }
    return ws._clideckStream;
  }

  function ready(ws) {
    return ws?.readyState === 1;
  }

  function noteBacklog(ws, state) {
    state.maximumBacklog = Math.max(state.maximumBacklog, Number(ws.bufferedAmount || 0));
  }

  function sendControl(ws, message) {
    if (!ready(ws)) return false;
    try {
      ws.send(JSON.stringify(message));
      noteBacklog(ws, stateFor(ws));
      return true;
    } catch {
      return false;
    }
  }

  function pauseForBackpressure(ws, state) {
    state.paused = true;
    state.resyncPending = true;
    state.recovering = true;
  }

  function sendTerminal(ws, message) {
    if (!ready(ws)) return false;
    const state = stateFor(ws);
    noteBacklog(ws, state);
    if (state.paused || ws.bufferedAmount > BACKLOG_HIGH_WATER) {
      pauseForBackpressure(ws, state);
      return false;
    }
    try {
      ws.send(JSON.stringify(message));
      noteBacklog(ws, state);
      if (ws.bufferedAmount > BACKLOG_HIGH_WATER) pauseForBackpressure(ws, state);
      return !state.paused;
    } catch {
      return false;
    }
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
    state.recovering = false;
    state.paused = false;
    state.resyncPending = false;
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

  async function sendSnapshot(ws, state, token, id, reason) {
    const session = getSession(id);
    if (!session) return false;
    let captured;
    try {
      captured = await snapshot(id);
    } catch (error) {
      if (isCurrent(state, token, id)) {
        sendControl(ws, { type: 'session.resyncRequired', id, reason: error.message || 'snapshot-failed' });
      }
      return false;
    }
    if (!isCurrent(state, token, id)) return false;
    session.outputGeneration = session.outputGeneration || crypto.randomUUID();
    sendTerminal(ws, {
      type: 'session.snapshot',
      id,
      generation: session.outputGeneration,
      atSeq: captured.atSeq,
      data: captured.data,
      cols: captured.cols,
      rows: captured.rows,
    });
    if (state.paused) return false;
    state.generation = session.outputGeneration;
    state.nextSeq = captured.atSeq;
    const current = session.outputSeq;
    const catchup = bufferedSlice(session, state.nextSeq, current);
    if (catchup === null) {
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'snapshot-catchup-gap' });
      state.recovering = true;
      return false;
    }
    if (catchup) {
      sendTerminal(ws, {
        type: 'output', id, data: catchup, replay: true,
        generation: session.outputGeneration, startSeq: state.nextSeq, endSeq: current,
      });
      if (state.paused) return false;
      state.nextSeq = current;
    }
    state.recovering = false;
    sendControl(ws, {
      type: 'session.subscribed', id, generation: session.outputGeneration,
      atSeq: state.nextSeq, mode: 'snapshot', ...(reason ? { reason } : {}),
    });
    return true;
  }

  async function subscribe(ws, message) {
    const id = String(message.id || '');
    const session = getSession(id);
    const state = stateFor(ws);
    const size = normalizeTerminalSize(message.cols, message.rows);
    if (!size.ok) {
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'invalid-size' });
      return false;
    }
    if (!session) {
      sendControl(ws, { type: 'session.resyncRequired', id, reason: 'session-missing' });
      return false;
    }
    unsubscribe(ws);
    state.sessionId = id;
    state.recovering = true;
    state.paused = false;
    state.resyncPending = false;
    const token = { ws, value: crypto.randomUUID() };
    state.token = token;

    if (message.claimResize) {
      claimResize(ws, id);
      applyResize(id, size.cols, size.rows);
    }

    const replay = message.replay === 'resume' ? 'resume' : 'snapshot';
    const cursor = message.cursor;
    if (replay !== 'resume'
      || !cursor
      || cursor.generation !== session.outputGeneration
      || !Number.isSafeInteger(cursor.seq)) {
      return sendSnapshot(ws, state, token, id, replay === 'resume' ? 'generation-changed' : undefined);
    }

    const endSeq = session.outputSeq;
    const delta = bufferedSlice(session, cursor.seq, endSeq);
    if (delta === null) return sendSnapshot(ws, state, token, id, 'buffer-gap');
    if (!isCurrent(state, token, id)) return false;
    state.generation = session.outputGeneration;
    state.nextSeq = cursor.seq;
    if (delta) {
      sendTerminal(ws, {
        type: 'output', id, data: delta, replay: true,
        generation: session.outputGeneration, startSeq: cursor.seq, endSeq,
      });
      if (state.paused) return false;
      state.nextSeq = endSeq;
    }
    state.recovering = false;
    sendControl(ws, {
      type: 'session.subscribed', id, generation: session.outputGeneration,
      atSeq: state.nextSeq, mode: delta ? 'delta' : 'current',
    });
    return true;
  }

  function deliverOutput(id, message) {
    for (const ws of clients) {
      const state = stateFor(ws);
      if (state.sessionId !== id || state.recovering || state.paused) continue;
      if (state.generation !== message.generation || !Number.isSafeInteger(state.nextSeq)) {
        state.recovering = true;
        sendControl(ws, { type: 'session.resyncRequired', id, reason: 'generation-changed' });
        continue;
      }
      if (state.nextSeq >= message.endSeq) continue;
      if (state.nextSeq < message.startSeq) {
        state.recovering = true;
        sendControl(ws, { type: 'session.resyncRequired', id, reason: 'buffer-gap' });
        continue;
      }
      const data = message.data.slice(state.nextSeq - message.startSeq);
      const startSeq = state.nextSeq;
      if (!data) continue;
      sendTerminal(ws, { ...message, data, startSeq });
      if (!state.paused) state.nextSeq = message.endSeq;
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

  function queueOutput(id, data, startSeq, endSeq) {
    const session = getSession(id);
    if (!session) return;
    let batch = session._networkBatch;
    if (!batch || batch.endSeq !== startSeq) {
      if (batch) flush(session, id);
      batch = session._networkBatch = { data: '', bytes: 0, startSeq, endSeq: startSeq, timer: null };
      batch.timer = setTimeout(() => flush(session, id), BATCH_DELAY_MS);
    }
    batch.data += data;
    batch.bytes += Buffer.byteLength(data);
    batch.endSeq = endSeq;
    if (batch.bytes >= BATCH_MAX_BYTES) flush(session, id);
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
          if (!state.resyncPending || !ready(ws) || ws.bufferedAmount > BACKLOG_RECOVERY) continue;
          state.paused = false;
          state.resyncPending = false;
          state.recovering = true;
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
      return {
        maximumBacklog: state.maximumBacklog,
        paused: state.paused,
        resyncPending: state.resyncPending,
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

module.exports = {
  BACKLOG_HIGH_WATER,
  BACKLOG_RECOVERY,
  BATCH_DELAY_MS,
  BATCH_MAX_BYTES,
  HEARTBEAT_MS,
  bufferedSlice,
  createSessionStream,
};
