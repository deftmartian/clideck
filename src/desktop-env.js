const { spawnSync } = require('child_process');

// A systemd user service usually starts at boot, before the graphical login imports its display and
// agent sockets into the user manager. Fill those from the manager at spawn time so shells and agents
// started after a reboot can still reach the clipboard, browser and ssh agent.
const DESKTOP_KEYS = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'SSH_AUTH_SOCK',
  'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION',
];
const CACHE_MS = 30_000;
let cached = null;
let cachedAt = 0;

function readManagerEnvironment(run = spawnSync) {
  const result = run('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 1000 });
  if (result.error || result.status !== 0) return {};
  const values = {};
  for (const line of String(result.stdout || '').split('\n')) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at > 0 && DESKTOP_KEYS.includes(key)) values[key] = line.slice(at + 1);
  }
  return values;
}

function desktopEnvironment(base = process.env, { platform = process.platform, now = Date.now(), run } = {}) {
  if (platform !== 'linux' || base.CLIDECK_NO_DESKTOP_ENV === '1') return {};
  if (DESKTOP_KEYS.every(key => base[key])) return {};
  if (run || !cached || now - cachedAt > CACHE_MS) {
    cached = readManagerEnvironment(run);
    cachedAt = now;
  }
  const missing = {};
  for (const [key, value] of Object.entries(cached)) if (!base[key]) missing[key] = value;
  return missing;
}

module.exports = { desktopEnvironment, DESKTOP_KEYS };
