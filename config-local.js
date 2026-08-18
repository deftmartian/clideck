// Fork-specific configuration policy. Keep persisted-config migrations and
// filtered-client reconciliation out of upstream's core config lifecycle.

function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isGrokLauncherCommand(command) {
  const value = String(command || '').trim();
  // Only promote commands that actually launch Grok. A shell command that
  // merely prints or passes the word "grok" must remain a shell command.
  const executable = /^(?:"[^"]*[\\/]grok(?:\.exe)?"|'[^']*[\\/]grok(?:\.exe)?'|(?:[a-z]:)?[\\/]?(?:[^\s"'\\/]+[\\/])*grok(?:\.exe)?)(?:\s|$)/i;
  const execWrapper = /\bexec\s+(?:"[^"]*[\\/]grok(?:\.exe)?"|'[^']*[\\/]grok(?:\.exe)?'|(?:[a-z]:)?[\\/]?(?:[^\s"'\\/]+[\\/])*grok(?:\.exe)?)(?:\s|$)/i;
  return executable.test(value) || execWrapper.test(value);
}

function migrateCommandBeforePreset(command) {
  if (!command || command.presetId === 'grok') return false;
  if (!isGrokLauncherCommand(command.command)) return false;
  if (command.presetId && command.presetId !== 'shell' && command.presetId !== 'custom') return false;

  const raw = String(command.command || '');
  const yolo = /--permission-mode\s+bypassPermissions|--always-approve|bypassPermissions/i.test(raw);
  const sandboxOff = /--sandbox\s+off|\bsandbox\s+off\b/i.test(raw);
  const minimal = /(?:^|\s)--minimal(?:\s|$)/.test(raw);
  const isWrapper = /bash|sh\b/.test(raw) && /exec\s+grok|\bgrok\b/.test(raw);

  command.presetId = 'grok';
  command.isAgent = true;
  command.canResume = true;
  if (isWrapper || !raw.trim().startsWith('grok')) {
    const parts = ['grok'];
    if (minimal) parts.push('--minimal');
    if (yolo) parts.push('--permission-mode', 'bypassPermissions');
    if (sandboxOff) parts.push('--sandbox', 'off');
    command.command = parts.join(' ');
  }
  const resume = String(command.resumeCommand || '');
  if (!resume.includes('{{sessionId}}') || /bash|sh\b/.test(resume) || isWrapper) {
    command.resumeCommand = `${String(command.command || 'grok').trim()} --resume {{sessionId}}`;
  }
  command.sessionIdPattern = null;
  if (!command.label || /^shell$/i.test(command.label) || /terminal/i.test(command.icon || '')) {
    command.label = command.label && !/^shell$/i.test(command.label)
      ? command.label
      : 'Grok Build';
  }
  return true;
}

function migrateCommandWithPreset(command, preset) {
  if (preset?.presetId !== 'grok') return;
  if (command.command === 'grok' || command.command === 'grok --minimal') {
    command.command = preset.command;
  }
  if (
    command.resumeCommand === 'grok --resume {{sessionId}}'
    || command.resumeCommand === 'grok --minimal --resume {{sessionId}}'
  ) {
    command.resumeCommand = preset.resumeCommand;
  }
  if (
    command.sessionIdPattern === undefined
    || command.sessionIdPattern === 'Session ID:\\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
  ) {
    command.sessionIdPattern = preset.sessionIdPattern;
  }
}

function presetForShippedCommand(command, exposedPresets, matchPreset) {
  if (command?.presetId) {
    const byId = exposedPresets.find(preset => preset.presetId === command.presetId);
    if (byId) return byId;
  }
  const matched = matchPreset(command);
  return matched && exposedPresets.some(preset => preset.presetId === matched.presetId)
    ? matched
    : null;
}

// The browser receives only commands usable on this host. Reconcile that
// filtered view without treating an omitted shipped preset as a deletion.
function mergeClientUpdate(current, update, visibleIds, options) {
  const { exposedPresets, matchPreset, migrate } = options;
  const nextUpdate = { ...update };
  if (Array.isArray(update.commands)) {
    const incoming = [...update.commands];
    const shippedPreset = command => presetForShippedCommand(
      command,
      exposedPresets,
      matchPreset,
    );
    const incomingIds = new Set(incoming.map(command => command.id));
    const incomingPresetIds = new Set(
      incoming.map(shippedPreset).filter(Boolean).map(preset => preset.presetId),
    );
    const preserved = (current.commands || []).filter(command => {
      if (incomingIds.has(command.id)) return false;
      const preset = shippedPreset(command);
      if (preset) return !incomingPresetIds.has(preset.presetId);
      return !visibleIds.has(command.id);
    });
    nextUpdate.commands = [...incoming, ...preserved];
  }
  return migrate({ ...current, ...nextUpdate });
}

module.exports = {
  isPresetEnabled,
  mergeClientUpdate,
  migrateCommandBeforePreset,
  migrateCommandWithPreset,
};
