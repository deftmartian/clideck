// One session-bound draft store for keyboard input, dictation and attachments.
import { store } from '../store.js';
import { commitTerminalDraft } from './terminal.js';
import { toast } from './toast.js';
import { showTerminalTab } from './content-dock.js';
import { openPluginComposition, updatePluginComposition, closePluginComposition,
  pluginCompositionState, onPluginCompositionChange, beforeCompositionOpen, focusComposition } from './plugin-composition.js';

const OWNER = '$terminal-draft';
const drafts = new Map();
const STORAGE_PREFIX = 'clideck.draft.v2:';
const listeners = new Set();
let mobileView = null;
export function registerMobileDraftView(view) { mobileView = view; }
export function onDraftChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let warnedStorage = false;
function persist(id) {
  const draft = drafts.get(id);
  try {
    if (!draft || (!draft.text && !draft.pending.size && !draft.alternates.length)) localStorage.removeItem(STORAGE_PREFIX + id);
    else localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({text:draft.text,pending:draft.pending.size,alternates:draft.alternates}));
  } catch {
    if (!warnedStorage) { warnedStorage = true; toast.warn({title:'Draft recovery unavailable',body:'Keep this tab open until you send. Browser storage is unavailable.'}); }
  }
}
let restore = null;
function record(id) {
  if (!drafts.has(id)) {
    let text = '', interrupted = false, alternates = [], readable = true;
    // Read independently: a malformed old key must not hide a valid draft.
    const read = fn => { try { return fn(); } catch { readable = false; return null; } };
    const saved = read(() => JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || 'null'));
    const recent = read(() => JSON.parse(sessionStorage.getItem('clideck.terminal-draft.v1:' + id) || 'null'));
    const legacy = read(() => localStorage.getItem('clideck.composerDraft.' + id));
    const valid = value => typeof value === 'string' && value.length <= 64000;
    text = [saved?.text, recent?.text, legacy].find(valid) ?? '';
    alternates = [...new Set([recent?.text, legacy, ...(Array.isArray(saved?.alternates) ? saved.alternates : [])]
      .filter(value => valid(value) && value && value !== text))];
    interrupted = (saved?.pending || recent?.pending || 0) > 0;
    drafts.set(id, { text, alternates, pending: new Set() });
    // Retire legacy keys only after the new recovery record was written successfully.
    try {
      if (!readable) throw new Error('One recovery record could not be read');
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({text,alternates,pending:0}));
      sessionStorage.removeItem('clideck.terminal-draft.v1:' + id);
      localStorage.removeItem('clideck.composerDraft.' + id);
    } catch {
      if (!warnedStorage) { warnedStorage = true; queueMicrotask(()=>toast.warn({title:'Draft recovery limited',body:'Some saved text could not be read or saved. Keep this tab open until you send.'})); }
    }
    if (interrupted) {persist(id);queueMicrotask(()=>toast.warn({title:'Image upload interrupted',body:'Your text was recovered. Paste the image again to attach it.'}));}
  }
  return drafts.get(id);
}
function fits(text) { return text.length <= 64000 && new TextEncoder().encode(text).byteLength <= 64 * 1024; }
function options(id) {
  const draft = record(id);
  return { editable: true, state: 'ready', title: 'Write a prompt', draft: draft.text,
    hint: draft.pending.size ? 'Attaching image…' : !fits(draft.text) ? 'Shorten this draft before sending.' : 'Send submits the draft. Paste only inserts it.',
    canSend: !!draft.text.trim() && !draft.pending.size && fits(draft.text), canStop: !!draft.text.trim() && !draft.pending.size && fits(draft.text) };
}
function paint(id) {
  for (const fn of listeners) fn(id);
  if (pluginCompositionState()?.pluginId === OWNER && store.activeId === id) updatePluginComposition(OWNER, options(id));
}
function joined(a, b) { return [a, b].filter(Boolean).join(a && !/\s$/.test(a) ? '\n' : ''); }
export function closeTerminalDraft() { closePluginComposition(OWNER); }
export function openTerminalDraft({ focus = true } = {}) {
  const session = store.active();
  if (!session || session.live === false) return false;
  showTerminalTab();
  if (mobileView?.enabled()) { mobileView.open({focus}); return true; }
  if (pluginCompositionState() && pluginCompositionState().pluginId !== OWNER) {
    restore = session.id; return false;
  }
  openPluginComposition(OWNER, options(session.id), event => {
    if (event.reason) return;
    const draft = record(event.sessionId);
    if (event.type === 'change') { draft.text = event.draft; persist(event.sessionId); paint(event.sessionId); return; }
    if (event.type === 'cancel') { closeTerminalDraft(); return; }
    if (draft.pending.size || !fits(draft.text)) return;
    if (commitTerminalDraft(draft.text, { sessionId: event.sessionId, submit: event.type === 'send', focus: false })) {
      draft.text = ''; persist(event.sessionId); paint(event.sessionId); focusComposition();
    } else toast.warn({title:'Draft kept', body:'Reconnect to this session before sending.'});
  });
  if (focus) focusComposition();
  return true;
}
export function toggleTerminalDraft() {
  if (pluginCompositionState()?.pluginId === OWNER && !document.getElementById('term-panel')?.hidden) closeTerminalDraft(); else openTerminalDraft();
}
// Called by the plugin host, never directly exposed to another plugin's state.
export function commitCompositionDraft(text, options = {}) {
  const id = options.sessionId;
  if (!id || id !== store.activeId || store.active()?.live === false) return false;
  const draft = record(id);
  if (draft.pending.size || !fits(joined(draft.text, text))) return false;
  if (options.submit) {
    if (!commitTerminalDraft(joined(draft.text, text), {...options,focus:false})) return false;
    draft.text = ''; restore = id;
  } else {
    draft.text = joined(draft.text, text); restore = id;
  }
  persist(id); paint(id); return true;
}
export function beginDraftAttachment(id) {
  const draft = record(id), ticket = { id, draft };
  draft.pending.add(ticket); persist(id);
  if (pluginCompositionState() && pluginCompositionState().pluginId !== OWNER) restore = id;
  if (id === store.activeId) openTerminalDraft({focus:false});
  paint(id); return ticket;
}
export function finishDraftAttachment(ticket, path) {
  const draft = drafts.get(ticket.id);
  if (draft !== ticket.draft || !draft.pending.delete(ticket)) return false;
  if (path && !fits(joined(draft.text, path))) { persist(ticket.id); paint(ticket.id); return false; }
  if (path) draft.text = joined(draft.text, path);
  persist(ticket.id); paint(ticket.id); return true;
}
beforeCompositionOpen(owner => {
  if (owner !== OWNER && pluginCompositionState()?.pluginId === OWNER) {
    restore = store.activeId; closeTerminalDraft();
  }
});
onPluginCompositionChange(state => {
  if (state || !restore || restore !== store.activeId) return;
  const id = restore;
  // A closing plugin completes its own cleanup before the core draft reopens.
  queueMicrotask(() => { if (restore === id && store.activeId === id && !pluginCompositionState()) { restore = null; openTerminalDraft({focus:false}); } });
});
store.on('active', () => { restore = null; });
store.on('session:remove', id => { if (restore === id) restore = null; });
store.on('reset', () => { restore = null; });

// Presentation-independent operations shared by the phone composer and plugin draft bridge.
export function getDraft(id) { const d = record(id); return {...options(id), pending:d.pending.size, alternates:[...d.alternates]}; }
export function setDraft(id, text) { const d = record(id); d.text = String(text).slice(0,64000); persist(id); paint(id); }
export function recoverDraft(id, index) {
  const d = record(id), chosen = d.alternates[index];
  if (chosen == null) return;
  d.alternates.splice(index,1); if(d.text && d.text !== chosen) d.alternates.push(d.text);
  d.text = chosen; persist(id); paint(id);
}
export function submitDraft(id, {submit = true} = {}) {
  const d = record(id);
  if (!d.text.trim() || d.pending.size || !fits(d.text)) return false;
  if (!commitTerminalDraft(d.text,{sessionId:id,submit,focus:false})) {
    toast.warn({title:'Draft kept',body:'Reconnect to this session before sending.'}); return false;
  }
  d.text = ''; persist(id); paint(id); return true;
}
