const {
  closeSync,
  fstatSync,
  statSync,
  openSync,
  readSync,
  watch,
} = require('fs');
const { createCodexTurnReader } = require('./codex-turns');

const CODEX_BASELINE_TOKENS = 12_000;
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_WATCH_DEBOUNCE_MS = 250;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeContextUsage(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const usedTokens = finiteNumber(value.usedTokens);
  const windowTokens = finiteNumber(value.windowTokens);
  if (usedTokens === null || usedTokens < 0 || windowTokens === null || windowTokens <= 0) return null;
  const suppliedPercent = finiteNumber(value.percent);
  const percent = suppliedPercent === null
    ? Math.round((usedTokens / windowTokens) * 100)
    : Math.round(suppliedPercent);
  return {
    usedTokens: Math.round(usedTokens),
    windowTokens: Math.round(windowTokens),
    percent: Math.min(100, Math.max(0, percent)),
    estimated: value.estimated === true,
    updatedAt: Math.round(finiteNumber(value.updatedAt) ?? now),
  };
}

function structuredContextUsage(payload, estimated = false) {
  const usage = payload?.context_usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return normalizeContextUsage({
    usedTokens: usage.used_tokens ?? usage.tokens,
    windowTokens: usage.window_tokens ?? usage.context_window ?? usage.contextWindow,
    percent: usage.percent,
    estimated: usage.estimated ?? estimated,
  });
}

function claudeContextUsage(payload) {
  const context = payload?.context_window;
  if (!context || typeof context !== 'object') return undefined;
  const current = context.current_usage;
  if (!current || typeof current !== 'object') return null;
  return normalizeContextUsage({
    usedTokens: Number(current.input_tokens || 0)
      + Number(current.cache_creation_input_tokens || 0)
      + Number(current.cache_read_input_tokens || 0),
    windowTokens: context.context_window_size,
    percent: context.used_percentage,
  });
}

function codexContextUsage(info) {
  const usedTokens = finiteNumber(info?.last_token_usage?.total_tokens);
  const windowTokens = finiteNumber(info?.model_context_window);
  if (usedTokens === null || usedTokens < 0 || windowTokens === null
    || windowTokens <= CODEX_BASELINE_TOKENS) return null;
  const effectiveWindow = windowTokens - CODEX_BASELINE_TOKENS;
  const effectiveUsed = Math.max(0, usedTokens - CODEX_BASELINE_TOKENS);
  const remaining = Math.round((Math.max(0, effectiveWindow - effectiveUsed) / effectiveWindow) * 100);
  return normalizeContextUsage({
    usedTokens,
    windowTokens,
    percent: 100 - remaining,
  });
}

function parseCodexLine(line) {
  if (!line.includes('"token_count"')) return null;
  try {
    const record = JSON.parse(line);
    if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
    return codexContextUsage(record.payload.info);
  } catch {
    return null;
  }
}

function readLatestCodexUsage(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    if (!size) return null;
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const usage = parseCodexLine(lines[index]);
      if (usage) return usage;
    }
  } catch {}
  finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return null;
}

// Resume can omit the startup model banner. Recover actual transcript metadata,
// without guessing the current CLI default or reading an unbounded conversation.
function readLatestCodexModel(path,limit=4*1024*1024) {
  let fd;
  try {
    fd=openSync(path,'r');const size=fstatSync(fd).size;
    const length=Math.min(size,limit),buffer=Buffer.allocUnsafe(length);
    const count=readSync(fd,buffer,0,length,size-length);
    const lines=buffer.subarray(0,count).toString('utf8').split('\n');
    for(let index=lines.length-1;index>=0;index--){
      if(!lines[index].includes('"model"'))continue;
      try {const record=JSON.parse(lines[index]);if(['turn_context','session_meta'].includes(record.type)&&typeof record.payload?.model==='string')return record.payload.model;}catch{}
    }
  } catch {} finally {if(fd!==undefined)closeSync(fd);}
  return null;
}

function watchCodexContext(path, onUsage, options = {}) {
  if (!path || typeof onUsage !== 'function') return () => {};
  const readUsage = options.readUsage || readLatestCodexUsage;
  const watchFile = options.watch || watch;
  const debounceMs = Number(options.debounceMs ?? CODEX_WATCH_DEBOUNCE_MS);
  const readTurns = typeof options.onTurn === 'function'
    ? createCodexTurnReader(path, options.onTurn, options.onReset) : () => false;
  let timer = null;
  let watcher = null;
  let signature = '';
  let stopped = false, modelFound = false, modelSize = -1;
  const sample = () => {
    if (stopped) return;
    if (readTurns()) schedule(0); // Drain bursts in bounded chunks, yielding between reads.
    if(options.onModel){
      // Upstream polls once a second; only rescan for the model when the transcript has grown.
      let size=-1;try{size=statSync(path).size;}catch{}
      if(size!==modelSize){modelSize=size;const model=(options.readModel || readLatestCodexModel)(path,modelFound?CODEX_TAIL_BYTES:4*1024*1024);if(model){modelFound=true;options.onModel(model);}}
    }
    const usage = readUsage(path);
    if (!usage) return;
    const next = `${usage.usedTokens}:${usage.windowTokens}:${usage.percent}`;
    if (next === signature) return;
    signature = next;
    onUsage(usage);
  };
  const schedule = (delay = debounceMs) => {
    if (stopped || timer) return; // Continuous output must not postpone the sample forever.
    timer = setTimeout(() => { timer = null; sample(); }, delay);
    timer.unref?.();
  };
  try {
    watcher = watchFile(path, { persistent: false }, () => schedule());
    watcher.on?.('error', () => {});
  } catch {}
  sample();
  // fs.watch can coalesce/drop notifications or remain attached to a replaced inode.
  const poll = typeof options.onTurn === 'function'
    ? setInterval(() => schedule(0), options.pollMs ?? 1000) : null;
  poll?.unref?.();
  return () => {
    stopped = true;
    clearInterval(poll);
    clearTimeout(timer);
    timer = null;
    try { watcher?.close(); } catch {}
  };
}

module.exports = {
  CODEX_BASELINE_TOKENS,
  claudeContextUsage,
  codexContextUsage,
  normalizeContextUsage,
  parseCodexLine,
  readLatestCodexUsage,
  readLatestCodexModel,
  structuredContextUsage,
  watchCodexContext,
};
