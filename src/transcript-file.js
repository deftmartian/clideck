const { statSync } = require('fs');

function hasNonemptyFile(path) {
  if (!path) return false;
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function waitForNonemptyFile(path, timeoutMs) {
  if (hasNonemptyFile(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let poll;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ready);
    };
    const check = () => {
      if (hasNonemptyFile(path)) finish(true);
    };
    // A file created before watchFile completes its initial stat can become
    // the watcher's baseline and never emit a change. Poll readiness directly.
    poll = setInterval(check, 100);
    poll.unref?.();
    timer = setTimeout(() => finish(hasNonemptyFile(path)), timeoutMs);
    check();
  });
}

module.exports = { hasNonemptyFile, waitForNonemptyFile };
