import { store } from '../store.js';
import { openContentPath, uploadFile } from '../ws.js';
import { openWorkspaceTab, showTerminalTab } from './content-dock.js';
import { openFolderPicker } from './folder-picker.js';
import { beginDraftAttachment, finishDraftAttachment, openTerminalDraft } from './terminal-draft.js';
import { toast } from './toast.js';

import { stageFiles } from './attachments.js';

const views = new Map();
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>'),
  up: svg('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  newFolder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  newFile: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M12 11v6M9 14h6"/>'),
  upload: svg('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>'),
  download: svg('<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
};
function icon(name, className = 'files-icon') {
  const node = el('span', undefined, className); node.innerHTML = ICONS[name]; node.setAttribute('aria-hidden', 'true'); return node;
}
function button(text, action, iconName, className) {
  const node = el('button'); node.type = 'button'; node.onclick = action; node.setAttribute('aria-label', text);
  if (iconName) node.append(icon(iconName));
  node.append(el('span', text, 'files-label'));
  if (className) node.className = className;
  return node;
}
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024; const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
const formatDate = ms => Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
function input(label) {
  const node = el('input'); node.setAttribute('aria-label', label); node.autocomplete = 'off'; return node;
}
async function request(sessionId, action, fields) {
  if (!store.connected) throw new Error('Reconnect before using Files.');
  const response = await fetch('/api/files', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, action, ...fields }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || result.error || 'File operation failed.');
  return result;
}
export function hasFilesView(session) { return views.has(session.id); }
export function filesDirectory(session) { return views.get(session.id)?.path || session.cwd; }
export async function attachPickedFiles(session, files, directory = filesDirectory(session)) {
  await stageFiles(session, files, directory);
  const view = views.get(session.id);
  if (view?.path === directory) void view.refresh();
}
function recoverEditor(path, value, eol) {
  const overlay = el('div', undefined, 'files-recovery');
  const dialog = el('section'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Unsaved file recovery');
  const heading = el('h2', 'Unsaved file edits');
  const explanation = el('p', `The session closed. Your edits to ${path} are still here. Copy or download them before closing this recovery window.`);
  const text = el('textarea'); text.value = value; text.readOnly = true; text.setAttribute('aria-label', 'Recovered file text');
  const warn = event => { event.preventDefault(); event.returnValue = ''; };
  window.addEventListener('beforeunload', warn);
  const actions = el('div', undefined, 'files-toolbar');
  actions.append(button('Download unsaved text', () => {
    const url = URL.createObjectURL(new Blob([value.replace(/\n/g, eol)], {type:'text/plain;charset=utf-8'}));
    const link = el('a'); link.href = url; link.download = path.split(/[\\/]/).pop() + '.unsaved.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }), button('Close recovery', () => {
    if (!confirm('Close this recovery window? Copy or download your edits first.')) return;
    window.removeEventListener('beforeunload', warn); overlay.remove();
  }));
  dialog.append(heading, explanation, text, actions); overlay.append(dialog); document.body.append(overlay); text.focus();
}
export function initFiles() {
  const trigger = document.getElementById('th-files');
  trigger.onclick = () => {
    const session = store.active();
    if (session) openWorkspaceTab('$core', { id: 'files', title: 'Files', build: () => buildFiles(session) });
  };
  const refresh = () => { trigger.disabled = !store.active(); };
  store.on('active', refresh); refresh();
}
function buildFiles(session) {
  const root = el('section', undefined, 'files-workspace'); root.setAttribute('aria-label', 'Files');
  const pathForm = el('form', undefined, 'files-path');
  const pathInput = input('Folder path'); pathInput.spellcheck = false;
  const up = button('Up', () => navigate(parent), 'up');
  const go = button('Go', () => navigate(pathInput.value));
  pathForm.append(up, pathInput, go); pathForm.onsubmit = event => { event.preventDefault(); navigate(pathInput.value); };
  const crumbs = el('nav', undefined, 'files-crumbs'); crumbs.setAttribute('aria-label', 'Location');
  const toolbar = el('div', undefined, 'files-toolbar');
  const hidden = input('Show hidden files'); hidden.type = 'checkbox';
  const hiddenLabel = el('label', 'Hidden', 'files-hidden'); hiddenLabel.prepend(hidden); hidden.onchange = () => navigate(path);
  const filter = input('Filter files'); filter.type = 'search'; filter.placeholder = 'Filter'; filter.className = 'files-filter';
  const upload = el('input'); upload.type = 'file'; upload.multiple = true; upload.hidden = true; upload.setAttribute('aria-label', 'Upload files');
  toolbar.append(button('Refresh', () => navigate(path), 'refresh'), hiddenLabel, filter,
    button('New folder', () => create('directory'), 'newFolder'), button('New file', () => create('file'), 'newFile'),
    button('Upload', () => upload.click(), 'upload'), upload);
  const actions = el('div', undefined, 'files-toolbar files-actions');
  const slot = el('div', undefined, 'files-form-slot');
  const status = el('div', '', 'files-status'); status.setAttribute('role', 'status');
  const listing = el('div', undefined, 'files-list'); listing.setAttribute('role', 'listbox'); listing.setAttribute('aria-label', 'Folder contents');
  const editor = el('div', undefined, 'files-editor'); editor.hidden = true;
  const title = el('strong');
  const text = el('textarea'); text.setAttribute('aria-label', 'File text'); text.spellcheck = false;
  const save = button('Save', () => saveText());
  const editorBar = el('div', undefined, 'files-toolbar');
  editorBar.append(title, save, button('Close editor', () => closeEditor())); editor.append(editorBar, text);
  root.append(pathForm, crumbs, toolbar, actions, slot, status, listing, editor);
  let path = session.cwd, parent = path, entries = [], selected = null, generation = 0, busy = false, disposed = false;
  let edit = null, discardApproved = false;
  const view = { path, refresh: () => navigate(path) }; views.set(session.id, view);
  const dirty = () => !!edit && text.value !== edit.text;
  const beforeUnload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  root._beforeClose = () => { discardApproved = !busy && (!dirty() || confirm('Discard unsaved file edits?')); return discardApproved; };
  root._dispose = () => { if (dirty() && !discardApproved) recoverEditor(edit.path, text.value, edit.eol); disposed = true; generation++; window.removeEventListener('beforeunload', beforeUnload); if (views.get(session.id) === view) views.delete(session.id); };
  async function run(action) {
    if (disposed) return;
    if (busy) { toast.info({title:'Files is busy',body:'Wait for the current operation, then try again.'}); return; }
    busy = true; root.classList.add('files-busy'); status.textContent = 'Working…'; paintActions();
    try { await action(); }
    catch (error) { if (!disposed) status.textContent = error.message; }
    finally { busy = false; root.classList.remove('files-busy'); paintActions(); }
  }
  async function navigate(next) {
    if (disposed || busy) return;
    const ticket = ++generation; status.textContent = 'Loading…';
    try {
      const result = await request(session.id, 'list', { path: next, showHidden: hidden.checked });
      if (disposed || ticket !== generation) return;
      path = result.path; parent = result.parent; view.path = path; pathInput.value = path;
      entries = result.entries; selected = null; filter.value = ''; slot.replaceChildren();
      notice = result.truncated ? 'Showing the first 5,000 entries. Open a subfolder to narrow the list.' : '';
      const hadFocus = listing.contains(document.activeElement);
      paintCrumbs(); paintEntries(); paintActions();
      if (hadFocus) listing.querySelector('.files-row[tabindex="0"]')?.focus();
    } catch (error) { if (!disposed && ticket === generation) { pathInput.value = path; status.textContent = error.message; } }
  }
  function paintCrumbs() {
    crumbs.replaceChildren();
    const parts = path.split('/').filter(Boolean);
    const targets = ['/', ...parts.map((part, index) => '/' + parts.slice(0, index + 1).join('/'))];
    targets.forEach((target, index) => {
      const crumb = el('button', index ? parts[index - 1] : '/', 'files-crumb'); crumb.type = 'button';
      crumb.setAttribute('aria-label', `Go to ${target}`); crumb.title = target;
      if (index === parts.length) crumb.setAttribute('aria-current', 'location');
      crumb.onclick = () => navigate(target);
      crumbs.append(crumb);
    });
    crumbs.scrollLeft = crumbs.scrollWidth;
  }
  const visibleEntries = () => {
    const needle = filter.value.trim().toLowerCase();
    return needle ? entries.filter(entry => entry.name.toLowerCase().includes(needle)) : entries;
  };
  function select(entry, focus) {
    selected = entry;
    for (const item of entries) if (item.row) {
      const on = item === entry;
      item.row.classList.toggle('is-selected', on); item.row.setAttribute('aria-selected', String(on)); item.row.tabIndex = on ? 0 : -1;
    }
    if (focus) entry.row.focus();
    paintActions();
  }
  function paintEntries() {
    listing.replaceChildren();
    const shown = visibleEntries();
    if (selected && !shown.includes(selected)) selected = null;
    for (const entry of entries) entry.row = null;
    for (const entry of shown) {
      const row = el('div', undefined, 'files-row'); row.setAttribute('role', 'option'); row.setAttribute('aria-label', entry.name);
      row.setAttribute('aria-selected', 'false'); row.tabIndex = -1; row.title = entry.name;
      const kind = entry.kind === 'directory' ? 'folder' : entry.symlink ? 'link' : 'file';
      const label = el('span', entry.name, 'files-name');
      const size = el('span', entry.kind === 'directory' ? '' : formatSize(entry.size), 'files-size');
      const modified = el('span', formatDate(entry.modified), 'files-modified');
      row.append(icon(kind, `files-icon files-icon-${kind}`), label, size, modified);
      row.onclick = () => select(entry);
      row.ondblclick = () => open(entry);
      row.onkeydown = event => {
        const index = shown.indexOf(entry);
        if (event.key === 'Enter') { event.preventDefault(); open(entry); }
        else if (event.key === ' ') { event.preventDefault(); select(entry); }
        else if (event.key === 'ArrowDown' && shown[index + 1]) { event.preventDefault(); select(shown[index + 1], true); }
        else if (event.key === 'ArrowUp' && shown[index - 1]) { event.preventDefault(); select(shown[index - 1], true); }
        else if (event.key === 'Home') { event.preventDefault(); select(shown[0], true); }
        else if (event.key === 'End') { event.preventDefault(); select(shown[shown.length - 1], true); }
      };
      entry.row = row; listing.append(row);
    }
    const first = selected?.row || shown[0]?.row;
    if (first) first.tabIndex = 0;
    if (selected) select(selected);
    if (!shown.length) listing.append(el('div', entries.length ? 'No items match the filter.' : 'This folder is empty.', 'files-empty'));
    paintStatus();
  }
  let notice = '';
  function paintStatus() {
    const shown = visibleEntries().length;
    const count = shown === entries.length ? `${entries.length} items` : `${shown} of ${entries.length} items`;
    status.textContent = notice ? `${count}. ${notice}` : count;
  }
  filter.oninput = () => { paintEntries(); paintActions(); };
  function selectedPath(entry = selected) { return path.replace(/[\\/]+$/, '') + '/' + entry.name; }
  function open(entry) {
    if (busy) return;
    if (entry.kind === 'directory') void navigate(selectedPath(entry));
    else openContentPath(session.id, selectedPath(entry));
  }
  function paintActions() {
    actions.replaceChildren();
    if (!selected) { actions.append(el('span', 'Select a file or folder', 'files-hint')); return; }
    const isDirectory = selected.kind === 'directory';
    const summary = el('span', undefined, 'files-selection');
    summary.append(el('strong', selected.name), el('small', isDirectory ? 'Folder' : formatSize(selected.size)));
    const primary = el('div', undefined, 'files-primary');
    primary.append(button('Open', () => open(selected), undefined, 'files-open'));
    if (!isDirectory) primary.append(button('Download', () => download(selected), 'download'));
    primary.append(button('Insert path', () => insertPath()));
    if (!isDirectory) {
      const editButton = button('Edit text', () => editText());
      editButton.disabled = selected.kind !== 'file' || selected.symlink; primary.append(editButton);
    }
    const secondary = el('div', undefined, 'files-secondary');
    secondary.append(button('Rename', () => rename()), button('Move', () => move()), button('Delete', () => remove(), undefined, 'files-danger'));
    actions.append(summary, primary, secondary);
    actions.querySelectorAll('button').forEach(node => { node.disabled = node.disabled || busy; });
  }
  function download(entry) {
    const source = selectedPath(entry);
    run(async () => {
      // Show validation errors in Files before handing the transfer to the browser.
      const info = await request(session.id, 'stat', { path: source });
      const link = el('a'); link.rel = 'noopener'; link.download = info.name;
      link.href = `/api/files/download?${new URLSearchParams({ sessionId: session.id, path: source })}`;
      document.body.append(link); link.click(); link.remove();
      status.textContent = `Download started: ${info.name} (${formatSize(info.size)})`;
    });
  }
  function insertPath() {
    const ticket = beginDraftAttachment(session.id);
    if (!finishDraftAttachment(ticket, selectedPath())) { status.textContent = 'The draft is full.'; return; }
    showTerminalTab(); openTerminalDraft({ focus: true });
  }
  function nameForm(container, label, initial, submit) {
    const form = el('form', undefined, 'files-name-form');
    const field = input(label); field.value = initial; field.placeholder = label;
    const done = button('Confirm', () => form.requestSubmit());
    form.append(field, done, button('Cancel', () => form.remove()));
    form.onsubmit = event => { event.preventDefault(); if (field.value) submit(field.value, form); };
    container.replaceChildren(form); field.focus(); field.select();
  }
  function create(kind) {
    if (busy) return;
    const directory = path;
    nameForm(slot, kind === 'directory' ? 'New folder name' : 'New file name', '', (name, form) => run(async () => {
      await request(session.id, 'create', { path: directory, name, kind }); form.remove(); status.textContent = 'Created.';
      await reloadAfterMutation();
    }));
  }
  function affectsEditor(source) { return edit && (edit.path === source || edit.path.startsWith(source + '/')); }
  function rename() {
    const source = selectedPath(), directory = path;
    const entry = selected;
    nameForm(slot, 'New name', entry.name, (name, form) => run(async () => {
      if (affectsEditor(source) && dirty()) throw new Error('Save or close the editor before renaming this file.');
      await request(session.id, 'move', { path: source, destination: directory, name });
      if (affectsEditor(source)) closeEditor(); form.remove(); await reloadAfterMutation();
    }));
  }
  function move() {
    const source = selectedPath();
    openFolderPicker(path, destination => run(async () => {
      if (affectsEditor(source) && dirty()) throw new Error('Save or close the editor before moving this file.');
      await request(session.id, 'move', { path: source, destination });
      if (affectsEditor(source)) closeEditor(); await reloadAfterMutation();
    }));
  }
  function remove() {
    const source = selectedPath(), entry = selected;
    const confirmation = prompt(`Delete ${entry.name}? This cannot be undone. Type its exact name:`);
    if (confirmation !== entry.name) return;
    run(async () => {
      if (affectsEditor(source) && dirty()) throw new Error('Save or close the editor before deleting this file.');
      try { await request(session.id, 'delete', { path: source, confirmName: confirmation }); }
      catch (error) {
        if (entry.kind !== 'directory' || !/ENOTEMPTY|not empty/i.test(error.message)) throw error;
        if (!confirm(`Delete ${entry.name} and everything inside it? This cannot be undone.`)) { status.textContent = 'Deletion cancelled.'; return; }
        await request(session.id, 'delete', { path: source, confirmName: confirmation, recursive: true });
      }
      if (affectsEditor(source)) closeEditor(); await reloadAfterMutation();
    });
  }
  async function reloadAfterMutation() {
    busy = false; await navigate(path); busy = true;
  }
  function closeEditor() {
    if (dirty() && !confirm('Discard unsaved file edits?')) return false;
    edit = null; editor.hidden = true; return true;
  }
  function editText() {
    const source = selectedPath();
    if (!closeEditor()) return;
    run(async () => {
      const result = await request(session.id, 'read', { path: source });
      if (result.links > 1) throw new Error('Use another editor for hard-linked files to preserve their link relationships.');
      const endings = [...new Set(result.text.match(/\r\n|\r|\n/g) || [])];
      if (endings.length > 1) throw new Error('This file mixes line endings. Preview it here; use another editor to preserve them when editing.');
      text.value = result.text;
      edit = { ...result, path: source, text: text.value, eol: endings[0] || '\n' }; title.textContent = source; title.title = source;
      editor.hidden = false; status.textContent = 'UTF-8 text · up to 1 MiB'; text.focus();
    });
  }
  function saveText() {
    if (!edit) return;
    if (!dirty()) { status.textContent = 'No changes to save.'; return; }
    const source = edit, value = text.value;
    run(async () => {
      const result = await request(session.id, 'save', { path: source.path, text: value.replace(/\n/g, source.eol), revision: source.revision });
      if (edit === source) { edit.revision = result.revision; edit.text = value; }
      status.textContent = 'Saved.';
    });
  }
  async function uploadFiles(files) {
    const destination = path;
    await run(async () => {
      for (const file of files) {
        status.textContent = `Uploading ${file.name}…`;
        await uploadFile(session.id, file.name, file, progress => { status.textContent = `Uploading ${file.name}: ${Math.round(progress * 100)}%`; }, destination);
      }
      await reloadAfterMutation();
    });
  }
  upload.onchange = () => { const files = [...upload.files]; upload.value = ''; void uploadFiles(files); };
  // Keep the terminal drop handler from redirecting Files drops back to session cwd.
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) root.addEventListener(type, event => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault(); event.stopPropagation();
    if (type === 'drop') void uploadFiles([...event.dataTransfer.files]);
  });
  void navigate(path);
  return root;
}
