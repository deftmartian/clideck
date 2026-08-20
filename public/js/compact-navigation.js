import { state } from './state.js';
import { TOUCH_FIRST_MEDIA } from './touch-ui.js';

export function initCompactNavigation({ foreground, suspend, setConnectionState, onHidden }) {
  const compactLayoutQuery = window.matchMedia(`(max-width: 960px), ${TOUCH_FIRST_MEDIA}`);
  const close = () => document.body.classList.remove('mobile-nav-open');

  document.getElementById('mobile-nav-toggle').addEventListener('click', () => {
    if (compactLayoutQuery.matches) document.body.classList.toggle('mobile-nav-open');
  });
  document.getElementById('mobile-nav-close').addEventListener('click', close);
  document.getElementById('mobile-sidebar-backdrop').addEventListener('click', close);
  compactLayoutQuery.addEventListener('change', event => { if (!event.matches) close(); });

  let windowBlurredAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      onHidden?.();
      return;
    }
    close();
    windowBlurredAt = 0;
    foreground?.();
  });
  window.addEventListener('blur', () => {
    if (document.visibilityState === 'visible') windowBlurredAt = Date.now();
  });
  window.addEventListener('focus', () => {
    close();
    const blurredAt = windowBlurredAt;
    windowBlurredAt = 0;
    if (
      document.visibilityState === 'visible'
      && blurredAt
      && Date.now() - blurredAt >= 1000
      && (!state.ws || state.ws.readyState !== WebSocket.OPEN)
    ) {
      foreground?.();
    }
  });
  window.addEventListener('pageshow', event => {
    close();
    if (event.persisted) foreground?.();
  });
  window.addEventListener('online', () => {
    setConnectionState('reconnecting');
    foreground?.();
  });
  window.addEventListener('offline', () => {
    suspend('browser offline');
    setConnectionState('offline');
  });
  window.addEventListener('clideck:retry-connection', () => foreground?.());
  if (screen.orientation?.addEventListener) {
    screen.orientation.addEventListener('change', close);
  } else {
    window.addEventListener('orientationchange', close);
  }

  // Controls that navigate to the main pane close the drawer after their own
  // click handlers run.
  document.addEventListener('click', event => {
    const promptRow = event.target.closest('#prompts-list .prompt-row');
    const promptAction = event.target.closest('.prompt-edit, .prompt-del');
    const mainDestination = event.target.closest(
      '#rail-settings, #btn-remote, #settings-nav .settings-cat',
    );
    if (mainDestination || (promptRow && !promptAction)) close();
  });

  return close;
}
