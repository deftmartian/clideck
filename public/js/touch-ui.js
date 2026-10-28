export const TOUCH_UI_MODE_STORAGE_KEY = 'clideck.touchUiMode';
export const TOUCH_FIRST_MEDIA = '(hover: none) and (pointer: coarse)';

const VALID_MODES = new Set(['auto', 'desktop', 'touch']);
const listeners = new Set();
let capabilityQuery = null;
let initialized = false;
let mode = readStoredMode();

function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : 'auto';
}

function readStoredMode() {
  try { return normalizeMode(window.localStorage.getItem(TOUCH_UI_MODE_STORAGE_KEY)); }
  catch { return 'auto'; }
}

function notify() {
  const enabled = isTouchUiEnabled();
  for (const listener of listeners) listener(enabled, mode);
}

function init() {
  if (initialized) return;
  initialized = true;
  capabilityQuery = window.matchMedia(TOUCH_FIRST_MEDIA);
  capabilityQuery.addEventListener?.('change', () => {
    if (mode === 'auto') notify();
  });
  window.addEventListener('storage', event => {
    if (event.key !== TOUCH_UI_MODE_STORAGE_KEY) return;
    const next = normalizeMode(event.newValue);
    if (next === mode) return;
    mode = next;
    notify();
  });
}

export function getTouchUiMode() {
  return mode;
}

export function isTouchUiEnabled() {
  init();
  if (mode === 'desktop') return false;
  if (mode === 'touch') return true;
  return capabilityQuery.matches;
}

export function setTouchUiMode(value) {
  const next = normalizeMode(value);
  if (next === mode) return;
  mode = next;
  try {
    if (next === 'auto') window.localStorage.removeItem(TOUCH_UI_MODE_STORAGE_KEY);
    else window.localStorage.setItem(TOUCH_UI_MODE_STORAGE_KEY, next);
  } catch {}
  notify();
}

export function onTouchUiChange(listener) {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
