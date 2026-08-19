const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = join(__dirname, '..');
const PUBLIC_ROOT = join(ROOT, 'dist', 'public');
const BUILD_ROOT = join(PUBLIC_ROOT, 'build');

function treeHash(paths) {
  const hash = createHash('sha256');
  const visit = path => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    hash.update(path.slice(ROOT.length)).update('\0').update(readFileSync(path)).update('\0');
  };
  for (const path of paths) visit(path);
  return hash.digest('hex');
}

test('staged client bundle is deterministic and within the cold-shell budget', () => {
  const sourcePaths = [
    join(ROOT, 'public', 'index.html'),
    join(ROOT, 'public', 'js'),
    join(ROOT, 'src'),
  ];
  const before = treeHash(sourcePaths);
  const output = execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.js'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /deterministic and current when staged/);
  assert.equal(treeHash(sourcePaths), before, 'client builds must not rewrite tracked sources');

  const sourceHtml = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(sourceHtml, /\/build\/(?:app|styles)-/);
  const html = readFileSync(join(PUBLIC_ROOT, 'index.html'), 'utf8');
  const entries = [
    html.match(/<script type="module" src="\/build\/([^"]+)"><\/script>/)?.[1],
    html.match(/<link rel="stylesheet" href="\/build\/([^"]+)">/)?.[1],
  ];
  assert.ok(entries.every(Boolean), 'staged HTML must reference bundled app and CSS entrypoints');
  const criticalBrotliBytes = entries.reduce(
    (total, name) => total + statSync(join(BUILD_ROOT, `${name}.br`)).size,
    0,
  );
  assert.ok(criticalBrotliBytes <= 350 * 1024, `critical Brotli assets use ${criticalBrotliBytes} bytes`);
  assert.equal(entries.length + 1 <= 8, true, 'HTML plus critical assets must fit the request budget');
  assert.ok(readdirSync(BUILD_ROOT).some(name => /^chunk-.*\.js$/.test(name)), 'WebGL must be lazy');
});

test('check detects stale staged assets and missing runtime assets fail clearly', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'clideck-stale-client-'));
  try {
    const stale = spawnSync(process.execPath, [
      join(ROOT, 'tools', 'build-client.js'), '--check', '--outdir', temporary,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /asset list is stale/);

    const missing = spawnSync(process.execPath, ['-e', "require('./client-build')"], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CLIDECK_PUBLIC_ROOT: join(temporary, 'missing') },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /client assets are not staged.*npm run build:client/s);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('npm package includes runtime files and staged assets but excludes client sources and tools', () => {
  const packResult = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  const packed = Array.isArray(packResult)
    ? packResult[0]
    : packResult.clideck || Object.values(packResult)[0];
  const files = packed.files.map(item => item.path);
  assert.ok(files.includes('server.js'));
  assert.ok(files.includes('dist/public/index.html'));
  assert.ok(files.some(file => file.startsWith('dist/public/build/app-')));
  for (const prefix of ['public/', 'src/', 'tests/', 'tools/', 'assets/', 'docs/', 'skills/']) {
    assert.equal(files.some(file => file.startsWith(prefix)), false, `package contains ${prefix}`);
  }
  assert.equal(files.includes('tailwind.config.js'), false);
});

test('favicon is a compact 64 by 64 PNG', () => {
  const icon = readFileSync(join(PUBLIC_ROOT, 'icons', 'clideck-64.png'));
  assert.ok(icon.length < 10 * 1024, `favicon uses ${icon.length} bytes`);
  assert.equal(icon.readUInt32BE(16), 64);
  assert.equal(icon.readUInt32BE(20), 64);
});
