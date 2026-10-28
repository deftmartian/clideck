import { store } from "../store.js";

// Long sessions routinely outgrow the stored terminal output cap. Say so in a header pill rather than
// covering the terminal; the full explanation stays available on hover/focus.
function paint() {
  const pill = document.getElementById("history-retention");
  if (!pill) return;
  const text = store.active()?.historyRetention?.message || "";
  pill.hidden = !text;
  pill.title = text;
  pill.setAttribute("aria-label", text ? `Older terminal output trimmed. ${text}` : "");
}

export function initHistoryRetention() {
  store.on("active", paint);
  store.on("session:update", (id) => { if (id === store.activeId) paint(); });
  store.on("reset", paint);
  paint();
}
