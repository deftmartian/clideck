import { countPerf, maxPerf, notePerf } from './perf.js';

function byteLength(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function sequenceMetadata(message, data) {
  const generation = String(message?.generation || '');
  const startSeq = Number(message?.startSeq);
  const endSeq = Number(message?.endSeq);
  if (!generation
    || !Number.isSafeInteger(startSeq)
    || !Number.isSafeInteger(endSeq)
    || startSeq < 0
    || endSeq < startSeq
    || endSeq - startSeq !== String(data || '').length) return null;
  return { generation, startSeq, endSeq };
}

export function createTerminalRecoveryClient({ requestResync, sendAck, onCurrent }) {
  const warnedSessions = new Set();

  function requestResyncOnce(sessionId, reason) {
    if (warnedSessions.has(sessionId)) return;
    warnedSessions.add(sessionId);
    requestResync(sessionId, reason);
  }

  function flushAck(entry) {
    if (!entry?.pendingAck) return;
    const payload = entry.pendingAck;
    entry.pendingAck = null;
    if (entry.ackRaf) cancelAnimationFrame(entry.ackRaf);
    entry.ackRaf = null;
    sendAck(payload);
  }

  function scheduleAck(entry, payload, immediate = false) {
    entry.pendingAck = payload;
    if (immediate) {
      flushAck(entry);
      return;
    }
    if (entry.ackRaf) return;
    entry.ackRaf = requestAnimationFrame(() => {
      entry.ackRaf = null;
      flushAck(entry);
    });
  }

  function maybeCurrent(entry) {
    if (!entry
      || entry.syncCurrent
      || !Number.isSafeInteger(entry.syncTargetSeq)
      || !Number.isSafeInteger(entry.appliedSeq)
      || entry.appliedSeq < entry.syncTargetSeq) return false;
    entry.syncCurrent = true;
    notePerf('terminalParseComplete', {
      id: entry.id,
      mode: entry.syncMode,
      streamId: entry.streamId,
    });
    onCurrent?.(entry);
    return true;
  }

  function noteQueued(entry, data) {
    const bytes = byteLength(data);
    entry.unparsedBytes = (entry.unparsedBytes || 0) + bytes;
    entry.writeQueueDepth = (entry.writeQueueDepth || 0) + 1;
    countPerf('terminalBytesReceived', bytes);
    maxPerf('maximumUnparsedBytes', entry.unparsedBytes);
    maxPerf('maximumWriteQueueDepth', entry.writeQueueDepth);
    return bytes;
  }

  function write(entry, data, replay, callback) {
    const bytes = noteQueued(entry, data);
    const complete = () => {
      entry.unparsedBytes = Math.max(0, (entry.unparsedBytes || 0) - bytes);
      entry.writeQueueDepth = Math.max(0, (entry.writeQueueDepth || 0) - 1);
      countPerf('terminalBytesApplied', bytes);
      callback();
    };
    if (!data) {
      complete();
      return;
    }
    if (!entry.queue(data, replay, complete)) entry.writeChunk(data, replay, complete);
  }

  function handleSync(entry, message) {
    if (!entry || !Number.isSafeInteger(message.streamId)
      || !Number.isSafeInteger(message.targetSeq)) return false;
    warnedSessions.delete(message.id);
    entry.id = message.id;
    entry.streamId = message.streamId;
    entry.outputGeneration = message.generation;
    entry.syncTargetSeq = message.targetSeq;
    entry.syncMode = message.mode;
    entry.syncCurrent = false;
    entry.pendingSnapshot = null;
    countPerf(`terminalSyncMode.${message.mode || 'unknown'}`);
    if (Number.isFinite(message.deltaBytes)) countPerf('deltaBytes', message.deltaBytes);
    if (Number.isFinite(message.snapshotBytes)) countPerf('snapshotBytes', message.snapshotBytes);
    notePerf('terminalSyncStarted', {
      id: message.id,
      mode: message.mode,
      streamId: message.streamId,
    });
    return maybeCurrent(entry);
  }

  function handleOutput(ws, entry, message) {
    if (!entry?.term || message.streamId !== entry.streamId) return '';
    const incoming = String(message.data || '');
    const sequence = sequenceMetadata(message, incoming);
    if (!sequence || sequence.generation !== entry.outputGeneration) {
      requestResyncOnce(message.id, 'output-metadata-gap');
      return '';
    }
    const cursor = Number.isSafeInteger(entry.receivedSeq)
      ? entry.receivedSeq
      : (Number.isSafeInteger(entry.appliedSeq) ? entry.appliedSeq : sequence.startSeq);
    if (cursor < sequence.startSeq || cursor > sequence.endSeq) {
      requestResyncOnce(message.id, 'output-sequence-gap');
      return '';
    }
    if (cursor === sequence.endSeq) return '';
    const output = incoming.slice(cursor - sequence.startSeq);
    entry.receivedSeq = sequence.endSeq;
    const streamId = entry.streamId;
    write(entry, output, !!message.replay, () => {
      if (entry.streamId !== streamId || entry.outputGeneration !== sequence.generation) return;
      entry.appliedSeq = sequence.endSeq;
      entry.lastOutputSeq = sequence.endSeq;
      entry.replayInitialized = true;
      const reachesTarget = Number.isSafeInteger(entry.syncTargetSeq)
        && entry.appliedSeq >= entry.syncTargetSeq;
      scheduleAck(entry, {
        type: 'output.ack',
        streamId,
        id: message.id,
        generation: sequence.generation,
        seq: sequence.endSeq,
      }, reachesTarget);
      maybeCurrent(entry);
    });
    return output;
  }

  function handleSnapshot(entry, message) {
    if (!entry?.term || message.streamId !== entry.streamId
      || message.generation !== entry.outputGeneration) return false;
    const part = Number(message.part);
    const parts = Number(message.parts);
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(parts)
      || parts < 1 || part < 0 || part >= parts) {
      requestResyncOnce(message.id, 'snapshot-part-gap');
      return false;
    }
    if (part === 0) {
      try { entry.term.reset(); } catch {}
      entry.pendingSnapshot = {
        streamId: message.streamId,
        generation: message.generation,
        atSeq: message.atSeq,
        parts,
        nextPart: 0,
        appliedPart: -1,
      };
      entry.receivedSeq = null;
      entry.appliedSeq = null;
      entry.lastOutputSeq = null;
    }
    const pending = entry.pendingSnapshot;
    if (!pending
      || pending.streamId !== message.streamId
      || pending.generation !== message.generation
      || pending.atSeq !== message.atSeq
      || pending.parts !== parts
      || part !== pending.nextPart) {
      entry.pendingSnapshot = null;
      requestResyncOnce(message.id, 'snapshot-part-gap');
      return false;
    }
    pending.nextPart += 1;
    const data = String(message.data || '');
    const streamId = entry.streamId;
    write(entry, data, true, () => {
      if (entry.streamId !== streamId || entry.pendingSnapshot !== pending) return;
      pending.appliedPart = part;
      const final = part === parts - 1;
      if (final) {
        entry.receivedSeq = message.atSeq;
        entry.appliedSeq = message.atSeq;
        entry.lastOutputSeq = message.atSeq;
        entry.replayInitialized = true;
      }
      scheduleAck(entry, {
        type: 'output.ack',
        streamId,
        id: message.id,
        generation: message.generation,
        seq: final ? message.atSeq : null,
        part,
      }, final);
      if (final) {
        entry.pendingSnapshot = null;
        notePerf('terminalSnapshotComplete', { id: message.id, streamId });
        maybeCurrent(entry);
      }
    });
    return part === parts - 1;
  }

  function handleSubscribed(entry, message) {
    if (!entry || message.streamId !== entry.streamId) return false;
    warnedSessions.delete(message.id);
    return maybeCurrent(entry);
  }

  return { handleOutput, handleSnapshot, handleSubscribed, handleSync };
}
