export function trimTerminalSelection(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function writeClipboardFallback(text, documentRef) {
  if (!documentRef?.body || typeof documentRef.execCommand !== 'function') {
    throw new Error('Clipboard copy is unavailable');
  }
  const active = documentRef.activeElement;
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  documentRef.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!documentRef.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally {
    textarea.remove();
    try { active?.focus?.({ preventScroll: true }); } catch {}
  }
}

// Clipboard API access is restricted to secure contexts. CliDeck is commonly
// opened over plain HTTP on a private LAN, so user-initiated copy actions need
// the still-supported synchronous fallback while the key/click gesture is live.
export function writeClipboardText(text, {
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
} = {}) {
  const value = String(text ?? '');
  if (!clipboard?.writeText) {
    try {
      writeClipboardFallback(value, documentRef);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return clipboard.writeText(value).catch(() => writeClipboardFallback(value, documentRef));
}

export async function copyTrimmedTerminalSelection(text, writeText) {
  const source = String(text || '');
  const trimmed = trimTerminalSelection(source);
  if (!trimmed) return { copied: false, length: 0, saved: source.length };
  await writeText(trimmed);
  return { copied: true, length: trimmed.length, saved: source.length - trimmed.length };
}
