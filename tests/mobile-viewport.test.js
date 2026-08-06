const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('mobile shell uses the dynamic viewport and protects bottom controls', () => {
  const index = read('public/index.html');
  const sourceCss = read('src/input.css');
  const builtCss = read('public/tailwind.css');

  assert.match(index, /height:\s*var\(--clideck-viewport-height,\s*100dvh\)/);
  assert.doesNotMatch(index, /<body[^>]*\bh-screen\b/);
  assert.match(
    index,
    /\.terminal-input-actions[\s\S]{0,180}bottom:\s*max\(70px,\s*calc\(60px \+ env\(safe-area-inset-bottom\)\)\)/,
  );
  assert.match(
    sourceCss,
    /\.tmx-jump-latest[\s\S]{0,180}bottom:\s*max\(70px,\s*calc\(60px \+ env\(safe-area-inset-bottom\)\)\)/,
  );
  assert.match(
    builtCss,
    /\.tmx-jump-latest\{[^}]*bottom:max\(70px,calc\(60px \+ env\(safe-area-inset-bottom\)\)\)/,
  );
});

test('one viewport controller owns mobile geometry changes', () => {
  const index = read('public/index.html');
  const viewport = read('public/js/viewport.js');
  const terminals = read('public/js/terminals.js');
  const prompts = read('public/js/prompts.js');
  const viewportOwners = fs.readdirSync(path.join(root, 'public/js'))
    .filter(file => file.endsWith('.js'))
    .filter(file => /visualViewport/.test(read(`public/js/${file}`)));

  assert.match(index, /interactive-widget=resizes-content/);
  assert.deepEqual(viewportOwners, ['viewport.js']);
  assert.match(viewport, /--clideck-viewport-height/);
  assert.match(viewport, /window\.addEventListener\('resize', scheduleViewportSync/);
  assert.match(viewport, /visualViewport\?\.addEventListener\('resize', scheduleViewportSync/);
  assert.match(viewport, /visualViewport\?\.addEventListener\('scroll', scheduleViewportSync/);
  assert.match(viewport, /isPinchZoomed\s*\?\s*layoutHeight/);
  assert.doesNotMatch(terminals, /visualViewport/);
  assert.doesNotMatch(prompts, /visualViewport/);
  assert.match(terminals, /syncViewport\(\)/);
  assert.match(prompts, /getViewportRect\(\)/);
  assert.match(prompts, /onViewportChange\(scheduleDropdownPosition\)/);
});

test('terminal loads the installed xterm beta line with accelerated rendering and a safe fallback', () => {
  const pkg = JSON.parse(read('package.json'));
  const index = read('public/index.html');
  const server = read('server.js');
  const terminals = read('public/js/terminals.js');
  const vendoredWebgl = read('public/addon-webgl.js');
  const installedWebgl = read('node_modules/@xterm/addon-webgl/lib/addon-webgl.js');

  for (const dependency of ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl']) {
    assert.match(pkg.dependencies[dependency], /-beta\.\d+$/);
  }
  assert.match(server, /'\/xterm\.css':\s+require\.resolve\('@xterm\/xterm\/css\/xterm\.css'\)/);
  assert.match(server, /'\/xterm\.js':\s+require\.resolve\('@xterm\/xterm\/lib\/xterm\.js'\)/);
  assert.match(server, /'\/addon-fit\.js':\s+require\.resolve\('@xterm\/addon-fit\/lib\/addon-fit\.js'\)/);
  assert.match(index, /<script src="\/addon-webgl\.js"><\/script>/);
  assert.equal(vendoredWebgl, installedWebgl);
  assert.match(terminals, /smoothScrollDuration:\s*180/);
  assert.match(terminals, /globalThis\.WebglAddon\?\.WebglAddon/);
  assert.match(terminals, /onContextLoss\(\(\) => \{[\s\S]{0,100}addon\.dispose\(\)/);
  assert.match(terminals, /catch \{[\s\S]{0,60}addon\?\.dispose\(\)/);
});

test('mobile composer owns predictive text until an explicit coherent send', () => {
  const index = read('public/index.html');
  const sourceCss = read('src/input.css');
  const builtCss = read('public/tailwind.css');
  const terminals = read('public/js/terminals.js');
  const composer = read('public/js/mobile-composer.js');
  const app = read('public/js/app.js');

  assert.match(index, /id="mobile-composer"[^>]*aria-hidden="true"/);
  assert.match(index, /id="mobile-composer-tools"[^>]*aria-expanded="false"/);
  assert.match(index, /id="mobile-composer-accessories"[^>]*aria-hidden="true"/);
  assert.match(index, /id="mobile-composer-text"[^>]*autocomplete="on"[^>]*autocorrect="on"/);
  assert.match(index, /id="mobile-composer-direct"[^>]*aria-pressed="false"/);
  assert.match(index, /id="mobile-composer-attach"/);
  assert.doesNotMatch(index, /id="mobile-composer-paste"/);
  assert.match(index, /id="mobile-composer-send"[^>]*disabled/);
  assert.match(index, /data-terminal-key="interrupt"/);
  assert.match(sourceCss, /--mobile-composer-height:\s*64px/);
  assert.match(sourceCss, /body\.mobile-composer-enabled \.term-wrap[\s\S]{0,100}var\(--mobile-composer-height\)/);
  assert.match(sourceCss, /body\.mobile-composer-enabled #tmx-toasts[\s\S]{0,100}var\(--mobile-composer-height\)/);
  assert.match(sourceCss, /body\.mobile-composer-expanded \.terminal-input-actions/);
  assert.match(sourceCss, /#mobile-composer\.tools-open \.mobile-composer-accessories/);
  assert.match(builtCss, /body\.mobile-composer-enabled \.term-wrap\{[^}]*--mobile-composer-height/);
  assert.match(terminals, /createMobileComposer\(\{/);
  assert.match(terminals, /term\.onData\(data => \{[\s\S]{0,120}mobileComposer\.ownsInput\(entry\)\) return/);
  assert.match(composer, /terminalTextarea\.disabled = composerOwnsInput/);
  assert.match(composer, /terminalTextarea\.readOnly = composerOwnsInput \|\| !!entry\.term\.options\.disableStdin/);
  assert.match(composer, /prepareComposerData\(draft, !!entry\.term\.modes\?\.bracketedPasteMode\)/);
  assert.match(composer, /return prepared/);
  assert.match(composer, /COMMIT_ENTER_DELAY_MS = 100/);
  assert.match(composer, /setTimeout\(\(\) => finishCommit\(transaction\), COMMIT_ENTER_DELAY_MS\)/);
  assert.match(composer, /sendTerminalData\(transaction\.id, '\\r'\)/);
  assert.match(composer, /interrupt:\s*'\\x03'/);
  assert.match(composer, /EDITOR_MAX_HEIGHT = 82/);
  assert.match(terminals, /distanceFromBottom[\s\S]{0,320}scrollToLine/);
  assert.doesNotMatch(terminals, /onMobileTerminalClick/);
  assert.doesNotMatch(terminals, /function commitMobileComposer/);
  assert.doesNotMatch(app, /getElementById\('mobile-composer-paste'\)/);
});

test('mobile Select mode owns drag only while armed and uses xterm public selection APIs', () => {
  const index = read('public/index.html');
  const sourceCss = read('src/input.css');
  const terminals = read('public/js/terminals.js');
  const selection = read('public/js/mobile-selection.js');
  const clipboard = read('public/js/terminal-clipboard.js');
  const touchScroll = read('public/js/mobile-touch-scroll.js');
  const trimClip = read('plugins/trim-clip/client.js');

  assert.match(index, /id="mobile-selection-toggle"[^>]*aria-pressed="false"/);
  assert.match(index, /id="mobile-selection-actions"[^>]*aria-hidden="true"/);
  assert.match(index, /id="mobile-selection-copy"[^>]*disabled/);
  assert.match(index, /id="mobile-selection-done"/);
  assert.match(sourceCss, /body\.mobile-selection-active \.term-wrap\.active \.xterm-screen[\s\S]{0,100}touch-action:\s*none/);
  assert.match(sourceCss, /body\.mobile-selection-active #mobile-selection-actions/);
  assert.match(selection, /term\.select\(startIndex % term\.cols, Math\.floor\(startIndex \/ term\.cols\), endIndex - startIndex \+ 1\)/);
  assert.match(selection, /buffer\.viewportY \+ viewportRow/);
  assert.match(selection, /addEventListener\('touchmove', onTouchMove, touchOptions\)/);
  assert.match(selection, /removeEventListener\('touchmove', onTouchMove, touchOptions\)/);
  assert.match(selection, /term\.getSelection\(\)/);
  assert.match(clipboard, /map\(line => line\.trimEnd\(\)\)/);
  assert.match(selection, /copyTrimmedTerminalSelection\(text, writeText\)/);
  assert.match(trimClip, /copyTrimmedTerminalSelection/);
  assert.match(touchScroll, /onTap\?\.\(id, term, screen, touch\)/);
  assert.match(terminals, /onTap:[\s\S]{0,160}activateTerminalLinkAtPoint/);
  assert.match(terminals, /new MouseEvent\('mousemove'/);
  assert.match(terminals, /screen\.classList\.contains\('xterm-cursor-pointer'\)/);
  assert.match(terminals, /linkHandler:\s*\{[\s\S]{0,100}openTerminalLink/);
  assert.match(terminals, /mobileSelection\.attach\(id, term, el\)/);
  assert.match(terminals, /mobileSelection\.detach\(id\)/);
});

test('mobile shell exposes a safe-area-aware explicit refresh control', () => {
  const index = read('public/index.html');
  const pwa = read('public/js/pwa.js');

  assert.match(index, /id="mobile-page-reload"[^>]*aria-label="Refresh CliDeck"/);
  assert.match(index, /#mobile-nav-toggle,\s*#mobile-page-reload,\s*#mobile-nav-close[\s\S]{0,160}display:\s*inline-flex/);
  assert.match(index, /#mobile-nav-toggle,\s*#mobile-page-reload\s*\{[\s\S]{0,180}safe-area-inset-top/);
  assert.match(index, /#mobile-page-reload\s*\{\s*left:\s*60px;\s*\}/);
  assert.match(index, /#connection-banner\s*\{[\s\S]{0,100}safe-area-inset-top/);
  assert.match(pwa, /getElementById\(['"]mobile-page-reload['"]\)/);
  assert.match(
    pwa,
    /pageReloadButton\?\.addEventListener\(['"]click['"],\s*\(\)\s*=>\s*\{\s*window\.location\.reload\(\)/,
  );
});
