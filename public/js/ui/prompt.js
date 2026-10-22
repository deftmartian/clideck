// R2 prompt surfaces: a blocked agent asks the user via prompt.show. Two flavors:
//  • question card — options[] → real buttons, else a text input + Send; shown prominently at the foot of the
//    terminal for the OPEN session (pulsing "waiting" state — the agent is blocked); other session → switch toast.
//  • annotate — an image + a drawing surface (annotate.js); Send → marks JSON.
// Either way the answer goes out as prompt.answer {promptId, value}. prompt.resolved {promptId} ALWAYS dismisses
// the card in every client (another client may answer first; it also fires on timeout / session close).
import { store } from "../store.js";
import { answerPrompt, cancelPrompt } from "../ws.js";
import { toast } from "./toast.js";
import { h, shortId } from "../util.js";
import { openAnnotate, closeAnnotate, annotateOpenFor } from "./annotate.js";

const ASK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.8 2.8 0 0 1 5.5.8c0 1.9-2.8 2.5-2.8 2.5"/><path d="M12 17h.01"/></svg>';
const pending = new Map();        // sessionId -> ev (the full prompt.show)
const promptSession = new Map();  // promptId  -> sessionId
let card = null, returnFocus = null;

export function initPrompt() {
  store.on("prompt:show", onShow);
  store.on("prompt:resolved", onResolved);
  store.on("active", renderActive);
  store.on("session:remove", (id) => { const ev = pending.get(id); if (ev) { promptSession.delete(ev.promptId); pending.delete(id); if (id === store.activeId) renderActive(); } });
  store.on("reset", () => { pending.clear(); promptSession.clear(); renderActive(); });
}

function label(sid) { const s = store.sessions.get(sid); return (s && (s.name || shortId(sid))) || shortId(sid) || "a session"; }

function onShow(ev) {
  if (!ev || !ev.promptId) return;
  pending.set(ev.sessionId, ev);
  promptSession.set(ev.promptId, ev.sessionId);
  if (ev.sessionId === store.activeId) renderActive();
  else toast.info({
    id: "prompt:" + ev.promptId,
    title: label(ev.sessionId),
    body: ev.annotate ? "wants you to annotate an image" : "is asking a question",
    iconHtml: ASK_ICON,
    duration: 0,   // sticky — a blocked agent shouldn't time its ask off the screen
    onClick: () => store.select(ev.sessionId),
  });
}

function onResolved(ev) {
  const sid = ev && ev.promptId != null ? promptSession.get(ev.promptId) : null;
  if (sid == null) { if (ev && annotateOpenFor() === ev.promptId) closeAnnotate(); return; }
  promptSession.delete(ev.promptId);
  if (pending.get(sid)?.promptId === ev.promptId) {
    pending.delete(sid);
    if (sid === store.activeId) renderActive();
  }
  if (annotateOpenFor() === ev.promptId) closeAnnotate();
}

function answer(promptId, value) {
  const sid = promptSession.get(promptId);
  answerPrompt(promptId, value);
  if (sid != null) { promptSession.delete(promptId); if (pending.get(sid)?.promptId === promptId) pending.delete(sid); }   // optimistic dismiss; prompt.resolved re-affirms
  renderActive();
  if (annotateOpenFor() === promptId) closeAnnotate();
}

// Reconcile the surfaces to the ACTIVE session's pending prompt.
function renderActive() {
  const ev = pending.get(store.activeId);
  if (!ev) { hideCard(); if (annotateOpenFor()) closeAnnotate(); return; }
  if (ev.annotate) {
    hideCard();
    if (annotateOpenFor() !== ev.promptId) openAnnotate(ev, (value) => answer(ev.promptId, value));
    return;
  }
  if (annotateOpenFor()) closeAnnotate();
  showCard(ev);
}

function showCard(ev) {
  const frame = document.querySelector(".term-frame");
  if (!frame) return;
  if (!card) { card = h("div", "pcard"); }
  if (!card.isConnected) returnFocus = document.activeElement;
  card.replaceChildren();
  card.appendChild(h("div", "pcard-glow"));
  const q = h("div", "pcard-q"); q.textContent = ev.question || "The agent is waiting for your input";
  const head = h("div", "pcard-head");
  const close = h("button", "pcard-close"); close.type = "button";
  close.title = "Dismiss question"; close.setAttribute("aria-label", "Dismiss question");
  close.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const cancel = () => {
    if (!cancelPrompt(ev.promptId)) toast.error({ title: "Question not dismissed", body: "Reconnect to CliDeck and try again." });
  };
  close.addEventListener("click", cancel);
  const escape = (e) => {
    if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); cancel(); }
  };
  head.addEventListener("keydown", escape);
  head.append(q, close); card.appendChild(head);
  const actions = h("div", "pcard-actions");
  actions.addEventListener("keydown", escape);
  const opts = Array.isArray(ev.options) ? ev.options.filter((o) => o != null && String(o) !== "") : [];
  if (opts.length) {
    for (const opt of opts) { const b = h("button", "pcard-opt"); b.type = "button"; b.textContent = String(opt); b.addEventListener("click", () => answer(ev.promptId, String(opt))); actions.appendChild(b); }
  } else {
    const input = h("input", "pcard-input"); input.type = "text"; input.placeholder = "Type your answer…"; input.spellcheck = false; input.autocomplete = "off";
    const send = h("button", "pcard-send"); send.type = "button"; send.textContent = "Send";
    const go = () => { answer(ev.promptId, input.value); };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { e.stopPropagation(); escape(e); if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); } });
    actions.append(input, send);
    setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
  }
  card.appendChild(actions);
  if (card.parentNode !== frame) frame.appendChild(card);
  card.classList.add("show");
}

function hideCard() {
  if (!card?.parentNode) return;
  const restore = card.contains(document.activeElement);
  card.classList.remove("show"); card.remove();
  if (restore && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}
