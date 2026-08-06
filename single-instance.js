const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const { DATA_DIR } = require('./paths');
const { PORT, HOST, localUrl } = require('./runtime');

const LOCK_PATH = join(DATA_DIR, 'server.lock');
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

function currentBootId() {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync(BOOT_ID_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function removeLockIfOwned() {
  const lock = readLock();
  if (!lock || lock.pid !== process.pid) return;
  try { unlinkSync(LOCK_PATH); } catch {}
}

function acquireServerLock() {
  const existing = readLock();
  const bootId = currentBootId();
  const sameBoot = !bootId || !existing?.bootId || existing.bootId === bootId;
  if (existing && sameBoot && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    return { ok: false, lock: existing };
  }

  const lock = {
    pid: process.pid,
    host: HOST,
    port: PORT,
    url: localUrl(),
    startedAt: new Date().toISOString(),
    ...(bootId ? { bootId } : {}),
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  return { ok: true, lock };
}

module.exports = { acquireServerLock, removeLockIfOwned, isPidAlive, LOCK_PATH };
