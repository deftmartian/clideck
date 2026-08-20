import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { state, send } from './state.js';
import { resolveTheme } from './profiles.js';
import { attachToTerminal } from './hotkeys.js';
import { countPerf, notePerf } from './perf.js';
import { isTouchUiEnabled, onTouchUiChange } from './touch-ui.js';

const MIN_CONTRAST_RATIO = 4.5;
const MAX_DESKTOP_RENDERERS = 4;

export function createTerminalRendererLifecycle({
  terminalLocal,
  addLinkProvider,
  shouldShowJumpLatest,
  onSelect,
  onOpenMenu,
}) {
  let rendererUseCounter = 0;

  function markRendererUsed(entry) {
    if (!entry) return;
    entry.rendererLastUsed = ++rendererUseCounter;
  }

  function subscribeRenderer(id, { snapshot = false } = {}) {
    const entry = state.terms.get(id);
    if (!entry?.term || document.visibilityState === 'hidden') return false;
    const hasCursor = !snapshot
      && entry.outputGeneration
      && Number.isSafeInteger(entry.appliedSeq)
      && entry.receivedSeq === entry.appliedSeq;
    return send({
      type: 'session.subscribe',
      id,
      strategy: hasCursor ? 'auto' : 'snapshot',
      ...(hasCursor ? { cursor: { generation: entry.outputGeneration, seq: entry.appliedSeq } } : {}),
      claimResize: true,
      cols: entry.term.cols,
      rows: entry.term.rows,
    });
  }

  function disposeRenderer(id, { evicted = false } = {}) {
    const entry = state.terms.get(id);
    if (!entry?.term) return;
    entry.cancelFitRaf?.();
    entry.ro?.disconnect();
    entry.el?.removeEventListener?.('contextmenu', entry.onContextMenu);
    terminalLocal.detach(id);
    entry.term.dispose();
    countPerf('renderersDisposed');
    entry.el?.remove();
    if (evicted) {
      entry.rendererEvicted = true;
      countPerf('rendererEvictions');
      notePerf('rendererEvicted', { id });
    }
    Object.assign(entry, {
      term: null, fit: null, el: null, ro: null, fitted: false,
      requestFit: null, cancelFitRaf: null, onContextMenu: null,
      queue: null, writeChunk: null,
    });
  }

  function enforceDesktopRetention(id) {
    if (isTouchUiEnabled()) return;
    const retained = [...state.terms.entries()]
      .filter(([otherId, other]) => otherId !== id && otherId !== state.active && other.term)
      .sort((a, b) => (a[1].rendererLastUsed || 0) - (b[1].rendererLastUsed || 0));
    let rendererCount = [...state.terms.values()].filter(other => other.term).length;
    while (rendererCount >= MAX_DESKTOP_RENDERERS && retained.length) {
      disposeRenderer(retained.shift()[0], { evicted: true });
      rendererCount -= 1;
    }
  }

  function mountRenderer(id) {
    const entry = state.terms.get(id);
    if (!entry || entry.term) return entry;

    enforceDesktopRetention(id);
    const rehydrating = !!entry.rendererEvicted;
    entry.rendererEvicted = false;
    markRendererUsed(entry);
    if (rehydrating) {
      countPerf('snapshotRehydrations');
      notePerf('snapshotRehydration', { id });
    }

    const el = document.createElement('div');
    el.className = 'term-wrap';
    if (state.active === id) el.classList.add('active');
    el.style.backgroundColor = resolveTheme(entry.themeId).background;
    document.getElementById('terminals').appendChild(el);

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: resolveTheme(entry.themeId),
      // Keep ANSI/truecolor output readable across dark and light terminal themes.
      minimumContrastRatio: MIN_CONTRAST_RATIO,
      cursorBlink: true,
      scrollback: 10000,
      smoothScrollDuration: 180,
      linkHandler: terminalLocal.linkHandler,
    });
    countPerf('renderersCreated');
    notePerf('rendererCreated', { id });
    const fit = new FitAddon();
    term.loadAddon(fit);
    addLinkProvider(term);
    term.onData(data => terminalLocal.handleTerminalData(id, data));
    term.onWriteParsed(() => {
      const current = state.terms.get(id);
      if (current) current.lastRenderAt = Date.now();
    });

    term.open(el);
    const refreshJumpLatest = terminalLocal.attachTerminal(id, term, el, shouldShowJumpLatest);
    let replayWrites = 0;
    const writeChunk = (data, replay = false, onComplete) => {
      if (replay) replayWrites += 1;
      term.write(data, () => {
        if (replay) replayWrites -= 1;
        onComplete?.();
      });
    };
    attachToTerminal(term, entry.presetId, () => replayWrites > 0);
    const onContextMenu = (event) => {
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(id);
      onOpenMenu(id, { x: event.clientX, y: event.clientY });
    };
    el.addEventListener('contextmenu', onContextMenu);
    let fitted = false;
    let pending = [];
    // Only fit when proposed dimensions change so sub-pixel layout shifts do not
    // force buffer reflows and make the terminal scrollbar jump.
    const fitController = terminalLocal.createFitController(id, term, fit);
    const requestFit = () => fitController.request();
    Object.assign(entry, {
      term, fit, el, requestFit,
      cancelFitRaf: () => fitController.cancel(),
      onContextMenu,
      queue(data, replay = false, onComplete) {
        if (!fitted) { pending.push({ data, replay, onComplete }); return true; }
        return false;
      },
      writeChunk,
      ...terminalLocal.entryState(id, refreshJumpLatest, requestFit),
    });
    const ro = new ResizeObserver(() => {
      if (!el.offsetWidth) return;
      if (!fitted) {
        fitted = true;
        fit.fit();
        countPerf('terminalFits');
        entry.fitted = true;
        for (const chunk of pending) writeChunk(chunk.data, chunk.replay, chunk.onComplete);
        pending = null;
        refreshJumpLatest();
        subscribeRenderer(id, { snapshot: true });
        return;
      }
      requestFit();
    });
    entry.ro = ro;
    ro.observe(el);
    return entry;
  }

  onTouchUiChange(enabled => {
    if (!enabled) return;
    for (const [id, entry] of state.terms) {
      if (id !== state.active && entry.term) disposeRenderer(id, { evicted: true });
    }
  });

  return {
    disposeRenderer,
    markRendererUsed,
    mountRenderer,
    subscribeRenderer,
  };
}

export { MAX_DESKTOP_RENDERERS };
