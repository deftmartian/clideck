const CLIENT_PROTOCOL_VERSION = 4;
const CLIENT_PROTOCOL_PARAM = 'clideckProtocol';

function clientProtocolVersionFromUrl(requestUrl) {
  try {
    const raw = new URL(String(requestUrl || '/'), 'http://clideck.local')
      .searchParams.get(CLIENT_PROTOCOL_PARAM);
    if (raw === null) return undefined;
    if (raw.trim() === '') return null;
    const version = Number(raw);
    return Number.isSafeInteger(version) ? version : null;
  } catch {
    return null;
  }
}

function isClientProtocolCompatible(received, expected = CLIENT_PROTOCOL_VERSION) {
  return received === expected;
}

module.exports = {
  CLIENT_PROTOCOL_PARAM,
  CLIENT_PROTOCOL_VERSION,
  clientProtocolVersionFromUrl,
  isClientProtocolCompatible,
};
