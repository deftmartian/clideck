// Read Grok's own persisted counters. Do not estimate tokens from terminal text.
const { openSync, readSync, closeSync, fstatSync, watch } = require('node:fs');
const { dirname, join } = require('node:path');
const { normalizeContextUsage } = require('../context-usage');
const MAX_METADATA_BYTES = 256 * 1024;
function readMetadata(path) {
  let fd;
  try {
    fd = openSync(path, 'r'); const size = fstatSync(fd).size;
    if (!size || size > MAX_METADATA_BYTES) return null;
    const buffer = Buffer.alloc(size);
    const length = readSync(fd, buffer, 0, size, 0);
    return JSON.parse(buffer.subarray(0,length).toString('utf8'));
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function readGrokContext(transcriptPath) {
  const root = dirname(transcriptPath);
  const signals = readMetadata(join(root,'signals.json'));
  const summary = readMetadata(join(root,'summary.json'));
  const usage = signals && typeof signals.contextTokensUsed === 'number' && typeof signals.contextWindowTokens === 'number'
    ? normalizeContextUsage({usedTokens:signals.contextTokensUsed,windowTokens:signals.contextWindowTokens}) : null;
  const model = typeof summary?.current_model_id === 'string' ? summary.current_model_id.slice(0,160) : null;
  return {usage,model};
}
function watchGrokContext(path, onUsage, {onModel = () => {}, debounceMs = 250, pollMs = 5000} = {}) {
  let stopped = false, timer, watcher, usageSignature = '', modelSignature = '';
  function sample() {
    if (stopped) return;
    const {usage,model} = readGrokContext(path);
    if (usage) {
      const next = `${usage.usedTokens}:${usage.windowTokens}:${usage.percent}`;
      if (next !== usageSignature) {usageSignature = next;onUsage(usage);}
    }
    if (model && model !== modelSignature) {modelSignature = model;onModel(model);}
  }
  const schedule = () => {clearTimeout(timer);timer = setTimeout(sample,debounceMs);timer.unref?.();};
  // Directory watch survives atomic file replacement; polling recovers missed fs events.
  try { watcher = watch(dirname(path),{persistent:false},(_event,name)=>{if (!name || ['signals.json','summary.json'].includes(String(name))) schedule();});watcher.on('error',()=>{}); } catch {}
  const poll = setInterval(sample,pollMs);poll.unref?.();sample();
  return () => {stopped = true;clearTimeout(timer);clearInterval(poll);watcher?.close();};
}
module.exports = {readGrokContext,watchGrokContext};
