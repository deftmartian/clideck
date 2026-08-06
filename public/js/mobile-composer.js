import { isTouchUiEnabled, onTouchUiChange } from './touch-ui.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const EDITOR_MIN_HEIGHT = 44;
const EDITOR_MAX_HEIGHT = 82;
const COMMIT_ENTER_DELAY_MS = 100;

const CONTROL_INPUTS = Object.freeze({
  escape: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  interrupt: '\x03',
});

function prepareComposerData(text, bracketedPasteMode) {
  let prepared = String(text ?? '')
    .replace(/\r?\n/g, '\r')
    .replace(/\x1b/g, '\u241b');
  if (bracketedPasteMode) {
    prepared = `${BRACKETED_PASTE_START}${prepared}${BRACKETED_PASTE_END}`;
  }
  return prepared;
}

// Phones reload constantly (tab discards, PWA updates, our own reload
// banner): drafts persist per session so a half-typed prompt survives.
// Keys are kept when a session closes — resumed sessions reuse their ID and
// get their draft back.
const DRAFT_STORAGE_PREFIX = 'clideck.composerDraft.';

export function loadStoredDraft(id) {
  try { return localStorage.getItem(DRAFT_STORAGE_PREFIX + id) || ''; } catch { return ''; }
}

export function storeDraft(id, value) {
  try {
    if (value) localStorage.setItem(DRAFT_STORAGE_PREFIX + id, value);
    else localStorage.removeItem(DRAFT_STORAGE_PREFIX + id);
  } catch {}
}

function focusWithoutScroll(element) {
  try { element?.focus({ preventScroll: true }); }
  catch { element?.focus(); }
}

export function createMobileComposer({
  getActiveId,
  getEntry,
  getEntries,
  sendInput,
  onControlInput,
  onDraftChange,
  onCommitted,
  onSendFailure,
}) {
  let initialized = false;
  let toolsOpen = false;
  let pendingCommit = null;
  // Focus snapshot taken on control-button pointerdown, before Firefox moves
  // focus to the button: click handlers use it to preserve an open keyboard
  // without ever summoning a closed one.
  let keyboardWasUp = false;

  function elements() {
    return {
      root: document.getElementById('mobile-composer'),
      toolsButton: document.getElementById('mobile-composer-tools'),
      accessories: document.getElementById('mobile-composer-accessories'),
      textarea: document.getElementById('mobile-composer-text'),
      sendButton: document.getElementById('mobile-composer-send'),
      directButton: document.getElementById('mobile-composer-direct'),
    };
  }

  function available() {
    return isTouchUiEnabled();
  }

  function ownsInput(entry) {
    return !!entry && available() && !entry.mobileDirect;
  }

  function syncTerminalInput(entry) {
    const terminalTextarea = entry?.term?.textarea;
    if (!terminalTextarea) return;
    const composerOwnsInput = ownsInput(entry);
    // readOnly/inputmode=none is only advisory on Android. A synthesized
    // mousedown can still make xterm focus its hidden textarea and open the
    // keyboard. Disabled controls cannot receive focus, which gives Composer
    // exclusive ownership without interfering with xterm's touch scroller.
    terminalTextarea.disabled = composerOwnsInput;
    terminalTextarea.readOnly = composerOwnsInput || !!entry.term.options.disableStdin;
    if (composerOwnsInput) {
      if (document.activeElement === terminalTextarea) terminalTextarea.blur();
      terminalTextarea.setAttribute('inputmode', 'none');
      terminalTextarea.setAttribute('aria-disabled', 'true');
      terminalTextarea.dataset.clideckMobileComposer = 'true';
    } else {
      terminalTextarea.removeAttribute('inputmode');
      terminalTextarea.removeAttribute('aria-disabled');
      delete terminalTextarea.dataset.clideckMobileComposer;
    }
  }

  function resizeEditor(enabled, direct) {
    const { textarea } = elements();
    if (!textarea) return;
    textarea.style.height = `${EDITOR_MIN_HEIGHT}px`;
    const height = enabled && !direct
      ? Math.min(EDITOR_MAX_HEIGHT, Math.max(EDITOR_MIN_HEIGHT, textarea.scrollHeight))
      : EDITOR_MIN_HEIGHT;
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > EDITOR_MAX_HEIGHT ? 'auto' : 'hidden';
    document.body.style.setProperty('--mobile-composer-editor-extra', `${Math.max(0, height - EDITOR_MIN_HEIGHT)}px`);
    document.body.classList.toggle('mobile-composer-expanded', enabled && !direct && height > EDITOR_MIN_HEIGHT);
  }

  function setToolsOpen(open) {
    const { root, toolsButton, accessories } = elements();
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    toolsOpen = !!open && available() && !!entry;
    root?.classList.toggle('tools-open', toolsOpen);
    document.body.classList.toggle('mobile-composer-tools-open', toolsOpen);
    // The drawer wraps to more than one row on narrow screens; publish its
    // real height so toasts and the jump control clear it instead of
    // covering the controls.
    document.body.style.setProperty(
      '--mobile-composer-tools-height',
      toolsOpen && accessories ? `${accessories.offsetHeight + 6}px` : '0px',
    );
    toolsButton?.setAttribute('aria-expanded', toolsOpen ? 'true' : 'false');
    accessories?.setAttribute('aria-hidden', toolsOpen ? 'false' : 'true');
    resizeEditor(!!entry && available(), !!entry?.mobileDirect);
  }

  function sendTerminalData(id, data) {
    if (!id || !data || !sendInput(id, data)) {
      onSendFailure?.();
      return false;
    }
    return true;
  }

  function syncSendState() {
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    const { textarea, sendButton } = elements();
    if (!textarea || !sendButton) return;
    const busy = pendingCommit !== null;
    sendButton.disabled = busy || !entry || !textarea.value.trim() || !!entry.mobileDirect;
    sendButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function finishCommit(transaction) {
    if (pendingCommit !== transaction) return;
    if (!sendTerminalData(transaction.id, '\r')) {
      pendingCommit = null;
      syncSendState();
      return;
    }

    pendingCommit = null;
    const entry = getEntry(transaction.id);
    const { textarea } = elements();
    const unchanged = entry?.composerDraft === transaction.draft;
    if (entry && unchanged) {
      entry.composerDraft = '';
      storeDraft(transaction.id, '');
      entry.inputLength = 0;
      entry.inputHasText = false;
    }
    if (getActiveId() === transaction.id && textarea?.value === transaction.draft) {
      textarea.value = '';
      resizeEditor(true, false);
    }
    setToolsOpen(false);
    syncSendState();
    onCommitted?.(transaction.id);
    // Keep the keyboard if it was up when the draft was committed, never
    // summon a closed one.
    if (getActiveId() === transaction.id && !entry?.mobileDirect
      && transaction.keyboardWasUp) {
      requestAnimationFrame(() => focusWithoutScroll(textarea));
    }
  }

  function commit() {
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    const { textarea } = elements();
    if (!entry || !textarea || entry.mobileDirect || pendingCommit) return false;
    const draft = textarea.value;
    if (!draft.trim()) return false;
    const data = prepareComposerData(draft, !!entry.term.modes?.bracketedPasteMode);
    if (!sendTerminalData(id, data)) return false;
    // Keep Enter outside both the bracketed paste frame and the browser event
    // turn. Fast PTY delivery can otherwise make agent TUIs such as Claude and
    // Grok finish handling the paste after the Enter has already arrived.
    const transaction = {
      id,
      draft,
      keyboardWasUp: keyboardWasUp || document.activeElement === textarea,
    };
    pendingCommit = transaction;
    syncSendState();
    window.setTimeout(() => finishCommit(transaction), COMMIT_ENTER_DELAY_MS);
    return true;
  }

  function sendControl(key) {
    const data = CONTROL_INPUTS[key];
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    if (!entry || !data || !sendTerminalData(id, data)) return;
    onControlInput?.(id, data);
    // Drawer keys exist for keyboard-less navigation: keep focus if the
    // keyboard was up at pointerdown, never summon a closed one.
    const { textarea } = elements();
    if (!entry.mobileDirect && (keyboardWasUp || document.activeElement === textarea)) {
      focusWithoutScroll(textarea);
    }
  }

  function refresh({ focus = false } = {}) {
    init();
    const { root, textarea, sendButton, directButton } = elements();
    if (!root || !textarea || !sendButton || !directButton) return;
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    const enabled = !!entry && available();
    const wasEnabled = document.body.classList.contains('mobile-composer-enabled');

    document.body.classList.toggle('mobile-composer-enabled', enabled);
    document.body.classList.toggle('mobile-composer-direct', enabled && !!entry?.mobileDirect);
    root.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    for (const candidate of getEntries()) syncTerminalInput(candidate);

    if (!enabled) {
      setToolsOpen(false);
      resizeEditor(false, false);
      if (wasEnabled && entry) requestAnimationFrame(() => entry.requestFit?.());
      return;
    }

    if (textarea.value !== (entry.composerDraft || '')) textarea.value = entry.composerDraft || '';
    textarea.disabled = !!entry.mobileDirect;
    textarea.placeholder = entry.mobileDirect ? 'Direct terminal input is active' : 'Write a prompt or command…';
    syncSendState();
    directButton.setAttribute('aria-pressed', entry.mobileDirect ? 'true' : 'false');
    directButton.textContent = entry.mobileDirect ? 'Composer' : 'Direct';
    resizeEditor(true, !!entry.mobileDirect);

    if (wasEnabled !== enabled) requestAnimationFrame(() => entry.requestFit?.());
    if (focus) {
      setToolsOpen(false);
      if (entry.mobileDirect) entry.term.focus();
      else focusWithoutScroll(textarea);
    }
  }

  function toggleDirectInput() {
    const id = getActiveId();
    const entry = id ? getEntry(id) : null;
    if (!entry || !available()) return;
    entry.mobileDirect = !entry.mobileDirect;
    setToolsOpen(false);
    refresh({ focus: true });
  }

  function init() {
    if (initialized) return;
    const { root, toolsButton, textarea, sendButton, directButton } = elements();
    if (!root || !toolsButton || !textarea || !sendButton || !directButton) return;
    initialized = true;

    textarea.addEventListener('input', () => {
      const id = getActiveId();
      const entry = id ? getEntry(id) : null;
      if (!entry) return;
      entry.composerDraft = textarea.value;
      storeDraft(id, textarea.value);
      syncSendState();
      resizeEditor(true, false);
      onDraftChange?.(id, textarea.value);
    });
    textarea.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      commit();
    });

    for (const button of [toolsButton, sendButton, directButton, ...root.querySelectorAll('[data-terminal-key]')]) {
      button.addEventListener('pointerdown', event => {
        keyboardWasUp = document.activeElement === elements().textarea;
        event.preventDefault();
      });
      // Firefox only suppresses its mousedown focus steal when mousedown
      // itself is cancelled; cancelling pointerdown is enough for Chromium.
      button.addEventListener('mousedown', event => event.preventDefault());
    }
    toolsButton.addEventListener('click', () => setToolsOpen(!toolsOpen));
    sendButton.addEventListener('click', commit);
    directButton.addEventListener('click', toggleDirectInput);
    root.querySelectorAll('[data-terminal-key]').forEach(button => {
      button.addEventListener('click', () => sendControl(button.dataset.terminalKey));
    });

    onTouchUiChange(() => refresh());
  }

  return {
    available,
    ownsInput,
    refresh,
    syncTerminalInput,
    closeTools: () => setToolsOpen(false),
    blurInput: () => elements().textarea?.blur(),
  };
}
