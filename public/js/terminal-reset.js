// RIS is parsed in order with queued output. A synchronous term.reset() can
// let an older pending write run after the reset and corrupt the next snapshot.
export function resetTerminalView(term) { term.write('\x1bc'); }
