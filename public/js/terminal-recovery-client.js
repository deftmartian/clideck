import {
  commitTerminalReplay,
  noteTerminalLiveOutput,
  planTerminalReplay,
} from './terminal-recovery.js';

export function createTerminalRecoveryClient({ requestResync }) {
  const warnedSessions = new Set();

  function requestResyncOnce(sessionId, recovery) {
    if (
      (recovery.status !== 'gap' && recovery.status !== 'legacy-gap')
      || warnedSessions.has(sessionId)
    ) return;
    warnedSessions.add(sessionId);
    requestResync(sessionId, recovery.status);
  }

  function handleOutput(ws, entry, message) {
    let output = message.data;
    if (message.replay && entry) {
      const recovery = planTerminalReplay(entry, output, message);
      output = recovery.data;
      commitTerminalReplay(entry, recovery);
      requestResyncOnce(message.id, recovery);
    }
    if (entry?.term && output && !entry.queue(output, !!message.replay)) {
      entry.writeChunk(output, !!message.replay);
    }
    if (entry && !message.replay) noteTerminalLiveOutput(entry, message.data, message);
    return output;
  }

  function handleSnapshot(entry, message) {
    if (!entry?.term) return false;
    let snapshot = message;
    if (Number.isSafeInteger(message.parts) && message.parts > 1) {
      if (message.part === 0) {
        entry.pendingSnapshot = {
          generation: message.generation,
          atSeq: message.atSeq,
          cols: message.cols,
          rows: message.rows,
          parts: message.parts,
          data: [],
        };
      }
      const pending = entry.pendingSnapshot;
      if (!pending
        || pending.generation !== message.generation
        || pending.atSeq !== message.atSeq
        || pending.parts !== message.parts
        || message.part !== pending.data.length) {
        entry.pendingSnapshot = null;
        requestResync(message.id, 'snapshot-part-gap');
        return false;
      }
      pending.data.push(String(message.data || ''));
      if (pending.data.length < pending.parts) return false;
      snapshot = { ...pending, data: pending.data.join('') };
      entry.pendingSnapshot = null;
    } else {
      entry.pendingSnapshot = null;
    }
    warnedSessions.delete(message.id);
    try { entry.term.reset(); } catch {}
    entry.replayInitialized = true;
    entry.outputGeneration = snapshot.generation;
    entry.lastOutputSeq = snapshot.atSeq;
    const data = String(snapshot.data || '');
    if (data && !entry.queue(data, true)) entry.writeChunk(data, true);
    return true;
  }

  function handleSubscribed(entry, message) {
    if (!entry) return;
    warnedSessions.delete(message.id);
    entry.replayInitialized = true;
    entry.outputGeneration = message.generation;
    entry.lastOutputSeq = message.atSeq;
  }

  return { handleOutput, handleSnapshot, handleSubscribed };
}
