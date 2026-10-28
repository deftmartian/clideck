import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,firefox} from 'playwright-core';
const require=createRequire(import.meta.url);
const {HeadlessServer}=require('../src/server');
const dir=mkdtempSync(join(tmpdir(),'clideck-cursor-'));
const server=new HeadlessServer({port:0,dataDir:dir,cwd:dir,requireProtocol:true});
const type=process.env.BROWSER==='firefox'?firefox:chromium;
let browser;
try {
 const {httpUrl}=await server.listen();
 // A bottom-anchored input line, like a terminal agent UI. Redraw on real SIGWINCH.
 const fixture=`process.stdin.setRawMode(true);process.stdin.resume();let input='';
 function draw(){const rows=process.stdout.rows;process.stdout.write('\\x1b[2J\\x1b[HOUTPUT HISTORY\\x1b['+rows+';1H> '+input);}
 process.stdout.on('resize',draw);process.stdin.on('data',d=>{input+=d.toString();draw();});setTimeout(draw,150);`;
 const session=server.startSession({provider:{id:'shell',supportsAsk:false,statusFromActivity:true,activityIdleMs:50,createLaunch:()=>({command:process.execPath,args:['-e',fixture]})},cwd:dir,name:'Cursor fixture',cols:120,rows:40,port:server.port},true);
 browser=await type.launch({headless:true,...(type===chromium?{args:['--no-sandbox']}: {})});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.addInitScript(()=>{
  Object.defineProperty(window,'Terminal',{configurable:true,set(Original){
   Object.defineProperty(window,'Terminal',{configurable:true,writable:true,value:class extends Original {constructor(...args){super(...args);window.cursorTestTerminal=this;}}});
  }});
 });
 await page.goto(httpUrl);
 await page.locator(`.row[data-id="${session.id}"]`).click();
 for (const viewport of [{width:1280,height:900},{width:800,height:620},{width:1100,height:780}]) {
  await page.setViewportSize(viewport);
  try { await page.waitForFunction(()=>{const t=window.cursorTestTerminal;return t&&t.buffer.active.getLine(t.buffer.active.baseY+t.rows-1)?.translateToString(true).startsWith('>');},{},{timeout:5000}); }
  catch(error){console.error('PTY size',session.cols,session.rows,'screen',await session.capture.lines({limit:8}));console.error(await page.evaluate(()=>{const t=window.cursorTestTerminal;if(!t)return 'No captured terminal';const b=t.buffer.active;return {rows:t.rows,cols:t.cols,cursorY:b.cursorY,lines:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true))};}));throw error;}
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('CURSOR');
  await page.waitForFunction(()=>{const t=window.cursorTestTerminal,b=t.buffer.active;return b.getLine(b.baseY+t.rows-1)?.translateToString(true).includes('CURSOR');});
  await page.reload();
  try {await page.waitForFunction(()=>{const t=window.cursorTestTerminal;if(!t)return false;const b=t.buffer.active;return b.getLine(b.baseY+t.rows-1)?.translateToString(true).includes('CURSOR') && b.getLine(b.baseY)?.translateToString(true)==='OUTPUT HISTORY';},{},{timeout:5000});} catch(error) {console.error('Reload cursor state',await page.evaluate(()=>{const t=window.cursorTestTerminal,b=t.buffer.active;return {rows:t.rows,cols:t.cols,cursorY:b.cursorY,baseY:b.baseY,disabled:t.options.disableStdin,lines:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true))};}));console.error('PTY',session.cols,session.rows,await session.capture.lines({limit:8}));throw error;}
  const actual=await page.evaluate(()=>{const t=window.cursorTestTerminal,b=t.buffer.active;return {cols:t.cols,rows:t.rows,cursorY:b.cursorY,history:b.getLine(b.baseY)?.translateToString(true)};});
  assert.equal(actual.cols,session.cols,'browser and PTY columns agree');
  assert.equal(actual.rows,session.rows,'browser and PTY rows agree');
  assert.equal(actual.cursorY,actual.rows-1,'input stays at bottom after snapshot replay');
  assert.equal(actual.history,'OUTPUT HISTORY','typing never overwrites prior output');
 }
 console.log('PASS: bottom-anchored input preserves cursor and output across resize and refresh');
} finally {await browser?.close();await server.close();rmSync(dir,{recursive:true,force:true});}
