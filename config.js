const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const os = require('os');
const { DATA_DIR } = require('./paths');
const { defaultShell } = require('./utils');
const { presetForCommand } = require('./preset-utils');

const CONFIG_PATH = join(DATA_DIR, 'config.json');

const STARTER_PROMPTS = [
  {
    id: 'starter-prompt-update-documentation',
    name: 'Update documentation',
    text: 'Our docs needs to be updated based on the latest diff changes. Please review the latest changes and udpate the docs accordingly. List the changes you did in concise points in your response. Thanks.',
  },
  {
    id: 'starter-prompt-investigate-codebase',
    name: 'Investigate codebase',
    text: `Learn the codebase and investigate it for:
- Critical issues
- Serious logical issues
- Things you dont understand why they are there
- Redundent code
- Ugly workarounds / plasters / band-aids

list your fidings please.`,
  },
  {
    id: 'starter-prompt-reviewer-findings',
    name: 'Reviewer findings',
    text: 'Here are the reviewer findings, if you find that any are valid and relevant, please fix with pure solutions, simple approaches, never apply workarounds / plasters.\nWhen finish, list what you fix and how:',
  },
];

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
      env: {},
    },
  ],
  confirmClose: true,
  notifyIdle: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  notifyMinWork: 0,
  askDispatchSoundEnabled: true,
  askDispatchSound: 'agent-dispatch-ambient',
  defaultTheme: 'catppuccin-mocha',
  defaultShell,
  prompts: [],
  projects: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;
function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
const EXPOSED_PRESETS = PRESETS.filter(isPresetEnabled);

function matchPreset(cmd) { return presetForCommand(cmd, PRESETS, { usePresetId: false }); }

function firstCommandToken(command) {
  const raw = String(command || '').trim();
  const m = raw.match(/^(['"])(.*?)\1|^(\S+)/);
  return m ? (m[2] || m[3] || '') : '';
}

function commandPathMissing(command) {
  const token = firstCommandToken(command);
  return !token || (token.startsWith('/') && !existsSync(token));
}

function isShellCommand(cmd, preset) {
  return preset?.presetId === 'shell'
    || cmd.presetId === 'shell'
    || (!cmd.isAgent && !cmd.presetId && String(cmd.label || '').toLowerCase() === 'shell');
}

// Promote second-class shell wrappers that actually launch Grok Build into the
// first-class grok preset (hooks, resume, status, creator tile).
function isGrokLauncherCommand(command) {
  const s = String(command || '').trim();
  // Only promote commands that actually launch Grok. A shell command that
  // merely prints or passes the word "grok" must stay a shell command because
  // migration runs automatically against persisted user configuration.
  const executable = /^(?:"[^"]*[\\/]grok(?:\.exe)?"|'[^']*[\\/]grok(?:\.exe)?'|(?:[a-z]:)?[\\/]?(?:[^\s"'\\/]+[\\/])*grok(?:\.exe)?)(?:\s|$)/i;
  const execWrapper = /\bexec\s+(?:"[^"]*[\\/]grok(?:\.exe)?"|'[^']*[\\/]grok(?:\.exe)?'|(?:[a-z]:)?[\\/]?(?:[^\s"'\\/]+[\\/])*grok(?:\.exe)?)(?:\s|$)/i;
  return executable.test(s) || execWrapper.test(s);
}

function promoteShellGrokCommand(cmd) {
  if (!cmd || cmd.presetId === 'grok') return false;
  if (!isGrokLauncherCommand(cmd.command)) return false;
  // Only rewrite when it was filed as shell/custom, not when another agent
  // binary happens to appear in a grok rule string.
  if (cmd.presetId && cmd.presetId !== 'shell' && cmd.presetId !== 'custom') return false;

  const raw = String(cmd.command || '');
  const yolo = /--permission-mode\s+bypassPermissions|--always-approve|bypassPermissions/i.test(raw);
  const sandboxOff = /--sandbox\s+off|\bsandbox\s+off\b/i.test(raw);
  const minimal = /(?:^|\s)--minimal(?:\s|$)/.test(raw);
  // Fragile wrappers forced CliDeck's UUID onto Grok via bash; drop that and
  // let SessionStart hooks capture the real Grok session ID.
  const isWrapper = /bash|sh\b/.test(raw) && /exec\s+grok|\bgrok\b/.test(raw);

  cmd.presetId = 'grok';
  cmd.isAgent = true;
  cmd.canResume = true;
  if (isWrapper || !raw.trim().startsWith('grok')) {
    const parts = ['grok'];
    if (minimal) parts.push('--minimal');
    if (yolo) parts.push('--permission-mode', 'bypassPermissions');
    if (sandboxOff) parts.push('--sandbox', 'off');
    cmd.command = parts.join(' ');
  }
  // Keep custom flags on resume when we rewrote, or when resume still points
  // at the old bash wrapper / missing template.
  const resume = String(cmd.resumeCommand || '');
  if (!resume.includes('{{sessionId}}') || /bash|sh\b/.test(resume) || isWrapper) {
    const base = String(cmd.command || 'grok').trim();
    cmd.resumeCommand = `${base} --resume {{sessionId}}`;
  }
  cmd.sessionIdPattern = null;
  if (!cmd.label || /^shell$/i.test(cmd.label) || /terminal/i.test(cmd.icon || '')) {
    cmd.label = cmd.label && !/^shell$/i.test(cmd.label) ? cmd.label : 'Grok Build';
  }
  return true;
}

function migrate(cfg) {
  if (!Array.isArray(cfg.commands)) cfg.commands = [];
  // Migrate profiles → defaultTheme
  if (cfg.profiles && !cfg.defaultTheme) {
    const defProfile = cfg.profiles.find(p => p.id === cfg.defaultProfile) || cfg.profiles[0];
    cfg.defaultTheme = defProfile?.themeId || 'default';
  }
  delete cfg.profiles;
  delete cfg.defaultProfile;
  if (!cfg.defaultTheme || cfg.defaultTheme === 'solarized-dark') cfg.defaultTheme = 'catppuccin-mocha';
  // Backfill and sync fields from presets
  for (const cmd of cfg.commands) {
    promoteShellGrokCommand(cmd);
    let preset = cmd.presetId ? PRESETS.find(p => p.presetId === cmd.presetId) : matchPreset(cmd);
    if (isShellCommand(cmd, preset)) {
      preset = PRESETS.find(p => p.presetId === 'shell') || preset;
      cmd.presetId = 'shell';
      cmd.label = cmd.label || 'Shell';
    }
    if (preset?.presetId === 'shell' && commandPathMissing(cmd.command)) {
      cmd.command = defaultShell;
    }
    // Stamp presetId for reliable lookup
    if (preset && !cmd.presetId) cmd.presetId = preset.presetId;
    // Icon always syncs from preset — the preset is the source of truth for logos
    if (preset) cmd.icon = preset.icon;
    else if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    if (!cmd.env || typeof cmd.env !== 'object' || Array.isArray(cmd.env)) cmd.env = {};
    // Claude Code telemetry is built-in, always on
    if (preset?.telemetryEnabled === true) cmd.telemetryEnabled = true;
    else if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
    // Codex: keep shipped default commands aligned with the current preset.
    // Only rewrite the known default strings so custom Codex commands stay intact.
    if (preset?.presetId === 'codex') {
      if (cmd.command === 'codex' || cmd.command === 'codex --no-alt-screen') cmd.command = preset.command;
      if (cmd.resumeCommand === 'codex resume {{sessionId}}' || cmd.resumeCommand === 'codex resume {{sessionId}} --no-alt-screen') {
        cmd.resumeCommand = preset.resumeCommand;
      }
    }
    // Grok: keep the plain shipped launcher aligned with the preset; leave
    // YOLO / sandbox / minimal customizations intact.
    if (preset?.presetId === 'grok') {
      if (cmd.command === 'grok' || cmd.command === 'grok --minimal') cmd.command = preset.command;
      if (cmd.resumeCommand === 'grok --resume {{sessionId}}'
          || cmd.resumeCommand === 'grok --minimal --resume {{sessionId}}') {
        cmd.resumeCommand = preset.resumeCommand;
      }
      if (cmd.sessionIdPattern === undefined || cmd.sessionIdPattern === 'Session ID:\\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
        cmd.sessionIdPattern = preset.sessionIdPattern;
      }
    }
  }
  // Auto-add any shipped presets not yet in the commands list
  for (const preset of EXPOSED_PRESETS) {
    const exists = cfg.commands.some(c => c.presetId === preset.presetId || matchPreset(c)?.presetId === preset.presetId);
    if (!exists) {
      cfg.commands.push({
        id: crypto.randomUUID(), presetId: preset.presetId, label: preset.name, icon: preset.icon,
        command: preset.command, enabled: true, defaultPath: '',
        isAgent: preset.isAgent, canResume: preset.canResume,
        resumeCommand: preset.resumeCommand, sessionIdPattern: preset.sessionIdPattern,
        outputMarker: preset.outputMarker || null,
        env: {},
      });
    }
  }
  if (!cfg.projects) cfg.projects = [];
  return cfg;
}

function presetForShippedCommand(cmd) {
  if (cmd?.presetId) {
    const byId = EXPOSED_PRESETS.find(p => p.presetId === cmd.presetId);
    if (byId) return byId;
  }
  const matched = matchPreset(cmd);
  return matched && EXPOSED_PRESETS.some(p => p.presetId === matched.presetId) ? matched : null;
}

// The browser only receives commands that are usable on this host. Reconcile
// its filtered view without treating an omitted shipped preset as a deletion:
// a reconnect can otherwise save an empty/stale command list over Codex/Shell.
function mergeClientUpdate(current, update, visibleIds = new Set()) {
  const nextUpdate = { ...update };
  if (Array.isArray(update.commands)) {
    const incoming = [...update.commands];
    const incomingIds = new Set(incoming.map(c => c.id));
    const incomingPresetIds = new Set(
      incoming.map(presetForShippedCommand).filter(Boolean).map(p => p.presetId),
    );
    const preserved = (current.commands || []).filter(cmd => {
      if (incomingIds.has(cmd.id)) return false;
      const preset = presetForShippedCommand(cmd);
      if (preset) return !incomingPresetIds.has(preset.presetId);
      return !visibleIds.has(cmd.id);
    });
    nextUpdate.commands = [...incoming, ...preserved];
  }
  return migrate({ ...current, ...nextUpdate });
}

function load() {
  if (!existsSync(CONFIG_PATH)) {
    return migrate({
      ...deepCopy(DEFAULTS),
      prompts: deepCopy(STARTER_PROMPTS),
    });
  }
  try {
    return migrate({ ...deepCopy(DEFAULTS), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) });
  } catch { return migrate(deepCopy(DEFAULTS)); }
}

function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { load, save, mergeClientUpdate };
