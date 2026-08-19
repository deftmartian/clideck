#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { basename, join, relative, resolve } = require('path');
const { createHash } = require('crypto');
const zlib = require('zlib');

const ROOT = resolve(__dirname, '..');
const PUBLIC_ROOT = join(ROOT, 'public');
const BUILD_ROOT = join(PUBLIC_ROOT, 'build');
const INDEX_PATH = join(PUBLIC_ROOT, 'index.html');
const TEXT_ASSET_RE = /\.(?:css|js|json)$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function filesIn(directory) {
  return readdirSync(directory).filter(name => statSync(join(directory, name)).isFile()).sort();
}

function compress(filePath) {
  const source = readFileSync(filePath);
  writeFileSync(`${filePath}.gz`, zlib.gzipSync(source, { level: 9 }));
  writeFileSync(`${filePath}.br`, zlib.brotliCompressSync(source, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
}

async function buildInto(outdir) {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: {
      app: 'public/js/app.js',
      styles: 'public/client.css',
    },
    outdir,
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
  const entry = kind => {
    const found = outputs.find(([, meta]) => meta.entryPoint?.endsWith(kind));
    if (!found) throw new Error(`Missing built entry for ${kind}`);
    return basename(found[0]);
  };
  const app = entry('public/js/app.js');
  const styles = entry('public/client.css');
  const assetFiles = filesIn(outdir);
  const buildHash = createHash('sha256');
  for (const name of assetFiles) {
    buildHash.update(name).update('\0').update(readFileSync(join(outdir, name))).update('\0');
  }
  const buildId = buildHash.digest('hex').slice(0, 16);
  const manifest = {
    buildId,
    target: 'es2020',
    entrypoints: { app: `/build/${app}`, styles: `/build/${styles}` },
    files: Object.fromEntries(assetFiles.map(name => {
      const data = readFileSync(join(outdir, name));
      return [name, { bytes: data.length, sha256: sha256(data) }];
    })),
  };
  const manifestData = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestName = `manifest-${sha256(manifestData).slice(0, 16)}.json`;
  writeFileSync(join(outdir, manifestName), manifestData);
  for (const name of filesIn(outdir)) {
    if (TEXT_ASSET_RE.test(name)) compress(join(outdir, name));
  }
  return { app, styles, buildId, manifestName };
}

function renderIndex(source, build) {
  const styles = `<!-- client-build:styles:start -->\n  <link rel="stylesheet" href="/build/${build.styles}">\n  <meta name="clideck-build-id" content="${build.buildId}">\n  <!-- client-build:styles:end -->`;
  const scripts = `<!-- client-build:scripts:start -->\n  <script type="module" src="/build/${build.app}"></script>\n  <!-- client-build:scripts:end -->`;
  return source
    .replace(/<!-- client-build:styles:start -->[\s\S]*?<!-- client-build:styles:end -->/, styles)
    .replace(/<!-- client-build:scripts:start -->[\s\S]*?<!-- client-build:scripts:end -->/, scripts);
}

function compareDirectories(actual, expected) {
  const actualFiles = existsSync(actual) ? filesIn(actual) : [];
  const expectedFiles = filesIn(expected);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Generated client asset list is stale.\nactual: ${actualFiles.join(', ')}\nexpected: ${expectedFiles.join(', ')}`);
  }
  for (const name of expectedFiles) {
    const a = readFileSync(join(actual, name));
    const b = readFileSync(join(expected, name));
    if (!a.equals(b)) throw new Error(`Generated client asset is stale: ${name}`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'clideck-client-build-'));
    const temporaryBuild = join(temporaryRoot, 'build');
    try {
      const result = await buildInto(temporaryBuild);
      compareDirectories(BUILD_ROOT, temporaryBuild);
      const currentIndex = readFileSync(INDEX_PATH, 'utf8');
      if (renderIndex(currentIndex, result) !== currentIndex) throw new Error('public/index.html references stale client assets');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    process.stdout.write('client build is deterministic and current\n');
    return;
  }

  const result = await buildInto(BUILD_ROOT);
  const index = readFileSync(INDEX_PATH, 'utf8');
  writeFileSync(INDEX_PATH, renderIndex(index, result));
  process.stdout.write(`built ${result.app}, ${result.styles}, ${result.manifestName}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
