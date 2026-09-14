// The terminal component owns xterm input and focus. Layouts select an owner.
export function createTerminalInput({ getTerminal, getSession, isConnected }) {
  let owner = 'terminal';
  const canWrite = () => owner === 'terminal' && !!getSession() && getSession().live !== false && isConnected();
  function sync() {
    const term = getTerminal();
    if (!term) return;
    term.options.disableStdin = !canWrite();
    const textarea = term.textarea;
    if (!textarea) return;
    const claimed = owner !== 'terminal';
    textarea.disabled = claimed;
    textarea.readOnly = !canWrite();
    if (claimed) {
      textarea.setAttribute('inputmode', 'none');
      if (textarea.ownerDocument.activeElement === textarea) textarea.blur();
    } else textarea.removeAttribute('inputmode');
  }
  function setOwner(next) {
    if (!['terminal', 'composer', 'plugin'].includes(next)) throw new Error('Unknown terminal input owner');
    owner = next; sync();
  }
  function focus() { if (canWrite()) getTerminal()?.focus(); }
  return { setOwner, sync, canWrite, focus };
}
