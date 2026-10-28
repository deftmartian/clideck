const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { applyPageFlipOff, revertPageFlipOff } = require('./grok-ui-pref');

// Stop is on the turn path: the helper must exit 0. Grok exit 2 blocks the stop.
// Notification is only the idle_prompt backstop, not every notification.
const EVENTS = {
  UserPromptSubmit: 'start',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  StopCancelled: 'stop-cancelled',
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
  Notification: 'idle',
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

function hasExistingHook(arr, port, route, matcher) {
  return !!arr?.some(entry => {
    if (matcher && entry.matcher !== matcher) return false;
    return entry.hooks?.some(hook => {
      if (!hook.command?.includes('grok-hook.js') || !hook.command?.includes(` ${route}`)) return false;
      const helperPath = extractQuotedPath(hook.command, 'grok-hook.js');
      if (!helperPath || !existsSync(helperPath)) return false;
      const command = String(hook.command).replace(/\\/g, '/');
      const normalizedPath = helperPath.replace(/\\/g, '/');
      const quotedIdx = command.indexOf(`"${normalizedPath}"`);
      if (quotedIdx < 0) return false;
      const suffix = command.slice(quotedIdx + normalizedPath.length + 2).trim().split(/\s+/);
      return suffix[0] === String(port) && suffix[1] === route;
    });
  });
}

function readSettings(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const settings = JSON.parse(text);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) {
    throw new Error('Expected a settings object with a hooks object');
  }
  for (const entries of Object.values(settings.hooks || {})) {
    if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !Array.isArray(entry.hooks)
      || entry.hooks.some(hook => !object(hook)
        || (hook.command !== undefined && typeof hook.command !== 'string')
        || (hook.url !== undefined && typeof hook.url !== 'string')))) {
      throw new Error('Expected hook entries containing arrays of hook objects');
    }
  }
  return settings;
}

function probeSettings(path) {
  try { return readSettings(path); } catch { return {}; }
}

function healthy(configRoot, port) {
  const hooks = probeSettings(configPath(configRoot)).hooks || {};
  return Object.entries(EVENTS).every(([event, route]) => hasExistingHook(
    hooks[event], port, route, event === 'Notification' ? 'idle_prompt' : '',
  ));
}

function hasAny(configRoot) {
  const hooks = probeSettings(configPath(configRoot)).hooks || {};
  return Object.values(hooks).some(arr => arr?.some(entry => entry.hooks?.some(hook => {
    if (!hook.command?.includes('grok-hook.js')) return false;
    const helperPath = extractQuotedPath(hook.command, 'grok-hook.js');
    return !!helperPath && existsSync(helperPath);
  })));
}

function complete(configRoot) {
  const hooks = probeSettings(configPath(configRoot)).hooks || {};
  return Object.entries(EVENTS).every(([event, route]) => hooks[event]?.some(entry => {
    if (event === 'Notification' && entry.matcher !== 'idle_prompt') return false;
    return entry.hooks?.some(hook => {
      const path = extractQuotedPath(hook.command, 'grok-hook.js');
      const node = String(hook.command || '').match(/^"([^"]+)"/)?.[1];
      return path && node && existsSync(node) && existsSync(path) && new RegExp(`\\s${route}(?:\\s|$)`).test(hook.command);
    });
  }));
}

function withoutCliDeckHooks(entries) {
  return (entries || []).map(entry => ({...entry,hooks:(entry.hooks || []).filter(hook =>
    !hook.command?.includes('grok-hook.js') && !hook.url?.includes('/hook/grok/'))})).filter(entry => entry.hooks.length);
}

function install(configRoot, port, options = {}) {
  const path = configPath(configRoot);
  let settings;
  try { settings = readSettings(path); } catch (error) {
    return { success: false, message: `Cannot read ${path}: ${error.message}` };
  }
  const hooks = settings.hooks || {};
  const helperPath = String(options.helperPath || join(__dirname, '../../bin/grok-hook.js')).replace(/\\/g, '/');
  const nodePath = String(options.nodePath || process.execPath).replace(/\\/g, '/');
  const hookCmd = route => `"${nodePath}" "${helperPath}" ${port} ${route}`;
  const clideckHook = (event, route) => ({
    ...(event === 'Notification' ? { matcher: 'idle_prompt' } : {}),
    hooks: [{ type: 'command', command: hookCmd(route), timeout: 5 }],
  });
  const has = (arr, event, route) => arr?.some(entry => {
    if (event === 'Notification' && entry.matcher !== 'idle_prompt') return false;
    return entry.hooks?.some(hook => hook.command === hookCmd(route));
  });

  const hooksAlready = Object.entries(EVENTS).every(([event, route]) => has(hooks[event], event, route));
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

  const stripOld = withoutCliDeckHooks;
  for (const [event, route] of Object.entries(EVENTS)) {
    hooks[event] = stripOld(hooks[event]);
    if (!has(hooks[event], event, route)) hooks[event] = [...hooks[event], clideckHook(event, route)];
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
  const path = configPath(configRoot);
  let settings;
  try { settings = readSettings(path); } catch (error) {
    return { success: false, message: `Cannot read ${path}: ${error.message}` };
  }
  const pref = revertPageFlipOff(grokConfigTomlPath(configRoot));
  if (pref.success === false) {
    return { success: false, message: pref.message };
  }
  const prefNote = pref.changed
    ? `Removed CliDeck [ui] page_flip_on_send from ${pref.path}`
    : pref.message || '';
  if (!existsSync(path)) {
    return { success: pref.success !== false, message: joinMessages('No config file to clean', prefNote) };
  }
  if (!settings.hooks) {
    return { success: pref.success !== false, message: joinMessages('No hooks to remove', prefNote) };
  }

  for (const event of Object.keys(EVENTS)) {
    const arr = settings.hooks[event];
    if (!arr) continue;
    settings.hooks[event] = withoutCliDeckHooks(arr);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (!Object.keys(settings).length) {
    unlinkSync(path);
  } else {
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  }
  return {
    success: pref.success !== false,
    message: joinMessages(`Removed CliDeck hooks from ${path}`, prefNote),
  };
}

module.exports = { configPath, grokConfigTomlPath, hasAny, complete, healthy, install, remove };
