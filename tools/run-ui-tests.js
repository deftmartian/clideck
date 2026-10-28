// Runs every fake-DOM integration suite (test-ui/*-it.mjs) in its own process; they share globals.
// Real-browser suites (*-browser.mjs) have their own npm scripts.
const { spawnSync } = require('child_process');
const { readdirSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const only = process.argv.slice(2);
const suites = readdirSync(join(root, 'test-ui'))
  .filter(name => name.endsWith('-it.mjs') && (!only.length || only.some(part => name.includes(part))))
  .sort();
const failed = [];
for (const name of suites) {
  const result = spawnSync(process.execPath, [join('test-ui', name)], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${name}`);
  if (!ok) {
    failed.push(name);
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    if (output) console.log(output.replace(/^/gm, '      '));
  }
}
console.log(`\n${suites.length - failed.length}/${suites.length} UI suites passed`);
if (failed.length) process.exitCode = 1;
