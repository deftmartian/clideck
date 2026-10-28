// Connection presentation only. ws.js owns every retry and the active socket.
let banner;
export function connectionStatus(state, retry) {
  if (!banner) {
    banner = document.createElement('aside'); banner.className = 'connection-status';
    banner.setAttribute('role','status'); document.body.appendChild(banner);
  }
  banner.hidden = state === 'connected';
  if (banner.hidden) return;
  const labels = {connecting:'Connecting…',offline:'You are offline. Drafts stay here.',auth:'Sign in again to reconnect.',incompatible:'CliDeck was updated. Reload this page.',unavailable:'Unable to reach CliDeck. Retrying…'};
  banner.replaceChildren(document.createTextNode(labels[state] || labels.unavailable));
  const button = document.createElement('button');
  button.textContent = state === 'auth' ? 'Sign in' : state === 'incompatible' ? 'Reload' : 'Retry';
  button.onclick = state === 'auth' ? () => location.assign('/') : state === 'incompatible' ? () => location.reload() : retry;
  banner.appendChild(button);
}
export async function diagnoseConnection(signal) {
  if (navigator.onLine === false) return 'offline';
  try {
    const response = await fetch('/api/health',{cache:'no-store',credentials:'same-origin',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
    if (response.type === 'opaqueredirect' || [401,403].includes(response.status) || (response.status >= 300 && response.status < 400)) return 'auth';
    if (!response.ok) return 'unavailable';
    if (!response.headers.get('content-type')?.includes('application/json')) return 'auth';
    const status = await response.json();
    return status.protocol === 'fork-v6' ? 'unavailable' : 'incompatible';
  } catch { return navigator.onLine === false ? 'offline' : 'unavailable'; }
}
