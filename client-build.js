const { readFileSync } = require('fs');
const { join, resolve } = require('path');

const PUBLIC_ROOT = resolve(process.env.CLIDECK_PUBLIC_ROOT || join(__dirname, 'dist', 'public'));

function calculateClientBuildId(publicRoot = PUBLIC_ROOT) {
  const indexPath = join(publicRoot, 'index.html');
  let index;
  try { index = readFileSync(indexPath, 'utf8'); }
  catch {
    throw new Error('CliDeck client assets are not staged. Run `npm run build:client` before `npm start`.');
  }
  const match = index.match(/<meta name="clideck-build-id" content="([0-9a-f]{16})">/);
  if (!match) throw new Error('CliDeck staged client assets are invalid. Run `npm run build:client` again.');
  return match[1];
}

const CLIENT_BUILD_ID = calculateClientBuildId();

module.exports = { CLIENT_BUILD_ID, calculateClientBuildId };
