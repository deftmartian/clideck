const HEIGHT_PROPERTY = '--clideck-viewport-height';
const listeners = new Set();
let currentViewport = null;
let syncRaf = 0;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function measureViewport() {
  const root = document.documentElement;
  const layoutWidth = Math.max(1, Math.floor(window.innerWidth || root.clientWidth || 1));
  const layoutHeight = Math.max(1, Math.floor(window.innerHeight || root.clientHeight || 1));
  const visual = window.visualViewport;
  if (!visual) {
    return {
      left: 0,
      top: 0,
      right: layoutWidth,
      bottom: layoutHeight,
      width: layoutWidth,
      height: layoutHeight,
      scale: 1,
      appHeight: layoutHeight,
    };
  }

  const left = Math.min(
    layoutWidth - 1,
    Math.max(0, rounded(Number(visual.offsetLeft) || 0)),
  );
  const top = Math.min(
    layoutHeight - 1,
    Math.max(0, rounded(Number(visual.offsetTop) || 0)),
  );
  const right = Math.min(
    layoutWidth,
    rounded(left + positiveNumber(visual.width, layoutWidth)),
  );
  const bottom = Math.min(
    layoutHeight,
    rounded(top + positiveNumber(visual.height, layoutHeight)),
  );
  const scale = positiveNumber(visual.scale, 1);
  const isPinchZoomed = Math.abs(scale - 1) > 0.01;

  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, rounded(right - left)),
    height: Math.max(1, rounded(bottom - top)),
    scale,
    // The app remains anchored at layout y=0, so its height follows the
    // visible bottom edge. Pinch zoom must not reflow the terminal.
    appHeight: isPinchZoomed ? layoutHeight : Math.max(1, Math.floor(bottom)),
  };
}

function viewportChanged(previous, next) {
  if (!previous) return true;
  return previous.left !== next.left
    || previous.top !== next.top
    || previous.right !== next.right
    || previous.bottom !== next.bottom
    || previous.scale !== next.scale
    || previous.appHeight !== next.appHeight;
}

export function syncViewport() {
  const next = measureViewport();
  const previous = currentViewport;
  const value = `${next.appHeight}px`;
  const rootStyle = document.documentElement.style;
  if (rootStyle.getPropertyValue(HEIGHT_PROPERTY) !== value) {
    rootStyle.setProperty(HEIGHT_PROPERTY, value);
  }
  currentViewport = next;

  if (viewportChanged(previous, next)) {
    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        console.error('Viewport listener failed', error);
      }
    }
  }
  return next;
}

export function getViewportRect() {
  return currentViewport || syncViewport();
}

export function onViewportChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function scheduleViewportSync() {
  if (syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    syncViewport();
  });
}

syncViewport();
window.addEventListener('resize', scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener('resize', scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener('scroll', scheduleViewportSync, { passive: true });
