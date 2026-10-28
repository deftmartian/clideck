import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, firefox } from 'playwright-core';
const browserType = process.env.BROWSER === 'firefox' ? firefox : chromium;
const launchOptions = { headless: true, ...(browserType === chromium ? {executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), args:['--no-sandbox']} : {}) };
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const script = process.env.XTERM_JS || require.resolve('@xterm/xterm');
const css = resolve(dirname(script), '../css/xterm.css');
const server = createServer((req, res) => {
  if (req.url === '/mobile-touch-scroll.js') {res.setHeader('Content-Type','text/javascript');res.end(readFileSync(new URL('../public/js/mobile-touch-scroll.js',import.meta.url)));}
  else if (req.url === '/xterm.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(script)); }
  else if (req.url === '/xterm.css') { res.setHeader('Content-Type', 'text/css'); res.end(readFileSync(css)); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/xterm.css"><style>body{margin:0}#term{width:390px;height:600px}</style><div id="term"></div><script src="/xterm.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserType.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...(browserType === chromium && {isMobile: true}), hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.term = new Terminal({ cols: 40, rows: 30, scrollback: 1000 });
    term.open(document.getElementById('term'));
    const {createMobileTouchScroll}=await import('/mobile-touch-scroll.js');
    window.reports=[];window.nativeMode=false;window.selectMode=false;
    window.scrollHelper=createMobileTouchScroll({isSelectionActive:()=>selectMode,isNativeScroll:()=>nativeMode,sendInput:(_id,data)=>reports.push(data)});
    scrollHelper.attach('fixture',term,document.getElementById('term'));
    await new Promise(resolve => term.write(Array.from({length: 180}, (_, i) => `history ${i}\r\n`).join(''), resolve));
  });
  const cdp = browserType === chromium ? await page.context().newCDPSession(page) : null;
  const touch = async (type,y) => {
    if(cdp)return cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:150,y}]});
    return page.evaluate(({type,y})=>{
      const target=document.querySelector('.xterm-screen');
      const point=new Touch({identifier:1,target,clientX:150,clientY:y,pageX:150,pageY:y});
      target.dispatchEvent(new TouchEvent(type.toLowerCase(),{bubbles:true,cancelable:true,touches:type==='touchEnd'?[]:[point],targetTouches:type==='touchEnd'?[]:[point],changedTouches:[point]}));
    },{type,y});
  };
  const before = await page.evaluate(() => term.buffer.active.viewportY);
  await touch('touchStart',180);
  for (let y = 200; y <= 440; y += 20) {
    await touch('touchMove',y);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd',440);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => term.buffer.active.viewportY);
  assert.ok(after < before, `touch scroll moves through history: ${before} -> ${after}`);
  console.log(`PASS: mobile touch gesture scrolls history (${before} -> ${after})`);
  const result = await page.evaluate(async () => {
    const write = data => new Promise(resolve => term.write(data, resolve));
    term.scrollLines(-20);
    await write('\x1b[3J');
    await write(Array.from({length:80}, (_, i) => `new ${i}\r\n`).join(''));
    return { viewport:term.buffer.active.viewportY, base:term.buffer.active.baseY };
  });
  if (process.env.EXPECT_PINNED === '1') assert.notEqual(result.viewport, result.base);
  else assert.equal(result.viewport, result.base, 'viewport follows new output after scrollback clear');
  console.log(`${process.env.EXPECT_PINNED === '1' ? 'REPRODUCED OLD BUG' : 'PASS'}: scrollback clear ${JSON.stringify(result)}`);
  await page.evaluate(async()=>{window.mouseReports=reports;term.onData(data=>mouseReports.push(data));await new Promise(resolve=>term.write('\x1b[?1000h\x1b[?1006h',resolve));});
  await touch('touchStart',180);
  for(let y=200;y<=400;y+=20){await touch('touchMove',y);await page.waitForTimeout(16);}
  await touch('touchEnd',400);await page.waitForTimeout(150);
  const reports=await page.evaluate(()=>mouseReports);
  console.log('Application mouse reports:',JSON.stringify(reports.slice(0,4)));
  assert.ok(reports.some(data=>/^(?:\x1b\[<6[45];\d+;\d+[Mm])+$/.test(data)),'application-controlled touch scroll emits valid wheel coordinates');
  assert.ok(reports.every(data=>!data.includes('NaN')),'mouse reports never contain NaN');
  await page.evaluate(()=>{scrollHelper.interrupt('fixture');nativeMode=true;mouseReports.length=0;term.scrollToBottom();});
  const nativeBefore=await page.evaluate(()=>term.buffer.active.viewportY);
  await touch('touchStart',180);for(let y=200;y<=400;y+=20){await touch('touchMove',y);await page.waitForTimeout(16);}await touch('touchEnd',400);await page.waitForTimeout(80);
  assert.ok(await page.evaluate(()=>term.buffer.active.viewportY)<nativeBefore,'minimal mode scrolls native history even with mouse tracking');
  assert.deepEqual(await page.evaluate(()=>mouseReports),[],'minimal mode sends no mouse bytes');
  console.log('PASS: app-mouse and minimal-mode touch routing');

} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
