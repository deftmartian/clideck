const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('an explicit data directory isolates packaged preflight state', t => {
  const root = join(__dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'clideck-explicit-data-'));
  const dataDir = join(temporary, 'state');
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const result = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./paths").DATA_DIR)'], {
    cwd: root,
    env: { ...process.env, CLIDECK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result, dataDir);
  assert.equal(existsSync(dataDir), true);
});
