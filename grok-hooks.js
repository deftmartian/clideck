const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { applyPageFlipOff, revertPageFlipOff } = require('./grok-ui-pref');

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

function grokConfigTomlPath(configRoot) {
  return join(configRoot, 'config.toml');
}

function prefMessage(pref) {
  if (!pref) return '';
  if (!pref.success && pref.message) return pref.message;
  if (pref.changed) {
    return `Set [ui] page_flip_on_send = false in ${pref.path} (removed on uninstall if still false)`;
  }
  return '';
}

function joinMessages(...parts) {
  return parts.filter(Boolean).join('. ');
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

  const hooksAlready = Object.entries(EVENTS).every(([event, route]) => has(hooks[event], route));
  const prefs = applyPageFlipOff(grokConfigTomlPath(configRoot));
  if (prefs.success === false) {
    return { success: false, message: prefMessage(prefs) };
  }
  if (hooksAlready) {
    return {
      success: prefs.success !== false,
      message: joinMessages(prefs.changed ? prefMessage(prefs) : 'Already configured', !prefs.changed && prefMessage(prefs)),
    };
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
  return {
    success: true,
    message: joinMessages(`Added CliDeck hooks to ${path}`, prefMessage(prefs)),
  };
}

function remove(configRoot) {
  const pref = revertPageFlipOff(grokConfigTomlPath(configRoot));
  if (pref.success === false) {
    return { success: false, message: pref.message };
  }
  const prefNote = pref.changed
    ? `Removed CliDeck [ui] page_flip_on_send from ${pref.path}`
    : pref.message || '';
  const path = configPath(configRoot);
  if (!existsSync(path)) {
    return { success: pref.success !== false, message: joinMessages('No config file to clean', prefNote) };
  }
  const settings = readSettings(path);
  if (!settings.hooks) {
    return { success: pref.success !== false, message: joinMessages('No hooks to remove', prefNote) };
  }

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
  return {
    success: pref.success !== false,
    message: joinMessages(`Removed CliDeck hooks from ${path}`, prefNote),
  };
}

module.exports = { configPath, grokConfigTomlPath, hasAny, healthy, install, remove };
