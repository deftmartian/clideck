const test = require('node:test');
const assert = require('node:assert/strict');
const { ServerCapture } = require('../../src/fork/server-capture');

const loadFilter = () => import('../../public/js/terminal-replies.js');

test('browser reply filter blocks terminal reports without eating user input', async () => {
  const { isTerminalReply } = await loadFilter();
  for (const report of ['\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1bP>|xterm.js(6.1.0-beta.292)\x1b\\',
    '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[24;80R', '\x1b[0n', '\x1b[?2026;1$y',
    '\x1bP1$r0m\x1b\\', '\x1b]11;rgb:0000/0000/0000\x07']) assert.equal(isTerminalReply(report), true, JSON.stringify(report));
  for (const input of ['hello', '\r', '\x1b[A', '\x1b[1;5D', '\x1b[200~hello\x1b[201~',
    '>|xterm.js(6.0.0)', 'please explain \x1b[6n']) assert.equal(isTerminalReply(input), false, JSON.stringify(input));
});

test('headless owns each query response and snapshots never repeat version queries', async () => {
  const reports = [];
  const capture = new ServerCapture({ cols: 80, rows: 24, onReply: s => reports.push(s) });
  const { isTerminalReply } = await loadFilter();
  try {
    const text = 'ready\r\n\x1b[>0q\x1b[6n\x1b[c';
    await capture.write(text, text.length);
    assert.equal(reports.length, 3);
    assert.ok(reports.every(isTerminalReply));
    assert.ok(reports.some(reply => reply.includes('xterm.js(')));
    const snapshot = await capture.snapshot();
    assert.doesNotMatch(snapshot.data, /\x1b\[>0q/);
    assert.match(snapshot.data, /ready/);
    const restored = new ServerCapture({ cols: 80, rows: 24, onReply: s => reports.push(s) });
    try { await restored.write(snapshot.data, snapshot.data.length); } finally { restored.dispose(); }
    assert.equal(reports.length, 3);
  } finally { capture.dispose(); }
});
