// Gate: right-clicking the TERMINAL gives a text menu; right-clicking a ROW still gives the session menu.
// Real browser, real engine, real PTY, real right-click — a fake DOM cannot tell you what a contextmenu
// event on xterm actually produces.
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('/Users/rusty/Projects/clideck-next/src/server.js');
const WebSocket = require('/Users/rusty/Projects/clideck-next/node_modules/ws/index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/clideck-terminal-menu-ui';
mkdirSync(OUT, {recursive:true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fail++; };
const SESSION_ONLY = ['Rename', 'Delete', 'Theme…', 'Restart session', 'Mute', 'Copy @address'];

(async () => {
  let server, ctl, chrome, cws;
  try {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-data-'));
  writeFileSync(join(dataDir,'config.json'),JSON.stringify({onboarding:{completed:true,seenTips:['guided-tour','about-me']}}));
  const cwd = mkdtempSync(join(tmpdir(), 'tm-cwd-'));
  server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', d => { try { events.push(JSON.parse(d)); } catch {} });
  await new Promise((res, rej) => { ctl.on('open', res); ctl.on('error', rej); });
  ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'menus', cwd }));
  const sid = await new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => {
    const hit = events.find(e => e.type === 'session.created');
    if (hit) { clearInterval(iv); res(hit.sessionId); } else if (Date.now() - t0 > 10000) { clearInterval(iv); rej(new Error('no session')); } }, 40); });

  const prof = mkdtempSync(join(tmpdir(), 'chrome-tm-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(200);
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { cws.on('open', res); cws.on('error', rej); });
  let seq = 0; const pending = new Map();
  cws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (m, p = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); cws.send(JSON.stringify({ id, method: m, params: p })); });
  const js = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async (n) => { const s = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); console.log('  captured ' + n); };
  const items = () => js(`[...document.querySelectorAll('.menu .menu-item')].map(e => e.textContent.trim())`);
  const escape = async () => { await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(160); };

  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1240, height: 820, deviceScaleFactor: 2, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cmd('Page.navigate', { url: base });
  await sleep(4200);
  await js(`(() => { const r = document.querySelector('.row[data-id="${sid}"]'); r && r.click(); return true; })()`);
  await sleep(900);

  // ── right-click the TERMINAL ────────────────────────────────────────────────────────────────────
  const pt = await js(`(() => { const b = document.querySelector('#term').getBoundingClientRect();
    return { x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) }; })()`);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  await sleep(500);
  const term = await items();
  check('0control a menu actually opened on the terminal', Array.isArray(term) && term.length > 0, JSON.stringify(term));
  check('1 the terminal menu is Copy + Paste only (plus any plugin action)',
    term.length >= 2 && term[0] === 'Copy' && term[1] === 'Paste', JSON.stringify(term));
  check('2 and carries NO session actions',
    SESSION_ONLY.every(x => !term.includes(x)), JSON.stringify(term));
  check('3 no selection under the cursor → Copy is disabled, not silently inert',
    await js(`(() => { const c = [...document.querySelectorAll('.menu .menu-item')].find(e => e.textContent.trim() === 'Copy'); return c ? c.disabled : null; })()`) === true);
  await snap('termmenu-dark-terminal.png');
  await escape();

  // ── right-click / ▾ the ROW — unchanged ─────────────────────────────────────────────────────────
  const bx = await js(`(() => { const b = document.querySelector('.row[data-id="${sid}"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width - 24), y: Math.round(b.top + b.height/2) }; })()`);
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx.x, y: bx.y, button: 'left' });
  await sleep(200);
  const btn = await js(`(() => { const b = document.querySelector('.row[data-id="${sid}"] .r-menu-btn');
    if (!b || getComputedStyle(b).display === 'none') return null; const r = b.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.cx, y: btn.cy, button: 'left' });
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await sleep(400);
  const row = await items();
  check('4 the ROW menu still carries the session actions', SESSION_ONLY.every(x => row.includes(x)), JSON.stringify(row));
  check('5 the two menus are genuinely different', row.length > term.length, `row ${row.length} vs terminal ${term.length}`);
  await snap('termmenu-dark-row.png');
  await escape();

  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(400);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  await sleep(450);
  check('6 same in light mode', (await items()).join('|') === term.join('|'), JSON.stringify(await items()));
  await snap('termmenu-light-terminal.png');

  await escape();
  await js(`(async()=>{
    const term=(await import('/js/ui/terminal.js')).__termForTest();term.select(0,0,1);
  })()`);
  for(const theme of ['dark','light']) {
    await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}')})()`);
    await cmd('Input.dispatchMouseEvent', { type:'mousePressed',x:pt.x,y:pt.y,button:'right',clickCount:1 });
    await cmd('Input.dispatchMouseEvent', { type:'mouseReleased',x:pt.x,y:pt.y,button:'right',clickCount:1 });await sleep(350);
    check(theme+' all four actions have safe matching SVG icons',await js(`document.querySelectorAll('.menu .menu-ic svg').length===4`));
    check(theme+' icon slots remain hidden from screen readers',await js(`Array.from(document.querySelectorAll('.menu .menu-ic')).every(e=>e.getAttribute('aria-hidden')==='true')`));
    await snap('termmenu-'+theme+'-icons.png');await escape();
  }
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  } finally {
    chrome?.kill();ctl?.close();cws?.close();await server?.close();
  }
  process.exitCode=fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
