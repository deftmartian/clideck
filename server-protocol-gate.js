const {
  CLIENT_PROTOCOL_VERSION,
  clientProtocolVersionFromUrl,
  isClientProtocolCompatible,
} = require('./protocol');
const { CLIENT_BUILD_ID } = require('./client-build');

function acceptClient(ws, req, { onConnection, version }) {
  const receivedProtocolVersion = clientProtocolVersionFromUrl(req.url);
  if (isClientProtocolCompatible(receivedProtocolVersion)) {
    onConnection(ws);
    return;
  }

  const payload = JSON.stringify({
    type: 'protocol.incompatible',
    expectedProtocolVersion: CLIENT_PROTOCOL_VERSION,
    receivedProtocolVersion: receivedProtocolVersion ?? null,
    version,
    buildId: CLIENT_BUILD_ID,
  });
  const close = () => {
    try { ws.close(1008, 'unsupported CliDeck client protocol'); } catch {}
  };
  try { ws.send(payload, close); } catch { close(); }
}

module.exports = { acceptClient };
