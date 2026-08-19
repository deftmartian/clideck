const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } = require('fs');
const { join, dirname } = require('path');
const { execFileSync, execFile } = require('child_process');
const os = require('os');
const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const { listDirs, binName, defaultShell } = require('./utils');
const { presetForCommand: findPresetForCommand } = require('./preset-utils');
const { PORT, localUrl } = require('./runtime');
const { saveClipboardImage, bracketedPaste } = require('./clipboard-images');
const { CLIENT_PROTOCOL_VERSION } = require('./protocol');
const { CLIENT_BUILD_ID } = require('./client-build');
const grokHooks = require('./grok-hooks');
for (const p of presets) if (p.presetId === 'shell') p.command = defaultShell;
function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
function clientPresets() {
  return presets.filter(isPresetEnabled);
}
function filterClientCommands(commands) {
  const allowedPresetIds = new Set(clientPresets().map(p => p.presetId));
  const knownPresetIds = new Set(presets.map(p => p.presetId));
  return (commands || []).filter(cmd => {
    if (cmd.presetId && !allowedPresetIds.has(cmd.presetId) && knownPresetIds.has(cmd.presetId)) return false;
    const preset = cmd.presetId ? presets.find(p => p.presetId === cmd.presetId) : null;
    return !(preset?.available === false && String(cmd.command || '').trim() === String(preset.command || '').trim());
  });
}
const transcript = require('./transcript');
const plugins = require('./plugin-loader');
const { upsertCodexConfig, stripCodexConfig, validateCodexConfigToml, readCodexSetup } = require('./codex-config');
const { installCodexHooks, removeCodexHooks, codexHooksHealthy, codexHooksRemain } = require('./codex-hooks');

const opencodePluginDir = join(
  process.platform === 'win32' ? (process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming')) : join(os.homedir(), '.config'),
  'opencode', 'plugins'
);
// Resolve opencode preset paths for current platform
for (const p of presets) {
  if (p.presetId !== 'opencode') continue;
  const bridgePath = join(opencodePluginDir, 'clideck-bridge.js');
  if (p.pluginPath) p.pluginPath = bridgePath;
  if (p.pluginSetup) {
    const copyCmd = process.platform === 'win32'
      ? `copy opencode-plugin\\clideck-bridge.js "${opencodePluginDir}\\"`
      : `cp opencode-plugin/clideck-bridge.js ${opencodePluginDir}/`;
    p.pluginSetup = `Install the CliDeck bridge plugin to enable real-time status and resume.\n\n${copyCmd}`;
  }
}

// Check for clideck-remote updates (cached, once per hour)
let remoteUpdateCache = null;
let remoteUpdateCheckedAt = 0;
const REMOTE_UPDATE_INTERVAL = 3600000;

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function parseVersion(text) {
  const m = String(text || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : '';
}

function getInstalledVersion(bin) {
  try { return parseVersion(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
  try { return parseVersion(execFileSync(bin, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
  return '';
}

function presetForCommand(cmd) {
  return findPresetForCommand(cmd, presets);
}

function rawCommandEnv(cmd) {
  return cmd?.env && typeof cmd.env === 'object' && !Array.isArray(cmd.env) ? cmd.env : {};
}

function expandHomePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(os.homedir(), text.slice(2));
  return text;
}

function configRootFor(preset, cmd) {
  const env = rawCommandEnv(cmd);
  if (preset?.presetId === 'claude-code') return expandHomePath(env.CLAUDE_CONFIG_DIR) || join(os.homedir(), '.claude');
  if (preset?.presetId === 'codex') return expandHomePath(env.CODEX_HOME) || join(os.homedir(), '.codex');
  if (preset?.presetId === 'gemini-cli') return join(expandHomePath(env.GEMINI_CLI_HOME) || os.homedir(), '.gemini');
  if (preset?.presetId === 'pi') return expandHomePath(env.PI_CODING_AGENT_DIR) || join(os.homedir(), '.pi', 'agent');
  if (preset?.presetId === 'grok') return expandHomePath(env.GROK_HOME) || join(os.homedir(), '.grok');
  return os.homedir();
}

function checkRemoteUpdate(ws, force = false) {
  const now = Date.now();
  if (!force && remoteUpdateCache && now - remoteUpdateCheckedAt < REMOTE_UPDATE_INTERVAL) {
    ws.send(JSON.stringify({ type: 'remote.update', checked: true, ...remoteUpdateCache }));
    return;
  }
  const shellOpt = process.platform === 'win32';
  require('child_process').execFile('npm', ['list', '-g', 'clideck-remote', '--json', '--depth=0'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
    let installed;
    try { installed = JSON.parse(stdout).dependencies['clideck-remote'].version; }
    catch {
      ws.send(JSON.stringify({ type: 'remote.update', available: false, checked: false }));
      return;
    }
    require('child_process').execFile('npm', ['view', 'clideck-remote', 'version'], { shell: shellOpt, timeout: 10000 }, (err2, stdout2) => {
      if (err2) {
        ws.send(JSON.stringify({ type: 'remote.update', installed, available: false, checked: false }));
        return;
      }
      const latest = stdout2.trim();
      remoteUpdateCache = { installed, latest, available: compareVersions(latest, installed) > 0 };
      remoteUpdateCheckedAt = now;
      ws.send(JSON.stringify({ type: 'remote.update', checked: true, ...remoteUpdateCache }));
    });
  });
}

// Check which agent binaries are available on PATH
const whichCmd = process.platform === 'win32' ? 'where' : 'which';
function checkAvailability() {
  for (const p of presets) {
    if (!isPresetEnabled(p)) continue;
    if (p.presetId === 'shell') { p.available = true; p.version = ''; p.versionOk = true; p.health = { ok: true }; continue; }
    const bin = binName(p.command);
    try {
      execFileSync(whichCmd, [bin], { stdio: 'ignore' });
      p.available = true;
      p.version = getInstalledVersion(bin);
      p.versionOk = !p.minVersion || (p.version && compareVersions(p.version, p.minVersion) >= 0);
      p.health = p.versionOk ? { ok: true } : { ok: false, reason: `Update required (${p.minVersion}+)` };
    } catch {
      p.available = false;
      p.version = '';
      p.versionOk = true;
      p.health = { ok: false, reason: 'Not installed' };
    }
  }
}
checkAvailability();

let cfg = config.load();
if (detectTelemetryConfig(cfg)) config.save(cfg);

function extractQuotedPath(command, needle) {
  if (!command || !needle) return '';
  const parts = String(command).match(/"([^"]+)"/g) || [];
  for (const part of parts) {
    const value = part.slice(1, -1);
    if (value.includes(needle)) return value;
  }
  return '';
}

function hasExistingHook(arr, hookFile, route) {
  return !!arr?.some(h => h.hooks?.some(x => {
    if (!x.command?.includes(hookFile) || !x.command?.includes(` ${route}`)) return false;
    const hookPath = extractQuotedPath(x.command, hookFile);
    if (!hookPath || !existsSync(hookPath)) return false;
    const command = String(x.command).replace(/\\/g, '/');
    const normalizedPath = hookPath.replace(/\\/g, '/');
    const quotedIdx = command.indexOf(`"${normalizedPath}"`);
    if (quotedIdx < 0) return false;
    const suffix = command.slice(quotedIdx + normalizedPath.length + 2).trim().split(/\s+/);
    return suffix[0] === String(PORT) && suffix[1] === route;
  }));
}

function hasAnyExistingHook(hooks, hookFile) {
  return Object.values(hooks || {}).some(arr => arr?.some(h => h.hooks?.some(x => {
    if (!x.command?.includes(hookFile)) return false;
    const hookPath = extractQuotedPath(x.command, hookFile);
    return !!hookPath && existsSync(hookPath);
  })));
}

function codexConfigLooksHealthy(content, port, codexHome) {
  const setup = readCodexSetup(content, port);
  // needsRepair means the file on disk still does not parse for Codex itself.
  if (!setup.valid || setup.needsRepair) return false;
  if (!setup.otelOk || setup.wrongOtel || !setup.hooksEnabled) return false;
  const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
  if (!codexHooksHealthy(codexHome, codexHookPath, port)) return false;
  return !!setup.notifyHelper && existsSync(setup.notifyHelper);
}

function opencodeBridgeLooksHealthy() {
  const bridgePath = join(opencodePluginDir, 'clideck-bridge.js');
  if (!existsSync(bridgePath)) return false;
  try {
    const content = readFileSync(bridgePath, 'utf8');
    return content.includes('/opencode-events')
      && content.includes('CLIDECK_URL')
      && content.includes('CLIDECK_PORT');
  } catch {
    return false;
  }
}

function piBridgePath(cmd) {
  return join(configRootFor({ presetId: 'pi' }, cmd), 'extensions', 'clideck-bridge.ts');
}

function piBridgeLooksHealthy(cmd) {
  const bridgePath = piBridgePath(cmd);
  if (!existsSync(bridgePath)) return false;
  try {
    const content = readFileSync(bridgePath, 'utf8');
    return content.includes('/hook/pi')
      && content.includes('CLIDECK_SESSION_ID')
      && content.includes('sessionManager.getSessionId');
  } catch {
    return false;
  }
}

function detectTelemetryConfig(c) {
  const port = String(PORT);
  let changed = false;
  const attemptedRepairs = new Set();

  for (let pass = 0; pass < 2; pass++) {
    let repairedAny = false;
    for (const cmd of c.commands || []) {
      const preset = presetForCommand(cmd);
      if (!preset) continue;
      let detected = false;
      let reason = '';
      let repairAllowed = cmd.telemetrySetupConsent === true;
      if (preset.presetId === 'claude-code') {
        try {
          const s = JSON.parse(readFileSync(join(configRootFor(preset, cmd), 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          repairAllowed = repairAllowed || hasAnyExistingHook(hooks, 'claude-hook.js');
          detected = hasExistingHook(hooks.UserPromptSubmit, 'claude-hook.js', 'start')
                  && hasExistingHook(hooks.Stop, 'claude-hook.js', 'stop')
                  && hasExistingHook(hooks.SessionStart, 'claude-hook.js', 'session-start')
                  && hasExistingHook(hooks.SessionEnd, 'claude-hook.js', 'session-end')
                  && hasExistingHook(hooks.PreToolUse, 'claude-hook.js', 'menu')
                  && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && hasExistingHook([h], 'claude-hook.js', 'idle'))
                  && !hooks.StopFailure;
          if (detected && cmd.telemetrySetupConsent !== true) {
            cmd.telemetrySetupConsent = true;
            changed = true;
          }
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'codex') {
        try {
          const codexHome = configRootFor(preset, cmd);
          const content = readFileSync(join(codexHome, 'config.toml'), 'utf8');
          detected = codexConfigLooksHealthy(content, port, codexHome);
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'gemini-cli') {
        try {
          const s = JSON.parse(readFileSync(join(configRootFor(preset, cmd), 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          detected = hasExistingHook(hooks.BeforeAgent, 'gemini-hook.js', 'start')
                  && hasExistingHook(hooks.AfterAgent, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.SessionEnd, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.BeforeTool, 'gemini-hook.js', 'menu');
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'grok') {
        const grokRoot = configRootFor(preset, cmd);
        repairAllowed = repairAllowed || grokHooks.hasAny(grokRoot);
        detected = grokHooks.healthy(grokRoot, port);
        if (!detected) reason = 'Needs re-patch';
      } else if (preset.presetId === 'opencode') {
        detected = opencodeBridgeLooksHealthy();
        if (!detected) reason = 'Needs re-patch';
      } else if (preset.presetId === 'pi') {
        detected = piBridgeLooksHealthy(cmd);
        if (!detected) reason = 'Needs re-patch';
      } else { continue; }
      if (preset.available && preset.minVersion && !preset.versionOk) {
        detected = false;
        reason = `Update required (${preset.minVersion}+)`;
      } else if (!detected && cmd.telemetryEnabled && repairAllowed && preset.telemetryAutoSetup && preset.available && preset.versionOk && !attemptedRepairs.has(cmd.id || preset.presetId)) {
        attemptedRepairs.add(cmd.id || preset.presetId);
        const repaired = applyTelemetryConfig(preset, cmd);
        if (repaired.success) {
          repairedAny = true;
          continue;
        }
      }
      const nextEnabled = detected || (!!cmd.telemetryEnabled && !reason.startsWith('Update required'));
      const nextStatus = detected ? { ok: true } : { ok: false, error: reason || 'Needs setup' };
      if (cmd.telemetryEnabled !== nextEnabled || JSON.stringify(cmd.telemetryStatus || null) !== JSON.stringify(nextStatus)) {
        cmd.telemetryEnabled = nextEnabled;
        cmd.telemetryStatus = nextStatus;
        changed = true;
      }
      preset.health = detected ? { ok: true } : { ok: false, reason: reason || 'Needs setup' };
    }
    if (!repairedAny) break;
  }
  if (changed) console.log('Config: synced telemetry/plugin state from detected config files');
  return changed;
}

const appVersion = require('./package.json').version;

function configForClient() {
  return {
    ...cfg,
    commands: filterClientCommands(cfg.commands),
    pluginsDir: plugins.PLUGINS_DIR,
    version: appVersion,
    buildId: CLIENT_BUILD_ID,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
  };
}

function remoteCliEnv() {
  return { ...process.env, CLIDECK_PORT: String(PORT) };
}

function remoteVoiceCapabilityError() {
  const voicePlugin = plugins.getInfo().find(p => p.id === 'voice-input' && p.installed);
  return voicePlugin
    ? 'Restart CliDeck so the Voice Input plugin update can finish loading.'
    : 'Install the Voice Input plugin in CliDeck first.';
}

function onConnection(ws) {
  sessions.registerClient(ws);

  const sendControl = message => sessions.sendControl(ws, message);
  sendControl({ type: 'config', config: configForClient() });
  sendControl({ type: 'themes', themes });
  sendControl({ type: 'presets', presets: clientPresets() });
  sendControl({ type: 'sessions', list: sessions.list() });
  sendControl({ type: 'sessions.resumable', list: sessions.getResumable(cfg) });
  sendControl({ type: 'plugins', list: plugins.getInfo() });
  sendControl({ type: 'pills', list: plugins.getPills() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create':          sessions.create(msg, ws, cfg); break;
      case 'session.resume':  sessions.resume(msg, ws, cfg); break;
      case 'session.restart': console.log('[handler] session.restart', msg.id); sessions.restart(msg, ws, cfg); break;
      case 'session.subscribe':    sessions.subscribe(ws, msg); break;
      case 'session.unsubscribe':  sessions.unsubscribe(ws, msg.id); break;
      case 'transcript.cache.request':
        ws.send(JSON.stringify({ type: 'transcript.cache', cache: transcript.getCache() }));
        break;
      case 'transport.stats.request':
        sendControl({ type: 'transport.stats', ...sessions.streamStats(ws) });
        break;
      case 'input':                sessions.input(msg, ws); break;
      case 'clipboard.image': {
        const result = sessions.getSessions().has(String(msg.id || ''))
          ? saveClipboardImage(msg)
          : { success: false, error: 'No active session selected for image paste.' };
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'clipboard.image.error', id: msg.id, error: result.error }));
          break;
        }
        // Codex treats a pasted image path as an image attachment. Bracketed
        // paste keeps this on the same path as ordinary terminal paste.
        sessions.input({ id: msg.id, data: bracketedPaste(result.path) }, ws);
        ws.send(JSON.stringify({
          type: 'clipboard.image.saved', id: msg.id, path: result.path, bytes: result.bytes,
        }));
        break;
      }
      case 'session.statusReport':
        if (sessions.getSessions().has(msg.id)) {
          sessions.broadcast({ type: 'session.status', id: msg.id, working: !!msg.working, source: 'client' });
        }
        break;
      case 'resize':               sessions.resize(msg, ws); break;
      case 'rename':          sessions.rename(msg); break;
      case 'close':           sessions.close(msg, cfg); break;

      case 'config.get':
        ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
        break;

      case 'checkAvailability':
        checkAvailability();
        if (detectTelemetryConfig(cfg)) config.save(cfg);
        ws.send(JSON.stringify({ type: 'presets', presets: clientPresets() }));
        ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
        break;

      case 'config.update':
        delete msg.config.pluginsDir;
        delete msg.config.version;
        delete msg.config.buildId;
        delete msg.config.protocolVersion;
        // The client only ever sees the filtered command list — keep the
        // hidden commands and shipped presets so a stale reconnect cannot
        // overwrite Codex/Shell with an empty command list.
        const visibleIds = new Set(filterClientCommands(cfg.commands).map(c => c.id));
        cfg = config.mergeClientUpdate(cfg, msg.config, visibleIds);
        detectTelemetryConfig(cfg);
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;

      case 'session.theme': {
        const ok = sessions.setTheme(msg.id, msg.themeId);
        if (ok) sessions.broadcast({ type: 'session.theme', id: msg.id, themeId: msg.themeId });
        break;
      }

      case 'telemetry.autosetup': {
        const targetCmd = msg.commandId ? cfg.commands.find(c => c.id === msg.commandId) : null;
        const preset = targetCmd ? presetForCommand(targetCmd) : presets.find(p => p.presetId === msg.presetId);
        if (!preset?.telemetryAutoSetup) break;
        if (preset.available === false) {
          ws.send(JSON.stringify({
            type: 'telemetry.autosetup.result',
            presetId: preset.presetId,
            commandId: msg.commandId || null,
            success: false,
            output: `${preset.name} is not installed`,
          }));
          break;
        }
        const result = applyTelemetryConfig(preset, targetCmd);
        for (const cmd of cfg.commands) {
          if (targetCmd ? cmd.id === targetCmd.id : presetForCommand(cmd)?.presetId === preset.presetId) {
            cmd.telemetryEnabled = result.success;
            cmd.telemetryStatus = result.success ? { ok: true } : { ok: false, error: result.message };
            if (result.success) cmd.telemetrySetupConsent = true;
            // Enable the agent when setup succeeds, disable if it fails
            if (result.success) cmd.enabled = true;
          }
        }
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        ws.send(JSON.stringify({
          type: 'telemetry.autosetup.result',
          presetId: preset.presetId,
          commandId: msg.commandId || null,
          success: result.success,
          output: result.message,
        }));
        break;
      }

      case 'telemetry.configure': {
        const targetCmd = msg.commandId ? cfg.commands.find(c => c.id === msg.commandId) : null;
        const preset = targetCmd ? presetForCommand(targetCmd) : presets.find(p => p.presetId === msg.presetId);
        if (!preset) break;
        const enable = !!msg.enable;
        let result;
        if (enable) {
          result = applyTelemetryConfig(preset, targetCmd);
        } else {
          result = removeTelemetryConfig(preset, targetCmd);
        }
        // Update all matching commands in config. A failed removal leaves the
        // state alone: the agent is still configured to report, so showing it as
        // disabled would hide live tracking.
        for (const cmd of cfg.commands) {
          if (targetCmd ? cmd.id === targetCmd.id : presetForCommand(cmd)?.presetId === preset.presetId) {
            if (enable) {
              cmd.telemetryEnabled = result.success;
              cmd.telemetrySetupConsent = result.success;
              cmd.telemetryStatus = result.success ? { ok: true } : { ok: false, error: result.message };
            } else if (result.success) {
              cmd.telemetryEnabled = false;
              cmd.telemetrySetupConsent = false;
              cmd.telemetryStatus = null;
            }
          }
        }
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        // Anything still able to send events has to be said out loud, whether the
        // removal failed outright or deliberately preserved the user's settings.
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.message || 'Failed to update telemetry configuration.' }));
        } else if (result.warning) {
          ws.send(JSON.stringify({ type: 'error', message: result.warning }));
        }
        break;
      }

      case 'session.mute': {
        const ok = sessions.setMute(msg.id, msg.muted);
        if (ok) sessions.broadcast({ type: 'session.mute', id: msg.id, muted: !!msg.muted });
        break;
      }

      case 'session.setProject': {
        const result = sessions.setProject(msg.id, msg.projectId);
        if (result?.ok) sessions.broadcast({ type: 'session.setProject', id: msg.id, projectId: msg.projectId });
        else if (result?.error) ws.send(JSON.stringify({ type: 'error', message: result.error }));
        break;
      }

      // Client reports latest preview text — stored in memory, persisted by auto-save
      case 'session.setPreview':
        sessions.setPreview(msg.id, msg.text, msg.timestamp);
        break;

      case 'project.delete': {
        const proj = cfg.projects?.find(p => p.id === msg.id);
        if (!proj) break;
        // Kill all sessions in this project
        for (const s of sessions.list()) {
          if (s.projectId === msg.id) sessions.close({ id: s.id }, cfg);
        }
        cfg.projects = cfg.projects.filter(p => p.id !== msg.id);
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;
      }

      case 'project.openPath': {
        const proj = cfg.projects?.find(p => p.id === msg.id);
        if (!proj?.path) {
          ws.send(JSON.stringify({ type: 'project.openPath.result', id: msg.id, success: false, error: 'Project path is not set' }));
          break;
        }
        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
          ws.send(JSON.stringify({ type: 'project.openPath.result', id: msg.id, success: false, headless: true, path: proj.path }));
          break;
        }
        const cmd = process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
        execFile(cmd, [proj.path], { shell: process.platform === 'win32' }, (err) => {
          ws.send(JSON.stringify({
            type: 'project.openPath.result',
            id: msg.id,
            success: !err,
            error: err ? err.message : '',
          }));
        });
        break;
      }

      case 'dirs.list': {
        const target = msg.path || cfg.defaultPath;
        const result = listDirs(target, !!msg.showHidden);
        const entries = Array.isArray(result) ? result : [];
        const error = result.error || undefined;
        ws.send(JSON.stringify({ type: 'dirs', path: target, entries, error }));
        break;
      }

      case 'dirs.mkdir': {
        const name = (msg.name || '').trim();
        if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: false, error: 'Invalid folder name' }));
          break;
        }
        const dirPath = join(msg.parent, name);
        try {
          mkdirSync(dirPath);
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: true, path: dirPath }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: false, error: e.message }));
        }
        break;
      }

      case 'plugin.settings.update':
        plugins.updateSetting(msg.pluginId, msg.key, msg.value);
        sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        break;

      case 'plugin.install': {
        ws.send(JSON.stringify({ type: 'plugin.install.progress', pluginId: msg.pluginId }));
        plugins.installPlugin(msg.pluginId, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'plugin.install.result', pluginId: msg.pluginId, success: false, error: err.message }));
          } else {
            sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
            ws.send(JSON.stringify({ type: 'plugin.install.result', pluginId: msg.pluginId, success: true }));
          }
        });
        break;
      }
      case 'plugin.delete': {
        const result = plugins.removePlugin(msg.pluginId);
        if (result.success) {
          sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        } else {
          ws.send(JSON.stringify({ type: 'plugin.delete.error', pluginId: msg.pluginId, error: result.message }));
        }
        break;
      }

      case 'pill.getLogs':
        ws.send(JSON.stringify({ type: 'pill.logs', id: msg.id, logs: plugins.getPillLogs(msg.id) }));
        break;

      case 'remote.status': {
        let installed = false;
        try { execFileSync(whichCmd, ['clideck-remote'], { stdio: 'ignore' }); installed = true; } catch {}
        if (!installed) { ws.send(JSON.stringify({ type: 'remote.status', installed: false })); break; }
        require('child_process').execFile('clideck-remote', ['status', '--json'], { timeout: 5000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.status', installed: true, ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); }
        });
        checkRemoteUpdate(ws, !!msg.forceUpdate);
        break;
      }

      case 'remote.pair': {
        require('child_process').execFile('clideck-remote', ['pair', '--json'], { timeout: 15000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.error', error: err.message })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.paired', ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.error', error: 'Invalid response from clideck-remote' })); }
        });
        break;
      }

      case 'remote.unpair': {
        require('child_process').execFile('clideck-remote', ['unpair', '--json'], { timeout: 5000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'remote.error', error: err.message }));
          } else {
            sessions.broadcast({ type: 'remote.unpaired' });
          }
        });
        break;
      }

      case 'remote.getHistory': {
        ws.send(JSON.stringify({ type: 'remote.history', id: msg.id, turns: transcript.getTurns(msg.id, 20, 'end') }));
        break;
      }

      case 'remote.voice.transcribe': {
        const requestId = String(msg.requestId || '');
        const replyError = (error) => ws.send(JSON.stringify({ type: 'remote.voice.error', requestId, error }));
        if (!plugins.hasCapability('voice-input', 'transcribeAudio')) {
          replyError(remoteVoiceCapabilityError());
          break;
        }
        if (typeof msg.audio !== 'string' || !msg.audio) {
          replyError('No audio received.');
          break;
        }
        plugins.invoke('voice-input', 'transcribeAudio', { audio: msg.audio })
          .then(result => ws.send(JSON.stringify({ type: 'remote.voice.result', requestId, ...result })))
          .catch(e => replyError(e.message || 'Voice transcription failed.'));
        break;
      }

      case 'remote.voice.send': {
        const requestId = String(msg.requestId || '');
        const id = String(msg.id || '');
        const replyError = (error) => ws.send(JSON.stringify({ type: 'remote.voice.error', requestId, error }));
        if (!plugins.hasCapability('voice-input', 'transcribeAudio')) {
          replyError(remoteVoiceCapabilityError());
          break;
        }
        if (!id || !sessions.getSessions().has(id)) {
          replyError('Session is not available.');
          break;
        }
        if (typeof msg.audio !== 'string' || !msg.audio) {
          replyError('No audio received.');
          break;
        }
        plugins.invoke('voice-input', 'transcribeAudio', { audio: msg.audio })
          .then(result => {
            const text = String(result?.text || '').trim();
            if (!text) {
              ws.send(JSON.stringify({ type: 'remote.voice.sent', requestId, id, skipped: true }));
              return;
            }
            sessions.input({ id, data: text });
            setTimeout(() => sessions.input({ id, data: '\r' }), 150);
            ws.send(JSON.stringify({ type: 'remote.voice.sent', requestId, id, text }));
          })
          .catch(e => replyError(e.message || 'Voice transcription failed.'));
        break;
      }

      case 'remote.install': {
        const update = !!msg.update;
        const restartAfterUpdate = !!msg.restart;
        const proc = require('child_process').spawn('npm', ['install', '-g', 'clideck-remote'], {
          shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.on('close', code => {
          remoteUpdateCache = null;
          if (code !== 0 || !update || !restartAfterUpdate) {
            ws.send(JSON.stringify({ type: 'remote.install.done', success: code === 0, update, restarted: false }));
            return;
          }
          require('child_process').execFile('clideck-remote', ['restart', '--json'], { timeout: 10000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'remote.install.done', success: false, update, error: err.message }));
              return;
            }
            let restart = null;
            try { restart = JSON.parse(stdout); } catch {}
            ws.send(JSON.stringify({ type: 'remote.install.done', success: true, update, restart }));
          });
        });
        break;
      }

      default:
        if (msg.type?.startsWith('plugin.')) plugins.handleMessage(msg);
        break;
    }
  });

  ws.on('close', () => sessions.unregisterClient(ws));
}

// Deterministic telemetry config writers per agent — no AI, no YOLO
function applyTelemetryConfig(preset, cmd = null) {
  const port = String(PORT);

  try {
    if (preset.presetId === 'claude-code') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      const hooks = settings.hooks || {};
      const hookCmd = (route) => `"${process.execPath.replace(/\\/g, '/')}" "${join(__dirname, 'bin', 'claude-hook.js').replace(/\\/g, '/')}" ${port} ${route}`;
      const clideckHook = (route) => ({ hooks: [{ type: 'command', command: hookCmd(route) }] });
      const hasClideck = (arr, path) => arr?.some(h => h.hooks?.some(x => x.command === hookCmd(path)));
      if (hasClideck(hooks.UserPromptSubmit, 'start')
          && hasClideck(hooks.Stop, 'stop')
          && hasClideck(hooks.SessionStart, 'session-start')
          && hasClideck(hooks.SessionEnd, 'session-end')
          && hasClideck(hooks.PreToolUse, 'menu')
          && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && h.hooks?.some(x => x.command === hookCmd('idle')))
          && !hooks.StopFailure) {
        return { success: true, message: 'Already configured' };
      }
      const stripOld = (arr) => (arr || []).filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
      hooks.UserPromptSubmit = stripOld(hooks.UserPromptSubmit);
      hooks.Stop = stripOld(hooks.Stop);
      delete hooks.StopFailure;
      hooks.SessionStart = stripOld(hooks.SessionStart);
      hooks.SessionEnd = stripOld(hooks.SessionEnd);
      hooks.PreToolUse = stripOld(hooks.PreToolUse);
      hooks.Notification = stripOld(hooks.Notification);
      if (!hasClideck(hooks.UserPromptSubmit, 'start')) hooks.UserPromptSubmit = [...(hooks.UserPromptSubmit || []), clideckHook('start')];
      if (!hasClideck(hooks.Stop, 'stop')) hooks.Stop = [...(hooks.Stop || []), clideckHook('stop')];
      if (!hasClideck(hooks.SessionStart, 'session-start')) hooks.SessionStart = [...(hooks.SessionStart || []), clideckHook('session-start')];
      if (!hasClideck(hooks.SessionEnd, 'session-end')) hooks.SessionEnd = [...(hooks.SessionEnd || []), clideckHook('session-end')];
      if (!hasClideck(hooks.Notification, 'idle')) hooks.Notification = [...(hooks.Notification || []), { matcher: 'idle_prompt', ...clideckHook('idle') }];
      if (!hasClideck(hooks.PreToolUse, 'menu')) hooks.PreToolUse = [...(hooks.PreToolUse || []), clideckHook('menu')];
      settings.hooks = hooks;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Added hooks to ${configPath} — Claude will ask for one-time approval` };
    }

    if (preset.presetId === 'codex') {
      const codexHome = configRootFor(preset, cmd);
      const configPath = join(codexHome, 'config.toml');
      let content = '';
      if (existsSync(configPath)) content = readFileSync(configPath, 'utf8');
      const setup = readCodexSetup(content, port);
      const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
      const hasHooks = setup.hooksEnabled && codexHooksHealthy(codexHome, codexHookPath, port);
      // The helper path must still exist — a stale one (moved or reinstalled
      // CliDeck) is configured on paper but silently sends nothing.
      const notifyLive = !!setup.notifyHelper && existsSync(setup.notifyHelper);
      if (setup.otelOk && !setup.wrongOtel && notifyLive && hasHooks && !setup.needsRepair) {
        return { success: true, message: 'Already configured' };
      }
      if (!setup.valid) return { success: false, message: `${configPath}: ${setup.error}` };
      const notifyHelperPath = join(__dirname, 'bin', 'notify-helper.js').replace(/\\/g, '/');
      const { content: nextContent, manual } = upsertCodexConfig(content, process.execPath.replace(/\\/g, '/'), notifyHelperPath, port);
      const valid = validateCodexConfigToml(nextContent);
      if (!valid.ok) return { success: false, message: valid.error };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, nextContent);
      installCodexHooks(codexHome, process.execPath.replace(/\\/g, '/'), codexHookPath, port);
      // Confirm what we wrote actually reads back as configured, rather than
      // trusting that the edit did what it intended.
      const after = readCodexSetup(nextContent, port);
      const todo = [...manual];
      if (!after.otelOk && !todo.includes('otel')) todo.push('otel');
      if ((!after.notifyHelper || !existsSync(after.notifyHelper)) && !todo.includes('notify')) todo.push('notify');
      if (!after.hooksEnabled) todo.push('hooks');
      if (todo.length) {
        // Settings the user owns are left exactly as they were — say what to add.
        const steps = {
          otel: `[${'otel.exporter.otlp-http'}] with endpoint = "http://localhost:${port}" and protocol = "json"`,
          notify: `"${notifyHelperPath}" in the notify chain`,
          hooks: 'hooks = true under [features]',
        };
        return { success: false, message: `${configPath} has its own settings CliDeck did not change. Add manually: ${todo.map(k => steps[k]).join('; ')}.` };
      }
      return { success: true, message: 'Configured. If Codex shows "2 hooks need review", open /hooks and approve the CliDeck hooks once.' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      const hooks = settings.hooks || {};
      const helperPath = join(__dirname, 'bin', 'gemini-hook.js').replace(/\\/g, '/');
      const nodePath = process.execPath.replace(/\\/g, '/');
      const hookCmd = (route) => `"${nodePath}" "${helperPath}" ${port} ${route}`;
      const geminiHook = (route) => ({
        matcher: '*',
        hooks: [{ type: 'command', command: hookCmd(route), name: `clideck-${route}`, timeout: 5000 }],
      });
      const has = (arr, route) => arr?.some(h => h.hooks?.some(x => x.command === hookCmd(route)));
      if (has(hooks.BeforeAgent, 'start') && has(hooks.AfterAgent, 'stop') && has(hooks.SessionEnd, 'stop') && has(hooks.BeforeTool, 'menu')) {
        return { success: true, message: 'Already configured' };
      }
      const stripOld = (arr) => (arr || []).filter(h => !h.hooks?.some(x => x.command?.includes('gemini-hook.js')));
      hooks.BeforeAgent = stripOld(hooks.BeforeAgent);
      hooks.AfterAgent = stripOld(hooks.AfterAgent);
      hooks.SessionEnd = stripOld(hooks.SessionEnd);
      hooks.BeforeTool = stripOld(hooks.BeforeTool);
      if (!has(hooks.BeforeAgent, 'start')) hooks.BeforeAgent = [...(hooks.BeforeAgent || []), geminiHook('start')];
      if (!has(hooks.AfterAgent, 'stop')) hooks.AfterAgent = [...(hooks.AfterAgent || []), geminiHook('stop')];
      if (!has(hooks.SessionEnd, 'stop')) hooks.SessionEnd = [...(hooks.SessionEnd || []), geminiHook('stop')];
      if (!has(hooks.BeforeTool, 'menu')) hooks.BeforeTool = [...(hooks.BeforeTool || []), geminiHook('menu')];
      settings.hooks = hooks;
      if (settings.telemetry?.target === 'local' && /localhost:\d+/.test(String(settings.telemetry?.otlpEndpoint || ''))) delete settings.telemetry;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Added CliDeck hooks to ${configPath}` };
    }

    if (preset.presetId === 'opencode') {
      const src = join(__dirname, 'opencode-plugin', 'clideck-bridge.js');
      mkdirSync(opencodePluginDir, { recursive: true });
      copyFileSync(src, join(opencodePluginDir, 'clideck-bridge.js'));
      // Remove old termix-bridge.js if present
      const old = join(opencodePluginDir, 'termix-bridge.js');
      if (existsSync(old)) try { unlinkSync(old); } catch {}
      return { success: true, message: `Installed bridge plugin to ${opencodePluginDir}` };
    }

    if (preset.presetId === 'pi') {
      const src = join(__dirname, 'pi-extension', 'clideck-bridge.ts');
      const dest = piBridgePath(cmd);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      return { success: true, message: `Installed Pi extension to ${dest}` };
    }

    if (preset.presetId === 'grok') {
      return grokHooks.install(configRootFor(preset, cmd), port);
    }

    return { success: false, message: `No auto-setup for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function removeTelemetryConfig(preset, cmd = null) {
  try {
    if (preset.presetId === 'claude-code') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      if (!settings.hooks) return { success: true, message: 'No hooks to remove' };
      delete settings.hooks.StopFailure;
      for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Notification', 'PreToolUse']) {
        const arr = settings.hooks[event];
        if (!arr) continue;
        settings.hooks[event] = arr.filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Removed CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'codex') {
      const codexHome = configRootFor(preset, cmd);
      const configPath = join(codexHome, 'config.toml');
      // Hooks live in their own file, so they must go even when there is no
      // config.toml — otherwise they keep firing after the UI says tracking is off.
      removeCodexHooks(codexHome);
      if (!existsSync(configPath)) return { success: true, message: `Removed CliDeck hooks from ${codexHome}` };
      const content = readFileSync(configPath, 'utf8');
      // features.hooks is Codex's global switch — leave it on if other hooks use it.
      const { content: cleaned, manual } = stripCodexConfig(content, { keepHooksFeature: codexHooksRemain(codexHome) });
      writeFileSync(configPath, cleaned);
      if (manual.length) {
        return {
          success: true,
          warning: `${configPath} still has your own ${manual.join(' and ')} settings — CliDeck left them alone, so Codex may keep sending events until you remove them by hand.`,
          message: `Removed CliDeck hooks from ${configPath}, kept your own ${manual.join(' and ')} settings`,
        };
      }
      return { success: true, message: `Removed otel + CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      for (const event of ['BeforeAgent', 'AfterAgent', 'SessionEnd', 'BeforeTool']) {
        const arr = settings.hooks?.[event];
        if (!arr) continue;
        settings.hooks[event] = arr.filter(h => !h.hooks?.some(x => x.command?.includes('gemini-hook.js')));
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
      if (settings.telemetry?.target === 'local' && /localhost:\d+/.test(String(settings.telemetry?.otlpEndpoint || ''))) delete settings.telemetry;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Removed CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'opencode') {
      try { unlinkSync(join(opencodePluginDir, 'clideck-bridge.js')); } catch {}
      try { unlinkSync(join(opencodePluginDir, 'termix-bridge.js')); } catch {}
      return { success: true, message: 'Removed bridge plugin' };
    }

    if (preset.presetId === 'pi') {
      try { unlinkSync(piBridgePath(cmd)); } catch {}
      return { success: true, message: 'Removed Pi extension' };
    }

    if (preset.presetId === 'grok') {
      return grokHooks.remove(configRootFor(preset, cmd));
    }

    return { success: false, message: `No removal logic for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getConfig() { return cfg; }

module.exports = { onConnection, getConfig };
