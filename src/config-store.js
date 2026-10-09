const {
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} = require('fs');
const { join } = require('path');
const { ensurePrivateDataDir } = require('./private-data-dir');
const { isValidProfile, mergeProfile } = require('./user-profile');
const { isValidOnboarding, mergeOnboarding } = require('./onboarding');

const STARTER_PROMPTS = Object.freeze([
  Object.freeze({
    id: 'starter-prompt-update-documentation',
    name: 'Update documentation',
    text: 'Our docs needs to be updated based on the latest diff changes. Please review the latest changes and udpate the docs accordingly. List the changes you did in concise points in your response. Thanks.',
  }),
  Object.freeze({
    id: 'starter-prompt-investigate-codebase',
    name: 'Investigate codebase',
    text: `Learn the codebase and investigate it for:
- Critical issues
- Serious logical issues
- Things you dont understand why they are there
- Redundent code
- Ugly workarounds / plasters / band-aids

list your fidings please.`,
  }),
  Object.freeze({
    id: 'starter-prompt-reviewer-findings',
    name: 'Reviewer findings',
    text: 'Here are the reviewer findings, if you find that any are valid and relevant, please fix with pure solutions, simple approaches, never apply workarounds / plasters.\nWhen finish, list what you fix and how:',
  }),
]);
const EMPTY_CONFIG = Object.freeze({
  prompts: Object.freeze([]),
  defaultCwd: '',
  commands: Object.freeze([]),
  projects: Object.freeze([]),
  providerArgs: Object.freeze({}),
});
const DEFAULT_CONFIG = Object.freeze({
  prompts: STARTER_PROMPTS,
  defaultCwd: '',
  commands: Object.freeze([]),
  projects: Object.freeze([]),
  providerArgs: Object.freeze({}),
});
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_KEYS = 100;
const MAX_PROMPTS = 500;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_COMMANDS = 100;
const MAX_COMMAND_BYTES = 16 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROJECTS = 500;
const MAX_PROJECT_BYTES = 16 * 1024;
const MAX_PROVIDER_ARGS = 4096;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,99}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Infinity;
  }
}

function isValidCommand(command) {
  if (!isObject(command) || jsonSize(command) > MAX_COMMAND_BYTES) return false;
  if (typeof command.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(command.id)) return false;
  if (typeof command.label !== 'string' || !command.label.trim() || command.label.length > 200) return false;
  if (typeof command.icon !== 'string' || command.icon.length > 200 || command.icon.includes('\0')) return false;
  if (typeof command.command !== 'string' || !command.command.trim()
    || command.command.length > 4096 || command.command.includes('\0')) return false;
  if (typeof command.enabled !== 'boolean' || typeof command.isAgent !== 'boolean'
    || typeof command.canResume !== 'boolean') return false;
  if (!isObject(command.env) || Object.keys(command.env).length > 100) return false;
  if (Object.entries(command.env).some(([key, value]) => !ENV_NAME.test(key)
    || typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) return false;
  if (command.resumeCommand !== null
    && (typeof command.resumeCommand !== 'string' || command.resumeCommand.length > 4096
      || command.resumeCommand.includes('\0'))) return false;
  if (command.sessionIdPattern !== null
    && (typeof command.sessionIdPattern !== 'string' || command.sessionIdPattern.length > 1000
      || command.sessionIdPattern.includes('\0'))) return false;
  try {
    if (command.sessionIdPattern) new RegExp(command.sessionIdPattern, 'i');
  } catch {
    return false;
  }
  return true;
}

function isValidProject(project) {
  return isObject(project)
    && jsonSize(project) <= MAX_PROJECT_BYTES
    && typeof project.id === 'string'
    && /^[A-Za-z0-9_-]{1,100}$/.test(project.id)
    && typeof project.name === 'string'
    && project.name.trim().length > 0
    && project.name.length <= 200
    && !project.name.includes('\0')
    && typeof project.path === 'string'
    && project.path.length <= 4096
    && !project.path.includes('\0')
    && typeof project.color === 'string'
    && project.color.length <= 100
    && !project.color.includes('\0')
    && typeof project.collapsed === 'boolean';
}

function isValidProviderArgs(value) {
  return isObject(value)
    && Object.keys(value).length <= 100
    && Object.entries(value).every(([id, args]) => PROVIDER_ID.test(id)
      && typeof args === 'string'
      && args.length <= MAX_PROVIDER_ARGS
      && !/[\0\r\n]/.test(args));
}

function recoveryMessage(reason) {
  const why = {
    malformed_json: 'config.json is not valid JSON',
    invalid_entries: 'config.json has entries that fail validation',
    too_large: 'config.json is larger than the 256 KiB settings limit',
    unreadable: 'config.json could not be read',
    not_a_file: 'config.json is not a regular file',
  }[reason] || 'config.json could not be loaded';
  return `${why}. The original file was left unchanged. Settings changes are blocked so a later save cannot replace it. Recover archives those original bytes as config.json.rejected-<time> and writes a new default config. Use the Recover action in CliDeck, or run \`clideck config recover\`.`;
}

function isValidConfigPatch(value) {
  if (!isObject(value)
    || Object.keys(value).length > MAX_CONFIG_KEYS
    || jsonSize(value) > MAX_CONFIG_BYTES) return false;
  if (value.defaultCwd !== undefined
    && (typeof value.defaultCwd !== 'string'
      || value.defaultCwd.length > 4096
      || value.defaultCwd.includes('\0'))) return false;
  if (value.prompts !== undefined
    && (!Array.isArray(value.prompts)
      || value.prompts.length > MAX_PROMPTS
      || value.prompts.some((prompt) => !isObject(prompt) || jsonSize(prompt) > MAX_PROMPT_BYTES))) {
    return false;
  }
  if (value.commands !== undefined
    && (!Array.isArray(value.commands)
      || value.commands.length > MAX_COMMANDS
      || value.commands.some((command) => !isValidCommand(command))
      || new Set(value.commands.map((command) => command.id)).size !== value.commands.length)) {
    return false;
  }
  if (value.projects !== undefined
    && (!Array.isArray(value.projects)
      || value.projects.length > MAX_PROJECTS
      || value.projects.some((project) => !isValidProject(project))
      || new Set(value.projects.map((project) => project.id)).size !== value.projects.length)) {
    return false;
  }
  if (value.providerArgs !== undefined && !isValidProviderArgs(value.providerArgs)) return false;
  if (value.about !== undefined && !isValidProfile(value.about)) return false;
  if (value.onboarding !== undefined && !isValidOnboarding(value.onboarding)) return false;
  return true;
}

class ConfigStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    if (!this.dataDir) throw new Error('ConfigStore requires a dataDir.');
    this.path = join(this.dataDir, 'config.json');
    this.recovery = null;
    const freshInstall = options.freshInstall ?? !existsSync(this.dataDir);
    ensurePrivateDataDir(this.dataDir);
    this.document = this.load();
    if (freshInstall && !existsSync(this.path)) {
      this.update({ onboarding: { completed: false, seenTips: [] } });
    }
  }

  holdRecovery(reason, byteLength) {
    this.recovery = Object.freeze({
      reason,
      byteLength: Number(byteLength) || 0,
      message: recoveryMessage(reason),
    });
    return clone(EMPTY_CONFIG);
  }

  load() {
    this.recovery = null;
    if (!existsSync(this.path)) return clone(DEFAULT_CONFIG);
    let stat;
    try {
      stat = statSync(this.path);
    } catch {
      return this.holdRecovery('unreadable', 0);
    }
    if (!stat.isFile()) return this.holdRecovery('not_a_file', stat.size);
    if (stat.size > MAX_CONFIG_BYTES) return this.holdRecovery('too_large', stat.size);
    let bytes;
    try {
      bytes = readFileSync(this.path);
    } catch {
      return this.holdRecovery('unreadable', stat.size);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return this.holdRecovery('malformed_json', bytes.length);
    }
    if (!isValidConfigPatch(value)) return this.holdRecovery('invalid_entries', bytes.length);
    const document = { ...clone(EMPTY_CONFIG), ...value };
    if (jsonSize(document) > MAX_CONFIG_BYTES) return this.holdRecovery('too_large', bytes.length);
    return document;
  }

  recoveryStatus() {
    if (!this.recovery) return null;
    return { ...this.recovery };
  }

  get() {
    return clone(this.document);
  }

  update(patch) {
    this.assertWritable();
    if (!isValidConfigPatch(patch)) {
      const error = new Error('Invalid config update.');
      error.code = 'invalid_config';
      throw error;
    }
    const document = { ...this.document, ...clone(patch) };
    if (patch.about !== undefined) document.about = mergeProfile(this.document.about, patch.about);
    if (patch.onboarding !== undefined) {
      document.onboarding = mergeOnboarding(this.document.onboarding, patch.onboarding);
    }
    return this.replace(document);
  }

  assertWritable() {
    if (!this.recovery) return;
    const error = new Error(this.recovery.message);
    error.code = 'config_recovery_required';
    throw error;
  }

  // Keep the original in place until the replacement succeeds, including on disk errors.
  recover() {
    if (!this.recovery) return { recovered: false, preserved: null, config: this.get() };
    const stat = statSync(this.path);
    if (!stat.isFile()) {
      const error = new Error('config.json is not a regular file, so it was not moved.');
      error.code = 'config_recovery_required';
      throw error;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let preserved = join(this.dataDir, `config.json.rejected-${stamp}`);
    let suffix = 0;
    while (existsSync(preserved)) {
      suffix += 1;
      preserved = join(this.dataDir, `config.json.rejected-${stamp}-${suffix}`);
    }
    copyFileSync(this.path, preserved, constants.COPYFILE_EXCL);
    chmodSync(preserved, 0o600);
    const recovery = this.recovery;
    this.recovery = null;
    try {
      this.replace(clone(DEFAULT_CONFIG));
    } catch (error) {
      this.recovery = recovery;
      throw error;
    }
    return { recovered: true, preserved, config: this.get() };
  }

  replace(document) {
    this.assertWritable();
    if (!isValidConfigPatch(document)) {
      const error = new Error('Config exceeds the size limit.');
      error.code = 'config_too_large';
      throw error;
    }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temporary, this.path);
    this.document = clone(document);
    return this.get();
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_CONFIG,
  STARTER_PROMPTS,
  MAX_CONFIG_BYTES,
  isValidCommand,
  isValidProject,
  isValidConfigPatch,
  recoveryMessage,
};
