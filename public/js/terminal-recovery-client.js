import {
  commitTerminalHistory,
  commitTerminalReplay,
  noteTerminalLiveOutput,
  planTerminalHistory,
  planTerminalReplay,
} from './terminal-recovery.js';

export function createTerminalRecoveryClient({ requireReload }) {
  const warnedSessions = new Set();

  function requireReloadOnce(ws, sessionId, message, recovery) {
    if (
      (recovery.status !== 'gap' && recovery.status !== 'legacy-gap')
      || warnedSessions.has(sessionId)
    ) return;
    warnedSessions.add(sessionId);
    requireReload(ws, message);
  }

  function handleOutput(ws, entry, message) {
    let output = message.data;
    if (message.replay && entry) {
      const recovery = planTerminalReplay(entry, output, message);
      output = recovery.data;
      commitTerminalReplay(entry, recovery);
      requireReloadOnce(
        ws,
        message.id,
        'Terminal output changed beyond the recovery window. Reload to rebuild its recent view.',
        recovery,
      );
    }
    if (entry && output && !entry.queue(output, !!message.replay)) {
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
    requireReloadOnce(
      ws,
      message.id,
      'Terminal history changed beyond the recovery window. Reload to rebuild its recent view.',
      recovery,
    );
  }

  return { handleHistory, handleOutput };
}
