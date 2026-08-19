const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));

function pngSize(file) {
  const buffer = fs.readFileSync(path.join(root, file));
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => match[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] || null;
}

function hasRel(tag, expected) {
  return (attr(tag, 'rel') || '').split(/\s+/).includes(expected);
}

function loadWorker({ fetchImpl, cached = new Map(), cacheMatch } = {}) {
  const handlers = new Map();
  class WorkerRequest extends Request {
    constructor(input, init) {
      super(input instanceof Request ? input : new URL(input, 'https://clideck.test'), init);
    }
  }
  const cache = {
    addAll: async () => {},
    put: async (request, response) => cached.set(request.url || request, response),
  };
  const context = {
    Request: WorkerRequest,
    Response,
    URL,
    console,
    self: {
      location: { origin: 'https://clideck.test' },
      addEventListener(type, handler) { handlers.set(type, handler); },
    },
    caches: {
      match: async request => cacheMatch?.(request) ?? cached.get(request.url || request),
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: fetchImpl || (async request => ({ source: 'network', request })),
  };
  vm.runInNewContext(read('public/sw.js'), context, { filename: 'public/sw.js' });
  return { handlers, cached };
}

async function dispatchLifecycle(worker, type) {
  const handler = worker.handlers.get(type);
  assert.equal(typeof handler, 'function', `worker must install a ${type} handler`);
  let work;
  handler({ waitUntil: value => { work = Promise.resolve(value); } });
  await work;
}

async function dispatchFetch(worker, request) {
  const handler = worker.handlers.get('fetch');
  assert.equal(typeof handler, 'function', 'worker must install a fetch handler');
  let response;
  handler({ request, respondWith: value => { response = Promise.resolve(value); } });
  return response;
}

test('manifest describes a standalone CliDeck with installable and maskable icons', () => {
  assert.equal(exists('public/manifest.webmanifest'), true, 'the manifest must be served from public/');
  const manifest = JSON.parse(read('public/manifest.webmanifest'));

  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.trim());
  assert.equal(typeof manifest.short_name, 'string');
  assert.ok(manifest.short_name.trim());
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons));

  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find(candidate =>
      String(candidate.sizes || '').split(/\s+/).includes(size));
    assert.ok(icon, `manifest needs a ${size} icon`);
    assert.equal(typeof icon.src, 'string');
    const iconPath = `public/${icon.src.replace(/^\//, '')}`;
    assert.ok(exists(iconPath), `${size} icon must exist`);
    assert.equal(pngSize(iconPath), size, `${size} declaration must match the image`);
  }

  const maskable = manifest.icons.find(icon =>
    String(icon.purpose || '').split(/\s+/).includes('maskable'));
  assert.ok(maskable, 'manifest needs a maskable icon');
  assert.equal(typeof maskable.src, 'string');
  assert.ok(exists(`public/${maskable.src.replace(/^\//, '')}`), 'maskable icon must exist');
});

test('document exposes the PWA manifest and installed-app metadata', () => {
  const index = read('public/index.html');
  const links = tags(index, 'link');
  const metas = tags(index, 'meta');

  const manifestLink = links.find(link => hasRel(link, 'manifest'));
  assert.ok(manifestLink, 'index must link the manifest');
  assert.equal(attr(manifestLink, 'href'), '/manifest.webmanifest');

  const themeColor = metas.find(meta => attr(meta, 'name') === 'theme-color');
  assert.ok(themeColor, 'index must define a browser theme color');
  assert.ok(attr(themeColor, 'content'));

  const appleIcon = links.find(link => hasRel(link, 'apple-touch-icon'));
  assert.ok(appleIcon, 'index must include an Apple touch icon');
  assert.ok(attr(appleIcon, 'href'));
  assert.ok(exists(`public/${attr(appleIcon, 'href').replace(/^\//, '')}`));

  const appleCapable = metas.find(meta => attr(meta, 'name') === 'apple-mobile-web-app-capable');
  assert.ok(appleCapable, 'index must opt into Apple standalone mode');
  assert.equal((attr(appleCapable, 'content') || '').toLowerCase(), 'yes');
});

test('client registers a root-scoped service worker and surfaces a waiting update', () => {
  const app = read('public/js/app.js');
  const pwa = read('public/js/pwa.js');

  assert.match(app, /registerPwa\(\)/);
  assert.match(pwa, /navigator\.serviceWorker\.register\(\s*['"]\/sw\.js['"]/);
  assert.match(pwa, /updatefound|waiting|controllerchange/, 'registration must observe worker updates');
  assert.match(
    pwa,
    /pwa-update-banner[\s\S]{0,800}(?:update|Update)|(?:update|Update)[\s\S]{0,800}pwa-update-banner/,
    'a waiting update must reach UI code rather than silently forcing a reload',
  );
});

test('service worker is foreground-first: network navigation falls back to a minimal offline response', async () => {
  assert.equal(exists('public/sw.js'), true, 'service worker must live at the root scope');
  const worker = read('public/sw.js');

  assert.match(worker, /addEventListener\(\s*['"]fetch['"]/);
  assert.match(worker, /request\.mode\s*!==\s*['"]navigate['"]/);
  assert.match(worker, /offline/i, 'the fallback must be explicitly offline-oriented');

  const networkResponse = { source: 'network' };
  const online = loadWorker({ fetchImpl: async () => networkResponse });
  const navigation = { url: 'https://clideck.test/', method: 'GET', mode: 'navigate' };
  assert.equal(await dispatchFetch(online, navigation), networkResponse, 'navigation must prefer the network');

  const authenticationRedirect = { source: 'authentication', status: 302 };
  const signedOut = loadWorker({ fetchImpl: async () => authenticationRedirect });
  assert.equal(
    await dispatchFetch(signedOut, navigation),
    authenticationRedirect,
    'an authentication response must pass through instead of looking offline',
  );

  const offlineResponse = { source: 'offline-fallback' };
  const offline = loadWorker({
    fetchImpl: async () => { throw new Error('offline'); },
    cacheMatch: request => /offline/i.test(String(request.url || request)) ? offlineResponse : undefined,
  });
  assert.equal(
    await dispatchFetch(offline, navigation),
    offlineResponse,
    'navigation must provide the cached offline fallback when the network fails',
  );
});

test('service worker installation caches only a validated same-origin offline page', async () => {
  let offlineRequest;
  const worker = loadWorker({
    fetchImpl: async request => {
      offlineRequest = request;
      return new Response('<!doctype html><title>Offline</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  });

  await dispatchLifecycle(worker, 'install');
  assert.equal(offlineRequest.url, 'https://clideck.test/offline.html');
  assert.equal(offlineRequest.credentials, 'same-origin');
  assert.equal(offlineRequest.redirect, 'error');
  assert.equal(worker.cached.has('/offline.html'), true);

  const redirected = loadWorker({
    fetchImpl: async () => new Response('', {
      status: 302,
      headers: { Location: 'https://auth.example.test/' },
    }),
  });
  await assert.rejects(dispatchLifecycle(redirected, 'install'));
  assert.equal(redirected.cached.size, 0);
});

test('service worker never intercepts mutable app, transcript, API, or WebSocket requests', async () => {
  assert.equal(exists('public/sw.js'), true, 'service worker must live at the root scope');
  const worker = loadWorker();

  for (const request of [
    { url: 'https://clideck.test/js/app.js', method: 'GET', mode: 'same-origin' },
    { url: 'https://clideck.test/api/session/agents', method: 'GET', mode: 'same-origin' },
    { url: 'https://clideck.test/transcripts/session-1', method: 'GET', mode: 'same-origin' },
    { url: 'wss://clideck.test/', method: 'GET', mode: 'websocket' },
  ]) {
    assert.equal(
      await dispatchFetch(worker, request),
      undefined,
      `${request.url} must remain a live request, not a service-worker response`,
    );
  }
});

test('service worker updates never take over or reload an active terminal automatically', () => {
  const worker = read('public/sw.js');
  const app = read('public/js/app.js');
  const pwa = read('public/js/pwa.js');

  assert.match(
    worker,
    /addEventListener\(\s*['"]message['"][\s\S]{0,240}ACTIVATE_UPDATE[\s\S]{0,120}skipWaiting\s*\(/,
    'skipWaiting is allowed only after the user requests activation',
  );
  const beforeMessageHandler = worker.split(/addEventListener\(\s*['"]message['"]/)[0];
  assert.doesNotMatch(beforeMessageHandler, /skipWaiting\s*\(/);
  assert.doesNotMatch(worker, /clients\.claim\s*\(/);
  assert.doesNotMatch(app, /(?:window\.)?location\.reload\s*\(/);
  assert.doesNotMatch(
    pwa,
    /(?:controllerchange|updatefound|statechange)[\s\S]{0,320}(?:window\.)?location\.reload\s*\(/,
    'worker lifecycle events must not reload an active terminal',
  );
  assert.match(
    pwa,
    /updateAction\?\.addEventListener\(\s*['"]click['"][\s\S]{0,260}(?:window\.)?location\.reload\s*\(/,
    'reload is available behind an explicit user action',
  );
});

test('server serves the web manifest with its PWA MIME type', () => {
  const serverStatic = read('server-static.js');
  assert.match(
    serverStatic,
    /['"]\.webmanifest['"]\s*:\s*['"]application\/manifest\+json(?:;[^'"]*)?['"]/,
  );
  assert.match(serverStatic, /['"]Cache-Control['"]:\s*['"]no-cache['"]/);
  assert.match(serverStatic, /req\.headers\[['"]if-none-match['"]\]/);
});

test('worker cache is limited to an inert offline fallback', () => {
  const worker = read('public/sw.js');
  const offline = read('public/offline.html');

  assert.match(worker, /OFFLINE_URL\s*=\s*['"]\/offline\.html['"]/);
  assert.match(worker, /cache\.put\(\s*OFFLINE_URL/);
  assert.doesNotMatch(worker, /cache\.addAll\s*\(/);
  assert.doesNotMatch(worker, /['"]\/(?:js|api|plugins|xterm|tailwind|transcript)/);
  assert.doesNotMatch(offline, /<script\b|\son\w+\s*=/i);
});

test('protocol compatibility gates queued mutations until server config arrives', () => {
  const { CLIENT_BUILD_ID, calculateClientBuildId } = require('../client-build');
  const {
    CLIENT_PROTOCOL_PARAM,
    CLIENT_PROTOCOL_VERSION,
    clientProtocolVersionFromUrl,
    isClientProtocolCompatible,
  } = require('../protocol');
  const protocol = read('protocol.js');
  const server = read('server.js');
  const protocolGate = read('server-protocol-gate.js');
  const handlers = read('handlers.js');
  const state = read('public/js/state.js');
  const app = read('public/js/app.js');
  const connectionClient = read('public/js/connection-client.js');

  assert.match(CLIENT_BUILD_ID, /^[a-f0-9]{16}$/);
  assert.equal(calculateClientBuildId(), CLIENT_BUILD_ID);
  const serverProtocol = Number(protocol.match(/CLIENT_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]);
  const clientProtocol = Number(connectionClient.match(/CLIENT_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]);
  assert.equal(clientProtocol, serverProtocol, 'client and server protocol constants must move together');
  assert.equal(serverProtocol, CLIENT_PROTOCOL_VERSION);
  assert.equal(serverProtocol, 3, 'subscription recovery requires protocol v3');
  assert.equal(clientProtocolVersionFromUrl(`/?${CLIENT_PROTOCOL_PARAM}=2`), 2);
  assert.equal(clientProtocolVersionFromUrl(`/?${CLIENT_PROTOCOL_PARAM}=1`), 1);
  assert.equal(clientProtocolVersionFromUrl('/'), undefined);
  assert.equal(clientProtocolVersionFromUrl(`/?${CLIENT_PROTOCOL_PARAM}=not-a-number`), null);
  assert.equal(isClientProtocolCompatible(undefined, 2), false);
  assert.equal(isClientProtocolCompatible(1, 2), false);
  assert.equal(isClientProtocolCompatible(2, 2), true);
  assert.equal(isClientProtocolCompatible(3, 2), false);
  assert.match(connectionClient, /searchParams\.set\(CLIENT_PROTOCOL_PARAM,\s*String\(CLIENT_PROTOCOL_VERSION\)\)/);
  assert.match(server, /acceptClient\(ws,\s*req,/);
  assert.match(protocolGate, /isClientProtocolCompatible\(receivedProtocolVersion\)/);
  assert.match(protocolGate, /type:\s*['"]protocol\.incompatible['"]/);
  assert.match(protocolGate, /ws\.close\(1008,/);
  assert.match(handlers, /buildId:\s*CLIENT_BUILD_ID/);
  assert.match(handlers, /protocolVersion:\s*CLIENT_PROTOCOL_VERSION/);
  assert.match(state, /state\.protocolReady\s*&&\s*state\.ws/);
  assert.match(connectionClient, /serverProtocol\s*!==\s*CLIENT_PROTOCOL_VERSION/);
  assert.match(app, /case\s+['"]protocol\.incompatible['"]/);
  assert.match(state, /if\s*\(state\.protocolBlocked\)\s*return false/);
  assert.match(connectionClient, /discardQueuedSends\(\)/);
  assert.match(
    connectionClient,
    /serverProtocol\s*!==[\s\S]{0,900}state\.protocolReady\s*=\s*true[\s\S]{0,900}flushQueuedSends\(\)/,
    'queued mutations flush only after compatibility succeeds',
  );
  const onOpen = app.match(/ws\.onopen\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \};/)?.[1] || '';
  assert.doesNotMatch(onOpen, /flushQueuedSends/);
});

test('terminal input is never queued while reconnecting', async () => {
  const source = read('public/js/state.js').replace(
    /import \{ countPerf \} from ['"]\.\/perf\.js['"];?/,
    'const countPerf = () => {};',
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const previousWebSocket = global.WebSocket;
  global.WebSocket = { OPEN: 1 };
  try {
    const { state, send, discardQueuedSends, flushQueuedSends } = await import(moduleUrl);
    const sent = [];
    state.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) };

    assert.equal(send({ type: 'input', id: 'session-1', data: 'dangerous replay' }), false);
    assert.equal(send({ type: 'create', name: 'safe queued action' }), true);
    assert.deepEqual(sent, []);

    state.protocolReady = true;
    flushQueuedSends();
    assert.deepEqual(sent, [{ type: 'create', name: 'safe queued action' }]);

    state.protocolBlocked = true;
    assert.equal(send({ type: 'create', name: 'incompatible action' }), false);
    discardQueuedSends();
    flushQueuedSends();
    assert.equal(sent.some(msg => msg.name === 'incompatible action'), false);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test('connection diagnostics distinguish offline, server, and authentication failures', () => {
  const localHttp = read('server-http-local.js');
  const pwa = read('public/js/pwa.js');
  const app = read('public/js/app.js');
  const connectionClient = read('public/js/connection-client.js');

  assert.match(localHttp, /req\.url\s*===\s*['"]\/api\/health['"]/);
  assert.match(localHttp, /['"]Cache-Control['"]:\s*['"]no-store['"]/);
  assert.match(pwa, /response\.type\s*===\s*['"]opaqueredirect['"]/);
  for (const state of ['offline', 'unavailable', 'auth', 'incompatible']) {
    assert.match(pwa, new RegExp(`\\b${state}:`));
  }
  assert.match(connectionClient, /diagnoseConnectionFailure\(\)/);
  assert.match(connectionClient, /Terminal input is not queued/);
  assert.match(app, /createConnectionClient\(/);
});

test('terminal gaps request a protocol snapshot without reloading the page', () => {
  const app = read('public/js/app.js');
  const pwa = read('public/js/pwa.js');
  const connectionClient = read('public/js/connection-client.js');
  const recoveryClient = read('public/js/terminal-recovery-client.js');

  assert.match(pwa, /export function requirePageReload\(message\)/);
  assert.match(pwa, /showReloadReady\(message,\s*\{\s*required:\s*true\s*\}\)/);
  assert.match(pwa, /dataset\.reloadRequired\s*===\s*['"]true['"]/);
  assert.match(pwa, /if\s*\(required\)\s*document\.body\.dataset\.reloadRequired\s*=\s*['"]true['"]/);
  assert.match(pwa, /if\s*\(!worker\s*\|\|\s*isReloadMandatory\(\)\)\s*return/);
  assert.match(app, /createTerminalRecoveryClient\(\{/);
  assert.match(recoveryClient, /requestResync\(sessionId, recovery\.status\)/);
  assert.match(app, /function requestTerminalSnapshot\(id\)/);
  assert.match(app, /replay:\s*['"]snapshot['"]/);
  assert.doesNotMatch(recoveryClient, /requireReload/);
  assert.match(connectionClient, /state\.protocolBlocked\s*=\s*true/);
  assert.match(connectionClient, /if\s*\(connectionBlocked\s*\|\|\s*state\.protocolBlocked\)\s*return null/);
  assert.doesNotMatch(connectionClient, /state\.protocolBlocked\s*=\s*false/);
  assert.match(recoveryClient, /recovery\.status !== ['"]gap['"]/);
  assert.match(recoveryClient, /recovery\.status !== ['"]legacy-gap['"]/);
});

test('a mandatory reload cannot be downgraded by worker or version notifications', async () => {
  const source = read('public/js/pwa.js');
  const ids = [
    'pwa-update-banner',
    'pwa-update-message',
    'pwa-update-action',
    'pwa-update-dismiss',
    'connection-banner',
    'connection-message',
    'connection-action',
  ];
  const elements = new Map(ids.map(id => [id, {
    id,
    hidden: false,
    textContent: '',
    disabled: false,
    dataset: {},
    addEventListener() {},
  }]));
  const classes = new Set();
  const body = {
    dataset: {},
    classList: {
      add: name => classes.add(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const registration = {
    waiting: { postMessage() {} },
    addEventListener() {},
    update: () => Promise.resolve(),
  };
  const descriptors = new Map();
  const replaceGlobal = (name, value) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  replaceGlobal('document', {
    body,
    activeElement: { blur() {} },
    getElementById: id => elements.get(id) || null,
    addEventListener() {},
  });
  replaceGlobal('window', {
    isSecureContext: true,
    addEventListener() {},
    dispatchEvent() {},
    location: { reload() {}, assign() {} },
  });
  replaceGlobal('navigator', {
    onLine: true,
    serviceWorker: {
      addEventListener() {},
      register: () => Promise.resolve(registration),
    },
  });

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#mandatory-${Date.now()}`;
    const pwa = await import(moduleUrl);
    pwa.requirePageReload('Terminal recovery requires a reload.');
    pwa.registerPwa();
    await new Promise(resolve => setImmediate(resolve));
    pwa.noteServerVersion('1.32.0', 'initial-build');
    pwa.noteServerVersion('1.32.0', 'replacement-build');
    pwa.showConnectionState('connected');

    assert.equal(elements.get('pwa-update-banner').hidden, false);
    assert.equal(elements.get('pwa-update-message').textContent, 'Terminal recovery requires a reload.');
    assert.equal(elements.get('pwa-update-action').textContent, 'Reload now');
    assert.equal(elements.get('pwa-update-dismiss').hidden, true);
    assert.equal(body.dataset.reloadRequired, 'true');
    assert.equal(classes.has('protocol-incompatible'), true);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('foreground reconnect uses protocol-v3 cursors and server snapshots', async () => {
  const source = read('public/js/terminal-recovery.js');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const {
    commitTerminalHistory,
    commitTerminalReplay,
    noteTerminalLiveOutput,
    planTerminalHistory,
    planTerminalReplay,
  } = await import(moduleUrl);
  const entry = {
    replayInitialized: true,
    outputGeneration: 'generation-1',
    lastOutputSeq: 2 * 1024 * 1024,
    scrolledUp: true,
  };
  const replay = 'A'.repeat(2 * 1024 * 1024);
  const missed = 'A';
  const meta = {
    generation: 'generation-1',
    startSeq: 1,
    endSeq: replay.length + 1,
  };

  const delta = planTerminalReplay(entry, replay, meta);
  assert.deepEqual(delta, {
    status: 'delta',
    data: missed,
    nextGeneration: 'generation-1',
    nextSeq: replay.length + 1,
  });
  commitTerminalReplay(entry, delta);
  assert.equal(entry.lastOutputSeq, replay.length + 1);
  assert.equal(entry.scrolledUp, true, 'recovery must not move a user reading scrollback');

  const current = planTerminalReplay(entry, replay, meta);
  assert.equal(current.status, 'current');
  assert.equal(current.data, '');

  const gap = planTerminalReplay(entry, replay, {
    ...meta,
    startSeq: entry.lastOutputSeq + 1,
    endSeq: entry.lastOutputSeq + 1 + replay.length,
  });
  assert.equal(gap.status, 'gap');
  assert.equal(gap.data, '', 'a server-buffer gap must preserve the local terminal');

  const legacyFresh = {};
  const initial = planTerminalReplay(legacyFresh, 'legacy replay');
  assert.equal(initial.status, 'initial');
  commitTerminalReplay(legacyFresh, initial);
  assert.equal(planTerminalReplay(legacyFresh, 'legacy replay').status, 'legacy-gap');

  const live = {};
  noteTerminalLiveOutput(live, 'same', {
    generation: 'generation-2', startSeq: 0, endSeq: 4,
  });
  assert.equal(live.outputGeneration, 'generation-2');
  assert.equal(live.lastOutputSeq, 4);

  const historyEntry = {};
  const historyInitial = planTerminalHistory(
    historyEntry,
    'formatted transcript',
    { snapshotId: 'snapshot-1' },
  );
  assert.equal(historyInitial.status, 'initial');
  commitTerminalHistory(historyEntry, historyInitial);
  assert.equal(
    planTerminalHistory(historyEntry, 'formatted transcript', { snapshotId: 'snapshot-1' }).status,
    'current',
  );
  assert.equal(
    planTerminalHistory(historyEntry, 'changed transcript', { snapshotId: 'snapshot-2' }).status,
    'gap',
  );
  assert.equal(
    planTerminalHistory(
      { replayInitialized: true },
      'formatted history after raw terminal output',
      { snapshotId: 'snapshot-after-restart' },
    ).status,
    'gap',
    'history must not be appended to an already-rendered raw terminal',
  );

  const app = read('public/js/app.js');
  const recoveryClient = read('public/js/terminal-recovery-client.js');
  assert.match(recoveryClient, /planTerminalReplay\(entry,\s*output,\s*message\)/);
  assert.match(recoveryClient, /planTerminalHistory\(entry,\s*historyText,\s*message\)/);
  assert.match(recoveryClient, /noteTerminalLiveOutput\(entry,\s*message\.data,\s*message\)/);
  assert.match(recoveryClient, /function handleSnapshot\(entry, message\)/);
  assert.match(recoveryClient, /entry\.term\.reset\(\)/);
  assert.match(app, /terminalRecovery\.handleOutput\(ws, entry, msg\)/);
  assert.match(app, /terminalRecovery\.handleSnapshot\(entry, msg\)/);
  assert.match(app, /terminalRecovery\.handleSubscribed\(state\.terms\.get\(msg\.id\), msg\)/);
  assert.match(app, /case ['"]session\.resyncRequired['"]/);
  assert.match(app, /if\s*\(output\)\s*markUnread\(msg\.id\)/);
  assert.doesNotMatch(
    app,
    /msg\.replay\s*&&[\s\S]{0,120}\.has\(msg\.id\)[\s\S]{0,80}\bbreak\b/,
    'reconnect must not discard the server snapshot for an existing terminal',
  );
});

test('foreground recovery has a guarded focus fallback and repaints the terminal surface', () => {
  const compactNavigation = read('public/js/compact-navigation.js');
  const terminalLocal = read('public/js/terminal-local.js');

  assert.match(compactNavigation, /window\.addEventListener\(['"]blur['"]/);
  assert.match(compactNavigation, /window\.addEventListener\(['"]focus['"]/);
  assert.match(
    compactNavigation,
    /Date\.now\(\)\s*-\s*blurredAt\s*>=\s*1000[\s\S]{0,160}readyState\s*!==\s*WebSocket\.OPEN[\s\S]{0,120}reconnect\(\)/,
  );
  assert.match(terminalLocal, /function recoverActiveTerminalSurface\(\)/);
  assert.match(terminalLocal, /clearTextureAtlas/);
  assert.match(terminalLocal, /\.refresh\(0,\s*Math\.max\(0,\s*entry\.term\.rows\s*-\s*1\)\)/);
  assert.match(
    terminalLocal,
    /visibilitychange[\s\S]{0,160}recoverActiveTerminalSurface\(\)/,
  );
});
