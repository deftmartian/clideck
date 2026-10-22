const { openSync, closeSync, fstatSync, readSync } = require('fs');

const READ_BYTES = 256 * 1024;
const LINE_BYTES = 256 * 1024;
const TURN_TYPES = new Set(['task_started', 'task_complete', 'turn_aborted']);

// Follow only complete records appended after attachment. Resuming a saved
// rollout must not replay old turns. Byte buffers preserve split UTF-8 text.
function createCodexTurnReader(path, onTurn, onReset = () => {}) {
  let identity = '';
  let offset = 0;
  let pending = Buffer.alloc(0);
  let skipping = false;

  const baseline = (fd, stat) => {
    identity = `${stat.dev}:${stat.ino}`;
    offset = stat.size;
    pending = Buffer.alloc(0);
    const last = Buffer.alloc(1);
    skipping = offset > 0 && readSync(fd, last, 0, 1, offset - 1) === 1 && last[0] !== 10;
  };
  const read = (initial = false) => {
    let fd;
    try {
      fd = openSync(path, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile()) return false;
      if (initial || identity !== `${stat.dev}:${stat.ino}` || stat.size < offset) {
        if (identity && !initial) onReset();
        baseline(fd, stat);
        return false;
      }
      const length = Math.min(READ_BYTES, stat.size - offset);
      if (!length) return false;
      const chunk = Buffer.allocUnsafe(length);
      const bytes = readSync(fd, chunk, 0, length, offset);
      offset += bytes;
      let start = 0;
      while (start < bytes) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 || newline >= bytes ? bytes : newline;
        if (!skipping) {
          if (pending.length + end - start > LINE_BYTES) {
            pending = Buffer.alloc(0);
            skipping = true;
          } else {
            pending = Buffer.concat([pending, chunk.subarray(start, end)]);
          }
        }
        if (end === bytes) break;
        if (!skipping) {
          const line = pending.toString('utf8');
          if (/"(?:task_started|task_complete|turn_aborted)"/.test(line)) {
            let record;
            try { record = JSON.parse(line); } catch {}
            const payload = record?.payload;
            if (record?.type === 'event_msg' && TURN_TYPES.has(payload?.type)
                && typeof payload.turn_id === 'string' && payload.turn_id.length > 0
                && payload.turn_id.length <= 256) onTurn(payload);
          }
        }
        pending = Buffer.alloc(0);
        skipping = false;
        start = end + 1;
      }
      return offset < stat.size;
    } catch {
      return false; // Missing/unreadable/unknown rollouts leave hooks in charge.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  read(true);
  return read;
}

module.exports = { createCodexTurnReader };
