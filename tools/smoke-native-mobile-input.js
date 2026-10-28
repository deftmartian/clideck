// Isolated native conversations exercise the exact mobile bracketed-paste + Enter transaction.
const assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync}=require('node:fs');
const {join}=require('node:path');const {tmpdir,homedir}=require('node:os');
const {HeadlessServer}=require('../src/server');
const hooks=require('../src/fork/grok-hooks');
const provider=process.env.SMOKE_PROVIDER||'grok';
async function waitFor(predicate,label,ms=60000){const until=Date.now()+ms;while(Date.now()<until){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
(async()=>{
 assert.ok(['grok','codex'].includes(provider));
 if(provider==='grok'&&!hooks.complete(join(homedir(),'.grok')))throw Error('Existing complete Grok hooks required; do not modify global hooks for a smoke.');
 const dir=mkdtempSync(join(tmpdir(),'clideck-native-mobile-')),codexHome=join(dir,'codex');mkdirSync(codexHome);
 if(provider==='codex'){copyFileSync(join(homedir(),'.codex/auth.json'),join(codexHome,'auth.json'));writeFileSync(join(codexHome,'config.toml'),`model = "gpt-6-astra"\n[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);}
 const server=new HeadlessServer({port:0,cwd:dir,dataDir:join(dir,'data'),providerOptions:{codex:{codexHome,bypassHookTrust:true}}});
 try{
  await server.listen();let s=server.createSession({provider,cwd:dir,name:'Isolated native mobile input',cols:120,rows:40,touchUi:true});
  try {await waitFor(()=>s.sessionStarted&&s.status==='idle','native ready');}catch(e){console.error((await s.capture.lines({limit:200})).filter(line=>line.trim()).slice(-20).join('\n'));throw e;}
  console.log('Ready: '+provider+', bracketedPaste='+s.bracketedPasteMode);
  await new Promise(resolve=>setTimeout(resolve,1500));
  let final='';s.on('event',event=>{if(event.type==='agent.final')final=event.text;});
  const input=process.env.SMOKE_COMBINED_WRITE==='1'?s.terminal.write.bind(s.terminal):s.writeInput.bind(s);
  input('\x1b[200~Reply with exactly CLIDECK_MOBILE_PASTE_OK.\nDo not use tools or contact other sessions.\x1b[201~\r');
  if(process.env.SMOKE_COMBINED_WRITE==='1'){try{await waitFor(()=>s.status==='working'||!!final,'old combined write',8000);console.log('Combined-write control submitted successfully');}catch{assert.equal(s.status,'idle');console.log('REPRODUCED: old combined write leaves Codex idle with unsent input');}return;}
  try {await waitFor(()=>final.includes('CLIDECK_MOBILE_PASTE_OK'),'combined paste and Enter',60000);}catch(e){console.error((await s.capture.lines({limit:200})).filter(line=>line.trim()).slice(-20).join('\n'));throw e;}
  await waitFor(()=>s.status==='idle'&&server.persistence.get(s.id)?.resumeHandle,'saved native pointer');
  const handle=server.persistence.get(s.id).resumeHandle;
  s=await server.restartSession({sessionId:s.id,touchUi:true});
  await waitFor(()=>s.sessionStarted&&s.status==='idle','native resume');
  assert.equal(s.launchOptions.resumeHandle,handle);
  if(provider==='grok')assert.equal(s.snapshot().nativeScroll,true);
  console.log('PASS: '+provider+' combined multiline paste/Enter and native resume');
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
