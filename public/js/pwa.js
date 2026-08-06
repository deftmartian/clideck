const updateBanner = document.getElementById('pwa-update-banner');
const updateMessage = document.getElementById('pwa-update-message');
const updateAction = document.getElementById('pwa-update-action');
const updateDismiss = document.getElementById('pwa-update-dismiss');
const connectionBanner = document.getElementById('connection-banner');
const connectionMessage = document.getElementById('connection-message');
const connectionAction = document.getElementById('connection-action');
const pageReloadButton = document.getElementById('mobile-page-reload');

let waitingWorker = null;
let activationRequested = false;
let activationTimer = null;
let reloadRequired = false;
let connectionState = 'connecting';
let connectionTimer = null;
let initialServerVersion = null;
let initialServerBuild = null;

const CONNECTION_COPY = {
  connecting: 'Connecting to CliDeck…',
  reconnecting: 'Connection interrupted. Reconnecting…',
  offline: 'This phone is offline. Agents continue on the VM.',
  unavailable: 'CliDeck’s server is unavailable. Agents may still be running.',
  auth: 'Your sign-in has expired.',
  incompatible: 'CliDeck was updated and this page must be reloaded.',
};

function setUpdateBannerVisible(visible) {
  if (!updateBanner) return;
  updateBanner.hidden = !visible;
}

function isReloadMandatory() {
  return document.body?.dataset.reloadRequired === 'true';
}

function showReloadReady(message, { required = false } = {}) {
  if (required) document.body.dataset.reloadRequired = 'true';
  if (isReloadMandatory() && !required) return;
  reloadRequired = true;
  waitingWorker = null;
  if (updateMessage) updateMessage.textContent = message;
  if (updateAction) {
    updateAction.disabled = false;
    updateAction.textContent = 'Reload now';
  }
  if (updateDismiss) updateDismiss.hidden = isReloadMandatory();
  setUpdateBannerVisible(true);
}

export function requirePageReload(message) {
  showReloadReady(message, { required: true });
  document.body?.classList.add('protocol-incompatible');
  document.activeElement?.blur?.();
}

function showWaitingWorker(worker) {
  if (!worker || isReloadMandatory()) return;
  waitingWorker = worker;
  reloadRequired = false;
  if (updateMessage) updateMessage.textContent = 'A CliDeck update is ready.';
  if (updateAction) {
    updateAction.disabled = false;
    updateAction.textContent = 'Prepare update';
  }
  if (updateDismiss) updateDismiss.hidden = false;
  setUpdateBannerVisible(true);
}

function observeRegistration(registration) {
  if (registration.waiting) showWaitingWorker(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showWaitingWorker(registration.waiting || worker);
      }
    });
  });
}

export function registerPwa() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!activationRequested) return;
    activationRequested = false;
    clearTimeout(activationTimer);
    activationTimer = null;
    showReloadReady('CliDeck is ready to finish updating.');
  });

  navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  }).then(registration => {
    observeRegistration(registration);
    registration.active?.postMessage({ type: 'REFRESH_OFFLINE' });

    let lastUpdateCheck = 0;
    const checkForUpdate = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastUpdateCheck < 60_000) return;
      lastUpdateCheck = Date.now();
      registration.update().catch(() => {});
    };
    window.addEventListener('online', checkForUpdate);
    document.addEventListener('visibilitychange', checkForUpdate);
  }).catch(() => {
    // CliDeck remains a normal web app if registration is unavailable.
  });
}

export function noteServerVersion(version, buildId) {
  const next = String(version || '').trim();
  const nextBuild = String(buildId || '').trim();
  if (!next && !nextBuild) return;
  if (initialServerVersion === null) {
    initialServerVersion = next;
    initialServerBuild = nextBuild;
    return;
  }
  if (initialServerVersion !== next || (initialServerBuild && nextBuild && initialServerBuild !== nextBuild)) {
    showReloadReady(`${next ? `CliDeck ${next}` : 'A new CliDeck build'} is running on the server.`);
  }
}

function renderConnectionBanner() {
  if (!connectionBanner || !connectionMessage || !connectionAction) return;
  const state = connectionState;
  if (state === 'connected') {
    connectionBanner.hidden = true;
    return;
  }

  connectionMessage.textContent = CONNECTION_COPY[state] || CONNECTION_COPY.reconnecting;
  connectionAction.hidden = state === 'connecting' || state === 'reconnecting';
  connectionAction.textContent = state === 'auth'
    ? 'Sign in'
    : state === 'incompatible'
      ? 'Reload'
      : 'Retry';
  connectionBanner.dataset.state = state;
  connectionBanner.hidden = false;
}

export function showConnectionState(state) {
  connectionState = state;
  const interactionBlocked = state === 'incompatible' || isReloadMandatory();
  document.body?.classList.toggle('protocol-incompatible', interactionBlocked);
  if (interactionBlocked) document.activeElement?.blur?.();
  clearTimeout(connectionTimer);
  if (state === 'connected') {
    renderConnectionBanner();
    return;
  }

  const delay = state === 'connecting' || state === 'reconnecting' ? 700 : 0;
  connectionTimer = setTimeout(renderConnectionBanner, delay);
}

export async function diagnoseConnectionFailure() {
  if (!navigator.onLine) return 'offline';
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (
      response.type === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400)
      || response.status === 401
      || response.status === 403
    ) {
      return 'auth';
    }
    const contentType = String(response.headers.get('content-type') || '');
    if (response.ok && contentType.includes('application/json')) return 'reconnecting';
    if (contentType.includes('text/html')) return 'auth';
    return 'unavailable';
  } catch {
    return navigator.onLine ? 'unavailable' : 'offline';
  }
}

updateAction?.addEventListener('click', () => {
  if (reloadRequired) {
    window.location.reload();
    return;
  }
  if (!waitingWorker) return;
  activationRequested = true;
  updateAction.disabled = true;
  updateAction.textContent = 'Preparing…';
  waitingWorker.postMessage({ type: 'ACTIVATE_UPDATE' });
  clearTimeout(activationTimer);
  activationTimer = setTimeout(() => {
    if (!activationRequested || !waitingWorker) return;
    activationRequested = false;
    updateAction.disabled = false;
    updateAction.textContent = 'Try again';
    if (updateMessage) updateMessage.textContent = 'The update is still waiting to activate.';
  }, 10_000);
});

updateDismiss?.addEventListener('click', () => {
  if (!isReloadMandatory()) setUpdateBannerVisible(false);
});

pageReloadButton?.addEventListener('click', () => {
  window.location.reload();
});

// Chrome only offers install through its own menu; surface the captured
// prompt as a drawer control so installing is one visible tap.
const installButton = document.getElementById('mobile-composer-install');
let deferredInstallPrompt = null;

function syncInstallButton() {
  if (installButton) installButton.hidden = !deferredInstallPrompt;
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallButton();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  syncInstallButton();
});
installButton?.addEventListener('click', async () => {
  const prompt = deferredInstallPrompt;
  if (typeof prompt?.prompt !== 'function') return;
  deferredInstallPrompt = null;
  syncInstallButton();
  try { await prompt.prompt(); } catch {}
});

connectionAction?.addEventListener('click', () => {
  if (connectionState === 'auth') {
    window.location.assign('/');
    return;
  }
  if (connectionState === 'incompatible') {
    window.location.reload();
    return;
  }
  window.dispatchEvent(new CustomEvent('clideck:retry-connection'));
});
