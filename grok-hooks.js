const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');

const EVENTS = {
  UserPromptSubmit: 'start',
  Stop: 'stop',
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
  PreToolUse: 'menu',
};

function configPath(configRoot) {
  return join(configRoot, 'hooks', 'clideck.json');
}

function extractQuotedPath(command, needle) {
  const parts = String(command || '').match(/"([^"]+)"/g) || [];
  for (const part of parts) {
    const value = part.slice(1, -1);
    if (value.includes(needle)) return value;
  }
  return '';
}

function hasExistingHook(arr, port, route) {
  return !!arr?.some(entry => entry.hooks?.some(hook => {
    if (!hook.command?.includes('grok-hook.js') || !hook.command?.includes(` ${route}`)) return false;
    const helperPath = extractQuotedPath(hook.command, 'grok-hook.js');
    if (!helperPath || !existsSync(helperPath)) return false;
    const command = String(hook.command).replace(/\\/g, '/');
    const normalizedPath = helperPath.replace(/\\/g, '/');
    const quotedIdx = command.indexOf(`"${normalizedPath}"`);
    if (quotedIdx < 0) return false;
    const suffix = command.slice(quotedIdx + normalizedPath.length + 2).trim().split(/\s+/);
    return suffix[0] === String(port) && suffix[1] === route;
  }));
}

function readSettings(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function healthy(configRoot, port) {
  const hooks = readSettings(configPath(configRoot)).hooks || {};
  return Object.entries(EVENTS).every(([event, route]) => hasExistingHook(hooks[event], port, route));
}

function hasAny(configRoot) {
  const hooks = readSettings(configPath(configRoot)).hooks || {};
  return Object.values(hooks).some(arr => arr?.some(entry => entry.hooks?.some(hook => {
    if (!hook.command?.includes('grok-hook.js')) return false;
    const helperPath = extractQuotedPath(hook.command, 'grok-hook.js');
    return !!helperPath && existsSync(helperPath);
  })));
}

function install(configRoot, port, options = {}) {
  const path = configPath(configRoot);
  const settings = existsSync(path) ? readSettings(path) : {};
  const hooks = settings.hooks || {};
  const helperPath = String(options.helperPath || join(__dirname, 'bin', 'grok-hook.js')).replace(/\\/g, '/');
  const nodePath = String(options.nodePath || process.execPath).replace(/\\/g, '/');
  const hookCmd = route => `"${nodePath}" "${helperPath}" ${port} ${route}`;
  const clideckHook = route => ({ hooks: [{ type: 'command', command: hookCmd(route), timeout: 5 }] });
  const has = (arr, route) => arr?.some(entry => entry.hooks?.some(hook => hook.command === hookCmd(route)));

  if (Object.entries(EVENTS).every(([event, route]) => has(hooks[event], route))) {
    return { success: true, message: 'Already configured' };
  }

  const stripOld = arr => (arr || []).filter(entry => !entry.hooks?.some(hook =>
    hook.command?.includes('grok-hook.js') || hook.url?.includes('/hook/grok/')));
  for (const [event, route] of Object.entries(EVENTS)) {
    hooks[event] = stripOld(hooks[event]);
    if (!has(hooks[event], route)) hooks[event] = [...hooks[event], clideckHook(route)];
  }
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { success: true, message: `Added CliDeck hooks to ${path}` };
}

function remove(configRoot) {
  const path = configPath(configRoot);
  if (!existsSync(path)) return { success: true, message: 'No config file to clean' };
  const settings = readSettings(path);
  if (!settings.hooks) return { success: true, message: 'No hooks to remove' };

  for (const event of Object.keys(EVENTS)) {
    const arr = settings.hooks[event];
    if (!arr) continue;
    settings.hooks[event] = arr.filter(entry => !entry.hooks?.some(hook =>
      hook.command?.includes('grok-hook.js') || hook.url?.includes('/hook/grok/')));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) {
    try { unlinkSync(path); } catch { writeFileSync(path, '{}\n'); }
  } else {
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  }
  return { success: true, message: `Removed CliDeck hooks from ${path}` };
}

module.exports = { configPath, hasAny, healthy, install, remove };
