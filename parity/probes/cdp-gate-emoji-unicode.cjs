// Shipped Unicode11 + actual F7 insertion; isolated engine/browser, synthetic client session, no PTY.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-emoji-width-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'emoji-recent-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: { emoji: { enabled: true, settings: { shortcut: 'F7' } } }, onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir });
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const sid = 'synthetic-width-probe';
    const profile = mkdtempSync(join(tmpdir(), 'emoji-recent-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i=0; i<100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r=>cws.on('open',r));
    let seq=0; const pending=new Map();
    cws.on('message', raw=> {const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},12000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});cws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const snap=async name=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(s.data,'base64'));};
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Page.enable');await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cmd('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',platform:'Linux x86_64'});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.applyEvent({type:'session.created',sessionId:${JSON.stringify(sid)},provider:'shell',live:true,pid:999999,cwd:'/tmp',name:'Width probe'});store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{}if(JSON.parse(data).type==='input')return;return send.call(this,data)};})()`);


    const key=async(key,code,n)=>{await cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n});await sleep(150);};
    for(const [id,glyph] of [['smile','😊'],['pray','🙏'],['heart','❤️'],['warning','⚠️']]){
      await js('term.focus();sent=[]');await key('F7','F7',118);
      await js(`document.querySelector('.pk-item[data-item-id="${id}"]').click()`);await sleep(150);
      check('F7 exact '+id+' without CR',await js(`JSON.stringify(sent.filter(m=>m.type==='input').map(m=>m.data))===JSON.stringify([${JSON.stringify('\x1b[200~'+glyph+'\x1b[201~')}])`));
    }


    check('shipped addon selected before output',await js("term.unicode.activeVersion==='11'"));
    const samples=[['ASCII',5],['中文',4],['é',1],['😊',2],['🥰',2],['🤔',2],['🥳',2],['🙏',2],['🤞',2],['🚀',2],['❤️',1],['⚠️',1],['👩‍💻',4],['👍🏽',4]];
    const result=await js(`(async()=>{
      term.reset();term.options.cursorBlink=false;
      const result=[];
      for(const [text] of ${JSON.stringify(samples)}){
        await new Promise(r=>term.write('\\r\\x1b[2K'+text,r));
        result.push([text,term.buffer.active.cursorX,term.buffer.active.getLine(0).translateToString(true)]);
      }
      return result;
    })()`);
    check('plain/combining/emoji widths and known sequence limits',result.every((r,i)=>r[1]===samples[i][1]&&r[2]===samples[i][0]),result);
    await js(`term.reset();term.focus();term.options.cursorStyle='block';new Promise(r=>term.write('😊',r))`);
    await sleep(150);
    check('block cursor is beyond two-cell emoji',await js(`(()=>{
      const row=document.querySelector('.xterm-rows>div'),emoji=row.querySelector('span'),cursor=row.querySelector('.xterm-cursor');
      return term.buffer.active.cursorX===2&&term.buffer.active.getLine(0).getCell(0).getWidth()===2&&cursor.getBoundingClientRect().left>=emoji.getBoundingClientRect().right-1;
    })()`));
    for(const theme of ['dark','light']){
      await js(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`);await sleep(150);await snap('emoji-cursor-'+theme+'.png');
    }
    await js(`term.resize(10,10);term.reset();new Promise(r=>term.write('123456789😊X',r))`);
    check('wide emoji wraps intact at final column',await js(`term.buffer.active.getLine(1).getCell(0).getChars()==='😊'&&term.buffer.active.getLine(1).getCell(0).getWidth()===2&&term.buffer.active.getLine(1).getCell(2).getChars()==='X'&&term.buffer.active.cursorX===3`));
    await js(`new Promise(r=>term.write('\\r\\x1b[2K🙏Y',r))`);
    check('line redraw retains wide emoji and next character',await js(`term.buffer.active.getLine(1).translateToString(true)==='🙏Y'&&term.buffer.active.cursorX===3`));
    await js(`store.active().outputBuf='A😊B中文é';store.applyEvent({type:'session.created',sessionId:'other',provider:'shell',live:true,pid:999998,cwd:'/tmp'});store.select('other');store.select('synthetic-width-probe')`);
    await sleep(200);
    check('session reset and replay keep Unicode11 and cursor alignment',await js(`term.unicode.activeVersion==='11'&&term.buffer.active.getLine(0).translateToString(true)==='A😊B中文é'&&term.buffer.active.cursorX===9&&term.buffer.active.getLine(0).getCell(1).getWidth()===2`));
  } finally {
    cws?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
