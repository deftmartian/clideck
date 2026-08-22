import wheelPolicy from '../../native-wheel-policy.js';

const { shouldStealNativeWheel, accumulateWheelLines } = wheelPolicy;

function storageFor(host) {
  try {
    return host?.ownerDocument?.defaultView?.localStorage || globalThis.localStorage;
  } catch {
    return null;
  }
}

export { shouldStealNativeWheel, accumulateWheelLines };

export function createNativeWheelScroll() {
  const attachments = new Map();

  function attach(id, term, host) {
    detach(id);
    const screen = host.querySelector('.xterm-screen') || host;
    let accumulator = 0;
    const options = { capture: true, passive: false };

    const onWheel = event => {
      if (!host.contains(event.target)) return;
      if (!shouldStealNativeWheel(term, event, storageFor(host))) return;
      const rect = screen.getBoundingClientRect();
      const cellHeight = (rect.height && term.rows) ? rect.height / term.rows : 17;
      const { lines, accumulator: next } = accumulateWheelLines(
        event, cellHeight, term.rows, accumulator,
      );
      event.preventDefault();
      event.stopImmediatePropagation();
      accumulator = next;
      if (!lines) return;
      term.scrollLines(lines);
    };

    // Document capture runs before xterm's own wheel handler, which lives on
    // an inner node and would otherwise send SGR reports and preventDefault.
    const root = host.ownerDocument || document;
    root.addEventListener('wheel', onWheel, options);
    attachments.set(id, {
      dispose() {
        root.removeEventListener('wheel', onWheel, options);
      },
    });
  }

  function detach(id) {
    attachments.get(id)?.dispose();
    attachments.delete(id);
  }

  return { attach, detach };
}
