#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const {
  cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} = require('fs');
const { execFileSync } = require('child_process');
const { tmpdir } = require('os');
const { basename, dirname, join, relative, resolve } = require('path');
const { createHash } = require('crypto');
const zlib = require('zlib');

const ROOT = resolve(__dirname, '..');
const SOURCE_PUBLIC = join(ROOT, 'public');
const DEFAULT_PUBLIC = join(ROOT, 'dist', 'public');
const CSS_STAGE = join(ROOT, 'dist', '.client-build', 'tailwind.css');
const INDEX_TEMPLATE = join(SOURCE_PUBLIC, 'index.html');
const TEXT_ASSET_RE = /\.(?:css|js|json)$/;
const STATIC_FILES = [
  'fx/agent-dispatch-ambient.mp3',
  'fx/agent-dispatch-soft.mp3',
  'fx/bold-beep-idle.mp3',
  'fx/default-beep.mp3',
  'fx/echo-beep-idle.mp3',
  'fx/musical-beep-idle.mp3',
  'fx/small-bleep-idle.mp3',
  'fx/soft-beep.mp3',
  'fx/space-idle.mp3',
  'icons/clideck-64.png',
  'icons/clideck-192.png',
  'icons/clideck-512.png',
  'icons/clideck-apple-180.png',
  'icons/clideck-maskable-512.png',
  'img/antigravity.svg',
  'img/claude-all.png',
  'img/claude-code.png',
  'img/clideck-agent-dark.svg',
  'img/clideck-agent-light.svg',
  'img/clideck-logo-icon.png',
  'img/clideck-logo-terminal-panel.png',
  'img/codex-dark.png',
  'img/codex-light.png',
  'img/gemini-all.png',
  'img/grok.svg',
  'img/opencode-all.png',
  'img/pi.svg',
  'manifest.webmanifest',
  'offline.html',
  'sw.js',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function filesIn(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push(relative(directory, absolute).replaceAll('\\', '/'));
    }
  };
  visit(directory);
  return files;
}

function compress(filePath) {
  const source = readFileSync(filePath);
  writeFileSync(`${filePath}.gz`, zlib.gzipSync(source, { level: 9, mtime: 0 }));
  writeFileSync(`${filePath}.br`, zlib.brotliCompressSync(source, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
}

function buildTailwind(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(process.execPath, [
    require.resolve('tailwindcss/lib/cli.js'),
    '-c', join(ROOT, 'tailwind.config.js'),
    '-i', join(ROOT, 'src', 'input.css'),
    '-o', outputPath,
    '--minify',
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
}

function copyStatic(publicRoot) {
  for (const sourceRelative of STATIC_FILES) {
    const source = join(SOURCE_PUBLIC, sourceRelative);
    if (!existsSync(source)) throw new Error(`Missing allowlisted client asset: public/${sourceRelative}`);
    const destination = join(publicRoot, sourceRelative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
}

async function buildInto(publicRoot) {
  rmSync(publicRoot, { recursive: true, force: true });
  mkdirSync(publicRoot, { recursive: true });
  copyStatic(publicRoot);

  const workspace = mkdtempSync(join(tmpdir(), 'clideck-client-source-'));
  const buildRoot = join(publicRoot, 'build');
  try {
    const tailwindPath = join(workspace, 'tailwind.css');
    const stylesPath = join(workspace, 'client.css');
    buildTailwind(tailwindPath);
    writeFileSync(
      stylesPath,
      `@import ${JSON.stringify(require.resolve('@xterm/xterm/css/xterm.css'))};\n@import ${JSON.stringify(tailwindPath)};\n`,
    );
    const result = await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: {
        app: 'public/js/app.js',
        styles: stylesPath,
      },
      outdir: buildRoot,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      charset: 'utf8',
      entryNames: '[name]-[hash]',
      chunkNames: 'chunk-[name]-[hash]',
      assetNames: 'asset-[name]-[hash]',
      metafile: true,
      logLevel: 'silent',
    });

    const outputs = Object.entries(result.metafile.outputs);
    const entry = name => {
      const found = outputs.find(([, meta]) => basename(meta.entryPoint || '') === name);
      if (!found) throw new Error(`Missing built entry for ${name}`);
      return basename(found[0]);
    };
    const app = entry('app.js');
    const styles = entry('client.css');
    const assetFiles = filesIn(buildRoot);
    const buildHash = createHash('sha256');
    for (const name of assetFiles) {
      buildHash.update(name).update('\0').update(readFileSync(join(buildRoot, name))).update('\0');
    }
    const buildId = buildHash.digest('hex').slice(0, 16);
    const manifest = {
      buildId,
      target: 'es2020',
      entrypoints: { app: `/build/${app}`, styles: `/build/${styles}` },
      files: Object.fromEntries(assetFiles.map(name => {
        const data = readFileSync(join(buildRoot, name));
        return [name, { bytes: data.length, sha256: sha256(data) }];
      })),
    };
    const manifestData = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestName = `manifest-${sha256(manifestData).slice(0, 16)}.json`;
    writeFileSync(join(buildRoot, manifestName), manifestData);
    for (const name of filesIn(buildRoot)) {
      if (TEXT_ASSET_RE.test(name)) compress(join(buildRoot, name));
    }
    const index = renderIndex(readFileSync(INDEX_TEMPLATE, 'utf8'), {
      app, styles, buildId,
    });
    writeFileSync(join(publicRoot, 'index.html'), index);
    return { app, styles, buildId, manifestName };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function renderIndex(source, build) {
  const styles = `<!-- client-build:styles:start -->\n  <link rel="stylesheet" href="/build/${build.styles}">\n  <meta name="clideck-build-id" content="${build.buildId}">\n  <!-- client-build:styles:end -->`;
  const scripts = `<!-- client-build:scripts:start -->\n  <script type="module" src="/build/${build.app}"></script>\n  <!-- client-build:scripts:end -->`;
  return source
    .replace(/<!-- client-build:styles:start -->[\s\S]*?<!-- client-build:styles:end -->/, styles)
    .replace(/<!-- client-build:scripts:start -->[\s\S]*?<!-- client-build:scripts:end -->/, scripts);
}

function compareDirectories(actual, expected, label = 'Staged client') {
  const actualFiles = filesIn(actual);
  const expectedFiles = filesIn(expected);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${label} asset list is stale.\nactual: ${actualFiles.join(', ')}\nexpected: ${expectedFiles.join(', ')}`);
  }
  for (const name of expectedFiles) {
    const a = readFileSync(join(actual, name));
    const b = readFileSync(join(expected, name));
    if (!a.equals(b)) throw new Error(`${label} asset is stale: ${name}`);
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes('--css-only')) {
    buildTailwind(CSS_STAGE);
    process.stdout.write(`built ${relative(ROOT, CSS_STAGE)}\n`);
    return;
  }
  const outdir = resolve(optionValue('--outdir') || DEFAULT_PUBLIC);
  if (process.argv.includes('--check')) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'clideck-client-check-'));
    const first = join(temporaryRoot, 'first');
    const second = join(temporaryRoot, 'second');
    try {
      await buildInto(first);
      await buildInto(second);
      compareDirectories(first, second, 'Repeated client build');
      if (existsSync(outdir)) compareDirectories(outdir, first);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    process.stdout.write('client build is deterministic and current when staged\n');
    return;
  }

  const result = await buildInto(outdir);
  process.stdout.write(`built ${result.app}, ${result.styles}, ${result.manifestName} in ${relative(ROOT, outdir)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
