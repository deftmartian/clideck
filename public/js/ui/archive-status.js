import { store } from '../store.js';
import { toast } from './toast.js';

// Recording warnings and failures must remain visible even when Settings is closed.
export function initArchiveStatus() {
  let lastNotice = '', notice = null;
  store.on('archive.status', status => {
    const failed = status.state === 'error';
    const warning = status.state === 'recording' && status.warning;
    if (!failed && !warning) { notice?.dismiss(); notice = null; lastNotice = ''; return; }
    const message = failed ? (status.error || 'Could not write session records.') : 'Recording continues. ' + status.warning;
    const key = JSON.stringify([status.state, status.directory, message]);
    if (key === lastNotice) return;
    lastNotice = key;
    notice = toast[failed ? 'error' : 'warn']({ id: 'session-archive', title: failed ? 'Session archive error' : 'Session archive warning', body: message, duration: 0 });
  });
}
