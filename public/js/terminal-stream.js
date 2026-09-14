import { resetTerminalView } from './terminal-reset.js';
let client;
let cursor = null;
let streamId = null;
let pending = false;
let probe;
let epoch = 0;
let snapshotPart = 0;
let receivedSeq = 0;
let historyRequest;
let pendingWrites = 0;

export function configureTerminalStream(config) { client = config; }

export function subscribeTerminal(options = {}) {
  if (!client) return;
  client.term.write('', () => beginSubscription(options));
}

function beginSubscription({ snapshot = false } = {}) {
  if (!client || !client.store.connected || document.visibilityState === 'hidden') return;
  const session = client.store.active();
  if (!session) return;
  if (session.live === false) {
    suspendTerminal();
    historyRequest = crypto.randomUUID();
    client.send({ type: 'session.history.get', sessionId: session.id, requestId: historyRequest });
    return;
  }
  const validCursor = !snapshot && cursor?.id === session.id && cursor.complete ? cursor : null;
  pending = true;
  epoch++;
  client.send({ type: 'session.subscribe', id: session.id, claimResize: true, strategy: snapshot ? 'snapshot' : 'auto',
    cols: Math.min(500, Math.max(20, client.term.cols)),
    rows: Math.min(300, Math.max(5, client.term.rows)),
    ...(validCursor && { cursor: { generation: validCursor.generation, seq: validCursor.seq } }),
  });
  clearTimeout(probe);
  probe = setTimeout(() => { if (pending) client.reconnect?.(); }, 2000);
}

export function suspendTerminal() {
  clearTimeout(probe);
  pending = false;
  const id = client?.store.activeId || cursor?.id;
  if (id) client.send({ type: 'session.unsubscribe', id });
}

export function resetTerminalStream() {
  clearTimeout(probe); cursor = null; streamId = null; pending = false; epoch++;
}

export function handleTerminalFrame(event) {
  if (!client) return false;
  if (event.type === 'session.history') {
    if (event.id === client.store.activeId && event.requestId === historyRequest && client.store.active()?.live === false) {
      resetTerminalView(client.term); client.store.active().outputBuf = '';
      client.store.applyEvent({ type: 'output', sessionId: event.id, data: event.data, replay: true });
    }
    return true;
  }
  if (event.type === 'session.resyncRequired') {
    if (event.id === client.store.activeId) subscribeTerminal({ snapshot: true });
    return true;
  }
  if (!['session.sync', 'session.subscribed', 'session.snapshot', 'output'].includes(event.type)) return false;
  // Unsequenced dormant history still follows upstream's read-only replay path.
  if (event.type === 'output' && event.streamId === undefined) return false;
  if (event.id !== client.store.activeId || document.visibilityState === 'hidden') return true;
  const session = client.store.active();
  if (event.type === 'session.sync') {
    pending = false; clearTimeout(probe); epoch++;
    streamId = event.streamId;
    if (event.mode === 'snapshot') {
      resetTerminalView(client.term); session.outputBuf = ''; snapshotPart = 0;
      cursor = { id: event.id, generation: event.generation, seq: event.targetSeq, complete: false };
    } else if (event.mode === 'current') cursor = { id: event.id, generation: event.generation, seq: event.targetSeq, complete: true };
    else if (!cursor || cursor.id !== event.id || cursor.generation !== event.generation) {
      subscribeTerminal({ snapshot: true });
    }
    receivedSeq = cursor?.seq || 0;
    return true;
  }
  if (event.type === 'session.subscribed') return true;
  if (pending || event.streamId !== streamId || event.generation !== cursor?.generation) return true;
  const snapshot = event.type === 'session.snapshot';
  if ((snapshot && event.part !== snapshotPart) || (!snapshot && event.startSeq !== receivedSeq)) {
    subscribeTerminal({ snapshot: true }); return true;
  }
  if (snapshot) snapshotPart++;
  // Track received sequence separately while xterm drains queued writes. ACKs
  // advance only in the parser callback, never when the WebSocket delivers bytes.
  const parsedSeq = snapshot ? event.atSeq : event.endSeq;
  receivedSeq = parsedSeq;
  const activeEpoch = epoch;
  pendingWrites++;
  client.store.applyEvent({ type: 'output', sessionId: event.id, data: event.data,
    replay: snapshot || event.replay, parsed: () => {
      pendingWrites = Math.max(0, pendingWrites - 1);
      if (epoch !== activeEpoch || client.store.activeId !== event.id) return;
      cursor.seq = parsedSeq;
      if (!snapshot || event.part === event.parts - 1) cursor.complete = true;
      client.send({ type: 'session.ack', id: event.id, streamId: event.streamId,
        generation: event.generation, ...(snapshot ? { part: event.part } : { seq: event.endSeq }) });
    } });
  return true;
}

export function resumeTerminal() {
  subscribeTerminal();
}

export function disconnectTerminalStream() {
  clearTimeout(probe); pending = false; epoch++; streamId = null;
  // Bytes still in xterm's parser queue are not a usable reconnect cursor.
  if (pendingWrites && cursor) cursor.complete = false;
}
