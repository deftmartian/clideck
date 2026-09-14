const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { readFileSync, existsSync, statSync } = require('node:fs');
const TIMEOUT_MS = 15 * 60_000;

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
}
function floatAudio(pcm) {
  const result = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 2) result.writeFloatLE(pcm.readInt16LE(i) / 32768, i * 2);
  return result.toString('base64');
}

function createTranscriber(api) {
  let worker = null, startup = null, readyWorker = null, nextId = 0, closed = false;
  let replacements = [], replMtime = null, replPath = null;
  const pending = new Map();
  const pyDir = join(api.dir, 'python'), venv = join(api.dataDir, '.venv');
  const python = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python3');
  const wantsLocal = () => !closed && api.getSetting('backend') === 'local';
    function loadReplacements() {
      const fp = api.getSetting('replacements-file');
      if (fp !== replPath) { replMtime = null; replPath = fp; }
      if (!fp || !existsSync(fp)) { replacements = []; replMtime = null; return; }
      try {
        const mt = statSync(fp).mtimeMs;
        if (replMtime === mt) return;
        const rules = [];
        for (const raw of readFileSync(fp, 'utf8').split('\n')) {
          const line = raw.trim();
          if (!line || line.startsWith('#') || !line.includes('=>')) continue;
          const [srcRaw, ...rest] = line.split('=>');
          const right = rest.join('=>').split('|');
          const src = srcRaw.trim().replace(/^['"]|['"]$/g, '');
          const tgt = (right[0] || '').trim().replace(/^['"]|['"]$/g, '');
          if (!src) continue;
          let flags = 'g';
          for (const o of right.slice(1)) {
            const t = o.trim().toLowerCase();
            if (t === 'all' || t === 'match_all' || t.includes('mode=all')) flags = 'gi';
          }
          const esc = src.split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
          rules.push({ re: new RegExp(`(?<!\\w)${esc}(?!\\w)`, flags), tgt });
        }
        replacements = rules;
        replMtime = mt;
      } catch (e) { api.log(`replacements: ${e.message}`); }
    }

    function applyReplacements(text) {
      if (!text) return text;
      loadReplacements();
      for (const { re, tgt } of replacements) text = text.replace(re, tgt);
      return text;
    }

    function processText(raw) {
      // Only user-authored replacements may change recognized words.
      return applyReplacements(String(raw).trim());
    }

  const setupHint = `Run clideck-voice-setup --voice-dir ${JSON.stringify(api.dataDir)} to prepare local voice.`;
  function ensureEnv() {
    if (process.platform !== 'linux') throw new Error('Local voice in this fork requires Linux. The OpenAI backend remains available.');
    if (!existsSync(python)) throw new Error(setupHint);
  }
  function stopWorker(reason = new Error('Voice backend stopped.')) {
    const previous = worker; worker = null; readyWorker = null;
    for (const request of [...pending.values()]) request.finish(reason);
    previous?.kill();
  }
  function spawnWorker() {
    if (worker) return;
    const child = spawn(python,['-u',join(pyDir,'worker.py')],{cwd:pyDir,stdio:['pipe','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});
    worker = child; let buffer = '';
    const failed = error => { if (worker === child) stopWorker(new Error(`${error.message} ${readyWorker === child ? '' : setupHint}`.trim())); };
    child.on('error', failed); child.stdin.on('error', failed);
    child.on('close', code => failed(new Error(`Voice worker exited (${code}).`)));
    child.stderr.on('data', chunk => api.log(String(chunk).trim().slice(0,4096)));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024*1024) { failed(new Error('Voice worker response exceeded its limit.')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        try { const result = JSON.parse(line); pending.get(result.id)?.finish(result.error ? new Error(result.error) : null, result); } catch {}
      }
    });
  }
  function command(action, data = {}, signal) {
    return new Promise((resolve,reject) => {
      if (!worker) return reject(new Error('Voice worker is unavailable.'));
      if (signal?.aborted) return reject(signal.reason);
      const id = String(++nextId);
      const finish = (error, result) => { if (!pending.delete(id)) return; clearTimeout(timer); signal?.removeEventListener('abort',abort); error ? reject(error) : resolve(result); };
      const abort = () => stopWorker(signal.reason || new Error('Recording cancelled.'));
      const timer = setTimeout(()=>stopWorker(new Error('Voice transcription timed out.')),TIMEOUT_MS);
      pending.set(id,{finish}); signal?.addEventListener('abort',abort,{once:true});
      worker.stdin.write(JSON.stringify({id,action,...data})+'\n',error=>{if(error)stopWorker(error);});
    });
  }
  async function ready() {
    if (!wantsLocal()) { if (closed) throw new Error('Voice backend stopped.'); return; }
    if (worker && readyWorker === worker) return;
    if (!startup) startup = (async()=>{
      await ensureEnv(); if (!wantsLocal()) throw new Error('Voice backend changed.');
      spawnWorker(); const child = worker;
      const result = await command('warmup');
      if (worker !== child || result.status !== 'ready') throw new Error('Voice model did not become ready.');
      readyWorker = child; api.log('local model ready');
    })().catch(error=>{throw new Error(`${error.message} ${error.message.includes(setupHint) ? '' : setupHint}`.trim());}).finally(()=>{startup=null;});
    return startup;
  }
  async function transcribe(pcm, {signal} = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new Error('Expected mono PCM16 audio.');
    signal?.throwIfAborted(); let result;
    if (api.getSetting('backend') === 'local') {
      await ready(); signal?.throwIfAborted();
      result = await command('transcribe',{audio:floatAudio(pcm),lang:api.getSetting('language')||'auto'},signal);
    } else {
      const key = api.getSetting('openai-api-key'); if (!key) throw new Error('OpenAI API key not configured.');
      const form = new FormData(); form.append('model','whisper-1'); form.append('response_format','verbose_json');
      const language = api.getSetting('language'); if (language && language !== 'auto') form.append('language',language);
      form.append('file',new Blob([pcmToWav(pcm)],{type:'audio/wav'}),'audio.wav');
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)});
      if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status}).`);
      result = await response.json();
    }
    return {text:processText(result.text||'')||'',language:result.language};
  }
  api.onSettingsChange(()=>{stopWorker(new Error('Voice settings changed.')); if(wantsLocal())ready().catch(e=>api.log(e.message));});
  api.onShutdown(()=>{closed=true;stopWorker();});
  if(wantsLocal())ready().catch(e=>api.log(e.message));
  return {ready,transcribe};
}
module.exports = {createTranscriber,pcmToWav,floatAudio};
