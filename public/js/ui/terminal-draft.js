import { store } from '../store.js';
import { commitTerminalDraft } from './terminal.js';
import { toast } from './toast.js';
import { showTerminalTab } from './content-dock.js';
import { openPluginComposition, updatePluginComposition, closePluginComposition,
  pluginCompositionState, onPluginCompositionChange, beforeCompositionOpen, focusComposition } from './plugin-composition.js';

const OWNER = '$terminal-draft';
const drafts = new Map();
let attachmentSequence = 0;
const STORAGE_PREFIX = 'clideck.draft.v2:';
const listeners = new Set();
let mobileView = null;
export function registerMobileDraftView(view) { mobileView = view; }
export function onDraftChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let warnedStorage = false;
function persist(id) {
  const draft = drafts.get(id);
  try {
    if (!draft || (!draft.text && !draft.pending.size && !draft.alternates.length && !draft.attachments.length)) localStorage.removeItem(STORAGE_PREFIX + id);
    else localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({text:draft.text,pending:draft.pending.size,alternates:draft.alternates,attachments:draft.attachments.map(({key,name,type,path,status,error})=>({key,name,type,path,status,error}))}));
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
    const attachments = (Array.isArray(saved?.attachments) ? saved.attachments : []).slice(0,32)
      .filter(a => a && typeof a.name === 'string' && a.name.length <= 1024)
      .map(a => ({key:String(++attachmentSequence), name:a.name, type:typeof a.type === 'string' ? a.type : '',
        path:typeof a.path === 'string' && a.path.length <= 8192 ? a.path : '',
        status:a.status === 'ready' && typeof a.path === 'string' && a.path.length > 0 && a.path.length <= 8192 ? 'ready' : 'error', error:'Upload interrupted. Remove and attach again.'}));
    drafts.set(id, { text, alternates, attachments, pending: new Set() });
    // Retire legacy keys only after the new recovery record was written successfully.
    try {
      if (!readable) throw new Error('One recovery record could not be read');
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({text,alternates,attachments,pending:0}));
      sessionStorage.removeItem('clideck.terminal-draft.v1:' + id);
      localStorage.removeItem('clideck.composerDraft.' + id);
    } catch {
      if (!warnedStorage) { warnedStorage = true; queueMicrotask(()=>toast.warn({title:'Draft recovery limited',body:'Some saved text could not be read or saved. Keep this tab open until you send.'})); }
    }
    if (interrupted) {persist(id);queueMicrotask(()=>toast.warn({title:'Attachment upload interrupted',body:'Your text was recovered. Attach the file again.'}));}
  }
  return drafts.get(id);
}
function fits(text) { return text.length <= 64000 && new TextEncoder().encode(text).byteLength <= 64 * 1024; }
function options(id) {
  const draft = record(id);
  const payload = draftPayload(draft);
  const blocked = draft.sending || draft.pending.size || draft.attachments.some(a => a.status !== 'ready');
  const canSend = !!payload.trim() && !blocked && fits(payload);
  return { editable: true, state: 'ready', title: 'Write a prompt', draft: draft.text,
    hint: draft.sending ? 'Sending attachments…' : blocked ? 'Finish or remove attachments before sending.' : !fits(payload) ? 'Shorten this draft before sending.' : 'Send submits the draft. Paste only inserts it.',
    canSend, canStop:canSend };
}
function paint(id) {
  for (const fn of listeners) fn(id);
  if (pluginCompositionState()?.pluginId === OWNER && store.activeId === id) updatePluginComposition(OWNER, options(id));
}
function joined(a, b) { return [a, b].filter(Boolean).join(a && !/\s$/.test(a) ? '\n' : ''); }
function nativeImage(a) { return /^image\/(png|jpeg|webp|gif)$/.test(a.type) && !/["\\\x00-\x1f]/.test(a.path); }
function draftPayload(draft, text = draft.text, includeImages = true) {
  return joined(text, draft.attachments.filter(a => a.status === 'ready' && (includeImages || !nativeImage(a))).map(a => JSON.stringify(a.path)).join('\n'));
}
function imagePaths(draft) { return draft.attachments.filter(nativeImage).map(a => a.path); }
function clear(draft) {
  for (const a of draft.attachments) { a.cancel?.(); if (a.preview) URL.revokeObjectURL(a.preview); }
  draft.attachments = []; draft.pending.clear(); draft.text = '';
}
export function discardDraft(id) { clear(record(id)); persist(id); paint(id); }
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
    if (submitDraft(event.sessionId, {submit:event.type === 'send'})) focusComposition();
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
  if (draft.sending || draft.pending.size || draft.attachments.some(a => a.status !== 'ready') || !fits(draftPayload(draft, joined(draft.text, text)))) return false;
  const previous = draft.text;
  draft.text = joined(draft.text, text); restore = id;
  if (options.submit) {
    const accepted = submitDraft(id, options);
    if (!accepted) { draft.text = previous; persist(id); paint(id); }
    return accepted;
  }
  persist(id); paint(id); return true;
}
export function draftOwnsInput(id) {
  return id === store.activeId && (mobileView?.enabled() || pluginCompositionState()?.sessionId === id);
}
export function beginDraftAttachment(id, file) {
  const draft = record(id);
  if (file && draft.attachments.length >= 32) return null;
  const attachment = file ? {key:String(++attachmentSequence),name:file.name,type:file.type,status:'queued',progress:0,
    preview:''} : null;
  const ticket = { id, draft, attachment };
  if (attachment) draft.attachments.push(attachment);
  draft.pending.add(ticket); persist(id);
  if (pluginCompositionState() && pluginCompositionState().pluginId !== OWNER) restore = id;
  if (id === store.activeId) openTerminalDraft({focus:false});
  paint(id); return ticket;
}
export function finishDraftAttachment(ticket, path) {
  const draft = drafts.get(ticket.id);
  if (draft !== ticket.draft || !draft.pending.delete(ticket)) return false;
  if (ticket.attachment) {
    delete ticket.attachment.cancel;
    Object.assign(ticket.attachment, {path:path || '',status:path ? 'ready' : 'error',error:path ? '' : 'Upload failed. Remove and attach again.'});
    persist(ticket.id); paint(ticket.id); return !!path;
  }
  if (path && !fits(joined(draft.text, path))) { persist(ticket.id); paint(ticket.id); return false; }
  if (path) draft.text = joined(draft.text, path);
  persist(ticket.id); paint(ticket.id); return true;
}
export function updateDraftAttachment(ticket, fields) {
  if (!ticket?.draft.pending.has(ticket)) return false;
  Object.assign(ticket.attachment, fields); paint(ticket.id); return true;
}
export function removeDraftAttachment(id, key) {
  const draft = record(id), index = draft.attachments.findIndex(a => a.key === key);
  if (index < 0) return;
  const [a] = draft.attachments.splice(index,1);
  for (const ticket of draft.pending) if (ticket.attachment === a) draft.pending.delete(ticket);
  a.cancel?.(); if (a.preview) URL.revokeObjectURL(a.preview);
  persist(id); paint(id);
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

export function getDraft(id) { const d = record(id); return {...options(id), pending:d.pending.size, alternates:[...d.alternates], attachments:d.attachments.map(({cancel,...a})=>({...a}))}; }
export function setDraft(id, text) { const d = record(id); d.text = String(text).slice(0,64000); persist(id); paint(id); }
export function recoverDraft(id, index) {
  const d = record(id), chosen = d.alternates[index];
  if (chosen == null) return;
  d.alternates.splice(index,1); if(d.text && d.text !== chosen) d.alternates.push(d.text);
  d.text = chosen; persist(id); paint(id);
}
export function submitDraft(id, {submit = true} = {}) {
  const d = record(id);
  if (!options(id).canSend) return false;
  const text = d.text, keys = d.attachments.map(a => a.key);
  const result = commitTerminalDraft(draftPayload(d, d.text, false),{sessionId:id,submit,focus:false,images:imagePaths(d),
    attachments:d.attachments.map(a => a.path), onResult:(ok,error) => {
      d.sending = false;
      if (ok) {
        if (d.text === text) d.text = '';
        for (const key of keys) removeDraftAttachment(id,key);
      } else toast.warn({title:'Draft kept',body:error || 'The terminal could not accept these attachments.'});
      persist(id); paint(id);
    }});
  if (!result) {
    toast.warn({title:'Draft kept',body:'Reconnect to this session before sending.'}); return false;
  }
  if (result === 'pending') d.sending = true; else clear(d);
  persist(id); paint(id); return true;
}
