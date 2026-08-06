import { copyTrimmedTerminalSelection } from './terminal-clipboard.js';
import { onTouchUiChange } from './touch-ui.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function touchFrom(list, identifier = null) {
  if (!list) return null;
  for (let index = 0; index < list.length; index += 1) {
    const touch = list.item ? list.item(index) : list[index];
    if (touch && (identifier === null || touch.identifier === identifier)) return touch;
  }
  return null;
}

function stopTouch(event) {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

function terminalCell(term, screen, touch) {
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height || !term.cols || !term.rows) return null;
  const column = clamp(Math.floor((touch.clientX - rect.left) * term.cols / rect.width), 0, term.cols - 1);
  const viewportRow = clamp(Math.floor((touch.clientY - rect.top) * term.rows / rect.height), 0, term.rows - 1);
  const buffer = term.buffer.active;
  const row = clamp(buffer.viewportY + viewportRow, 0, Math.max(0, buffer.length - 1));
  return { column, row };
}

function selectCellRange(term, anchor, focus) {
  const anchorIndex = anchor.row * term.cols + anchor.column;
  const focusIndex = focus.row * term.cols + focus.column;
  const startIndex = Math.min(anchorIndex, focusIndex);
  const endIndex = Math.max(anchorIndex, focusIndex);
  term.select(startIndex % term.cols, Math.floor(startIndex / term.cols), endIndex - startIndex + 1);
}

export function createMobileSelection({
  getActiveId,
  getEntry,
  available,
  writeText,
  onActivate,
  onModeChange,
  onCopied,
  onCopyError,
}) {
  const attachments = new Map();
  let initialized = false;
  let modeId = null;
  let anchor = null;
  let touchId = null;

  function elements() {
    return {
      toggleButton: document.getElementById('mobile-selection-toggle'),
      actions: document.getElementById('mobile-selection-actions'),
      status: document.getElementById('mobile-selection-status'),
      copyButton: document.getElementById('mobile-selection-copy'),
      doneButton: document.getElementById('mobile-selection-done'),
    };
  }

  function isAvailable() {
    return available();
  }

  function isActive(id = null) {
    return id === null ? modeId !== null : modeId === id;
  }

  function refreshActions() {
    const { toggleButton, actions, status, copyButton } = elements();
    const activeId = getActiveId();
    const entry = modeId ? getEntry(modeId) : null;
    const active = !!entry && modeId === activeId && isAvailable();
    const selection = active ? entry.term.getSelection() : '';

    document.body.classList.toggle('mobile-selection-active', active);
    toggleButton?.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (toggleButton) toggleButton.disabled = !activeId || !isAvailable();
    actions?.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (copyButton) copyButton.disabled = !selection;
    if (status) status.textContent = selection
      ? `${selection.length} character${selection.length === 1 ? '' : 's'} selected`
      : 'Drag across terminal text';
  }

  function deactivate({ clear = true } = {}) {
    const oldId = modeId;
    const oldEntry = oldId ? getEntry(oldId) : null;
    modeId = null;
    anchor = null;
    touchId = null;
    if (clear) oldEntry?.term?.clearSelection();
    refreshActions();
    if (oldId) onModeChange?.(false, oldId);
  }

  function activate() {
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    if (!id || !entry || !attachments.has(id) || !isAvailable()) return;
    if (modeId && modeId !== id) deactivate();
    modeId = id;
    anchor = null;
    touchId = null;
    entry.term.clearSelection();
    onActivate?.(id);
    entry.term.textarea?.blur();
    document.activeElement?.blur?.();
    refreshActions();
    onModeChange?.(true, id);
  }

  async function copySelection() {
    const entry = modeId ? getEntry(modeId) : null;
    const text = entry?.term?.getSelection() || '';
    if (!text) return;
    try {
      const result = await copyTrimmedTerminalSelection(text, writeText);
      if (!result.copied) return;
      deactivate();
      onCopied?.(result.length);
    } catch {
      onCopyError?.();
    }
  }

  function refresh() {
    init();
    if (modeId && (modeId !== getActiveId() || !getEntry(modeId) || !isAvailable())) {
      deactivate();
      return;
    }
    refreshActions();
  }

  function attach(id, term, host) {
    detach(id);
    const screen = host.querySelector('.xterm-screen');
    if (!screen) return;

    const onTouchStart = event => {
      if (modeId !== id) return;
      stopTouch(event);
      if (event.touches.length !== 1) {
        anchor = null;
        touchId = null;
        return;
      }
      const touch = touchFrom(event.changedTouches) || touchFrom(event.touches);
      const cell = touch ? terminalCell(term, screen, touch) : null;
      if (!touch || !cell) return;
      touchId = touch.identifier;
      anchor = cell;
      term.select(cell.column, cell.row, 1);
    };
    const onTouchMove = event => {
      if (modeId !== id || anchor === null || touchId === null) return;
      stopTouch(event);
      const touch = touchFrom(event.changedTouches, touchId) || touchFrom(event.touches, touchId);
      const cell = touch ? terminalCell(term, screen, touch) : null;
      if (cell) selectCellRange(term, anchor, cell);
    };
    const onTouchEnd = event => {
      if (modeId !== id || touchId === null) return;
      const touch = touchFrom(event.changedTouches, touchId);
      if (!touch) return;
      stopTouch(event);
      const cell = anchor ? terminalCell(term, screen, touch) : null;
      if (anchor && cell) selectCellRange(term, anchor, cell);
      anchor = null;
      touchId = null;
    };
    const onTouchCancel = event => {
      if (modeId !== id) return;
      stopTouch(event);
      anchor = null;
      touchId = null;
    };
    const onClick = event => {
      if (modeId !== id) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const touchOptions = { capture: true, passive: false };
    screen.addEventListener('touchstart', onTouchStart, touchOptions);
    screen.addEventListener('touchmove', onTouchMove, touchOptions);
    screen.addEventListener('touchend', onTouchEnd, touchOptions);
    screen.addEventListener('touchcancel', onTouchCancel, touchOptions);
    screen.addEventListener('click', onClick, true);
    const selectionDisposable = term.onSelectionChange(() => {
      if (modeId === id) refreshActions();
    });

    attachments.set(id, {
      dispose() {
        screen.removeEventListener('touchstart', onTouchStart, touchOptions);
        screen.removeEventListener('touchmove', onTouchMove, touchOptions);
        screen.removeEventListener('touchend', onTouchEnd, touchOptions);
        screen.removeEventListener('touchcancel', onTouchCancel, touchOptions);
        screen.removeEventListener('click', onClick, true);
        selectionDisposable.dispose();
      },
    });
  }

  function detach(id) {
    if (modeId === id) deactivate();
    attachments.get(id)?.dispose();
    attachments.delete(id);
  }

  function init() {
    if (initialized) return;
    const { toggleButton, copyButton, doneButton } = elements();
    if (!toggleButton || !copyButton || !doneButton) return;
    initialized = true;

    for (const button of [toggleButton, copyButton, doneButton]) {
      button.addEventListener('pointerdown', event => event.preventDefault());
    }
    toggleButton.addEventListener('click', () => {
      if (modeId === getActiveId()) deactivate();
      else activate();
    });
    copyButton.addEventListener('click', copySelection);
    doneButton.addEventListener('click', () => deactivate());
    onTouchUiChange(refresh);
  }

  return { attach, detach, refresh, isActive, activate, deactivate };
}
