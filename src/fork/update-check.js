'use strict';
const fs = require('node:fs');
const { join } = require('node:path');
const WebSocket = require('ws');

function validateNative(registry, ids) {
  for (const id of ids) {
    const entry = registry.find(item => item.id === id);
    if (!entry) throw Error(`Live session ${id} is not saved yet.`);
    if (!['codex', 'grok'].includes(entry.provider)) throw Error(`Automatic resume is not verified for ${entry.provider}: ${entry.name}`);
    if (!entry.resumeHandle || !entry.transcriptPath || !fs.existsSync(entry.transcriptPath)) throw Error(`Missing native resume metadata: ${entry.name}`);
    if (entry.provider === 'codex') {
      const fd = fs.openSync(entry.transcriptPath, 'r'), bytes = Buffer.alloc(65536);
      let length; try { length = fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
      const first = JSON.parse(bytes.subarray(0, length).toString().split('\n')[0]);
      if (first.type !== 'session_meta' || first.payload.id !== entry.resumeHandle || first.payload.cwd !== entry.cwd) throw Error(`Native resume mismatch: ${entry.name}`);
    } else if (!entry.transcriptPath.endsWith(`/${encodeURIComponent(entry.cwd)}/${entry.resumeHandle}/chat_history.jsonl`)) throw Error(`Grok resume mismatch: ${entry.name}`);
  }
}

async function check({ mode, dataDir, url, file, allowWorkingId = '' }) {
  const readRegistry = () => JSON.parse(fs.readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
  const registry = readRegistry();
  const before = mode === 'capture' ? null : JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = before?.sessions.filter(s => s.live).map(s => s.id) || [];
  if (before) validateNative(registry, expected);
  const health = await (await fetch(new URL('/api/health', url), {signal: AbortSignal.timeout(5000)})).json();
  if (health.protocol !== 'fork-v6') throw Error('The updater requires a fork-v6 v2 engine; v1 migration is a separate operation.');
  return new Promise((resolve, reject) => {
    const address = new URL(url); address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:'; address.searchParams.set('protocol', health.protocol);
    const socket = new WebSocket(address);
    const states = new Map(); let initialized = false, done = false;
    const timer = setTimeout(() => finish(Error('Session readiness timed out: '+JSON.stringify([...states.values()]))), mode === 'capture' ? 10000 : 90000);
    const finish = error => { if (done) return; done = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    socket.on('error', finish);
    socket.on('close', () => { if (!done) finish(Error('Session inventory connection closed.')); });
    socket.on('message', raw => {
      try {
        const event = JSON.parse(raw);
        if (event.type === 'error') throw Error(event.message || JSON.stringify(event));
        if (event.type === 'session.created') states.set(event.sessionId, {...states.get(event.sessionId), id:event.sessionId, name:event.name, provider:event.provider, live:event.live});
        if (event.type === 'status') states.set(event.sessionId, {...states.get(event.sessionId), id:event.sessionId, status:event.state});
        if (event.type === 'session.closed' && expected.includes(event.sessionId)) throw Error(`Session closed while resuming: ${event.sessionId}`);
        if (event.type === 'sessions.inventory') {
          initialized = true;
          if (mode === 'capture') {
            const sessions = [...states.values()];
            validateNative(registry, sessions.filter(s=>s.live).map(s=>s.id));
            const busy = sessions.filter(s=>s.live && s.status !== 'idle' && s.id !== allowWorkingId);
            if (busy.length) throw Error('Conversations are working or awaiting attention: '+busy.map(s=>s.name).join(', '));
            fs.writeFileSync(file,JSON.stringify({sessions,registryIds:registry.map(s=>s.id),native:registry.filter(s=>sessions.some(l=>l.id===s.id && l.live)).map(({id,resumeHandle,transcriptPath,cwd,provider})=>({id,resumeHandle,transcriptPath,cwd,provider}))},null,2)+'\n',{mode:0o600});
            console.log(`Validated ${sessions.filter(s=>s.live).length} live conversations and ${registry.length} saved panes.`); finish(); return;
          }
          if (JSON.stringify([...event.ids].sort()) !== JSON.stringify([...before.registryIds].sort())) throw Error('Saved session IDs changed.');
          if (mode === 'resume') for (const id of expected) if (!states.get(id)?.live) socket.send(JSON.stringify({type:'session.resume',sessionId:id}));
        }
        if (mode !== 'capture' && initialized && expected.every(id=>states.get(id)?.live && states.get(id)?.status === 'idle')) {
          const latest = readRegistry(); validateNative(latest, expected);
          for (const native of before.native) {
            const entry = latest.find(s=>s.id===native.id);
            if (entry.resumeHandle !== native.resumeHandle) throw Error(`Native conversation changed: ${native.id}`);
          }
          console.log(`Verified ${expected.length} native conversations live and idle.`); finish();
        }
      } catch (error) { finish(error); }
    });
  });
}

if (require.main === module) {
  const [mode,dataDir,url,file,allowWorkingId] = process.argv.slice(2);
  check({mode,dataDir,url,file,allowWorkingId}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports = { validateNative, check };
