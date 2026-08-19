const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const BUILD_ROOT = join(ROOT, 'public', 'build');

test('committed client bundle is deterministic and within the cold-shell budget', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'tools', 'build-client.js'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /deterministic and current/);

  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const entries = [
    html.match(/<script type="module" src="\/build\/([^"]+)"><\/script>/)?.[1],
    html.match(/<link rel="stylesheet" href="\/build\/([^"]+)">/)?.[1],
  ];
  assert.ok(entries.every(Boolean), 'HTML must reference bundled app and CSS entrypoints');
  const criticalBrotliBytes = entries.reduce(
    (total, name) => total + statSync(join(BUILD_ROOT, `${name}.br`)).size,
    0,
  );
  assert.ok(criticalBrotliBytes <= 350 * 1024, `critical Brotli assets use ${criticalBrotliBytes} bytes`);
  assert.equal(entries.length + 1 <= 8, true, 'HTML plus critical assets must fit the request budget');

  const webgl = readdirSync(BUILD_ROOT).filter(name => /^chunk-.*\.js$/.test(name));
  assert.ok(webgl.length >= 1, 'WebGL must be emitted as a lazy chunk');
});

test('favicon is a compact 64 by 64 PNG', () => {
  const icon = readFileSync(join(ROOT, 'public', 'icons', 'clideck-64.png'));
  assert.ok(icon.length < 10 * 1024, `favicon uses ${icon.length} bytes`);
  assert.equal(icon.readUInt32BE(16), 64);
  assert.equal(icon.readUInt32BE(20), 64);
});
