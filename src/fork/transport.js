const { randomUUID } = require('crypto');
const { ServerCapture } = require('./server-capture');
const { ReplayRing } = require('./replay-ring');
const { createSessionStream } = require('./session-stream');

const PROTOCOL = 'fork-v6';

class ForkTransport {
  constructor(server) {
    this.server = server;
    this.clients = new Set();
    this.stream = createSessionStream({
      clients: this.clients,
      batchDelayMs: 0,
      getSession: id => server.sessions.get(id),
      snapshot: async (id, atSeq) => server.sessions.get(id)?.capture.snapshot(1000, atSeq),
      applyResize: (id, cols, rows) => {
        const session = server.sessions.get(id);
        if (!session || session.closed) return;
        if (session.cols === cols && session.rows === rows) return;
        session.resize(cols, rows);
        session.capture.resize(cols, rows);
        server.persistence.touch(id, { cols, rows });
      },
    });
  }

  attach(session) {
    session.outputGeneration = randomUUID();
    session.outputSeq = 0;
    session.replayRing = new ReplayRing(2 * 1024 * 1024);
    session.capture = new ServerCapture({
      cols: Math.min(500, Math.max(20, session.cols)),
      rows: Math.min(300, Math.max(5, session.rows)),
      onReply: data => { if (!session.closed) session.terminal?.write(data); },
      onPause: () => session.terminal?.pause?.(),
      onResume: () => session.terminal?.resume?.(),
    });
  }

  output(session, data) {
    const start = session.outputSeq;
    session.outputSeq += data.length;
    session.replayRing.append(data, start);
    session.capture.write(data, session.outputSeq).catch(() => {
      // A corrupt capture cannot be used as a recovery snapshot.
      for (const socket of this.clients) {
        if (socket._clideckStream?.sessionId === session.id) socket.close(1011, 'terminal capture failed');
      }
    });
    this.stream.queueOutput(session.id, data, start, session.outputSeq);
  }

  register(socket) { this.clients.add(socket); this.stream.register(socket); }
  unregister(socket) { this.stream.unregister(socket); this.clients.delete(socket); }
  detach(session) { this.stream.clearSession(session.id); session.capture?.dispose(); }
  start() { this.stream.start(); }
  stop() { this.stream.stop(); }

  send(socket, event) {
    if (socket.forkTransport) return this.stream.sendControl(socket, event);
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  }
  replayHistory(socket, id) {
    if (socket.forkTransport) return;
    const data = this.server.persistence.historyTail(id);
    if (data) this.send(socket, {type:'output',sessionId:id,data,replay:true});
  }
  inventory(socket) {
    if (socket.forkTransport) this.send(socket, {type:'sessions.inventory',ids:this.server.persistence.list().map(entry=>entry.id)});
    else this.send(socket, {type:'transcript.cache',cache:this.server.transcriptStore.getCache()});
  }
  async selectedHistory(socket, {sessionId,requestId}) {
    const entry = this.server.persistence.get(sessionId);
    if (!entry || this.server.sessions.has(sessionId)) return;
    // One history capture per socket; a newer selection supersedes the old request.
    socket.historyRequest = requestId;
    if (socket.historyLoading) { socket.nextHistory = {sessionId,requestId}; return; }
    socket.historyLoading = true;
    const capture = new ServerCapture({
      cols: Math.min(500, Math.max(20, Number.isSafeInteger(entry.cols) ? entry.cols : 80)),
      rows: Math.min(300, Math.max(5, Number.isSafeInteger(entry.rows) ? entry.rows : 24)),
    });
    try {
      const history = this.server.persistence.historyTail(sessionId);
      await capture.write(history,history.length);
      const snapshot = await capture.snapshot(300);
      if (socket.historyRequest === requestId) this.send(socket,{
        type:'session.history',id:sessionId,requestId,data:snapshot.data,
        ...this.server.historyRetentionField(sessionId),
      });
    } finally {
      capture.dispose(); socket.historyLoading = false;
      const next = socket.nextHistory; socket.nextHistory = null;
      if (next && socket.readyState === 1) await this.selectedHistory(socket,next);
    }
  }
  control(socket, message) {
    if (!socket.forkTransport) return false;
    const id = String(message.id || message.sessionId || '');
    if (message.type === 'transcript.cache.get') this.send(socket,{type:'transcript.cache',cache:this.server.transcriptStore.getCache()});
    else if (message.type === 'session.history.get') this.selectedHistory(socket,message).catch(()=>socket.close(1011,'history failed'));
    else if (message.type === 'session.subscribe') {
      this.stream.subscribe(socket, { ...message, id }).catch(() => socket.close(1011, 'subscribe failed'));
    } else if (message.type === 'session.unsubscribe') this.stream.unsubscribe(socket);
    else if (message.type === 'session.ack') this.stream.acknowledge(socket, { ...message, id });
    else if (message.type === 'resize') this.stream.resize(socket, { ...message, id });
    else if (message.type === 'session.claimResize') this.stream.claimResize(socket, id);
    else return false;
    return true;
  }
}

module.exports = { ForkTransport, PROTOCOL };
