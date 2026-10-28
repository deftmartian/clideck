const { chmodSync, statSync } = require('fs');
const { dirname, resolve } = require('path');
const pty = require('node-pty');

let helperChecked = false;

// Inherited Claude nesting state must not leak into agents, but variables a CLI Agents command sets
// explicitly (e.g. CLAUDE_CODE_USE_BEDROCK) are user configuration and pass through.
function sanitizeProviderEnv(env, keep = []) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => {
    const name = key.toUpperCase();
    return keep.includes(key) || name !== 'CLAUDECODE'
      && name !== 'CLAUDE_EFFORT'
      && !name.startsWith('CLAUDE_CODE_');
  }));
}

function ensureHelperExecutable() {
  // Linux uses forkpty directly; spawn-helper is a macOS-only executable.
  if (helperChecked || process.platform !== 'darwin') return;
  const packageDirectory = dirname(require.resolve('node-pty/package.json'));
  // Match node-pty's own build/Release -> build/Debug -> prebuilds lookup.
  const { loadNativeModule } = require('node-pty/lib/utils');
  const native = loadNativeModule('pty');
  const helper = resolve(packageDirectory, 'lib', native.dir, 'spawn-helper');
  const mode = statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
  helperChecked = true;
}

function spawn(file, args, options) {
  ensureHelperExecutable();
  const { keepEnv, ...rest } = options || {};
  return pty.spawn(file, args, {
    ...rest,
    ...(rest.env && { env: sanitizeProviderEnv(rest.env, keepEnv) }),
  });
}

module.exports = { sanitizeProviderEnv, spawn };
