import { store } from '../store.js';
import { uploadFile } from '../ws.js';
import { createImageUploadQueue } from '../image-upload-queue.js';
import { beginDraftAttachment, finishDraftAttachment, updateDraftAttachment, removeDraftAttachment, getDraft, onDraftChange } from './terminal-draft.js';
import { onPluginCompositionChange } from './plugin-composition.js';
import { toast } from './toast.js';

const queue = createImageUploadQueue({maxActive:2,maxWaiting:8,maxBytes:100*1024*1024}, upload);
const imageType = file => /^image\/(png|jpeg|webp|gif)$/.test(file.type);

async function prepare(file, ticket, resize) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const thumb = document.createElement('canvas');
    const ratio = Math.min(1,96/Math.max(bitmap.width,bitmap.height));
    thumb.width = Math.max(1,Math.round(bitmap.width*ratio)); thumb.height = Math.max(1,Math.round(bitmap.height*ratio));
    thumb.getContext('2d').drawImage(bitmap,0,0,thumb.width,thumb.height);
    const preview = await new Promise(resolve => thumb.toBlob(resolve,'image/png'));
    if (preview && ticket.draft.pending.has(ticket)) updateDraftAttachment(ticket,{preview:URL.createObjectURL(preview)});
    if (!resize || file.type === 'image/gif') return file;
    const scale = Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
    if (scale === 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width*scale); canvas.height = Math.round(bitmap.height*scale);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    // Preserve screenshot alpha; JPEG conversion otherwise turns transparency black.
    const blob = await new Promise(resolve => canvas.toBlob(resolve,file.type === 'image/png' ? 'image/png' : 'image/jpeg',.88));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; } finally { bitmap?.close(); }
}
function uploadImage(id, body, signal, progress) {
  return new Promise((resolve,reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/session/${encodeURIComponent(id)}/clipboard-image`);
    xhr.setRequestHeader('Content-Type',body.type);
    xhr.setRequestHeader('X-Clideck-Protocol','fork-v6');
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded/event.total); };
    xhr.onload = () => {
      let result; try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && result?.path) resolve(result);
      else reject(new Error(result?.error || 'Image upload failed'));
    };
    xhr.onerror = () => reject(new Error('Image upload failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    const abort = () => xhr.abort();
    xhr.onloadend = () => signal.removeEventListener('abort',abort);
    if (signal.aborted) { reject(new Error('Upload cancelled')); return; }
    signal.addEventListener('abort',abort,{once:true}); xhr.send(body);
  });
}
async function upload(job) {
  const {file,ticket,controller,directory,resolve} = job;
  try {
    if (!updateDraftAttachment(ticket,{status:'uploading'})) return;
    const progress = fraction => updateDraftAttachment(ticket,{progress:Math.round(fraction*100)});
    const body = imageType(file) ? await prepare(file,ticket,!directory) : file;
    const result = imageType(file) && !directory
      ? await uploadImage(ticket.id,body,controller.signal,progress)
      : await uploadFile(ticket.id,file.name,file,progress,directory,controller.signal);
    if (!controller.signal.aborted) finishDraftAttachment(ticket,result.path);
  } catch (error) {
    if (!controller.signal.aborted) {
      finishDraftAttachment(ticket);
      toast.error({title:'Attachment failed',body:error.message});
    }
  } finally { resolve(); }
}
export function stageFiles(session, files, directory) {
  if (!session || session.live === false) return Promise.resolve();
  return Promise.all([...files].map(file => new Promise(resolve => {
    const limit = imageType(file) ? 25 : 100;
    if (file.size > limit*1024*1024) { toast.warn({title:'File not attached',body:`Each ${imageType(file) ? 'image' : 'file'} must be ${limit} MiB or smaller.`}); resolve(); return; }
    const ticket = beginDraftAttachment(session.id,file);
    if (!ticket) { toast.warn({title:'Attachment limit',body:'Send or remove attachments before adding more (32 per draft).'}); resolve(); return; }
    const controller = new AbortController();
    const job = {file,ticket,controller,directory,resolve,bytes:file.size};
    updateDraftAttachment(ticket,{cancel:() => {controller.abort();queue.remove(job);resolve();}});
    if (!queue.enqueue(job).ok) {
      removeDraftAttachment(session.id,ticket.attachment.key);
      toast.warn({title:'Attachment queue full',body:'Two files can upload at once and eight can wait.'});
      resolve();
    }
  })));
}
export function initAttachmentTray() {
  const tray = document.createElement('div'); tray.className = 'attachment-tray';
  tray.setAttribute('aria-label','Draft attachments'); tray.setAttribute('role','list');
  function render() {
    const id = store.activeId;
    const mobile = document.body.classList.contains('mobile-ui');
    const parent = mobile ? document.getElementById('mobile-composer') : document.querySelector('.terminal-draft .pc-content');
    if (!parent || !id) { tray.remove(); return; }
    if (tray.parentNode !== parent) parent.prepend(tray);
    const attachments = getDraft(id).attachments;
    tray.hidden = !attachments.length;
    tray.replaceChildren(...attachments.map(a => {
      const item = document.createElement('div'); item.className = 'attachment-item'; item.setAttribute('role','listitem');
      item.dataset.state = a.status; item.title = a.path || a.name;
      if (a.preview) { const image = document.createElement('img'); image.src = a.preview; image.alt = ''; item.append(image); }
      const label = document.createElement('span'); label.className = 'attachment-label';
      const name = document.createElement('strong'); name.textContent = a.name;
      const status = document.createElement('small');
      status.textContent = a.status === 'ready' ? 'Ready' : a.status === 'error' ? a.error : a.status === 'queued' ? 'Queued' : `Uploading ${a.progress || 0}%`;
      label.append(name,status);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label',`Remove ${a.name}`);
      remove.onclick = () => removeDraftAttachment(id,a.key);
      item.append(label,remove); return item;
    }));
  }
  onDraftChange(render); onPluginCompositionChange(() => queueMicrotask(render)); store.on('active',render); store.on('reset',render);
  window.addEventListener('resize',render); render();
}
