const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

function terminal(context, cols = 40) {
  const term = new Terminal({ allowProposedApi: true, cols, rows: 5 });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  context.after(() => term.dispose());
  return term;
}
const write = (term, text) => new Promise(resolve => term.write(text, resolve));

test('common picker emojis occupy two cells and leave the cursor after the full glyph', async context => {
  const term = terminal(context);
  for (const emoji of ['😊', '🙏', '🚀', '👍', '🥰', '🤔', '✨', '✅']) {
    await write(term, '\r\x1b[2K' + emoji + 'X');
    const line = term.buffer.active.getLine(0);
    assert.equal(line.getCell(0).getChars(), emoji);
    assert.equal(line.getCell(0).getWidth(), 2);
    assert.equal(line.getCell(1).getWidth(), 0);
    assert.equal(line.getCell(2).getChars(), 'X');
    assert.equal(term.buffer.active.cursorX, 3);
  }
});

test('Unicode11 preserves ordinary text and documents its sequence limitations', async context => {
  const term = terminal(context);
  for (const [text, width] of [['abc', 3], ['中', 2], ['e\u0301', 1], ['אב', 2],
    ['❤️', 1], ['⚠️', 1], ['👩‍💻', 4]]) {
    await write(term, '\r\x1b[2K' + text);
    assert.equal(term.buffer.active.cursorX, width, text);
    assert.equal(term.buffer.active.getLine(0).translateToString(true), text);
  }
});

test('wide emoji wrapping, cursor edits and reset/replay preserve cell positions', async context => {
  const term = terminal(context, 5);
  await write(term, 'abcd😊X');
  assert.equal(term.buffer.active.getLine(0).translateToString(true), 'abcd');
  assert.equal(term.buffer.active.getLine(1).translateToString(true), '😊X');
  assert.equal(term.buffer.active.cursorX, 3);
  assert.equal(term.buffer.active.cursorY, 1);
  // Move over X, erase through the wide glyph, then redraw at its original column.
  await write(term, '\x1b[3D\x1b[K🙏Y');
  assert.equal(term.buffer.active.getLine(1).translateToString(true), '🙏Y');
  assert.equal(term.buffer.active.cursorX, 3);
  term.reset();
  assert.equal(term.unicode.activeVersion, '11');
  await write(term, 'abcd😊X');
  assert.equal(term.buffer.active.getLine(1).translateToString(true), '😊X');
  assert.equal(term.buffer.active.getLine(1).getCell(0).getWidth(), 2);
  assert.equal(term.buffer.active.cursorX, 3);
});
