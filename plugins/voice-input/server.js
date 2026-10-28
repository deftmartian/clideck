const { createTranscriber } = require('./backend');
const MAX_BYTES = 16000 * 2 * 600;

exports.activate = (api, { backend = createTranscriber(api) } = {}) => {
  let active;
  let deadline;
  let busy = false;
  const matches = data => active && data?.streamId === active.envelope.streamId && data?.sessionId === active.envelope.sessionId;
  const cancel = () => { clearTimeout(deadline); active?.controller.abort(new Error('Recording cancelled.')); active = null; };
  const touch = () => { clearTimeout(deadline); deadline = setTimeout(() => {
    if (active) api.sendToClients('error', {...active.envelope,body:'Recording expired. Start a new recording.'});
    cancel();
  }, 90_000); deadline.unref?.(); };
  api.onClientMessage('prepare', async (data, context) => {
    if (typeof data?.streamId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(data.streamId) || typeof data.sessionId !== 'string') return;
    const envelope = { streamId: data.streamId, sessionId: data.sessionId };
    if (active || busy) { api.sendToClients('error', { ...envelope, body: 'Another recording is active.' }); return; }
    const entry = { envelope, context, chunks: [], bytes: 0, controller: new AbortController() };
    active = entry; touch();
    try {
      const session = await api.getSession(data.sessionId);
      if (active !== entry) return;
      if (!session || session.live === false) throw new Error('Open a live terminal first.');
      await backend.ready();
      if (active !== entry) return;
      api.sendToClients('status', { ...envelope, state: 'ready', body: 'Ready to record.' });
    } catch (error) { if (active === entry) { api.sendToClients('error', { ...envelope, body: error.message }); cancel(); } }
  });
  api.onClientMessage('audio', data => {
    if (!matches(data) || busy) return;
    if (typeof data.audio !== 'string' || data.audio.length > 48000 || data.audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio)) return;
    const buffer = Buffer.from(data.audio, 'base64');
    if (buffer.length % 2) return;
    const part = buffer.subarray(0, Math.max(0, MAX_BYTES - active.bytes));
    if (part.length) { active.chunks.push(part); active.bytes += part.length; }
    touch();
    if (active.bytes >= MAX_BYTES && !active.limitReached) {
      active.limitReached = true; api.sendToClients('limit', active.envelope);
    }
  });
  api.onClientMessage('finish', async data => {
    if (!matches(data) || busy) return;
    const entry = active; busy = true; clearTimeout(deadline);
    try {
      if (entry.bytes < 12800) throw new Error('Recording is too short.');
      const pcm = Buffer.concat(entry.chunks, entry.bytes); entry.chunks = [];
      const result = await backend.transcribe(pcm, {signal:entry.controller.signal});
      if (active !== entry) return;
      api.sendToClients('transcript', { ...entry.envelope, revision: 1, text: result.text || '' });
      api.sendToClients('finished', entry.envelope);
    } catch (error) {
      if (active === entry) api.sendToClients('error', { ...entry.envelope, body: error.message });
    } finally { busy = false; if (active === entry) cancel(); }
  });
  api.onClientMessage('cancel', data => { if (matches(data)) cancel(); });
  api.onShutdown(cancel);
};
exports.MAX_BYTES = MAX_BYTES;
