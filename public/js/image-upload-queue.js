export const IMAGE_UPLOAD_LIMITS = Object.freeze({
  maxActive: 2,
  maxWaiting: 8,
  maxBytes: 25 * 1024 * 1024,
});

export function createImageUploadQueue(limits, start) {
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < limits.maxActive && waiting.length) {
      const job = waiting.shift();
      active += 1;
      Promise.resolve()
        .then(() => start(job))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }
  return {
    enqueue(job) {
      const bytes = Number(job && job.bytes);
      if (!Number.isFinite(bytes) || bytes < 0 || bytes > limits.maxBytes) {
        return { ok: false, error: 'too_large' };
      }
      if (waiting.length >= limits.maxWaiting) return { ok: false, error: 'queue_full' };
      waiting.push(job);
      pump();
      return { ok: true };
    },
    remove(job) { const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index,1); },
    stats() {
      return { active, waiting: waiting.length };
    },
  };
}
