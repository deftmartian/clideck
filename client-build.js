const { createHash } = require('crypto');
const { readFileSync, readdirSync } = require('fs');
const { join, relative } = require('path');

const PUBLIC_ROOT = join(__dirname, 'public');

function clientAssetPaths() {
  const fixed = [
    join(PUBLIC_ROOT, 'index.html'),
    join(PUBLIC_ROOT, 'manifest.webmanifest'),
    join(PUBLIC_ROOT, 'offline.html'),
    join(PUBLIC_ROOT, 'sw.js'),
    join(PUBLIC_ROOT, 'tailwind.css'),
  ];
  const modules = readdirSync(join(PUBLIC_ROOT, 'js'))
    .filter(name => name.endsWith('.js'))
    .sort()
    .map(name => join(PUBLIC_ROOT, 'js', name));
  return [...fixed, ...modules];
}

function calculateClientBuildId() {
  const hash = createHash('sha256');
  for (const filePath of clientAssetPaths()) {
    hash.update(relative(PUBLIC_ROOT, filePath));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const CLIENT_BUILD_ID = calculateClientBuildId();

module.exports = { CLIENT_BUILD_ID, calculateClientBuildId };
