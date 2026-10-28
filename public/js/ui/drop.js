import { stageFiles } from "./attachments.js";
import { store } from "../store.js";
import { openContent } from "../ws.js";
import { toast } from "./toast.js";
import { h } from "../util.js";
import { armTabDrop, overTabDrop } from "./content-dock.js";

const UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>';
const DOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v5"/><path d="M9.5 14.5h5"/></svg>';

let zone = null, ic = null, title = null, sub = null, depth = 0;

export function initDrop() {
  const main = document.querySelector(".main");
  if (!main) return;
  zone = h("div", "drop-zone");
  const inner = h("div", "drop-inner");
  ic = h("div", "drop-ic"); ic.innerHTML = UP_ICON;
  title = h("div", "drop-title");
  sub = h("div", "drop-sub");
  inner.append(ic, title, sub);
  zone.appendChild(inner);
  main.appendChild(zone);
  main.addEventListener("dragenter", onEnter);
  main.addEventListener("dragover", onOver);
  main.addEventListener("dragleave", onLeave);
  main.addEventListener("drop", onDrop);
}

function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }
function hasFiles(e) { return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") !== -1; }
function activeLive() { const s = store.active(); return s && s.live !== false ? s : null; }

function onEnter(e) { if (!hasFiles(e) || !activeLive()) return; e.preventDefault(); depth++; armTabDrop(true); paintVeil(e); zone.classList.add("show"); }
function onOver(e) { if (!hasFiles(e) || !activeLive()) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; paintVeil(e); }
function onLeave(e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) hide(); }
function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault(); depth = 0;
  const toTab = overTabDrop(e.clientX || 0, e.clientY || 0);   // read the target BEFORE hide() tears the rail down
  hide();
  const s = activeLive(); if (!s) return;
  // Read everything off the dataTransfer NOW — it is neutered the moment this handler returns, and the tab-strip
  // path awaits the file's bytes.
  const files = Array.from(e.dataTransfer.files || []);
  if (toTab) { openDropped(s, files); return; }
  const selected = [];
  const items = Array.from(e.dataTransfer.items || []);
  if (items.some(item => typeof item.webkitGetAsEntry === 'function')) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        toast.info({title:'Folder not attached',body:'Choose files inside the folder to upload.'});
      } else { const file = item.getAsFile(); if (file) selected.push(file); }
    }
  } else selected.push(...files);
  void stageFiles(s, selected);
}

export function uploadFiles(s, files) { return stageFiles(s, files); }

// Dropped ON THE TAB STRIP → open each file as a document tab, BY VALUE.
// dataTransfer.files is the one thing EVERY source app gives us. The earlier version recovered a filesystem
// path from text/uri-list instead, which only Finder is obliged to provide — so every drag out of Nimble
// Commander (and any other file manager) failed with "carried no file path". There is no fallback chain here on
// purpose: a fallback chain is the same over-complication wearing a second coat. One path, every app.
const DOC_KIND = new Map([
  ["txt", "text"], ["log", "text"], ["json", "json"], ["csv", "csv"],
  ["md", "markdown"], ["markdown", "markdown"], ["mdown", "markdown"], ["mkd", "markdown"],
  ["html", "html"], ["htm", "html"], ["mmd", "mermaid"], ["patch", "diff"], ["diff", "diff"], ["pdf", "pdf"],
]);
const MAX_DOC = 10 * 1024 * 1024;   // the engine's decoded ceiling — refuse here rather than read a huge file into
                                    // memory, base64 it, and have it bounce off the wire
// The engine chooses the encoding BY KIND — content-store does `binary ? decodeBase64(encoded) :
// Buffer.from(encoded, 'utf8')` — so this side must split the same way or a README renders as its own base64.
// Flagged to the arch: one encoding for everything would delete this set and the branch below it.
const BINARY_KIND = new Set(["pdf"]);
// Chunked because String.fromCharCode(...bytes) blows the argument limit on anything sizeable.
async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function openDropped(session, files) {
  for (const f of files) {
    const kind = DOC_KIND.get(extOf(f.name));
    if (!kind) { toast.info({ id: "tabdrop-kind:" + f.name, title: f.name || "That file", body: "Text, JSON, Markdown, HTML, PDF, diffs and Mermaid open as documents" }); continue; }
    if (f.size > MAX_DOC) { toast.info({ id: "tabdrop-big:" + f.name, title: f.name, body: "Too large to open as a document" }); continue; }
    try { openContent(session.id, { name: f.name, kind, data: BINARY_KIND.has(kind) ? await toBase64(f) : await f.text() }); }
    catch { toast.error({ id: "tabdrop-read:" + f.name, title: f.name, body: "Couldn’t read that file" }); }
  }
}

function paintVeil(e) {
  const s = activeLive();
  // Over the strip the veil states the OTHER intention, so the two targets read as one choice rather than as a
  // hidden mode. Kind is not pre-judged there — the engine answers for what it can render.
  const toTab = overTabDrop(e.clientX || 0, e.clientY || 0);
  zone.classList.toggle("to-tab", toTab);
  ic.innerHTML = toTab ? DOC_ICON : UP_ICON;
  if (toTab) {
    const pre = h("span"); pre.textContent = "Open as a ";
    const what = h("b"); what.textContent = "document";
    title.replaceChildren(pre, what);
    sub.textContent = "Opens in a new tab — the agent isn’t told";
  } else {
    const pre = h("span"); pre.textContent = "Drop to attach to ";
    const name = h("b"); name.textContent = s ? (s.name || "this session") : "this session";
    title.replaceChildren(pre, name);
    sub.textContent = "Added to your draft — press Send when ready";
  }
}
function hide() { zone.classList.remove("show", "reject", "to-tab"); armTabDrop(false); }
