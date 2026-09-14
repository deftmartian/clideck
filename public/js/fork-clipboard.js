import { beginDraftAttachment, finishDraftAttachment } from './ui/terminal-draft.js';
import { store } from './store.js';
import { terminalSelection } from './ui/terminal.js';
import { copyTrimmedTerminalSelection } from './terminal-clipboard.js';
import { copyText } from './util.js';
import { toast } from './ui/toast.js';
import { registerHotkey } from './ui/hotkeys.js';

export function initClipboard() {
  let uploading = 0;
  document.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    const session = store.active();
    if (!files.length || !session || session.live === false || !document.getElementById('rp')?.contains(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    for (const file of files) upload(file, session.id);
  }, true);
  async function prepare(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 25*1024*1024) return file;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
      if (scale===1) return file;
      const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      // Keep alpha for PNG; do not flatten transparent screenshots to black.
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,file.type==='image/png'?'image/png':'image/jpeg',.88));
      return blob && blob.size<file.size ? blob : file;
    } catch { return file; } finally {bitmap?.close();}
  }
  async function upload(file,id) {
    if (uploading>=2 || file.size>25*1024*1024) {toast.warn({title:'Image not attached',body:'Use at most two image uploads, up to 25 MiB each.'});return;}
    const attachment=beginDraftAttachment(id);uploading++;
    try {
      const body=await prepare(file);
      const response=await fetch(`/api/session/${encodeURIComponent(id)}/clipboard-image`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':body.type,'X-Clideck-Protocol':'fork-v6'},body});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Image upload failed');
      if(finishDraftAttachment(attachment,result.path))toast.success({title:'Image attached',body:'Image added to your draft.'});
      else toast.warn({title:'Image saved without attaching',body:`Draft unavailable or full. Image saved at ${result.path}`});
    } catch(error){finishDraftAttachment(attachment);toast.error({title:'Image upload failed',body:error.message});}
    finally {uploading--;}
  }
  const picker=document.getElementById('mobile-composer-file'),attach=document.getElementById('mobile-composer-attach');
  attach?.addEventListener('click',()=>picker?.click());
  picker?.addEventListener('change',()=>{const session=store.active();if(session&&session.live!==false)for(const file of picker.files)upload(file,session.id);picker.value='';});
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
