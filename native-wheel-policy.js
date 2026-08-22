'use strict';

// Host policy: when a TUI enables mouse tracking on the primary buffer,
// xterm.js turns off native wheel-scroll and sends SGR wheel reports to the
// PTY. The app redraws in place, so the wheel looks dead. Steal the wheel on
// the normal buffer once xterm has history. Alt-screen apps keep SGR reports.
// This is global, not Grok-specific. Opt out with localStorage
// clideck.stealPrimaryWheel = "0".

const STEAL_PRIMARY_WHEEL_STORAGE_KEY = 'clideck.stealPrimaryWheel';

function isPrimaryWheelStealEnabled(storage) {
  try {
    const value = storage?.getItem?.(STEAL_PRIMARY_WHEEL_STORAGE_KEY);
    if (value == null || value === '') return true;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
  } catch {
    return true;
  }
}

function shouldStealNativeWheel(term, event, storage) {
  if (!isPrimaryWheelStealEnabled(storage)) return false;
  if (!term || !event) return false;
  if (event.ctrlKey) return false;
  if (!event.deltaY) return false;
  if (term.modes?.mouseTrackingMode === 'none') return false;
  if (term.buffer?.active?.type === 'alternate') return false;
  if (!(term.buffer?.active?.baseY > 0)) return false;
  return true;
}

function accumulateWheelLines(event, cellHeight, rows, accumulator) {
  let amount = 0;
  if (event.deltaMode === 1) amount = event.deltaY;
  else if (event.deltaMode === 2) amount = event.deltaY * Math.max(1, rows || 1);
  else {
    const height = cellHeight > 0 ? cellHeight : 17;
    amount = event.deltaY / height;
  }
  const next = accumulator + amount;
  const lines = Math.trunc(next);
  return { lines, accumulator: next - lines };
}

module.exports = {
  STEAL_PRIMARY_WHEEL_STORAGE_KEY,
  isPrimaryWheelStealEnabled,
  shouldStealNativeWheel,
  accumulateWheelLines,
};
