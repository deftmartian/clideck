const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SNAPSHOT_BYTES,
  ServerCapture,
} = require('../server-capture');

async function screenAfter(data, options = {}) {
  const capture = new ServerCapture(options);
  await capture.write(data, String(data).length);
  const lines = await capture.lines();
  capture.dispose();
  return lines;
}

test('headless capture handles rewrites, erase/cursor sequences, wrapping, and Unicode', async () => {
  const lines = await screenAfter(
    'progress 1%\rprogress 99%\x1b[K\r\nalpha\x1b[2DXY\r\n界🙂abcdef',
    { cols: 8, rows: 5 },
  );
  assert.match(lines.join('\n'), /progress[\s\S]*99%/);
  assert.ok(lines.some(line => line.includes('alpXY')));
  assert.ok(lines.some(line => line.includes('界🙂')));
  assert.ok(lines.length > 3, 'narrow terminal should wrap content');
});

test('headless capture preserves alternate-screen state and resize reflow', async () => {
  const capture = new ServerCapture({ cols: 12, rows: 3 });
  await capture.write('primary\r\nline\x1b[?1049halt screen', 35);
  assert.ok((await capture.lines()).join('').includes('alt screen'));
  capture.resize(6, 4);
  const snapshot = await capture.snapshot();
  assert.equal(snapshot.cols, 6);
  assert.equal(snapshot.rows, 4);
  assert.equal(snapshot.atSeq, 35);
  assert.match(snapshot.data, /alt/);
  capture.dispose();
});

test('serialization is ordered, bounded, and never cut mid-sequence', async () => {
  const capture = new ServerCapture({ cols: 80, rows: 24 });
  let seq = 0;
  for (let index = 0; index < 1300; index += 1) {
    const data = `\x1b[3${index % 8}mrow-${String(index).padStart(4, '0')}-${'x'.repeat(120)}\x1b[0m\r\n`;
    seq += data.length;
    capture.write(data, seq);
  }
  const snapshot = await capture.snapshot(5000);
  assert.ok(snapshot.bytes <= MAX_SNAPSHOT_BYTES);
  assert.ok(snapshot.scrollback <= 1000);
  assert.equal(snapshot.atSeq, seq);
  const restored = new ServerCapture({ cols: snapshot.cols, rows: snapshot.rows });
  await restored.write(snapshot.data, snapshot.atSeq);
  const restoredLines = await restored.lines();
  assert.ok(restoredLines.some(line => line.includes('row-1299')));
  restored.dispose();
  capture.dispose();
});

test('terminal query replies are surfaced once through the adapter', async () => {
  const replies = [];
  const capture = new ServerCapture({ cols: 80, rows: 24, onReply: data => replies.push(data) });
  await capture.write('\x1b[6n\x1b[c', 7);
  assert.equal(replies.filter(reply => /R$/.test(reply)).length, 1, 'DSR produces one cursor response');
  assert.equal(replies.filter(reply => /c$/.test(reply)).length, 1, 'DA produces one device response');
  capture.dispose();
});
