import { state } from './state.js';
import { showToast } from './toast.js';
import { select } from './terminals.js';
import { trimTerminalSelection } from './terminal-clipboard.js';
import { getViewportRect } from './viewport.js';
import { perfEnabled } from './perf.js';

export function installTestSurface() {
  if (!perfEnabled()) return;
  Object.defineProperty(window, '__clideckTest', {
    configurable: true,
    value: { state, showToast, select, trimTerminalSelection, getViewportRect },
  });
}
