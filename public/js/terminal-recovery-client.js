import {
  commitTerminalHistory,
  commitTerminalReplay,
  noteTerminalLiveOutput,
  planTerminalHistory,
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

  function handleHistory(ws, entry, message, historyText) {
    const recovery = entry
      ? planTerminalHistory(entry, historyText, message)
      : { status: 'current', data: '' };
    if (entry) commitTerminalHistory(entry, recovery);
    if (entry && recovery.data && !entry.queue(recovery.data, true)) {
      entry.writeChunk(recovery.data, true);
    }
    requestResyncOnce(message.id, recovery);
  }

  function handleSnapshot(entry, message) {
    if (!entry?.term) return;
    warnedSessions.delete(message.id);
    try { entry.term.reset(); } catch {}
    entry.replayInitialized = true;
    entry.outputGeneration = message.generation;
    entry.lastOutputSeq = message.atSeq;
    const data = String(message.data || '');
    if (data && !entry.queue(data, true)) entry.writeChunk(data, true);
  }

  function handleSubscribed(entry, message) {
    if (!entry) return;
    warnedSessions.delete(message.id);
    entry.replayInitialized = true;
    entry.outputGeneration = message.generation;
    entry.lastOutputSeq = message.atSeq;
  }

  return { handleHistory, handleOutput, handleSnapshot, handleSubscribed };
}
