import assert from 'node:assert/strict';
import { installFakeDom, installFakeWs } from './fakedom.mjs';
installFakeDom(); const ws = installFakeWs();
const { store } = await import('../public/js/store.js');
const { connectWs } = await import('../public/js/ws.js');
const { sessionFace, providerOf, PROVIDER_LIST } = await import('../public/js/providers-ui.js');
const { openSettingsAt, closeSettings } = await import('../public/js/ui/settings.js');
let count=0; const check=(name,fn)=>{fn();count++;console.log('PASS '+name);};
const base={id:'custom-codex',label:'My Codex',command:'codex --profile local',providerId:'codex',icon:'terminal',enabled:true,isAgent:true,env:{}};
function face(command) {
  store.applyEvent({type:'config',config:{commands:[command]}});
  return sessionFace({commandId:command.id,commandLabel:command.label,provider:'codex'});
}
for(const provider of PROVIDER_LIST) {
  for(const icon of [undefined,'terminal']) {
    check(`${provider.id} inherits native icon from ${icon || 'missing'} icon`,()=>{
      const f=face({...base,providerId:provider.id,icon});
      assert.equal(f.cls,provider.cls);assert.equal(f.mark().innerHTML,provider.mark().innerHTML);
      assert.equal(f.label,base.label);
    });
  }
}
check('explicit other provider icon takes precedence',()=>assert.equal(face({...base,icon:'gemini'}).cls,providerOf('gemini').cls));
check('explicit emoji stays literal',()=>assert.equal(face({...base,icon:'🦊'}).mark().textContent,'🦊'));
check('unknown provider stays generic',()=>assert.equal(face({...base,providerId:'unknown'}).cls,'pv-custom'));
check('custom command without native binding stays generic',()=>assert.equal(face({...base,providerId:undefined}).cls,'pv-custom'));
check('resolved signature changes when native binding changes',()=>assert.notEqual(face(base).sig,face({...base,providerId:'gemini'}).sig));
check('deleted command keeps safe pending fallback',()=>assert.equal(sessionFace({commandId:'deleted',commandLabel:'Old'}).label,'Old'));
connectWs(); await new Promise(r=>setTimeout(r,10));face(base);openSettingsAt('agents');
check('Settings shows same effective native icon',()=>assert.equal(document.querySelector('.set-card-ic svg').innerHTML,providerOf('codex').mark().innerHTML));
document.querySelector('.set-card-ic')._fire('click');
const defaultButton=[...document.querySelectorAll('.set-icon-cell')].find(b=>b.title==='Default (Codex)');
check('generic picker choice clearly describes native default',()=>assert.ok(defaultButton));
ws.clear();defaultButton._fire('click');
check('choosing default preserves provider binding and stored generic value',()=>{
  const c=ws.last('config.update').config.commands[0];assert.equal(c.providerId,'codex');assert.equal(c.icon,'terminal');
});
const name=document.querySelector('.set-card-name');name.value='Renamed';name._fire('input');closeSettings();
check('ordinary Settings edit retains native binding',()=>{
  const c=ws.last('config.update').config.commands[0];assert.equal(c.label,'Renamed');assert.equal(c.providerId,'codex');
});
const saved=ws.last('config.update').config.commands[0];
check('saved command roundtrip keeps native session face',()=>{
  const restored=face(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.cls,providerOf('codex').cls);assert.equal(restored.label,'Renamed');
});
closeSettings();console.log(`${count}/${count} passed`);process.exit(0);
