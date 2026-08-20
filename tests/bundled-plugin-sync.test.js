const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { join } = require('path');
const os = require('os');

const root = join(__dirname, '..');

test('same-version stale bundled plugin files are refreshed from the package', t => {
  const dataDir = mkdtempSync(join(os.tmpdir(), 'clideck-bundled-plugin-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const installed = join(dataDir, 'plugins', 'trim-clip');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  cpSync(join(root, 'plugins', 'trim-clip'), installed, { recursive: true });
  writeFileSync(join(installed, 'client.js'), "import '/js/terminal-clipboard.js';\n");
  writeFileSync(join(installed, 'local-note.txt'), 'preserve unmanaged runtime files\n');

  const output = execFileSync(process.execPath, ['-e', "require('./plugin-loader')"], {
    cwd: root,
    env: { ...process.env, CLIDECK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });

  assert.match(output, /\[plugin\] refreshed 1\.3\.1 trim-clip/);
  assert.equal(
    readFileSync(join(installed, 'client.js'), 'utf8'),
    readFileSync(join(root, 'plugins', 'trim-clip', 'client.js'), 'utf8'),
  );
  assert.equal(readFileSync(join(installed, 'local-note.txt'), 'utf8'), 'preserve unmanaged runtime files\n');
});

test('plugin info exposes a content revision and revisioned URLs still resolve', t => {
  const dataDir = mkdtempSync(join(os.tmpdir(), 'clideck-plugin-revision-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const script = `
    const loader = require('./plugin-loader');
    loader.init(() => {}, () => new Map(), () => ({}), () => {}, () => {});
    const plugin = loader.getInfo().find(item => item.id === 'trim-clip');
    process.stdout.write(JSON.stringify({
      revision: plugin.clientRevision,
      resolved: loader.resolveFile('/plugins/trim-clip/client.js?v=' + plugin.clientRevision),
    }));
  `;
  const raw = execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, CLIDECK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  const result = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1));
  const expected = createHash('sha256')
    .update(readFileSync(join(root, 'plugins', 'trim-clip', 'client.js')))
    .digest('hex').slice(0, 16);

  assert.equal(result.revision, expected);
  assert.equal(result.resolved, join(dataDir, 'plugins', 'trim-clip', 'client.js'));
});
