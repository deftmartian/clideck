import { openTerminalDraft } from './ui/terminal-draft.js';
import { attachPickedFiles, filesDirectory, hasFilesView } from './ui/files.js';
import { stageFiles, initAttachmentTray } from './ui/attachments.js';
import { store } from './store.js';
import { terminalSelection } from './ui/terminal.js';
import { copyTrimmedTerminalSelection } from './terminal-clipboard.js';
import { copyText } from './util.js';
import { toast } from './ui/toast.js';
import { registerHotkey } from './ui/hotkeys.js';

export function initClipboard() {
  initAttachmentTray();
  document.addEventListener('paste', event => {
    // Rich clipboard content can contain an image representation of the text.
    if (event.clipboardData?.getData('text/plain')) return;
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    const session = store.active();
    if (!files.length || !session || session.live === false || !document.getElementById('rp')?.contains(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void stageFiles(session, files);
  }, true);
  const picker=document.getElementById('mobile-composer-file'),attach=document.getElementById('mobile-composer-attach');
  let pickerSession = null, pickerDirectory, pickerUsesFiles = false;
  const openPicker=()=>{pickerSession=store.active();pickerDirectory=pickerSession&&filesDirectory(pickerSession);pickerUsesFiles=!!pickerSession&&hasFilesView(pickerSession);openTerminalDraft({focus:false});picker?.click();};
  attach?.addEventListener('click',openPicker);
  const desktopAttach = document.createElement('button'); desktopAttach.id='terminal-attach'; desktopAttach.type='button'; desktopAttach.textContent='Attach'; desktopAttach.setAttribute('aria-label','Attach files'); desktopAttach.onclick=openPicker;
  document.querySelector('.th-actions')?.append(desktopAttach);
  picker?.addEventListener('change',()=>{
    const session=pickerSession||store.active(), files=[...picker.files]; picker.value='';
    if(session&&session.live!==false){
      const useFiles=pickerSession?pickerUsesFiles:hasFilesView(session);
      if(useFiles) void attachPickedFiles(session,files,pickerDirectory||filesDirectory(session));
      else void stageFiles(session,files);
    }
    pickerSession=null;pickerDirectory=null;pickerUsesFiles=false;
  });
  const trim = async () => {
    const text = terminalSelection();
    if (!text.trim()) { toast.info({ title: 'Trim & Copy', body: 'Select terminal text first.' }); return; }
    try {
      const result = await copyTrimmedTerminalSelection(text, async value => { if (!await copyText(value)) throw new Error('Clipboard unavailable'); });
      toast.success({ title: 'Copied', body: `${result.saved || 0} padding characters removed.` });
    } catch (error) { toast.error({ title: 'Copy failed', body: error.message }); }
  };
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '✂'; button.title = 'Trim & Copy (F8)'; button.setAttribute('aria-label', 'Trim and copy terminal selection'); button.onclick = trim;
  document.querySelector('.th-actions')?.append(button);
  // Handle F8 inside xterm's key pipeline, before it clears selection or sends escape bytes.
  registerHotkey('trim-copy', 'F8', event => { if (!event.repeat) trim(); });
  button.addEventListener('mousedown', event => event.preventDefault());
}
