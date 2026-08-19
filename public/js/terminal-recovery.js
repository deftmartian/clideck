function sequenceMetadata(meta, data) {
  const generation = String(meta?.generation || '');
  const startSeq = Number(meta?.startSeq);
  const endSeq = Number(meta?.endSeq);
  if (
    !generation
    || !Number.isSafeInteger(startSeq)
    || !Number.isSafeInteger(endSeq)
    || startSeq < 0
    || endSeq < startSeq
    || endSeq - startSeq !== String(data || '').length
  ) {
    return null;
  }
  return { generation, startSeq, endSeq };
}

export function planTerminalReplay(entry, replay, meta = {}) {
  const incoming = String(replay || '');
  const sequence = sequenceMetadata(meta, incoming);
  const initialized = !!entry?.replayInitialized;

  if (!sequence) {
    return initialized
      ? { status: 'legacy-gap', data: '' }
      : { status: 'initial', data: incoming };
  }

  const next = {
    nextGeneration: sequence.generation,
    nextSeq: sequence.endSeq,
  };
  if (!initialized) return { status: 'initial', data: incoming, ...next };

  const cursor = Number(entry?.lastOutputSeq);
  if (
    entry?.outputGeneration !== sequence.generation
    || !Number.isSafeInteger(cursor)
    || cursor < sequence.startSeq
    || cursor > sequence.endSeq
  ) {
    return { status: 'gap', data: '', ...next };
  }
  if (cursor === sequence.endSeq) return { status: 'current', data: '', ...next };
  return {
    status: 'delta',
    data: incoming.slice(cursor - sequence.startSeq),
    ...next,
  };
}

export function commitTerminalReplay(entry, plan) {
  if (!entry || !plan) return;
  entry.replayInitialized = true;
  if (plan.nextGeneration) entry.outputGeneration = plan.nextGeneration;
  if (Number.isSafeInteger(plan.nextSeq)) entry.lastOutputSeq = plan.nextSeq;
}

export function noteTerminalLiveOutput(entry, data, meta = {}) {
  if (!entry) return;
  entry.replayInitialized = true;
  const sequence = sequenceMetadata(meta, data);
  if (!sequence) return;
  entry.outputGeneration = sequence.generation;
  entry.lastOutputSeq = sequence.endSeq;
}
