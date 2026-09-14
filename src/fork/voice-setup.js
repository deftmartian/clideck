'use strict';
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');

function parseSetupArgs(args) {
  const options = { voiceDir: join(homedir(), '.clideck-next', 'plugin-data', 'voice-input'), check: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') options.check = true;
    else if (args[i] === '--voice-dir' && args[i + 1] && !args[i + 1].startsWith('--')) options.voiceDir = resolve(args[++i]);
    else if (args[i] === '--help') options.help = true;
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  return options;
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code}).`)));
  });
}
async function runSetup(args, execute = run) {
  const options = parseSetupArgs(args);
  if (options.help) { console.log('Usage: clideck-voice-setup [--voice-dir PATH] [--check]\nSetup installs pinned Linux speech dependencies and downloads the small model. --check stays offline and changes nothing.'); return; }
  if (process.platform !== 'linux') throw new Error('Local voice setup requires Linux. Use the OpenAI backend on other platforms.');
  const venv = join(options.voiceDir, '.venv'), python = join(venv, 'bin', 'python3');
  const assets = resolve(__dirname, '../../plugins/voice-input/python');
  if (!options.check) {
    mkdirSync(options.voiceDir, { recursive: true, mode: 0o700 });
    if (!existsSync(python)) await execute('python3', ['-m', 'venv', venv]);
    await execute(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(assets, 'requirements.txt')]);
  } else if (!existsSync(python)) throw new Error('Local voice is not installed. Run clideck-voice-setup first.');
  await execute(python, [join(assets, 'worker.py'), options.check ? '--check' : '--prepare-model']);
}
module.exports = { parseSetupArgs, runSetup };
