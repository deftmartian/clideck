import { state, send, discardQueuedSends, flushQueuedSends } from './state.js';
import {
  diagnoseConnectionFailure,
  noteServerVersion,
  showConnectionState,
} from './pwa.js';
import { perfEnabled } from './perf.js';

const CLIENT_PROTOCOL_VERSION = 3;
const CLIENT_PROTOCOL_PARAM = 'clideckProtocol';

export function createConnectionClient({ connect }) {
  let reconnectTimer = null;
  let lastForegroundReconnectAt = 0;
  let connectionBlocked = false;
  let saveTimer = null;
  let stableTimer = null;
  let consecutiveFailures = 0;
  let reconnectAttempt = 0;
  let diagnosticAttempt = 0;
  const retryDelays = [250, 500, 1000, 2000, 5000];

  function clearReconnectTimer() {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function setConnectionState(connectionState) {
    const element = document.getElementById('save-indicator');
    if (!element) return;
    const connected = connectionState === 'connected';
    const tooltips = {
      connecting: 'Connecting to CliDeck. Terminal input is not queued.',
      reconnecting: 'Connection interrupted. Reconnecting; terminal input is not queued.',
      offline: 'This phone is offline. Agents continue on the VM; terminal input is not queued.',
      unavailable: 'CliDeck server unavailable. Agents may still be running; terminal input is not queued.',
      auth: 'Your sign-in expired. Sign in again to reconnect.',
      incompatible: 'CliDeck was updated. Reload before sending commands.',
    };
    element.dataset.connectionState = connectionState;
    element.classList.toggle('offline', !connected);
    if (!connected) {
      clearTimeout(saveTimer);
      element.classList.remove('saving', 'saved');
    }
    element.title = connected ? 'Sessions saved' : '';
    if (connected) element.removeAttribute('data-tooltip');
    else element.dataset.tooltip = tooltips[connectionState] || tooltips.reconnecting;
    element.setAttribute('aria-label', connected ? 'Connected to CliDeck' : element.dataset.tooltip);
    showConnectionState(connectionState);
  }

  function scheduleReconnect() {
    if (connectionBlocked || reconnectTimer !== null) return;
    const base = retryDelays[Math.min(reconnectAttempt, retryDelays.length - 1)];
    reconnectAttempt += 1;
    const delay = Math.max(0, Math.round(base * (0.8 + Math.random() * 0.4)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function stopUntilReload(ws, reason) {
    connectionBlocked = true;
    state.protocolReady = false;
    state.protocolBlocked = true;
    discardQueuedSends();
    if (state.ws === ws) state.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(1000, reason); } catch {}
  }

  function blockIncompatible(ws) {
    stopUntilReload(ws, 'client protocol mismatch');
    setConnectionState('incompatible');
  }

  function openSocket() {
    if (connectionBlocked || state.protocolBlocked) return null;
    if (state.ws && (
      state.ws.readyState === WebSocket.CONNECTING
      || state.ws.readyState === WebSocket.OPEN
    )) return null;
    clearReconnectTimer();
    state.protocolReady = false;
    setConnectionState('connecting');
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${wsProtocol}//${location.host}`);
    url.searchParams.set(CLIENT_PROTOCOL_PARAM, String(CLIENT_PROTOCOL_VERSION));
    if (perfEnabled()) url.searchParams.set('clideckPerf', '1');
    const ws = new WebSocket(url);
    state.ws = ws;
    return ws;
  }

  // Returns undefined when the socket was rejected; otherwise whether this is
  // the first compatible config received on the socket.
  function acceptServerConfig(ws, config) {
    const serverProtocol = Number(config?.protocolVersion ?? CLIENT_PROTOCOL_VERSION);
    if (serverProtocol !== CLIENT_PROTOCOL_VERSION) {
      blockIncompatible(ws);
      return undefined;
    }
    const firstConfigForSocket = !state.protocolReady;
    state.protocolReady = true;
    noteServerVersion(config?.version, config?.buildId);
    return firstConfigForSocket;
  }

  function finishServerConfig(firstConfigForSocket) {
    setConnectionState('connected');
    if (!firstConfigForSocket) return;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      consecutiveFailures = 0;
      reconnectAttempt = 0;
    }, 10000);
    flushQueuedSends();
    send({ type: 'remote.status', forceUpdate: true });
  }

  function handleClose(ws) {
    if (state.ws !== ws) return;
    state.ws = null;
    state.protocolReady = false;
    state.transcriptCacheState = 'idle';
    clearTimeout(stableTimer);
    consecutiveFailures += 1;
    setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
    if (consecutiveFailures >= 2) {
      const attempt = ++diagnosticAttempt;
      diagnoseConnectionFailure().then(result => {
        if (attempt === diagnosticAttempt && !state.ws && !connectionBlocked) setConnectionState(result);
      });
    }
    scheduleReconnect();
  }

  function handleError(ws) {
    if (state.ws !== ws || ws.readyState === WebSocket.CLOSED) return;
    try { ws.close(); } catch {}
  }

  function suspend(reason) {
    clearReconnectTimer();
    const ws = state.ws;
    state.ws = null;
    state.protocolReady = false;
    state.transcriptCacheState = 'idle';
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(1000, reason); } catch {}
  }

  function reconnect() {
    if (connectionBlocked || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastForegroundReconnectAt < 100) return;
    lastForegroundReconnectAt = now;
    suspend('foreground resume');
    setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
    connect();
  }

  function flashSaveIndicator() {
    const element = document.getElementById('save-indicator');
    if (!element || element.dataset.connectionState !== 'connected') return;
    clearTimeout(saveTimer);
    element.classList.add('saving');
    element.classList.remove('saved');
    saveTimer = setTimeout(() => {
      element.classList.remove('saving');
      element.classList.add('saved');
      saveTimer = setTimeout(() => element.classList.remove('saved'), 4000);
    }, 1500);
  }

  return {
    acceptServerConfig,
    blockIncompatible,
    finishServerConfig,
    flashSaveIndicator,
    handleClose,
    handleError,
    openSocket,
    reconnect,
    setConnectionState,
    suspend,
  };
}
