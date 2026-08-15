// Prompt Library — manage saved prompts and // trigger autocomplete
import { state, send } from './state.js';
import { esc, randomUUID } from './utils.js';
import { getViewportRect, onViewportChange } from './viewport.js';

// --- Panel rendering ---

const panel = document.getElementById('panel-prompts');

function getPrompts() { return state.cfg.prompts || []; }

function save() {
  send({ type: 'config.update', config: state.cfg });
}

export function renderPrompts() {
  const prompts = getPrompts();
  panel.innerHTML = `
    <div class="flex items-center justify-between px-3 pt-3 pb-2">
      <span class="text-sm font-bold text-slate-200 tracking-tight" style="font-family:'JetBrains Mono',monospace">Prompts</span>
      <div class="flex items-center gap-1">
        <button id="btn-prompt-help" class="icon-btn w-7 h-7 flex items-center justify-center rounded-md border border-slate-600 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors text-sm" title="How prompts work">?</button>
        <button id="btn-add-prompt" class="icon-btn w-7 h-7 flex items-center justify-center rounded-md border border-slate-600 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors text-sm" title="New prompt">+</button>
      </div>
    </div>
    <div class="px-3 pb-2.5">
      <div id="prompts-hint" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/40 text-slate-600 text-[11px] cursor-text">
        <kbd class="prompts-hint-kbd px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 font-mono text-[10px]">//</kbd>
        <span class="prompts-hint-label flex-1">Type in terminal to search &amp; paste</span>
        <input id="prompts-search" type="text" placeholder="Filter prompts…" class="hidden flex-1 bg-transparent text-slate-300 text-[11px] outline-none placeholder-slate-600">
      </div>
    </div>
    <div id="prompts-list" class="tmx-scroll flex-1 overflow-y-auto border-t border-slate-700/50"></div>`;

  const hint = panel.querySelector('#prompts-hint');
  const searchInput = panel.querySelector('#prompts-search');
  const hintKbd = panel.querySelector('.prompts-hint-kbd');
  const hintLabel = panel.querySelector('.prompts-hint-label');

  hint.addEventListener('click', () => {
    hintKbd.classList.add('hidden');
    hintLabel.classList.add('hidden');
    searchInput.classList.remove('hidden');
    searchInput.focus();
  });

  searchInput.addEventListener('blur', () => {
    if (!searchInput.value) {
      searchInput.classList.add('hidden');
      hintKbd.classList.remove('hidden');
      hintLabel.classList.remove('hidden');
    }
  });

  searchInput.addEventListener('input', () => {
    renderPromptList(prompts, searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.blur();
      renderPromptList(prompts, '');
    }
  });

  panel.querySelector('#btn-add-prompt').addEventListener('click', () => openEditor());
  panel.querySelector('#btn-prompt-help').addEventListener('click', () => openHelp());

  const list = panel.querySelector('#prompts-list');

  // Delegate clicks on the list once — survives innerHTML replacements from filtering
  list.addEventListener('click', (e) => {
    if (e.target.closest('.prompt-edit')) {
      const idx = +e.target.closest('.prompt-row').dataset.idx;
      openEditor(idx);
      return;
    }
    if (e.target.closest('.prompt-del')) {
      const idx = +e.target.closest('.prompt-row').dataset.idx;
      state.cfg.prompts.splice(idx, 1);
      save();
      renderPrompts();
      return;
    }
    const row = e.target.closest('.prompt-row');
    if (row) {
      const idx = +row.dataset.idx;
      pastePrompt(prompts[idx].text);
    }
  });

  renderPromptList(prompts, '');
}

// A prompt may be tagged with a project. Tagged ones surface first while you work
// in that project; untagged prompts stay global and are always listed, just after.
// With no project on the active session there is nothing to prefer, so order stands.
function orderByProject(prompts) {
  const current = state.terms.get(state.active)?.projectId || null;
  if (!current) return prompts;
  // Stable sort — ranking and library order are preserved inside each group.
  return prompts.slice().sort((a, b) =>
    Number(b.projectId === current) - Number(a.projectId === current));
}

// Rank matches so title (name) hits outrank body-only hits — the name is why the
// prompt exists, so //programmer lists every name match before any text-only match.
function searchPrompts(prompts, filter) {
  const q = (filter || '').toLowerCase().trim();
  if (!q) return prompts;
  return prompts
    .map((p, i) => {
      const rank = p.name.toLowerCase().includes(q) ? 2 : p.text.toLowerCase().includes(q) ? 1 : 0;
      return { p, i, rank };
    })
    .filter(m => m.rank)
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map(m => m.p);
}

function renderPromptList(prompts, filter) {
  const list = panel.querySelector('#prompts-list');
  const q = (filter || '').toLowerCase().trim();
  const filtered = searchPrompts(prompts, filter);
  if (!prompts.length) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center h-full px-6 text-center">
      <p class="text-sm text-slate-400 mb-1">No prompts saved</p>
      <p class="text-xs text-slate-600 leading-relaxed">Add prompts and paste them into any terminal<br>by typing <kbd class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px] font-mono">//</kbd> followed by a few letters.</p>
    </div>`;
  } else if (!filtered.length) {
    list.innerHTML = `<div class="flex items-center justify-center py-6 px-6 text-center">
      <p class="text-xs text-slate-600">No prompts matching "${esc(q)}"</p>
    </div>`;
  } else {
    list.innerHTML = filtered.map((p, i) => {
      const idx = prompts.indexOf(p);
      const project = p.projectId ? (state.cfg.projects || []).find(x => x.id === p.projectId) : null;
      return `
      <div class="prompt-row group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-slate-800/40 transition-colors ${i > 0 ? 'border-t border-slate-700/30' : ''}" data-idx="${idx}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-medium text-slate-200 truncate">${esc(p.name)}</span>
            ${project ? `<span class="flex-shrink-0 px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 text-[10px] leading-none">${esc(project.name)}</span>` : ''}
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">${esc(p.text)}</div>
        </div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
          <button class="prompt-edit w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/60 transition-colors" title="Edit">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="prompt-del w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/60 transition-colors" title="Delete">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }
}

function closeEditor() {
  document.getElementById('prompt-editor')?.remove();
}

function closeHelp() {
  document.getElementById('prompt-help')?.remove();
}

// PORT-TO-NEXT: prompts help card ([?] in header) — new feature, replicate in clideck-next.
// Concise usage help. Shares the editor's slot below the header and is mutually
// exclusive with it — opening help closes an open add/edit form, and vice versa.
function openHelp() {
  if (document.getElementById('prompt-help')) { closeHelp(); return; } // toggle off
  closeEditor();
  const card = document.createElement('div');
  card.id = 'prompt-help';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30 text-[11px] text-slate-400 leading-relaxed';
  card.innerHTML = `
    <div class="flex items-center justify-between mb-1.5">
      <span class="text-xs font-semibold text-slate-300">Using prompts</span>
      <button id="ph-close" class="text-slate-500 hover:text-slate-300 transition-colors" title="Close">✕</button>
    </div>
    <p class="mb-2">Save reusable prompts — coding guidance, reviewer notes, project intros. In any terminal, type <kbd class="px-1 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono text-[10px]">//</kbd> then a few letters to search and paste one (title matches rank first).</p>
    <p class="mb-2">Give a prompt a project to list it first while you work there. Prompts with no project stay available everywhere.</p>
    <p class="mb-1 text-slate-300">Placeholders — filled from the active session on paste:</p>
    <ul class="space-y-1">
      <li><code class="px-1 py-0.5 rounded bg-slate-900 text-slate-300 font-mono">{{session_name}}</code> → the session's name</li>
      <li><code class="px-1 py-0.5 rounded bg-slate-900 text-slate-300 font-mono">{{project_name}}</code> → its project (blank if none)</li>
    </ul>`;
  const list = panel.querySelector('#prompts-list');
  list.parentElement.insertBefore(card, list);
  card.querySelector('#ph-close').addEventListener('click', closeHelp);
}

function openEditor(idx) {
  // Toggle off if already open
  if (document.getElementById('prompt-editor')) { closeEditor(); if (idx == null) return; }
  closeHelp(); // help and the add/edit form share one slot — never both at once
  const existing = idx != null ? getPrompts()[idx] : null;

  const card = document.createElement('div');
  card.id = 'prompt-editor';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <input id="pe-name" type="text" maxlength="60" placeholder="Prompt name" value="${esc(existing?.name || '')}"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <textarea id="pe-text" rows="4" placeholder="Prompt text to paste into terminal"
      class="w-full max-w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors resize-y leading-relaxed font-mono mb-2" style="min-height:5lh">${esc(existing?.text || '')}</textarea>
    <select id="pe-project"
      class="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-300 outline-none focus:border-blue-500 transition-colors mb-2">
      <option value="">No project — listed everywhere</option>
      ${(state.cfg.projects || []).map(p => `
        <option value="${esc(p.id)}" ${existing?.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>
    <div class="flex items-center gap-2">
      <button id="pe-save" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors">${existing ? 'Save' : 'Add'}</button>
      <button id="pe-cancel" class="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const list = panel.querySelector('#prompts-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#pe-name');
  const textInput = card.querySelector('#pe-text');
  nameInput.focus();

  const doSave = () => {
    const name = nameInput.value.trim();
    const text = textInput.value.trim();
    if (!name || !text) return;
    // Empty select means global — store null rather than '' so the field reads
    // the same whether a prompt predates projects or was set back to global.
    const projectId = card.querySelector('#pe-project').value || null;
    if (!state.cfg.prompts) state.cfg.prompts = [];
    if (existing) {
      state.cfg.prompts[idx] = { ...existing, name, text, projectId };
    } else {
      state.cfg.prompts.push({ id: randomUUID(), name, text, projectId });
    }
    save();
    closeEditor();
    renderPrompts();
  };

  card.querySelector('#pe-save').addEventListener('click', doSave);
  card.querySelector('#pe-cancel').addEventListener('click', closeEditor);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
  });
}

// --- Paste prompt into active terminal ---

// PORT-TO-NEXT: prompt {{placeholders}} — new feature, replicate in clideck-next.
// Fill {{session_name}} / {{project_name}} placeholders from the target session
// on the fly at paste time. Missing/unknown values resolve to an empty string.
function fillPromptVars(text, id) {
  const entry = state.terms.get(id);
  const sessionName = document.querySelector(`.group[data-id="${id}"] .name`)?.textContent?.trim() || '';
  const project = entry?.projectId ? (state.cfg.projects || []).find(p => p.id === entry.projectId) : null;
  return text
    .replaceAll('{{session_name}}', sessionName)
    .replaceAll('{{project_name}}', project?.name || '');
}

function pastePrompt(text) {
  if (!state.active) return;
  send({ type: 'input', id: state.active, data: fillPromptVars(text, state.active) });
  // Refocus the terminal after pasting
  const entry = state.terms.get(state.active);
  if (entry) entry.term.focus();
}

// PORT-TO-NEXT: @@ agent mentions — new feature, replicate in clideck-next.
// Active sessions as mention targets: name + @project/session address (matches
// `clideck agents` / copySessionName). Built from the live session list on demand.
function getAgents() {
  const projects = state.cfg.projects || [];
  // Sessions sharing the active session's project come first: when you are working
  // inside a project, the agent you want to mention is nearly always in it.
  const current = state.terms.get(state.active)?.projectId || null;
  const out = [];
  for (const [id, entry] of state.terms) {
    const name = document.querySelector(`.group[data-id="${id}"] .name`)?.textContent?.trim();
    if (!name) continue;
    const project = entry.projectId ? projects.find(p => p.id === entry.projectId) : null;
    out.push({
      id,
      name,
      address: project?.name ? `@${project.name}/${name}` : name,
      sameProject: !!current && entry.projectId === current,
    });
  }
  // Stable sort, so sidebar order is preserved within each group.
  return out.sort((a, b) => Number(b.sameProject) - Number(a.sameProject));
}

// Project first, then name matches above address-only matches like searchPrompts.
function searchAgents(filter) {
  const q = (filter || '').toLowerCase().trim();
  const all = getAgents();
  if (!q) return all;
  return all
    .map((a, i) => {
      const rank = a.name.toLowerCase().includes(q) ? 2 : a.address.toLowerCase().includes(q) ? 1 : 0;
      return { a, i, rank };
    })
    .filter(m => m.rank)
    .sort((x, y) => Number(y.a.sameProject) - Number(x.a.sameProject) || y.rank - x.rank || x.i - y.i)
    .map(m => m.a);
}

// Bracketed paste — same technique session-ask.js uses to inject into an agent TUI.
// Wrapping the mention makes the agent treat the leading @ as literal pasted text,
// so it does NOT re-open Claude/Codex's native @ file-mention picker.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function insertMention(address) {
  if (!state.active) return;
  send({ type: 'input', id: state.active, data: `${BRACKETED_PASTE_START}${address} ${BRACKETED_PASTE_END}` });
  const entry = state.terms.get(state.active);
  if (entry) entry.term.focus();
}

// --- // (prompts) and @@ (agents) autocomplete ---

let buffer = '';         // chars typed after the trigger
let active = false;      // autocomplete is open
let dropdown = null;
let selectedIdx = 0;
let mode = 'prompt';     // 'prompt' (//) or 'agent' (@@) — set when the menu opens
let dropdownPositionRaf = 0;
let removeViewportListener = null;

// Per-mode config: match source, how each row renders, and what completion does.
const AUTOCOMPLETE_MODES = {
  prompt: {
    label: 'Prompts', prefix: '//', empty: 'No matching prompts',
    hint: 'Type <kbd>//</kbd> to search your prompt library', action: 'paste',
    matches: () => orderByProject(searchPrompts(getPrompts(), buffer)),
    main: m => m.name, sub: m => truncate(m.text, 80),
    complete: m => pastePrompt(m.text),
  },
  agent: {
    label: 'Agents', prefix: '@@', empty: 'No matching agents',
    hint: 'Type <kbd>@@</kbd> to mention an agent', action: 'insert',
    matches: () => searchAgents(buffer),
    main: m => m.name, sub: m => m.address,
    complete: m => insertMention(m.address),
  },
};

function getMatches() {
  return AUTOCOMPLETE_MODES[mode].matches();
}

function positionDropdown() {
  if (!dropdown?.isConnected) return;
  const viewport = getViewportRect();
  const viewportLeft = viewport.left;
  const viewportTop = viewport.top;
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const viewportRight = viewport.right;
  const viewportBottom = viewport.bottom;
  const gap = 8;

  dropdown.style.width = Math.max(0, Math.min(340, viewportWidth - gap * 2)) + 'px';
  dropdown.style.maxHeight = Math.max(0, viewportHeight - gap * 2) + 'px';

  const sidebar = document.getElementById('sidebar');
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : { right: 60 };
  const width = dropdown.offsetWidth;
  const height = dropdown.offsetHeight;
  let left = sidebarRect.right + 32;
  let top = viewportBottom - height - gap;

  if (left + width > viewportRight - gap) left = viewportRight - width - gap;
  if (left < viewportLeft + gap) left = viewportLeft + gap;
  if (top < viewportTop + gap) top = viewportTop + gap;

  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
}

function scheduleDropdownPosition() {
  if (!dropdown || dropdownPositionRaf) return;
  dropdownPositionRaf = requestAnimationFrame(() => {
    dropdownPositionRaf = 0;
    positionDropdown();
  });
}

function showDropdown() {
  closeDropdown();
  const matches = getMatches();

  dropdown = document.createElement('div');
  dropdown.className = 'prompt-autocomplete';
  renderDropdownContent(matches);

  // Append hidden, measure, then anchor inside the visible viewport.
  dropdown.style.visibility = 'hidden';
  document.body.appendChild(dropdown);
  positionDropdown();
  dropdown.style.visibility = '';
  removeViewportListener = onViewportChange(scheduleDropdownPosition);

  // Only activate input capture after dropdown is successfully mounted
  active = true;
}

function renderDropdownContent(matches) {
  if (!dropdown) return;
  const q = buffer.toLowerCase();
  const cfg = AUTOCOMPLETE_MODES[mode];

  if (!matches.length) {
    dropdown.innerHTML = `
      <div class="pa-empty">${cfg.empty}</div>
      <div class="pa-hint">${cfg.hint}</div>`;
    return;
  }

  dropdown.innerHTML = `
    <div class="pa-header">
      <span class="pa-label">${cfg.label}</span>
      <span class="pa-query">${cfg.prefix}${esc(buffer)}</span>
    </div>
    <div class="pa-list">${matches.map((m, i) => `
      <div class="pa-item${i === selectedIdx ? ' pa-selected' : ''}" data-idx="${i}">
        <div class="pa-name">${highlight(cfg.main(m), q)}</div>
        <div class="pa-text">${highlight(cfg.sub(m), q)}</div>
      </div>`).join('')}
    </div>
    <div class="pa-footer">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>Enter</kbd> ${cfg.action}</span>
      <span><kbd>Esc</kbd> cancel</span>
    </div>`;

  // Click to select
  dropdown.querySelectorAll('.pa-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const match = matches[+el.dataset.idx];
      if (match) { closeDropdown(); cfg.complete(match); }
    });
  });
}

function updateDropdown() {
  if (!dropdown) return;
  const matches = getMatches();
  selectedIdx = Math.min(selectedIdx, Math.max(0, matches.length - 1));
  renderDropdownContent(matches);
  positionDropdown();
}

export function closeDropdown() {
  active = false;
  buffer = '';
  selectedIdx = 0;
  if (dropdownPositionRaf) {
    cancelAnimationFrame(dropdownPositionRaf);
    dropdownPositionRaf = 0;
  }
  removeViewportListener?.();
  removeViewportListener = null;
  if (dropdown) { dropdown.remove(); dropdown = null; }
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// --- Key interception (called from hotkeys.js attachToTerminal) ---

// Trigger detection: let the first trigger char (/ or @) reach the terminal
// immediately (no lag). If a matching second char arrives within 300ms, erase the
// first with backspace and open the menu — // for prompts, @@ for agent mentions.
const TRIGGER_MODES = { '/': 'prompt', '@': 'agent' };
// @ can only be typed with a modifier (Shift, or AltGr on many layouts), so these
// keydowns interleave with the @ keystrokes — they must not disturb trigger history.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
let lastTriggerTime = 0;
let lastTriggerKey = '';
let lastKeyWasPrintable = false;

function triggerAvailable(m) {
  return m === 'agent' ? state.terms.size > 0 : getPrompts().length > 0;
}

export function handleTerminalKey(e) {
  if (e.type !== 'keydown') return true;

  // If autocomplete is open, consume ALL keys — nothing should leak to hotkeys
  if (active) {
    const matches = getMatches();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
      return false;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      updateDropdown();
      return false;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(matches.length - 1, selectedIdx + 1);
      updateDropdown();
      return false;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const match = matches[selectedIdx];
      const cfg = AUTOCOMPLETE_MODES[mode];
      closeDropdown();
      if (match) cfg.complete(match);
      return false;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        updateDropdown();
      } else {
        closeDropdown();
      }
      return false;
    }
    // Printable character — append to buffer
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      buffer += e.key;
      updateDropdown();
      return false;
    }
    // Block everything else (modifiers, function keys) while autocomplete is open
    e.preventDefault();
    return false;
  }

  // Modifier-only keydowns must not disturb trigger history. Since @ is typed with
  // Shift (or AltGr), a Shift keydown fires between the two @ of @@; letting it reset
  // state broke @@ across platforms and defeated the "printable char before" guard.
  if (MODIFIER_KEYS.has(e.key)) return true;

  // Treat AltGr-produced characters (e.g. @ on many EU layouts) as normal input, not
  // a Ctrl/Alt shortcut, so // and @@ trigger regardless of keyboard layout.
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  const isChar = e.key.length === 1 && !e.metaKey && (!e.ctrlKey || altGraph) && (!e.altKey || altGraph);

  // Detect // and @@ triggers — first char goes through normally, a matching second
  // char within 300ms activates. Suppress if a non-whitespace character was typed
  // just before the first char (e.g. s//, a@@, ://).
  // This is a key-history heuristic, not a true terminal-state check.
  const trigMode = TRIGGER_MODES[e.key];
  if (trigMode && isChar && triggerAvailable(trigMode)) {
    const now = Date.now();
    if (e.key === lastTriggerKey && now - lastTriggerTime < 300) {
      // Second matching char — erase the first from the terminal, open the menu
      lastTriggerTime = 0;
      lastTriggerKey = '';
      lastKeyWasPrintable = false;
      e.preventDefault();
      if (state.active) send({ type: 'input', id: state.active, data: '\x7f' }); // backspace to remove first char
      mode = trigMode;
      showDropdown();
      return false;
    }
    // First char — only arm the timer if the previous key wasn't a non-whitespace character
    if (!lastKeyWasPrintable) {
      lastTriggerTime = now;
      lastTriggerKey = e.key;
    }
    // The trigger char is itself non-whitespace — keep the flag hot so s/// / a@@@ don't re-trigger
    lastKeyWasPrintable = true;
    return true;
  }

  // Any other key resets the trigger timer
  lastTriggerTime = 0;
  lastTriggerKey = '';
  // Track non-whitespace printable keys; whitespace (space, tab) should not block a standalone // or @@
  lastKeyWasPrintable = isChar && e.key.trim() !== '';
  return true;
}
