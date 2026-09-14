import { closeTerminalDraft, getDraft, setDraft, submitDraft, recoverDraft, onDraftChange, registerMobileDraftView } from './ui/terminal-draft.js';
import { pluginCompositionState, onPluginCompositionChange, setPluginCompositionHost } from './ui/plugin-composition.js';
import { showTerminalTab } from './ui/content-dock.js';
import { resolveImmediateActions, runAction, onActionsChange } from './ui/action-registry.js';
import { pluginActionContext } from './ui/plugin-host.js';
import { createMobileTouchScroll } from './mobile-touch-scroll.js';
import { createMobileSelection } from './mobile-selection.js';
import { isTouchUiEnabled, getTouchUiMode, setTouchUiMode, onTouchUiChange } from './touch-ui.js';
import { writeClipboardText } from './terminal-clipboard.js';
import { store } from './store.js';
import { send } from './ws.js';
import { focusTerminalInput, setTerminalInputOwner, mobileTerminalEntry } from './ui/terminal.js';
import { toast } from './ui/toast.js';

export function initMobile() {
  const app = document.querySelector('.app'), pane = document.getElementById('rp');
  if (!app || !pane) return;
  const header = document.getElementById('term-head'), panel = document.getElementById('term-panel');
  const direct = new Set(); let enabled = false, toolsOpen = false, keyboardWasUp = false, attached = null;
  const button = (label, text = label) => { const el = document.createElement('button'); el.type='button'; el.textContent=text; el.setAttribute('aria-label',label); return el; };
  const nav=button('Sessions','☰'); nav.className='fork-mobile-nav'; app.prepend(nav);
  const backdrop=button('Close sessions'); backdrop.className='mobile-sidebar-backdrop'; app.append(backdrop);
  const closeNav=(focus=false)=>{document.body.classList.remove('fork-sidebar-open');nav.setAttribute('aria-expanded','false');if(focus)nav.focus({preventScroll:true});};
  nav.onclick=()=>{const open=!document.body.classList.contains('fork-sidebar-open');document.body.classList.toggle('fork-sidebar-open',open);nav.setAttribute('aria-expanded',String(open));};
  backdrop.onclick=()=>closeNav(true); closeNav();
  const git=button('Git changes','Git'), more=button('Session actions','•••'); git.className='mobile-git';more.className='mobile-more';header.append(git,more);
  const closeMenu=()=>{document.body.classList.remove('mobile-menu-open');more.setAttribute('aria-expanded','false');};
  more.onclick=()=>{const open=!document.body.classList.contains('mobile-menu-open');document.body.classList.toggle('mobile-menu-open',open);more.setAttribute('aria-expanded',String(open));};
  closeMenu();
  const indicator=document.createElement('span');indicator.className='mobile-session-status';indicator.setAttribute('role','status');document.querySelector('.th-id').prepend(indicator);
  const actions=document.querySelector('.th-actions');
  const reload=button('Refresh CliDeck','Reload');reload.id='mobile-page-reload';actions.append(reload);
  const mode=document.createElement('select');mode.id='interface-mode';mode.setAttribute('aria-label','Interface mode');
  for(const [value,label] of [['auto','Auto layout'],['touch','Phone layout'],['desktop','Desktop layout']]){const o=new Option(label,value);mode.append(o);}mode.value=getTouchUiMode();mode.onchange=()=>{setTouchUiMode(mode.value);closeMenu();};actions.append(mode);
  document.addEventListener('click',event=>{
    if(!actions.contains(event.target)&&!more.contains(event.target))closeMenu();
    if(event.target.closest('.th-actions button'))closeMenu();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeNav(true);closeMenu();setTools(false);}});
  window.addEventListener('orientationchange',()=>closeNav());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)closeNav();});
  window.addEventListener('pageshow',()=>closeNav());
  document.querySelector('.sidebar')?.addEventListener('click',event=>{if(event.target.closest('button')&&!event.target.closest('.row'))closeNav();});

  const root=document.createElement('section');root.id='mobile-composer';root.setAttribute('aria-label','Mobile terminal input');
  root.innerHTML=`<div id="mobile-voice-slot"></div><div id="mobile-composer-accessories" hidden></div><div id="mobile-selection-actions" class="fork-selection-actions"><span id="mobile-selection-status">Drag across terminal text</span><button id="mobile-selection-copy" type="button">Copy</button><button id="mobile-selection-done" type="button">Done</button></div><div class="mobile-composer-editor"><button id="mobile-composer-tools" type="button" aria-label="Terminal tools" aria-expanded="false">⌨</button><textarea id="mobile-composer-text" rows="1" maxlength="64000" autocomplete="on" autocorrect="on" autocapitalize="sentences" spellcheck="true" enterkeyhint="send" aria-label="Prompt" placeholder="Write a prompt or command…"></textarea><button id="mobile-composer-send" type="button" aria-label="Send">➤</button></div><div class="mobile-draft-status" role="status"></div>`;
  pane.append(root);
  const editor=root.querySelector('textarea'),sendButton=root.querySelector('#mobile-composer-send'),tools=root.querySelector('#mobile-composer-tools'),accessories=root.querySelector('#mobile-composer-accessories'),status=root.querySelector('.mobile-draft-status');
  const controlButtons=[];
  for(const [label,data] of [['Esc','\x1b'],['Tab','\t'],['Up','\x1b[A'],['Down','\x1b[B'],['Enter','\r'],['Ctrl+C','\x03']]){
    const el=button(label,{Up:'↑',Down:'↓',Enter:'↵'}[label]||label);accessories.append(el);controlButtons.push(el);
    el.onclick=()=>{const s=store.active();if(s?.live!==false&&store.connected&&s){send({type:'input',sessionId:s.id,data});if(keyboardWasUp&&!direct.has(s.id))focusEditor();}};
  }
  const attach=button('Attach image','Attach');attach.id='mobile-composer-attach';accessories.append(attach);
  const file=document.createElement('input');file.id='mobile-composer-file';file.type='file';file.accept='image/png,image/jpeg,image/webp,image/gif';file.multiple=true;file.hidden=true;accessories.append(file);
  const install=button('Install CliDeck','Install');install.id='mobile-composer-install';install.hidden=true;accessories.append(install);
  const select=button('Select terminal text','Select');select.id='mobile-selection-toggle';accessories.append(select);
  const directButton=button('Direct terminal input','Direct');accessories.append(directButton);
  const paste=button('Paste draft','Paste');accessories.append(paste);
  const discard=button('Discard current draft','Discard');accessories.append(discard);
  discard.onclick=()=>{const id=store.activeId;if(id&&confirm('Discard the current unsent draft?'))setDraft(id,'');};
  const recovery=document.createElement('select');recovery.setAttribute('aria-label','Recovered drafts');accessories.append(recovery);
  recovery.onchange=()=>{if(recovery.value)recoverDraft(store.activeId,Number(recovery.value));};
  function focusEditor(){if(enabled&&!editor.disabled&&!root.hidden)editor.focus({preventScroll:true});}
  function resizeEditor(){editor.style.height='44px';editor.style.height=`${Math.min(82,Math.max(44,editor.scrollHeight))}px`;}
  function setTools(open){toolsOpen=!!open;accessories.hidden=!toolsOpen;tools.setAttribute('aria-expanded',String(toolsOpen));}
  const selection=createMobileSelection({getActiveId:()=>store.activeId,getEntry:id=>id===store.activeId?mobileTerminalEntry():null,available:()=>enabled,
    writeText:writeClipboardText,onActivate:()=>{showTerminalTab();setTools(false);editor.blur();},onModeChange:()=>refresh(),
    onCopied:length=>toast.success({title:'Copied',body:`${length} characters copied.`}),onCopyError:()=>toast.error({title:'Copy failed',body:'Allow clipboard access and try again.'})});
  const scroll=createMobileTouchScroll({isSelectionActive:()=>!enabled||selection.isActive()||panel.hidden||document.hidden,
    isNativeScroll:id=>store.activeId===id&&store.active()?.nativeScroll===true,
    sendInput:(id,data)=>{if(enabled&&!document.hidden&&!panel.hidden&&id===store.activeId&&store.connected&&store.active()?.live!==false)send({type:'input',sessionId:id,data});},
    onDragClaim:()=>editor.blur(),onLongPress:()=>{if(enabled&&!panel.hidden)selection.activate();}});
  tools.onclick=()=>setTools(!toolsOpen);
  function commit(submit=true){const id=store.activeId;if(!id||direct.has(id))return;const keep=keyboardWasUp||document.activeElement===editor;if(submitDraft(id,{submit})){setTools(false);if(keep)focusEditor();}}
  sendButton.onclick=()=>commit();paste.onclick=()=>commit(false);
  directButton.onclick=()=>{const id=store.activeId;if(!id)return;selection.deactivate();if(direct.has(id))direct.delete(id);else direct.add(id);setTools(false);refresh();if(direct.has(id))focusTerminalInput();else focusEditor();};
  root.addEventListener('pointerdown',event=>{if(event.target.closest('button')){keyboardWasUp=document.activeElement===editor;if(event.pointerType!=='touch')event.preventDefault();}});
  root.addEventListener('mousedown',event=>{if(event.target.closest('button'))event.preventDefault();});
  editor.addEventListener('input',()=>{if(store.activeId)setDraft(store.activeId,editor.value);resizeEditor();});
  editor.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();commit();}});
  panel.addEventListener('touchmove',()=>{if(enabled&&document.activeElement===editor)editor.blur();},{passive:true});
  function gitAction(){return resolveImmediateActions('terminal.header',pluginActionContext('terminal','')).find(a=>a.pluginId==='git-diff'&&a.id==='open');}
  git.onclick=async()=>{editor.blur();closeMenu();setTools(false);await runAction(gitAction());};
  function refresh(){
    const s=store.active(),live=!!s&&s.live!==false,composition=pluginCompositionState(),voice=!!composition&&composition.pluginId!=='$terminal-draft';
    indicator.dataset.state=!store.connected?'offline':s?.live===false?'stopped':s?.status||'unknown';indicator.title=indicator.dataset.state;indicator.setAttribute('aria-label',indicator.dataset.state);
    const terminalVisible=!panel.hidden;
    if((!terminalVisible||!enabled||document.hidden)&&attached)scroll.interrupt(attached);
    root.hidden=!enabled||!s||(!terminalVisible&&!voice);
    root.classList.toggle('voice-active',voice);root.classList.toggle('direct-active',!!s&&direct.has(s.id));
    setTerminalInputOwner(voice ? 'plugin' : composition ? 'composer' : enabled && (!s || !direct.has(s.id) || !terminalVisible) ? 'composer' : 'terminal');
    if(!terminalVisible&&document.activeElement===editor)editor.blur();
    editor.disabled=!live||voice||direct.has(s?.id);editor.placeholder=direct.has(s?.id)?'Direct input · Tools → Composer':'Write a prompt or command…';
    const d=s?getDraft(s.id):null;if(editor.value!==(d?.draft||''))editor.value=d?.draft||'';
    discard.disabled=!d?.draft||!!d?.pending||voice;
    sendButton.disabled=!live||voice||direct.has(s?.id)||!d?.canSend;paste.disabled=sendButton.disabled;
    tools.disabled=!live||voice;attach.disabled=!live||voice;directButton.disabled=!live||voice||!store.connected;
    directButton.textContent=direct.has(s?.id)?'Composer':'Direct';directButton.setAttribute('aria-pressed',String(!!s&&direct.has(s.id)));
    for(const el of controlButtons)el.disabled=!live||voice||!store.connected;
    select.disabled=!s||voice;
    status.textContent=d?.pending?'Attaching image…':d?.draft&&!d.canSend?'Shorten this draft before sending.':'';
    recovery.hidden=!d?.alternates.length;const signature=JSON.stringify(d?.alternates||[]);
    if(recovery.dataset.signature!==signature){recovery.dataset.signature=signature;recovery.replaceChildren(new Option('Recover another draft…',''));(d?.alternates||[]).forEach((text,i)=>recovery.append(new Option(text.slice(0,60),String(i))));}
    git.disabled=!s||!gitAction();resizeEditor();
  }
  registerMobileDraftView({enabled:()=>enabled,open:({focus})=>{direct.delete(store.activeId);selection.deactivate();refresh();if(focus)focusEditor();}});
  onDraftChange(refresh);onPluginCompositionChange(refresh);onActionsChange(refresh);
  for(const event of ['session:update','connection','reset'])store.on(event,refresh);
  store.on('active',()=>{closeNav();closeMenu();setTools(false);if(attached){selection.detach(attached);scroll.detach(attached);}attached=store.activeId;const entry=mobileTerminalEntry();if(attached&&entry){selection.attach(attached,entry.term,entry.host);scroll.attach(attached,entry.term,entry.host);}selection.refresh();refresh();});
  document.addEventListener('visibilitychange',refresh);
  panel.addEventListener('click',event=>{if(event.target.closest('.scroll-btn')&&attached)scroll.interrupt(attached);});
  new MutationObserver(refresh).observe(panel,{attributes:true,attributeFilter:['hidden']});
  let viewportRaf=0;
  function fitViewport(){
    viewportRaf=0;
    enabled=getTouchUiMode()!=='desktop'&&(isTouchUiEnabled()||matchMedia('(max-width:760px)').matches);
    document.body.classList.toggle('mobile-ui',enabled);mode.value=getTouchUiMode();
    setPluginCompositionHost(enabled ? root.querySelector('#mobile-voice-slot') : null);
    const viewport=window.visualViewport,zoomed=Math.abs((viewport?.scale||1)-1)>.01;
    if(enabled){const height=zoomed?innerHeight:Math.round(viewport?.height||innerHeight),top=zoomed?0:Math.round(viewport?.offsetTop||0);app.style.setProperty('--mobile-height',`${height}px`);app.style.setProperty('--mobile-top',`${top}px`);app.classList.toggle('mobile-short',height<420);closeTerminalDraft();}
    else{app.style.removeProperty('--mobile-height');app.style.removeProperty('--mobile-top');app.classList.remove('mobile-short');closeNav();closeMenu();}
    refresh();
  }
  const schedule=()=>{if(!viewportRaf)viewportRaf=requestAnimationFrame(fitViewport);};
  window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);window.addEventListener('resize',schedule);onTouchUiChange(schedule);fitViewport();
}
