const updateBanner = document.getElementById('pwa-update-banner');
const updateMessage = document.getElementById('pwa-update-message');
const updateAction = document.getElementById('pwa-update-action');
const updateDismiss = document.getElementById('pwa-update-dismiss');
let pageReloadButton;

let waitingWorker = null;
let activationRequested = false;
let activationTimer = null;
let reloadReady = false;
let initialServerVersion = null;
let initialServerBuild = null;

function setUpdateBannerVisible(visible) {
  if (!updateBanner) return;
  updateBanner.hidden = !visible;
}

function showReloadReady(message) {
  reloadReady = true;
  waitingWorker = null;
  if (updateMessage) updateMessage.textContent = message;
  if (updateAction) {
    updateAction.disabled = false;
    updateAction.textContent = 'Reload now';
  }
  if (updateDismiss) updateDismiss.hidden = false;
  setUpdateBannerVisible(true);
}

function showWaitingWorker(worker) {
  if (!worker) return;
  waitingWorker = worker;
  reloadReady = false;
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
  pageReloadButton = document.getElementById('mobile-page-reload');
  installButton = document.getElementById('mobile-composer-install');
  pageReloadButton?.addEventListener('click', () => window.location.reload());
  installButton?.addEventListener('click', promptInstall);
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

updateAction?.addEventListener('click', () => {
  if (reloadReady) {
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
  setUpdateBannerVisible(false);
});

// Chrome only offers install through its own menu; surface the captured
// prompt as a drawer control so installing is one visible tap.
let installButton;
let deferredInstallPrompt = null;

function syncInstallButton() {
  if (installButton) installButton.hidden = !deferredInstallPrompt;
}

window.addEventListener('beforeinstallprompt', event => {
  if (!installButton) return;
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallButton();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  syncInstallButton();
});
async function promptInstall() {
  const prompt = deferredInstallPrompt;
  if (typeof prompt?.prompt !== 'function') return;
  deferredInstallPrompt = null;
  syncInstallButton();
  try { await prompt.prompt(); } catch {}
}
