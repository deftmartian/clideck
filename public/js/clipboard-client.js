import { state } from './state.js';
import { showToast } from './toast.js';
import { CLIENT_PROTOCOL_VERSION } from './protocol-version.js';

const MAX_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024;
const ATTACH_MAX_DIMENSION = 2048;
const ATTACH_JPEG_QUALITY = 0.85;

function clipboardImageItems(event) {
  return [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && /^image\//i.test(item.type || ''));
}

async function sendImageFile(file, sessionId, mimeFallback = 'image/png') {
  if (!file) throw new Error('Image was not available as a file.');
  if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(`Image is too large (${Math.ceil(file.size / 1024 / 1024)} MB).`);
  }
  if (!state.protocolReady) {
    throw new Error('CliDeck reconnected before the image was ready. Attach it again.');
  }
  const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/clipboard-image`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || mimeFallback,
      'X-CliDeck-Protocol': String(CLIENT_PROTOCOL_VERSION),
    },
    body: file,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let result = null;
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result?.error || `Image upload failed (${response.status}).`);
  showToast('Image attached to session.', {
    type: 'success', title: 'Image Paste', duration: 2200,
  });
  return result;
}

async function handleClipboardImagePaste(event) {
  const items = clipboardImageItems(event);
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();

  const sessionId = state.active;
  if (!sessionId || !state.protocolReady) {
    showToast('No active session is ready for image paste.', {
      type: 'error', title: 'Image Paste', duration: 4000,
    });
    return;
  }
  const count = items.length;
  showToast(`Attaching ${count} image${count === 1 ? '' : 's'}...`, {
    id: 'clipboard-image-paste', type: 'info', title: 'Image Paste', duration: 1200,
  });
  for (const item of items) {
    try {
      const file = item.getAsFile?.();
      if (!file) throw new Error('Clipboard image was not available as a file.');
      await sendImageFile(file, sessionId, item.type || 'image/png');
    } catch (error) {
      showToast(error.message || 'Image paste failed.', {
        type: 'error', title: 'Image Paste', duration: 5000,
      });
    }
  }
}

async function downscaleImageFile(file) {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const scale = ATTACH_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) { bitmap.close?.(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', ATTACH_JPEG_QUALITY));
  if (!blob || blob.size >= file.size) return file;
  const name = `${(file.name || 'image').replace(/\.[a-z0-9]+$/i, '')}.jpg`;
  return new File([blob], name, { type: 'image/jpeg' });
}

async function handleComposerAttach(files) {
  const sessionId = state.active;
  if (!sessionId || !state.protocolReady) {
    showToast('No active session is ready for image attach.', {
      type: 'error', title: 'Image Attach', duration: 4000,
    });
    return;
  }
  for (let index = 0; index < files.length; index += 1) {
    showToast(files.length === 1 ? 'Attaching image…' : `Attaching image ${index + 1} of ${files.length}…`, {
      id: 'clipboard-image-paste', type: 'info', title: 'Image Attach', duration: 4000,
    });
    try {
      await sendImageFile(await downscaleImageFile(files[index]), sessionId);
    } catch (error) {
      showToast(error.message || 'Image attach failed.', {
        type: 'error', title: 'Image Attach', duration: 5000,
      });
    }
  }
}

export function initClipboardClient() {
  document.addEventListener('paste', handleClipboardImagePaste, true);
  const attachButton = document.getElementById('mobile-composer-attach');
  const attachInput = document.getElementById('mobile-composer-file');
  if (!attachButton || !attachInput) return;

  // Preserve an open keyboard while the native file picker opens.
  attachButton.addEventListener('pointerdown', event => event.preventDefault());
  attachButton.addEventListener('mousedown', event => event.preventDefault());
  attachButton.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', async () => {
    const files = [...(attachInput.files || [])];
    attachInput.value = '';
    if (files.length) await handleComposerAttach(files);
  });
}
