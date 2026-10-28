let loading;
export async function enableTerminalRenderer(term) {
  try {
    if (!loading) loading = new Promise((resolve,reject) => {
      const script=document.createElement('script');script.src='/vendor/xterm-webgl.js';script.async=true;
      script.onload=resolve;script.onerror=()=>reject(new Error('WebGL addon unavailable'));document.head.append(script);
    });
    await loading;
    const addon=new window.WebglAddon.WebglAddon();
    addon.onContextLoss(()=>addon.dispose());
    try {term.loadAddon(addon);} catch {addon.dispose();}
  } catch { /* The DOM renderer stays usable when WebGL is unavailable. */ }
}
