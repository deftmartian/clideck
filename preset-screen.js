'use strict';

function asArgs(value) {
  return Array.isArray(value) ? value.filter(arg => typeof arg === 'string' && arg) : [];
}

function appendMissing(parts, extra) {
  const next = Array.isArray(parts) ? [...parts] : [];
  for (const arg of extra) {
    if (!next.includes(arg)) next.push(arg);
  }
  return next;
}

function applyPresetScreenArgs(parts, preset, touchUi) {
  const screen = preset && typeof preset === 'object' ? preset.screen : null;
  if (!screen || typeof screen !== 'object') {
    return Array.isArray(parts) ? [...parts] : [];
  }
  let next = appendMissing(parts, asArgs(screen.desktopArgs));
  if (touchUi) next = appendMissing(next, asArgs(screen.touchArgs));
  return next;
}

module.exports = { applyPresetScreenArgs };
