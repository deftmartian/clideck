import { state, send } from './state.js';
import { closeDropdown } from './prompts.js';
import { showToast } from './toast.js';
import { syncViewport } from './viewport.js';
import { countPerf, notePerf } from './perf.js';
import { createMobileComposer, loadStoredDraft } from './mobile-composer.js';
import { createMobileSelection } from './mobile-selection.js';
import { createMobileTouchScroll } from './mobile-touch-scroll.js';

const JUMP_LATEST_THRESHOLD_ROWS = 3;
const JUMP_LATEST_VISIBLE_CLASS = 'is-visible';
const APP_SCROLL_DEBT_CAP = 2000;
const APP_SCROLL_UP_DEBT_MULTIPLIER = 4;
const APP_SCROLL_JUMP_MIN_VIEWPORTS = 2;
const WHEEL_REPORT_RE = /\x1b\[<6([45]);\d+;\d+M/g;

function openTerminalLink(url) {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (win) win.opener = null;
}

function activateTerminalLinkAtPoint(term, screen, touch) {
  // Touch browsers do not reliably synthesize the mouse sequence xterm's
  // linkifier expects, so replay the tap through xterm's public surface.
  const common = {
    bubbles: true,
    cancelable: true,
    clientX: touch.clientX,
    clientY: touch.clientY,
    button: 0,
  };
  screen.dispatchEvent(new MouseEvent('mousemove', { ...common, buttons: 0 }));
  if (!screen.classList.contains('xterm-cursor-pointer')) return false;
  screen.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
  screen.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
  return true;
}

async function enableAcceleratedRenderer(term, element) {
  element.dataset.renderer = 'dom';
  let WebglAddonCtor;
  try {
    ({ WebglAddon: WebglAddonCtor } = await import('@xterm/addon-webgl'));
  } catch {}
  if (!element.isConnected) return;
  if (!WebglAddonCtor) {
    element.dataset.rendererFallback = 'addon-unavailable';
    return;
  }

  let addon;
  try {
    addon = new WebglAddonCtor();
    addon.onContextLoss(() => {
      addon.dispose();
      element.dataset.renderer = 'dom';
    });
    term.loadAddon(addon);
    element.dataset.renderer = 'webgl';
    countPerf('webglContextsCreated');
    notePerf('webglRendererReady');
    delete element.dataset.rendererFallback;
  } catch {
    try { addon?.dispose(); } catch {}
    element.dataset.rendererFallback = 'webgl-unavailable';
  }
}

export function createTerminalLocalIntegration({
  refreshInputActions,
  trackInput,
  writeClipboardText,
}) {
  let mobileSelection;
  const mobileComposer = createMobileComposer({
    getActiveId: () => state.active,
    getEntry: id => state.terms.get(id),
    getEntries: () => state.terms.values(),
    sendInput: (id, data) => send({ type: 'input', id, data }),
    onControlInput: trackInput,
    onDraftChange: refreshInputActions,
    onCommitted: () => {
      closeDropdown();
      refreshInputActions();
    },
    onSendFailure: () => showToast('The terminal is not connected. Your draft was kept.', {
      title: 'Mobile input', type: 'error', duration: 3500,
    }),
  });
  const mobileTouchScroll = createMobileTouchScroll({
    isSelectionActive: () => mobileSelection.isActive(),
    sendInput: (id, data) => send({ type: 'input', id, data }),
    onDragClaim: () => mobileComposer.blurInput(),
    onTap: (_id, term, screen, touch) => activateTerminalLinkAtPoint(term, screen, touch),
    onLongPress: () => mobileSelection.activate(),
    onAppScroll: reportAppWheelScroll,
  });
  mobileSelection = createMobileSelection({
    getActiveId: () => state.active,
    getEntry: id => state.terms.get(id),
    available: () => mobileComposer.available(),
    writeText: writeClipboardText,
    onActivate: () => {
      mobileComposer.closeTools();
      mobileComposer.blurInput();
    },
    onModeChange: refreshInputActions,
    onCopied: length => showToast(`${length} character${length === 1 ? '' : 's'} copied.`, {
      title: 'Terminal selection', duration: 1800,
    }),
    onCopyError: () => showToast('Could not copy the terminal selection.', {
      title: 'Copy failed', type: 'error', duration: 3000,
    }),
  });

  function recoverActiveTerminalSurface() {
    syncViewport();
    requestAnimationFrame(() => {
      const entry = state.active ? state.terms.get(state.active) : null;
      if (!entry?.term) return;
      try { entry.term.clearTextureAtlas?.(); } catch {}
      try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch {}
      entry.requestFit?.();
    });
  }

  window.addEventListener('pageshow', recoverActiveTerminalSurface, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverActiveTerminalSurface();
  });

  function reportAppWheelScroll(id, steps) {
    const entry = state.terms.get(id);
    if (!entry) return;
    const current = entry.appScrollDebt || 0;
    const delta = steps < 0 ? -steps * APP_SCROLL_UP_DEBT_MULTIPLIER : -steps;
    const debt = Math.min(APP_SCROLL_DEBT_CAP, Math.max(0, current + delta));
    if (debt === current) return;
    entry.appScrollDebt = debt;
    entry.refreshJumpLatest?.();
  }

  function countWheelReports(id, data) {
    if (!data || !data.includes('\x1b[<6')) return;
    let up = 0;
    let down = 0;
    for (const match of data.matchAll(WHEEL_REPORT_RE)) {
      if (match[1] === '4') up += 1;
      else down += 1;
    }
    if (up || down) reportAppWheelScroll(id, down - up);
  }

  function handleTerminalData(id, data) {
    const entry = state.terms.get(id);
    if (mobileComposer.ownsInput(entry)) return;
    trackInput(id, data);
    countWheelReports(id, data);
    send({ type: 'input', id, data });
  }

  function createJumpLatestButton(id, term) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tmx-jump-latest';
    button.title = 'Jump to latest';
    button.setAttribute('aria-label', 'Jump to latest output');
    button.innerHTML = `
      <span class="tmx-jump-latest-glow"></span>
      <span class="tmx-jump-latest-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14"/>
          <path d="m6.5 13.5 5.5 5.5 5.5-5.5"/>
        </svg>
      </span>`;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      button.classList.add('settling');
      mobileTouchScroll.interrupt(id);
      mobileComposer.blurInput();
      const entry = state.terms.get(id);
      const appDebt = entry?.appScrollDebt || 0;
      if (appDebt > 0 && term.modes.mouseTrackingMode !== 'none') {
        const column = Math.max(1, Math.ceil(term.cols / 2));
        const row = Math.max(1, Math.ceil(term.rows / 2));
        const reports = Math.min(
          APP_SCROLL_DEBT_CAP,
          Math.max(appDebt, term.rows * APP_SCROLL_JUMP_MIN_VIEWPORTS),
        ) + JUMP_LATEST_THRESHOLD_ROWS;
        send({ type: 'input', id, data: `\u001b[<65;${column};${row}M`.repeat(reports) });
      }
      if (entry?.appScrollDebt) entry.appScrollDebt = 0;
      term.scrollToBottom();
      if (!mobileComposer.ownsInput(entry)) term.focus();
      setTimeout(() => button.classList.remove('settling'), 260);
    });
    return button;
  }

  function attachTerminal(id, term, element, shouldShowJumpLatest) {
    mobileComposer.syncTerminalInput({ term, mobileDirect: false });
    mobileSelection.attach(id, term, element);
    mobileTouchScroll.attach(id, term, element);
    const scheduleRenderer = globalThis.requestIdleCallback
      ? callback => requestIdleCallback(callback, { timeout: 250 })
      : callback => setTimeout(callback, 0);
    scheduleRenderer(() => enableAcceleratedRenderer(term, element));

    const button = createJumpLatestButton(id, term);
    element.appendChild(button);
    const refreshJumpLatest = () => {
      const entry = state.terms.get(id);
      if (entry?.appScrollDebt && term.modes.mouseTrackingMode === 'none') {
        entry.appScrollDebt = 0;
      }
      const scrolledUp = shouldShowJumpLatest(term) || (entry?.appScrollDebt || 0) > 0;
      button.classList.toggle(JUMP_LATEST_VISIBLE_CLASS, scrolledUp);
      if (!entry || entry.scrolledUp === scrolledUp) return;
      entry.scrolledUp = scrolledUp;
      if (id === state.active) refreshInputActions();
    };
    term.onScroll(refreshJumpLatest);
    term.onWriteParsed(refreshJumpLatest);
    return refreshJumpLatest;
  }

  function createFitController(id, term, fit) {
    let frame = 0;
    let resizeTimer = 0;
    function fitPreservingScrollback() {
      const entry = state.terms.get(id);
      if (state.active !== id || !entry?.el?.classList.contains('active') || !entry.el.offsetWidth) return;
      const dimensions = fit.proposeDimensions();
      if (!dimensions || (dimensions.cols === term.cols && dimensions.rows === term.rows)) return;
      const oldBuffer = term.buffer.active;
      const distanceFromBottom = Math.max(0, oldBuffer.baseY - oldBuffer.viewportY);
      fit.fit();
      countPerf('terminalFits');
      if (distanceFromBottom > 0) {
        const newBuffer = term.buffer.active;
        term.scrollToLine(Math.max(0, newBuffer.baseY - distanceFromBottom));
      }
      clearTimeout(resizeTimer);
      const cols = term.cols;
      const rows = term.rows;
      resizeTimer = setTimeout(() => {
        const current = state.terms.get(id);
        if (state.active !== id || current?.term !== term || term.cols !== cols || term.rows !== rows) return;
        send({ type: 'resize', id, cols, rows });
      }, 120);
    }
    return {
      request() {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; fitPreservingScrollback(); });
      },
      cancel() {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        clearTimeout(resizeTimer);
        resizeTimer = 0;
      },
    };
  }

  return {
    attachTerminal,
    createFitController,
    detach(id) {
      mobileSelection.detach(id);
      mobileTouchScroll.detach(id);
    },
    entryState(id, refreshJumpLatest, requestFit) {
      return {
        composerDraft: loadStoredDraft(id),
        mobileDirect: false,
        appScrollDebt: 0,
        refreshJumpLatest,
        requestFit,
      };
    },
    handleTerminalData,
    inputActionsHidden(entry, visibleCount) {
      return !entry || visibleCount === 0 || !!entry.inputHasText
        || !!entry.composerDraft || !!entry.scrolledUp || mobileSelection.isActive();
    },
    linkHandler: { activate: (_event, url) => openTerminalLink(url) },
    ownsInput: entry => mobileComposer.ownsInput(entry),
    refresh() {
      mobileComposer.refresh();
      mobileSelection.refresh();
    },
  };
}
