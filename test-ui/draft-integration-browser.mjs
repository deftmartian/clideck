import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,firefox} from 'playwright-core';
const require=createRequire(import.meta.url);
const {HeadlessServer}=require('../src/server');
const browserType=process.env.BROWSER==='firefox'?firefox:chromium;
const dir=mkdtempSync(join(tmpdir(),'clideck-drafts-'));
const server=new HeadlessServer({port:0,dataDir:dir,cwd:dir,requireProtocol:true});
let browser,releaseUpload;
try {
 server.configStore.update({onboarding:{completed:true,seenTips:['about-me','guided-tour']}});
 const {httpUrl}=await server.listen();
 const inputs=new Map();
 function session(name){
  const s=server.startSession({provider:{id:'shell',supportsAsk:false,statusFromActivity:true,activityIdleMs:30,
   createLaunch:()=>({command:process.execPath,args:['-e',"process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',()=>{});process.stdout.write('READY\\r\\n')"]})},cwd:dir,name,cols:80,rows:24,port:server.port},true);
  inputs.set(s.id,[]);const write=s.terminal.write.bind(s.terminal);s.terminal.write=d=>{inputs.get(s.id).push(d);write(d);};return s;
 }
 const a=session('Draft A'),b=session('Draft B');
 
 browser=await browserType.launch({headless:true,...(browserType===chromium?{args:['--no-sandbox']}: {})});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,...(browserType===chromium?{isMobile:true}:{})});
 const page=await context.newPage();const syncModes=[];page.on('websocket',socket=>socket.on('framereceived',({payload})=>{try{const e=JSON.parse(payload);if(e.type==='session.sync')syncModes.push(e.mode);}catch{}}));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});
 // Exercise the actual modules with a single store, without adding test hooks to production.
 const handleHttp=server.handleHttp.bind(server);
 server.handleHttp=(req,res)=>{if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(readFileSync(new URL('../public/index.html',import.meta.url)));}else handleHttp(req,res);};
 await page.goto(httpUrl);await page.locator('#conn-text').filter({hasText:'live'}).waitFor();
 const select=async id=>{await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.locator(`.row[data-id="${id}"]`).click();};
 await select(a.id);await page.getByRole('textbox',{name:'Prompt',exact:true}).waitFor();
 const draft=page.getByRole('textbox',{name:'Prompt',exact:true});await draft.fill('Typed draft');
 await page.evaluate(async()=>{const c=await import('/js/ui/plugin-composition.js');c.openPluginComposition('test-voice',{state:'listening',title:'Voice test'},()=>{});});
 assert.equal(await page.locator('.plugin-composition').count(),1);
 await page.evaluate(async id=>{const d=await import('/js/ui/terminal-draft.js');const c=await import('/js/ui/plugin-composition.js');if(!d.commitCompositionDraft('Spoken words',{sessionId:id,submit:false}))throw new Error('Voice draft rejected');c.closePluginComposition('test-voice');},a.id);
 await draft.waitFor();assert.equal(await draft.inputValue(),'Typed draft\nSpoken words');
 assert.deepEqual(inputs.get(a.id),[],'reviewing voice never inserts into PTY');
 
 const uploadWait=new Promise(resolve=>{releaseUpload=resolve;});let uploadStarted;
 const started=new Promise(resolve=>{uploadStarted=resolve;});
 await page.route('**/clipboard-image',async route=>{uploadStarted();await uploadWait;await route.continue();});
 await draft.evaluate(el=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'image.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:data});el.dispatchEvent(event);});
 await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Paste did not start an upload')),5000))]);
 assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true,'upload blocks premature submit');
 await select(b.id);releaseUpload();
 await page.waitForFunction(async()=>{const response=await fetch('/api/health');return response.ok;});
 await page.getByRole('textbox',{name:'Prompt',exact:true}).waitFor();assert.equal(await draft.inputValue(),'');
 await select(a.id);await page.getByRole('textbox',{name:'Prompt',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('#mobile-composer-text')?.value.includes('.png'));
 const beforeOffline=await draft.inputValue();assert.match(beforeOffline,/Typed draft\nSpoken words\n.*\.png$/);
 assert.deepEqual(inputs.get(a.id),[],'image upload does not insert before Send');assert.deepEqual(inputs.get(b.id),[],'late upload never targets another session');
 await context.setOffline(true);for(const socket of server.clients)socket.close();
 await page.locator('#conn-text').filter({hasText:'offline'}).waitFor();
 await page.getByRole('button',{name:'Send',exact:true}).click();assert.equal(await draft.inputValue(),beforeOffline,'offline draft survives Send');
 await context.setOffline(false);await page.locator('#conn-text').filter({hasText:'live'}).waitFor({timeout:15000});
 assert.equal(await draft.inputValue(),beforeOffline,'draft survives reconnect');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#mobile-composer-text')?.value==='');
 await page.waitForTimeout(100);
 const sent=inputs.get(a.id).filter(value=>value.includes('Typed draft'));
 assert.equal(sent.length,1);assert.ok(sent[0].endsWith('\r'));assert.match(sent[0],/Spoken words/);assert.match(sent[0],/\.png/);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok([...server.clients].every(socket=>!socket._clideckStream?.sessionId),'hidden tab unsubscribes');
 const beforeRecovery=syncModes.length;
 a.handleOutput('BACKGROUND_RECOVERED\\r\\n'.replaceAll('\\r','\r').replaceAll('\\n','\n'));
 await new Promise(resolve=>setTimeout(resolve,100));
 await page.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(async()=>{const {__termForTest}=await import('/js/ui/terminal.js');const buffer=__termForTest().buffer.active;return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString()).join('\n').includes('BACKGROUND_RECOVERED');});
 assert.ok(syncModes.slice(beforeRecovery).includes('delta'),'visible tab recovers background output with a cursor delta');
 assert.deepEqual(errors,[]);
 console.log('PASS: one draft for typing, voice and images; late uploads stay bound; offline Send retains text; reconnect sends exactly once');
} finally {releaseUpload?.();await browser?.close();await server.close();rmSync(dir,{recursive:true,force:true});}
