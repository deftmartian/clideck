const { readFileSync } = require('fs');
const { join } = require('path');

const PUBLIC_ROOT = join(__dirname, 'public');

function calculateClientBuildId() {
  const index = readFileSync(join(PUBLIC_ROOT, 'index.html'), 'utf8');
  const match = index.match(/<meta name="clideck-build-id" content="([0-9a-f]{16})">/);
  if (!match) throw new Error('public/index.html does not contain a generated client build ID');
  return match[1];
}

const CLIENT_BUILD_ID = calculateClientBuildId();

module.exports = { CLIENT_BUILD_ID, calculateClientBuildId };
