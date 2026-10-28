import { store } from "../store.js";

function paint() {
  const banner = document.getElementById("history-retention");
  const frame = document.getElementById("term-panel");
  if (!banner || !frame) return;
  const notice = store.active()?.historyRetention;
  const text = notice?.message || "";
  banner.hidden = !text;
  banner.textContent = text;
  frame.classList.toggle("has-history-notice", Boolean(text));
}

export function initHistoryRetention() {
  store.on("active", paint);
  store.on("session:update", (id) => { if (id === store.activeId) paint(); });
  store.on("reset", paint);
  paint();
}
