// Real-browser recovery check. The server and PTY live under a throwaway HOME;
// the live CliDeck instance and real agent sessions are never touched.
//
//   npx playwright-core install firefox
//   npm run test:browser
//   npm run test:browser -- firefox

const { existsSync } = require('fs');
const { chromium, firefox } = require('playwright-core');
const { Sandbox } = require('./providers/sandbox');
const { Client } = require('./providers/client');

const requested = process.argv[2] || 'firefox';
const browserNames = requested === 'all' ? ['chromium', 'firefox'] : [requested];

function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function waitForAnimationFrames(page, count = 4) {
  await page.evaluate(frames => new Promise(resolve => {
    let remaining = frames;
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), count);
}

async function terminalText(page, sessionId) {
  return page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    if (!term) return '';
    const lines = [];
    const buffer = term.buffer.active;
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }, sessionId);
}

async function socketOpen(page) {
  return page.evaluate(async () => {
    const { state } = window.__clideckTest;
    return state.ws?.readyState === WebSocket.OPEN;
  });
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

async function waitForOutput(client, sessionId, marker, label) {
  await client.waitFor(
    msg => msg.type === 'output' && msg.id === sessionId && msg.data.includes(marker),
    { label },
  );
}

async function writeMarker(client, sessionId, marker) {
  const split = Math.floor(marker.length / 2);
  client.send({
    type: 'input',
    id: sessionId,
    // Keep the complete marker out of the echoed command line so duplicate
    // checks count terminal output, not shell input plus terminal output.
    data: `printf '%s%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}'\r`,
  });
  await waitForOutput(client, sessionId, marker, marker);
}

async function verifyTerminalQueryExactlyOnce(client, sessionId) {
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "process.stdin.setRawMode(true);let b='';process.stdin.on('data',d=>b+=d.toString('binary'));process.stdout.write('\\x1b[6n');setTimeout(()=>{console.log('\\nQUERY_'+'REPLY_COUNT_'+((b.match(/\\x1b\\[/g)||[]).length));process.exit(0)},500)"\r`,
  });
  await waitForOutput(client, sessionId, 'QUERY_REPLY_COUNT_1', 'one terminal query reply');
}

async function verifyClipboardActionsAfterCurrent(page, context, browserName, sessionId, marker) {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await waitFor(
    async () => (await page.locator('.plugin-btn[title="Trim & Copy"]').count()) === 1,
    `${browserName} Trim Clip plugin`,
  );
  const selectMarker = () => page.evaluate(({ id, value }) => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    if (!term || !buffer) return '';
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || '';
      const column = line.indexOf(value);
      if (column < 0) continue;
      term.select(column, index, value.length);
      term.focus();
      return term.getSelection();
    }
    return '';
  }, { id: sessionId, value: marker });

  const selected = await selectMarker();
  if (selected !== marker) throw new Error(`${browserName} could not select current terminal output`);
  await page.evaluate(() => navigator.clipboard.writeText('F8_SENTINEL'));
  await page.keyboard.press('F8');
  await waitFor(
    async () => (await page.evaluate(() => navigator.clipboard.readText())) === marker,
    `${browserName} F8 Trim Clip after current`,
  );

  await selectMarker();
  await page.evaluate(() => navigator.clipboard.writeText('CTRL_C_SENTINEL'));
  await page.keyboard.press('Control+KeyC');
  await waitFor(
    async () => (await page.evaluate(() => navigator.clipboard.readText())) === marker,
    `${browserName} Ctrl+C selection copy after current`,
  );

  await selectMarker();
  await page.locator('.term-wrap.active').dispatchEvent('contextmenu', {
    button: 2, clientX: 40, clientY: 40,
  });
  const copy = page.locator('.menu-action[data-action="copy"]');
  await waitFor(async () => copy.isVisible(), `${browserName} terminal context copy`);
  await page.evaluate(() => navigator.clipboard.writeText('CONTEXT_SENTINEL'));
  await copy.click();
  await waitFor(
    async () => (await page.evaluate(() => navigator.clipboard.readText())) === marker,
    `${browserName} context-menu copy after current`,
  );
}

async function verifyClipboardFallbackWithoutApi(page, browserName, sessionId, marker) {
  await page.evaluate(() => {
    globalThis.__clideckOriginalClipboard = navigator.clipboard;
    globalThis.__clideckFallbackCopy = { count: 0, value: '' };
    document.addEventListener('copy', () => {
      globalThis.__clideckFallbackCopy = {
        count: globalThis.__clideckFallbackCopy.count + 1,
        value: document.activeElement?.value || '',
      };
    }, true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });
  const selectMarker = () => page.evaluate(({ id, value }) => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    if (!term || !buffer) return '';
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || '';
      const column = line.indexOf(value);
      if (column < 0) continue;
      term.select(column, index, value.length);
      term.focus();
      return term.getSelection();
    }
    return '';
  }, { id: sessionId, value: marker });
  const copyCount = () => page.evaluate(() => globalThis.__clideckFallbackCopy.count);
  const expectCopy = async (before, label) => waitFor(async () => {
    const result = await page.evaluate(() => globalThis.__clideckFallbackCopy);
    return result.count === before + 1 && result.value === marker;
  }, `${browserName} ${label} without Clipboard API`);

  await selectMarker();
  let before = await copyCount();
  await page.keyboard.press('F8');
  await expectCopy(before, 'F8 Trim Clip');

  await selectMarker();
  before = await copyCount();
  await page.locator('.plugin-btn[title="Trim & Copy"]').click();
  await expectCopy(before, 'toolbar Trim Clip');

  await selectMarker();
  before = await copyCount();
  await page.keyboard.press('Control+KeyC');
  await expectCopy(before, 'Ctrl+C selection copy');

  await selectMarker();
  await page.locator('.term-wrap.active').dispatchEvent('contextmenu', {
    button: 2, clientX: 40, clientY: 40,
  });
  const copy = page.locator('.menu-action[data-action="copy"]');
  await waitFor(async () => copy.isVisible(), `${browserName} fallback terminal context copy`);
  before = await copyCount();
  await copy.click();
  await expectCopy(before, 'context-menu copy');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: globalThis.__clideckOriginalClipboard,
    });
  });
}

// An attached image is bracket-pasted into the shell as a bare path. Its echo
// can still be arriving when the next command is typed, so settle, clear the
// line, and prove the prompt is clean before moving on.
async function clearPromptAfterAttach(client, sessionId, label) {
  await new Promise(resolve => setTimeout(resolve, 750));
  client.send({ type: 'input', id: sessionId, data: '\u0003' });
  await writeMarker(client, sessionId, `${label}_${Date.now()}`);
}

function showTestToast(page, message) {
  return page.evaluate(async text => {
    const { showToast } = window.__clideckTest;
    showToast(text, { title: 'Probe', duration: 4000 });
  }, message);
}

async function setTouchUiModeFromSettings(page, mode) {
  await page.evaluate(value => {
    const select = document.getElementById('cfg-touch-ui-mode');
    if (!select) throw new Error('Touch controls setting is unavailable');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, mode);
}

async function touchUiState(page) {
  return page.evaluate(() => ({
    mode: document.getElementById('cfg-touch-ui-mode')?.value,
    stored: localStorage.getItem('clideck.touchUiMode'),
    capability: matchMedia('(hover: none) and (pointer: coarse)').matches,
    compactNavVisible: getComputedStyle(document.getElementById('mobile-nav-toggle')).display !== 'none',
    composerEnabled: document.body.classList.contains('mobile-composer-enabled'),
    composerHidden: document.getElementById('mobile-composer')?.getAttribute('aria-hidden'),
  }));
}

async function verifyProvisionalTerminalSize(page, browserName, { touch }) {
  const result = await page.evaluate(() => {
    const container = document.getElementById('terminals');
    return {
      estimate: window.__clideckTest.estimateSize(),
      width: container?.clientWidth,
      height: container?.clientHeight,
    };
  });
  const minimum = touch ? { cols: 20, rows: 5 } : { cols: 80, rows: 24 };
  if (
    result.estimate.cols < minimum.cols
    || result.estimate.rows < minimum.rows
    || result.estimate.cols > 500
    || result.estimate.rows > 300
    || (touch && result.width < 624 && result.estimate.cols >= 80)
  ) {
    throw new Error(`${browserName} provisional terminal size is wrong: ${JSON.stringify(result)}`);
  }
}

async function verifyTouchRendererLifecycle(page, browserName, primaryId, sessionIds) {
  const initial = await page.evaluate(async () => {
    const { state } = window.__clideckTest;
    return {
      sessions: state.terms.size,
      renderers: [...state.terms.values()].filter(entry => entry.term).length,
      webgl: document.querySelectorAll('.term-wrap[data-renderer="webgl"]').length,
    };
  });
  if (initial.sessions !== sessionIds.length || initial.renderers !== 1 || initial.webgl > 1) {
    throw new Error(`${browserName} touch renderer budget failed: ${JSON.stringify(initial)}`);
  }
  for (const sessionId of sessionIds.filter(id => id !== primaryId)) {
    await page.evaluate(async id => {
      const { select } = window.__clideckTest;
      select(id);
    }, sessionId);
    await waitFor(async () => page.evaluate(async id => {
      const { state } = window.__clideckTest;
      return !!state.terms.get(id)?.term
        && [...state.terms.values()].filter(entry => entry.term).length === 1;
    }, sessionId), `${browserName} single renderer while switching ten sessions`);
  }
  await page.evaluate(async id => {
    const { select } = window.__clideckTest;
    select(id);
  }, primaryId);
  await waitFor(() => page.evaluate(id => {
    const { state } = window.__clideckTest;
    return !!state.terms.get(id)?.term
      && [...state.terms.values()].filter(entry => entry.term).length === 1;
  }, primaryId), `${browserName} primary renderer remount`);
}

async function verifyInactiveUnread(page, browserName, client, primaryId, inactiveId) {
  const marker = `${browserName.toUpperCase()}_INACTIVE_${Date.now()}`;
  const split = Math.floor(marker.length / 2);
  client.messages.length = 0;
  client.send({
    type: 'input',
    id: inactiveId,
    data: `printf '%s%s\n' '${marker.slice(0, split)}' '${marker.slice(split)}'\r`,
  });
  await client.waitFor(
    message => message.type === 'session.activity' && message.id === inactiveId,
    { label: `${browserName} inactive activity` },
  );
  const unread = await waitFor(() => page.evaluate(id => {
    const entry = window.__clideckTest.state.terms.get(id);
    return entry?.unread && !entry.term && {
      latest: entry.latestActivitySeq,
      seen: entry.seenActivitySeq,
    };
  }, inactiveId), `${browserName} inactive unread state`);
  if (!Number.isSafeInteger(unread.latest) || unread.latest === unread.seen) {
    throw new Error(`${browserName} activity cursor did not advance unread state`);
  }

  await page.evaluate(id => window.__clideckTest.select(id), inactiveId);
  const rendered = await waitFor(async () => {
    const text = await terminalText(page, inactiveId);
    return text.includes(marker) ? text : '';
  }, `${browserName} inactive snapshot on selection`);
  if (count(rendered, marker) !== 1) throw new Error(`${browserName} duplicated inactive output`);
  const cleared = await page.evaluate(id => {
    const entry = window.__clideckTest.state.terms.get(id);
    return !entry.unread && entry.seenActivityGeneration === entry.latestActivityGeneration
      && entry.seenActivitySeq === entry.latestActivitySeq;
  }, inactiveId);
  if (!cleared) throw new Error(`${browserName} selection did not clear unread activity`);
  await page.evaluate(id => window.__clideckTest.select(id), primaryId);
}

async function setTranscriptQuery(page, query) {
  await page.evaluate(value => {
    const input = document.getElementById('search-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, query);
}

async function verifyTranscriptQuery(page, browserName, sessionId, query, label) {
  await setTranscriptQuery(page, query);
  await waitFor(() => page.evaluate(({ id, value }) => {
    const { state } = window.__clideckTest;
    const row = document.querySelector(`.group[data-id="${id}"]`);
    return state.transcriptCacheState === 'loaded'
      && state.terms.get(id)?.searchText?.includes(value)
      && row?.style.display !== 'none';
  }, { id: sessionId, value: query }), `${browserName} ${label} transcript filter`);
}

async function verifyRestartSnapshot(page, browserName, client, sessionId) {
  const before = await page.evaluate(id => window.__clideckPerfSnapshot().events
    .filter(event => event.name === 'terminalSnapshotComplete' && event.id === id).length, sessionId);
  client.messages.length = 0;
  client.send({ type: 'session.restart', id: sessionId, cols: 80, rows: 24 });
  const restarted = await client.waitFor(
    message => message.type === 'session.restarted' && message.id === sessionId,
    { label: `${browserName} restart acknowledgement` },
  );
  if (restarted.error) throw new Error(`${browserName} restart failed: ${restarted.error}`);
  await waitFor(() => page.evaluate(({ id, countBefore }) => {
    const events = window.__clideckPerfSnapshot().events;
    const snapshots = events.filter(event => event.name === 'terminalSnapshotComplete' && event.id === id).length;
    return snapshots === countBefore + 1 && window.__clideckTest.state.active === id;
  }, { id: sessionId, countBefore: before }), `${browserName} one restart snapshot`);

  client.messages.length = 0;
  client.subscribe(sessionId, { replay: 'snapshot' });
  await client.waitFor(
    message => message.type === 'session.subscribed' && message.id === sessionId,
    { label: `${browserName} producer restart subscription` },
  );
  const marker = `${browserName.toUpperCase()}_RESTARTED_${Date.now()}`;
  await writeMarker(client, sessionId, marker);
  const text = await waitFor(async () => {
    const current = await terminalText(page, sessionId);
    return current.includes(marker) ? current : '';
  }, `${browserName} output after restart`);
  if (count(text, marker) !== 1) throw new Error(`${browserName} duplicated output after restart`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await page.evaluate(id => window.__clideckPerfSnapshot().events
    .filter(event => event.name === 'terminalSnapshotComplete' && event.id === id).length, sessionId);
  if (after !== before + 1) {
    throw new Error(`${browserName} restart used ${after - before} snapshots`);
  }
}

async function verifyNarrowDesktopTouchUi(browser, baseUrl, browserName, sessionId, sessionIds, marker) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 844 },
    isMobile: false,
    hasTouch: false,
  });
  const page = await context.newPage();
  if (browserName === 'firefox') {
    // Playwright does not expose clipboard-read/write permissions for Firefox.
    // Keep the real Chromium integration check, and give Firefox a deterministic
    // Clipboard API so its keyboard/menu wiring and selected payload are still
    // exercised end to end.
    await page.addInitScript(() => {
      let value = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: async () => value,
          writeText: async text => { value = String(text); },
        },
      });
    });
  }
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '',
  }));
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(
      async () => (await terminalText(page, sessionId)).includes(marker),
      `${browserName} narrow-desktop replay`,
    );
    await verifyClipboardActionsAfterCurrent(page, context, browserName, sessionId, marker);
    await verifyClipboardFallbackWithoutApi(page, browserName, sessionId, marker);
    const initial = await touchUiState(page);
    if (
      initial.capability
      || !initial.compactNavVisible
      || initial.composerEnabled
      || initial.composerHidden !== 'true'
    ) {
      throw new Error(`${browserName} narrow desktop was misclassified: ${JSON.stringify(initial)}`);
    }
    await verifyProvisionalTerminalSize(page, browserName, { touch: false });

    const alternates = sessionIds.filter(id => id !== sessionId).slice(0, 4);
    for (const alternate of alternates) {
      await page.evaluate(id => window.__clideckTest.select(id), alternate);
      await waitFor(() => page.evaluate(id => {
        const { state } = window.__clideckTest;
        const renderers = [...state.terms.values()].filter(entry => entry.term).length;
        return !!state.terms.get(id)?.term && renderers <= 4;
      }, alternate), `${browserName} bounded desktop renderer switch`);
    }
    const afterEviction = await page.evaluate(primary => {
      const { state } = window.__clideckTest;
      return {
        primaryEvicted: !state.terms.get(primary)?.term,
        renderers: [...state.terms.values()].filter(entry => entry.term).length,
        perf: window.__clideckPerfSnapshot().renderers,
      };
    }, sessionId);
    if (!afterEviction.primaryEvicted || afterEviction.renderers !== 4
      || afterEviction.perf.current !== 4 || afterEviction.perf.webgl > 4
      || afterEviction.perf.evictions < 1) {
      throw new Error(`${browserName} desktop LRU cap failed: ${JSON.stringify(afterEviction)}`);
    }

    const retainedId = alternates[2];
    await page.evaluate(id => {
      const entry = window.__clideckTest.state.terms.get(id);
      entry.term.__clideckRetainedProbe = true;
      window.__clideckTest.select(id);
    }, retainedId);
    const retained = await page.evaluate(id =>
      window.__clideckTest.state.terms.get(id)?.term?.__clideckRetainedProbe === true, retainedId);
    if (!retained) throw new Error(`${browserName} recent desktop renderer was not retained`);

    await page.evaluate(id => window.__clideckTest.select(id), sessionId);
    await waitFor(
      async () => (await terminalText(page, sessionId)).includes(marker),
      `${browserName} evicted desktop snapshot rehydration`,
    );
    const rehydrated = await page.evaluate(() => window.__clideckPerfSnapshot().renderers);
    if (rehydrated.current !== 4 || rehydrated.webgl > 4 || rehydrated.snapshotRehydrations < 1) {
      throw new Error(`${browserName} desktop rehydration diagnostics failed: ${JSON.stringify(rehydrated)}`);
    }

    await setTouchUiModeFromSettings(page, 'touch');
    await waitFor(async () => (await touchUiState(page)).composerEnabled,
      `${browserName} explicit touch override`);
    const forced = await touchUiState(page);
    if (forced.mode !== 'touch' || forced.stored !== 'touch') {
      throw new Error(`${browserName} touch override was not stored: ${JSON.stringify(forced)}`);
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(
      async () => (await terminalText(page, sessionId)).includes(marker),
      `${browserName} touch-override reload replay`,
    );
    const persisted = await touchUiState(page);
    if (!persisted.composerEnabled || persisted.mode !== 'touch' || persisted.stored !== 'touch') {
      throw new Error(`${browserName} touch override did not survive reload: ${JSON.stringify(persisted)}`);
    }

    await setTouchUiModeFromSettings(page, 'auto');
    await waitFor(async () => !(await touchUiState(page)).composerEnabled,
      `${browserName} narrow-desktop auto restore`);
    const restored = await touchUiState(page);
    if (restored.mode !== 'auto' || restored.stored !== null || !restored.compactNavVisible) {
      throw new Error(`${browserName} Auto mode did not restore desktop input: ${JSON.stringify(restored)}`);
    }
    if (errors.length) throw new Error(`${browserName} narrow-desktop errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function verifyTouchFirstDesktopOverride(page, browserName) {
  const initial = await touchUiState(page);
  if (!initial.capability || !initial.composerEnabled || initial.mode !== 'auto') {
    throw new Error(`${browserName} touch-first Auto mode failed: ${JSON.stringify(initial)}`);
  }

  await setTouchUiModeFromSettings(page, 'desktop');
  await waitFor(async () => !(await touchUiState(page)).composerEnabled,
    `${browserName} explicit desktop override`);
  const desktop = await touchUiState(page);
  if (desktop.stored !== 'desktop' || !desktop.compactNavVisible || desktop.composerHidden !== 'true') {
    throw new Error(`${browserName} Desktop override failed: ${JSON.stringify(desktop)}`);
  }

  await setTouchUiModeFromSettings(page, 'auto');
  await waitFor(async () => (await touchUiState(page)).composerEnabled,
    `${browserName} touch-first Auto restore`);
  const restored = await touchUiState(page);
  if (restored.stored !== null || restored.mode !== 'auto') {
    throw new Error(`${browserName} Auto mode was not restored: ${JSON.stringify(restored)}`);
  }
  // Both transitions intentionally request a terminal refit. Let those frames
  // settle before the viewport coalescing probe starts counting layout work.
  await waitForAnimationFrames(page);
}

// Every drawer control must be tappable: the row wraps rather than sliding
// under the composer editor, and no toast may sit on top of it.
async function verifyDrawerControlsReachable(page, browserName) {
  const toolsButton = page.locator('#mobile-composer-tools');
  await toolsButton.click();
  showTestToast(page, 'drawer overlap probe');
  // Measure the worst case: every optional control present, whatever this
  // browser happens to support today.
  const restoreHidden = await page.evaluate(() => {
    const optional = ['mobile-composer-install'];
    const previous = optional.map(id => [id, document.getElementById(id)?.hidden]);
    for (const id of optional) {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    }
    return previous;
  });
  const report = await page.evaluate(() => {
    const drawer = document.getElementById('mobile-composer-accessories');
    const editor = document.querySelector('.mobile-composer-editor');
    const toasts = document.getElementById('tmx-toasts');
    const editorBox = editor?.getBoundingClientRect();
    const toastBox = toasts?.firstElementChild ? toasts.getBoundingClientRect() : null;
    const overlaps = (a, b) => !!a && !!b
      && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const problems = [];
    for (const button of drawer.querySelectorAll('button')) {
      if (button.hidden || button.offsetParent === null) continue;
      const box = button.getBoundingClientRect();
      const label = button.id || button.textContent.trim();
      if (box.left < 0 || box.right > window.innerWidth) problems.push(`${label}:offscreen`);
      if (overlaps(box, editorBox)) problems.push(`${label}:under-editor`);
      if (overlaps(box, toastBox)) problems.push(`${label}:under-toast`);
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      if (hit && !button.contains(hit) && hit !== button) problems.push(`${label}:covered-by-${hit.id || hit.className || hit.tagName}`);
    }
    return problems;
  });
  await page.evaluate(previous => {
    for (const [id, hidden] of previous) {
      const el = document.getElementById(id);
      if (el && hidden !== undefined) el.hidden = hidden;
    }
  }, restoreHidden);
  if (report.length) {
    throw new Error(`${browserName} drawer controls are not tappable: ${report.join(', ')}`);
  }
  await toolsButton.click();
}

async function verifyMobileReloadControl(page, browserName, sessionId, marker) {
  const reloadButton = page.locator('#mobile-page-reload');
  if (!(await reloadButton.isVisible())) {
    throw new Error(`${browserName} mobile reload control is not visible`);
  }
  const box = await reloadButton.boundingBox();
  if (!box || box.width < 40 || box.height < 40 || box.x < 0 || box.y < 0) {
    throw new Error(`${browserName} mobile reload control is outside the usable viewport`);
  }

  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    reloadButton.click(),
  ]);
  await waitFor(
    async () => (await terminalText(page, sessionId)).includes(marker),
    `${browserName} explicit page reload`,
  );
  await waitFor(() => socketOpen(page), `${browserName} socket after explicit page reload`);
}

async function verifyMobileComposer(page, browserName, client, sessionId) {
  const composer = page.locator('#mobile-composer');
  const textarea = page.locator('#mobile-composer-text');
  const sendButton = page.locator('#mobile-composer-send');
  const toolsButton = page.locator('#mobile-composer-tools');
  const accessories = page.locator('#mobile-composer-accessories');
  const directButton = page.locator('#mobile-composer-direct');
  if (!(await composer.isVisible()) || !(await textarea.isVisible()) || !(await toolsButton.isVisible())) {
    throw new Error(`${browserName} mobile composer is not visible`);
  }
  if (await accessories.isVisible()) throw new Error(`${browserName} terminal keys start expanded`);
  const initial = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    return {
      terminalReadOnly: entry?.term?.textarea?.readOnly,
      terminalInputMode: entry?.term?.textarea?.getAttribute('inputmode'),
      composerEnabled: document.body.classList.contains('mobile-composer-enabled'),
    };
  }, sessionId);
  if (!initial.composerEnabled || !initial.terminalReadOnly || initial.terminalInputMode !== 'none') {
    throw new Error(`${browserName} xterm still owns mobile IME input: ${JSON.stringify(initial)}`);
  }

  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const ws = state.ws;
    const originalSend = ws.send.bind(ws);
    globalThis.__clideckComposerFrames = [];
    ws.send = data => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'input' && message.id === id) {
          globalThis.__clideckComposerFrames.push({ ...message, sentAt: performance.now() });
        }
      } catch {}
      return originalSend(data);
    };
  }, sessionId);

  const marker = `${browserName.toUpperCase()}_COMPOSER_${Date.now()}`;
  const command = `printf '${marker}\\n'`;
  await textarea.fill(command);
  const beforeSend = await page.evaluate(() => globalThis.__clideckComposerFrames.length);
  if (beforeSend !== 0) {
    throw new Error(`${browserName} composer leaked draft input before Send`);
  }
  await sendButton.click();
  await waitForOutput(client, sessionId, marker, `${browserName} composer output`);
  // The shell echoes the bracketed paste before the delayed Enter frame is
  // sent, so terminal output alone does not prove the commit finished.
  await waitFor(
    async () => (await page.evaluate(() => globalThis.__clideckComposerFrames?.length)) === 2,
    `${browserName} composer Enter frame`,
  );
  const sent = await page.evaluate(() => ({
    frames: globalThis.__clideckComposerFrames,
    draft: document.getElementById('mobile-composer-text')?.value,
  }));
  if (sent.frames.length !== 2 || !sent.frames[0].data.includes(command)
    || !sent.frames[0].data.startsWith('\x1b[200~')
    || !sent.frames[0].data.endsWith('\x1b[201~')
    || sent.frames[1].data !== '\r'
    || sent.frames[1].sentAt - sent.frames[0].sentAt < 75) {
    throw new Error(`${browserName} composer did not send coherent text followed by Enter: ${JSON.stringify(sent.frames)}`);
  }
  if (sent.draft !== '') throw new Error(`${browserName} composer did not clear after Send`);

  await page.evaluate(() => { globalThis.__clideckComposerFrames = []; });
  const rowsBeforeTools = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.rows;
  }, sessionId);
  await toolsButton.click();
  if (!(await accessories.isVisible())) throw new Error(`${browserName} terminal keys did not open`);
  const toolsState = await page.evaluate(() => ({
    expanded: document.getElementById('mobile-composer-tools')?.getAttribute('aria-expanded'),
    rows: document.querySelector('.term-wrap.active')?.clientHeight,
  }));
  if (toolsState.expanded !== 'true') throw new Error(`${browserName} terminal keys have stale ARIA state`);
  await page.locator('[data-terminal-key="interrupt"]').click();
  const controlFrames = await page.evaluate(() => globalThis.__clideckComposerFrames);
  if (controlFrames.length !== 1 || controlFrames[0].data !== '\x03') {
    throw new Error(`${browserName} terminal key did not send the real control byte: ${JSON.stringify(controlFrames)}`);
  }
  const rowsAfterTools = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.rows;
  }, sessionId);
  if (rowsAfterTools !== rowsBeforeTools) {
    throw new Error(`${browserName} opening terminal keys resized xterm`);
  }
  await toolsButton.click();

  await textarea.fill('one\ntwo\nthree\nfour');
  const expanded = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      composerHeight: document.getElementById('mobile-composer')?.getBoundingClientRect().height,
      editorHeight: document.getElementById('mobile-composer-text')?.getBoundingClientRect().height,
      expanded: document.body.classList.contains('mobile-composer-expanded'),
      rows: state.terms.get(id)?.term?.rows,
    };
  }, sessionId);
  if (!expanded.expanded || expanded.editorHeight <= 44 || expanded.editorHeight > 82
    || expanded.composerHeight > 66 || expanded.rows !== rowsBeforeTools) {
    throw new Error(`${browserName} composer expansion changed terminal geometry: ${JSON.stringify(expanded)}`);
  }

  await textarea.fill('draft survives direct mode');
  await toolsButton.click();
  await directButton.click();
  const direct = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    return {
      terminalReadOnly: entry?.term?.textarea?.readOnly,
      terminalDisabled: entry?.term?.textarea?.disabled,
      pressed: document.getElementById('mobile-composer-direct')?.getAttribute('aria-pressed'),
      draft: document.getElementById('mobile-composer-text')?.value,
    };
  }, sessionId);
  if (direct.terminalReadOnly || direct.terminalDisabled || direct.pressed !== 'true'
    || direct.draft !== 'draft survives direct mode') {
    throw new Error(`${browserName} direct-mode transition lost state: ${JSON.stringify(direct)}`);
  }
  await toolsButton.click();
  await directButton.click();
  const restored = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    const editor = document.getElementById('mobile-composer-text');
    return {
      terminalReadOnly: entry?.term?.textarea?.readOnly,
      terminalDisabled: entry?.term?.textarea?.disabled,
      pressed: document.getElementById('mobile-composer-direct')?.getAttribute('aria-pressed'),
      draft: editor?.value,
      editorDisabled: editor?.disabled,
    };
  }, sessionId);
  if (!restored.terminalReadOnly || !restored.terminalDisabled || restored.pressed !== 'false'
    || restored.draft !== 'draft survives direct mode' || restored.editorDisabled) {
    throw new Error(`${browserName} composer-mode restore failed: ${JSON.stringify(restored)}`);
  }
  await textarea.fill('');
  await textarea.evaluate(editor => editor.blur());
  await page.locator('.term-wrap.active .xterm-screen').evaluate(screen => {
    screen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  const terminalTapFocusedComposer = await page.evaluate(
    () => document.activeElement?.id === 'mobile-composer-text',
  );
  if (terminalTapFocusedComposer) {
    throw new Error(`${browserName} terminal history tap opened the composer keyboard`);
  }
  const terminalFocusGuard = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    const terminalTextarea = entry?.term?.textarea;
    const screen = entry?.el?.querySelector('.xterm-screen');
    const beforeY = entry?.term?.buffer.active.viewportY;
    let focusEvents = 0;
    terminalTextarea?.addEventListener('focus', () => { focusEvents += 1; });
    entry?.term?.focus();
    screen?.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
    }));
    return {
      activeClass: document.activeElement?.className || '',
      composerFocused: document.activeElement?.id === 'mobile-composer-text',
      disabled: terminalTextarea?.disabled,
      focusEvents,
      beforeY,
      afterY: entry?.term?.buffer.active.viewportY,
    };
  }, sessionId);
  if (!terminalFocusGuard.disabled || terminalFocusGuard.focusEvents !== 0
    || terminalFocusGuard.composerFocused
    || String(terminalFocusGuard.activeClass).includes('xterm-helper-textarea')
    || terminalFocusGuard.afterY !== terminalFocusGuard.beforeY) {
    throw new Error(`${browserName} xterm focus guard failed: ${JSON.stringify(terminalFocusGuard)}`);
  }
}

async function verifyDirectModeLinkTap(page, browserName, client, sessionId, cdp) {
  const url = 'https://example.com/clideck-mobile-osc8';
  const label = 'MOBILE_OSC8_LINK';
  client.send({
    type: 'input',
    id: sessionId,
    data: `printf '\\033]8;;${url}\\033\\\\${label}\\033]8;;\\033\\\\\\n'\r`,
  });
  await waitForOutput(client, sessionId, label, `${browserName} OSC 8 link output`);
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
    globalThis.__clideckOpenedLinks = [];
    globalThis.__clideckOriginalOpen = window.open;
    window.open = (...args) => {
      globalThis.__clideckOpenedLinks.push(args);
      return { opener: 'set' };
    };
  }, sessionId);

  const toolsButton = page.locator('#mobile-composer-tools');
  const directButton = page.locator('#mobile-composer-direct');
  await toolsButton.click();
  await directButton.click();
  const point = await page.evaluate(async ({ id, targetLabel }) => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    const term = entry?.term;
    const screen = entry?.el?.querySelector('.xterm-screen');
    if (!term || !screen) return null;
    const buffer = term.buffer.active;
    const first = buffer.viewportY;
    const last = Math.min(buffer.length, first + term.rows);
    for (let row = last - 1; row >= first; row -= 1) {
      const text = buffer.getLine(row)?.translateToString(true) || '';
      const column = text.indexOf(targetLabel);
      if (column < 0) continue;
      const rect = screen.getBoundingClientRect();
      return {
        x: rect.left + (column + 1.5) * rect.width / term.cols,
        y: rect.top + (row - first + 0.5) * rect.height / term.rows,
      };
    }
    return null;
  }, { id: sessionId, targetLabel: label });
  if (!point) throw new Error(`${browserName} OSC 8 terminal link is not visible for touch`);

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const opened = await waitFor(
    () => page.evaluate(() => globalThis.__clideckOpenedLinks?.length
      ? globalThis.__clideckOpenedLinks : null),
    `${browserName} direct-mode link tap`,
  );
  await new Promise(resolve => setTimeout(resolve, 250));
  const finalOpened = await page.evaluate(() => globalThis.__clideckOpenedLinks);
  if (opened.length !== 1 || finalOpened.length !== 1 || finalOpened[0][0] !== url
    || finalOpened[0][1] !== '_blank' || !finalOpened[0][2].includes('noopener')) {
    throw new Error(`${browserName} direct-mode link tap was not opened exactly once: ${JSON.stringify(finalOpened)}`);
  }

  await page.evaluate(() => {
    window.open = globalThis.__clideckOriginalOpen;
    delete globalThis.__clideckOriginalOpen;
    delete globalThis.__clideckOpenedLinks;
  });
  await toolsButton.click();
  await directButton.click();
}

async function verifyMobileSelection(page, browserName, client, sessionId, cdp = null) {
  const marker = `${browserName.toUpperCase()}_SELECT_READY_${Date.now()}`;
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "for(let n=0;n<90;n++)console.log('SELECT_ROW_'+n+' abcdefghijklmnopqrstuvwxyz');console.log('${marker}')"\r`,
  });
  await waitForOutput(client, sessionId, marker, `${browserName} selection output`);
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
    document.getElementById('mobile-composer-text')?.focus();
  }, sessionId);

  await page.locator('#mobile-composer-tools').click();
  await page.locator('#mobile-selection-toggle').click();
  const mode = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    return {
      active: document.body.classList.contains('mobile-selection-active'),
      pressed: document.getElementById('mobile-selection-toggle')?.getAttribute('aria-pressed'),
      actionsHidden: document.getElementById('mobile-selection-actions')?.getAttribute('aria-hidden'),
      composerFocused: document.activeElement?.id === 'mobile-composer-text',
      rows: term?.rows,
      viewportY: term?.buffer.active.viewportY,
    };
  }, sessionId);
  if (!mode.active || mode.pressed !== 'true' || mode.actionsHidden !== 'false' || mode.composerFocused) {
    throw new Error(`${browserName} selection mode did not arm cleanly: ${JSON.stringify(mode)}`);
  }

  let selectedText;
  if (cdp) {
    const box = await page.locator('.term-wrap.active .xterm-screen').boundingBox();
    if (!box) throw new Error(`${browserName} selection mode has no terminal touch target`);
    const startX = box.x + box.width * 0.18;
    const endX = box.x + box.width * 0.72;
    const y = box.y + box.height * 0.42;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
    });
    for (let step = 1; step <= 4; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + (endX - startX) * step / 4, y }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    selectedText = await waitFor(async () => page.evaluate(async id => {
      const { state } = window.__clideckTest;
      return state.terms.get(id)?.term?.getSelection() || '';
    }, sessionId), `${browserName} drag selection`);
  } else {
    selectedText = await page.evaluate(async id => {
      const { state } = window.__clideckTest;
      const term = state.terms.get(id)?.term;
      const buffer = term?.buffer.active;
      if (!term || !buffer) return '';
      let row = buffer.viewportY;
      for (let index = buffer.viewportY; index < buffer.length; index += 1) {
        if (buffer.getLine(index)?.translateToString(true).includes('SELECT_ROW_')) {
          row = index;
          break;
        }
      }
      term.select(0, row, 18);
      return term.getSelection();
    }, sessionId);
  }

  const selected = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    return {
      text: term?.getSelection(),
      copyDisabled: document.getElementById('mobile-selection-copy')?.disabled,
      rows: term?.rows,
      viewportY: term?.buffer.active.viewportY,
    };
  }, sessionId);
  if (!selectedText || !selected.text || selected.copyDisabled
    || selected.rows !== mode.rows || selected.viewportY !== mode.viewportY) {
    throw new Error(`${browserName} selection drag changed scrolling or selected nothing: ${JSON.stringify(selected)}`);
  }

  if (cdp) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copySource = await page.evaluate(async id => {
      const { state } = window.__clideckTest;
      const term = state.terms.get(id)?.term;
      const buffer = term?.buffer.active;
      if (!term || !buffer) return '';
      let row = Math.max(buffer.viewportY, buffer.length - 2);
      for (let index = buffer.viewportY; index < buffer.length; index += 1) {
        if (buffer.getLine(index)?.translateToString(true).includes('SELECT_ROW_')) {
          row = index;
          break;
        }
      }
      term.select(0, row, term.cols * 2);
      return term.getSelection();
    }, sessionId);
    const expectedCopy = await page.evaluate(async source => {
      const { trimTerminalSelection } = window.__clideckTest;
      return trimTerminalSelection(source);
    }, copySource);
    await waitFor(
      async () => !(await page.locator('#mobile-selection-copy').isDisabled()),
      `${browserName} trimmed copy selection`,
    );
    await page.locator('#mobile-selection-copy').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!copySource || copied !== expectedCopy || /[ \t]+$/m.test(copied)
      || copied.startsWith('\n') || copied.endsWith('\n')) {
      throw new Error(`${browserName} copied selection was not whitespace-trimmed: ${JSON.stringify({ copySource, copied })}`);
    }
  } else {
    await page.locator('#mobile-selection-done').click();
  }

  const finished = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      active: document.body.classList.contains('mobile-selection-active'),
      selection: state.terms.get(id)?.term?.getSelection(),
    };
  }, sessionId);
  if (finished.active || finished.selection) {
    throw new Error(`${browserName} selection mode did not restore normal terminal behavior`);
  }
}

async function verifyBottomActionClearance(page, browserName) {
  await waitFor(() => page.evaluate(() => {
    const actions = document.querySelector('.terminal-input-actions');
    const mic = document.querySelector('.terminal-input-action[data-plugin-id="voice-input"]');
    return !!mic && !actions?.classList.contains('is-hidden')
      && getComputedStyle(mic).display !== 'none';
  }), `${browserName} real voice-input action visible`);
  // Compare on-screen positions, not computed `bottom` values: the two
  // controls resolve `bottom` against different containing blocks
  // (.terminal-input-actions against #terminals, .tmx-jump-latest against the
  // composer-raised .term-wrap), so equal computed values can still render
  // the jump button far from the mic slot it is meant to take over.
  const geometry = await page.evaluate(() => {
    const inputActions = document.querySelector('.terminal-input-actions');
    const mic = document.querySelector('.terminal-input-action[data-plugin-id="voice-input"]');
    const jumpLatest = document.querySelector('.term-wrap.active .tmx-jump-latest');
    if (!inputActions || !mic || !jumpLatest) return null;
    // Measure both controls where they sit when shown: their hidden states
    // carry translateY/scale transforms that would skew the rects (the mic
    // container is hidden-empty when no plugin buttons are registered).
    for (const el of [inputActions, jumpLatest]) {
      el.style.transition = 'none';
      el.style.transform = 'none';
    }
    const viewportHeight = window.innerHeight;
    const wrap = jumpLatest.closest('.term-wrap').getBoundingClientRect();
    const jumpRect = jumpLatest.getBoundingClientRect();
    const result = {
      inputBottom: viewportHeight - inputActions.getBoundingClientRect().bottom,
      micBottom: viewportHeight - mic.getBoundingClientRect().bottom,
      jumpBottom: viewportHeight - jumpRect.bottom,
      jumpClipped: jumpRect.top < wrap.top - 1 || jumpRect.bottom > wrap.bottom + 1,
    };
    for (const el of [inputActions, jumpLatest]) {
      el.style.transition = '';
      el.style.transform = '';
    }
    return result;
  });
  if (!geometry) {
    throw new Error(`${browserName} bottom controls were not rendered`);
  }
  if (
    geometry.inputBottom < 64
    || Math.abs(geometry.inputBottom - geometry.micBottom) > 1
    || geometry.jumpBottom < 64
    || Math.abs(geometry.inputBottom - geometry.jumpBottom) > 2
    || geometry.jumpClipped
  ) {
    throw new Error(
      `${browserName} bottom controls enter the obscured composer band: ${JSON.stringify(geometry)}`,
    );
  }
}

async function verifyVisualViewportHeight(page, browserName, sessionId) {
  const initial = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const viewport = window.visualViewport;
    return {
      rows: state.terms.get(id)?.term?.rows || 0,
      innerHeight: window.innerHeight,
      appHeight: Number.parseFloat(
        document.documentElement.style.getPropertyValue('--clideck-viewport-height'),
      ),
      visual: {
        height: viewport?.height || window.innerHeight,
        width: viewport?.width || window.innerWidth,
        offsetTop: viewport?.offsetTop || 0,
        offsetLeft: viewport?.offsetLeft || 0,
        scale: viewport?.scale || 1,
      },
    };
  }, sessionId);
  const compactHeight = Math.max(
    320,
    Math.floor(Math.min(initial.innerHeight, initial.visual.height) - 244),
  );
  const pannedOffset = Math.min(80, Math.max(0, compactHeight - 320));

  await page.evaluate(async ({ id, visual }) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('visualViewport is unavailable');
    const { state: appState } = window.__clideckTest;
    const entry = appState.terms.get(id);
    if (!entry) throw new Error('active terminal is unavailable');
    const propertyNames = ['height', 'width', 'offsetTop', 'offsetLeft', 'scale'];
    const nativeDescriptors = Object.fromEntries(
      propertyNames.map(name => [name, Object.getOwnPropertyDescriptor(viewport, name)]),
    );
    const probe = {
      values: { ...visual },
      nativeDescriptors,
      writes: 0,
      fits: 0,
      entry,
    };
    window.__clideckViewportProbe = probe;
    for (const name of propertyNames) {
      Object.defineProperty(viewport, name, {
        configurable: true,
        get: () => probe.values[name],
      });
    }

    let stylePrototype = document.documentElement.style;
    while (
      stylePrototype
      && !Object.prototype.hasOwnProperty.call(stylePrototype, 'setProperty')
    ) {
      stylePrototype = Object.getPrototypeOf(stylePrototype);
    }
    probe.stylePrototype = stylePrototype;
    probe.setPropertyDescriptor = stylePrototype
      ? Object.getOwnPropertyDescriptor(stylePrototype, 'setProperty')
      : null;
    if (!probe.setPropertyDescriptor?.value) {
      throw new Error('CSS setProperty descriptor is unavailable');
    }
    const originalSetProperty = probe.setPropertyDescriptor.value;
    Object.defineProperty(stylePrototype, 'setProperty', {
      ...probe.setPropertyDescriptor,
      value(name, ...args) {
        if (this === document.documentElement.style && name === '--clideck-viewport-height') {
          probe.writes += 1;
        }
        return originalSetProperty.call(this, name, ...args);
      },
    });

    probe.fitDescriptor = Object.getOwnPropertyDescriptor(entry.fit, 'fit');
    probe.originalFit = entry.fit.fit;
    Object.defineProperty(entry.fit, 'fit', {
      configurable: true,
      writable: true,
      value(...args) {
        probe.fits += 1;
        return probe.originalFit.apply(this, args);
      },
    });

    window.__setClideckTestViewport = (patch = {}, eventCount = 1) => {
      Object.assign(probe.values, patch);
      probe.writes = 0;
      probe.fits = 0;
      for (let index = 0; index < eventCount; index += 1) {
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      }
    };
    window.__restoreClideckTestViewport = () => {
      for (const [name, descriptor] of Object.entries(probe.nativeDescriptors)) {
        if (descriptor) Object.defineProperty(viewport, name, descriptor);
        else delete viewport[name];
      }
      Object.defineProperty(
        probe.stylePrototype,
        'setProperty',
        probe.setPropertyDescriptor,
      );
      if (probe.fitDescriptor) Object.defineProperty(entry.fit, 'fit', probe.fitDescriptor);
      else delete entry.fit.fit;
      delete window.__setClideckTestViewport;
      delete window.__restoreClideckTestViewport;
      delete window.__clideckViewportProbe;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  }, { id: sessionId, visual: initial.visual });

  await page.evaluate(() => window.__setClideckTestViewport({}, 25));
  await waitForAnimationFrames(page);
  const unchanged = await page.evaluate(() => ({
    writes: window.__clideckViewportProbe.writes,
    fits: window.__clideckViewportProbe.fits,
  }));
  if (unchanged.writes !== 0 || unchanged.fits !== 0) {
    throw new Error(
      `${browserName} unchanged viewport events caused layout work: ${JSON.stringify(unchanged)}`,
    );
  }

  await page.evaluate(height => {
    window.__setClideckTestViewport({ height, offsetTop: 0, scale: 1 }, 25);
  }, compactHeight);
  await page.waitForFunction(
    expected => document.documentElement.style.getPropertyValue('--clideck-viewport-height') === `${expected}px`,
    compactHeight,
  );
  await page.waitForFunction(
    async ({ id, beforeRows }) => {
      const { state } = window.__clideckTest;
      return (state.terms.get(id)?.term?.rows || 0) < beforeRows;
    },
    { id: sessionId, beforeRows: initial.rows },
  );
  await waitForAnimationFrames(page);
  const changed = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      writes: window.__clideckViewportProbe.writes,
      fits: window.__clideckViewportProbe.fits,
      rows: state.terms.get(id)?.term?.rows || 0,
    };
  }, sessionId);
  if (changed.writes !== 1 || changed.fits !== 1) {
    throw new Error(
      `${browserName} viewport change was not coalesced: ${JSON.stringify(changed)}`,
    );
  }

  await page.evaluate(({ height, offsetTop }) => {
    window.__setClideckTestViewport({ height: height - offsetTop, offsetTop }, 25);
  }, { height: compactHeight, offsetTop: pannedOffset });
  await page.waitForFunction(async ({ top, bottom }) => {
    const { getViewportRect } = window.__clideckTest;
    const viewport = getViewportRect();
    return viewport.top === top && viewport.bottom === bottom;
  }, { top: pannedOffset, bottom: compactHeight });
  await waitForAnimationFrames(page);
  const panned = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      writes: window.__clideckViewportProbe.writes,
      fits: window.__clideckViewportProbe.fits,
      rows: state.terms.get(id)?.term?.rows || 0,
      bodyBottom: document.body.getBoundingClientRect().bottom,
    };
  }, sessionId);
  if (
    panned.writes !== 0
    || panned.fits !== 0
    || panned.rows !== changed.rows
    || Math.abs(panned.bodyBottom - compactHeight) > 1
  ) {
    throw new Error(
      `${browserName} equal-bottom viewport pan caused terminal work: ${JSON.stringify(panned)}`,
    );
  }

  const expectedBottom = compactHeight;
  const geometry = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const bounds = selector => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null;
    };
    return {
      body: bounds('body'),
      main: bounds('#main'),
      terminals: bounds('#terminals'),
      terminal: bounds('.term-wrap.active'),
      xterm: bounds('.term-wrap.active .xterm'),
      rows: state.terms.get(id)?.term?.rows || 0,
    };
  }, sessionId);
  for (const [name, bounds] of Object.entries(geometry)) {
    if (name === 'rows') continue;
    if (!bounds || bounds.bottom > expectedBottom + 1) {
      throw new Error(
        `${browserName} ${name} extends below the visual viewport: ${JSON.stringify(geometry)}`,
      );
    }
  }

  await page.evaluate(visual => {
    window.__setClideckTestViewport(visual, 25);
  }, initial.visual);
  await page.waitForFunction(
    expected => Math.abs(document.body.getBoundingClientRect().bottom - expected) <= 1,
    initial.appHeight,
  );
  await page.waitForFunction(async ({ id, rows }) => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.rows === rows;
  }, { id: sessionId, rows: initial.rows });
  await waitForAnimationFrames(page);

  await page.evaluate(height => {
    window.__setClideckTestViewport({
      height,
      offsetTop: 0,
      scale: 1.4,
    }, 25);
  }, compactHeight);
  await waitForAnimationFrames(page);
  const pinch = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const { getViewportRect } = window.__clideckTest;
    const viewport = getViewportRect();
    return {
      height: Number.parseFloat(
        document.documentElement.style.getPropertyValue('--clideck-viewport-height'),
      ),
      bodyBottom: document.body.getBoundingClientRect().bottom,
      rows: state.terms.get(id)?.term?.rows || 0,
      scale: viewport.scale,
      visualHeight: viewport.height,
      writes: window.__clideckViewportProbe.writes,
      fits: window.__clideckViewportProbe.fits,
    };
  }, sessionId);
  if (
    pinch.height !== initial.innerHeight
    || Math.abs(pinch.bodyBottom - initial.innerHeight) > 1
    || pinch.rows !== initial.rows
    || pinch.scale !== 1.4
    || pinch.visualHeight !== compactHeight
    || pinch.writes !== 0
    || pinch.fits !== 0
  ) {
    throw new Error(`${browserName} pinch zoom reflowed the terminal: ${JSON.stringify(pinch)}`);
  }

  await page.evaluate(() => window.__restoreClideckTestViewport());
  await page.waitForFunction(
    expected => Math.abs(document.body.getBoundingClientRect().bottom - expected) <= 1,
    initial.appHeight,
  );
}

async function verifyAcceleratedRenderer(page, browserName) {
  const result = await page.evaluate(() => {
    const el = document.querySelector('.term-wrap.active');
    const probe = document.createElement('canvas');
    return {
      renderer: el?.dataset.renderer || null,
      fallback: el?.dataset.rendererFallback || null,
      webgl2Supported: !!probe.getContext('webgl2'),
      canvasCount: el?.querySelectorAll('.xterm-screen canvas').length || 0,
    };
  });
  if (result.webgl2Supported && result.renderer !== 'webgl') {
    throw new Error(`${browserName} did not activate xterm's accelerated renderer: ${JSON.stringify(result)}`);
  }
  if (!result.webgl2Supported && (
    result.renderer !== 'dom'
    || result.fallback !== 'webgl-unavailable'
  )) {
    throw new Error(`${browserName} did not fall back safely without WebGL2: ${JSON.stringify(result)}`);
  }
  if (result.renderer === 'webgl' && result.canvasCount < 1) {
    throw new Error(`${browserName} accelerated renderer has no canvas`);
  }
  return result.renderer;
}

async function verifyStableRendererReconciliation(page, browserName, sessionId) {
  const result = await page.evaluate(async id => {
    const entry = window.__clideckTest.state.terms.get(id);
    const term = entry?.term;
    if (!entry?.reconcileRenderer || !term) return null;
    const originalResize = term.resize;
    let resizeCalls = 0;
    term.resize = function (...args) {
      resizeCalls += 1;
      return originalResize.apply(this, args);
    };
    term.select(0, term.buffer.active.viewportY, 1);
    const selectionBefore = term.getSelection();
    entry.reconcileRenderer();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const report = {
      resizeCalls,
      selectionBefore,
      selectionAfter: term.getSelection(),
    };
    term.resize = originalResize;
    term.clearSelection();
    return report;
  }, sessionId);
  if (!result || result.resizeCalls !== 0 || !result.selectionBefore
    || result.selectionAfter !== result.selectionBefore) {
    throw new Error(`${browserName} stable renderer reconciliation reflowed selection: ${JSON.stringify(result)}`);
  }
}

async function dispatchTouchDrag(page, cdp) {
  const box = await page.locator('.term-wrap.active .xterm-screen').boundingBox();
  if (!box) throw new Error('Chromium terminal has no touch target');

  const x = box.x + box.width / 2;
  const startY = box.y + box.height * 0.35;
  const endY = box.y + box.height * 0.75;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= 4; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: startY + (endY - startY) * step / 4 }],
    });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// Claude-style session: continuous streamed writes must not defeat or unwind
// a touch scroll into history.
async function verifyTouchScrollDuringStream(page, cdp, client, sessionId) {
  const endMarker = `CHROMIUM_STREAM_END_${Date.now()}`;
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "let n=0;console.log('\\n\\n\\n');const tick=()=>{process.stdout.write('\\u001b[3F\\u001b[J');console.log('TRANSCRIPT_'+(n++));console.log('UI_ROW_A');console.log('UI_ROW_B');console.log('UI_ROW_C')};const t=setInterval(tick,45);setTimeout(()=>{clearInterval(t);console.log('${endMarker}')},12000)"\r`,
  });
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer?.baseY > 0;
  }, sessionId), 'Chromium streaming scrollback');
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
  await dispatchTouchDrag(page, cdp);
  await page.waitForFunction(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer && buffer.viewportY < buffer.baseY;
  }, sessionId);
  await new Promise(resolve => setTimeout(resolve, 700));
  const held = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer ? buffer.baseY - buffer.viewportY : 0;
  }, sessionId);
  if (held <= 0) {
    throw new Error('Chromium touch scroll did not hold during streaming output');
  }
  await waitForOutput(client, sessionId, endMarker, 'Chromium stream end');
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
}

// Grok-style session: the app owns the mouse (SGR tracking on the alternate
// screen), so a touch drag must reach it as wheel reports, not die silently.
// This fake app deliberately moves three rows up but only one row down per
// report, proving that jump recovery is conservative rather than a fragile 1:1
// estimate of an application's private scroll position.
async function verifyTouchScrollWithMouseTracking(page, cdp, client, sessionId) {
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "let p=0;process.stdout.write('\\u001b[?1049h\\u001b[?1000h\\u001b[?1002h\\u001b[?1003h\\u001b[?1006hAPP_POS_0');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',d=>{const s=d.toString('latin1');if(s.includes('q')){process.stdout.write('\\u001b[?1006l\\u001b[?1003l\\u001b[?1002l\\u001b[?1000l\\u001b[?1049l');process.exit(0)}const before=p;let m,n=0;const wheel=/\\u001b\\[<6([45]);\\d+;\\d+M/g;while((m=wheel.exec(s))){p=m[1]==='4'?Math.min(999,p+3):Math.max(0,p-1);n++}if(n){const bottom=before>0&&p===0?' AT_BOTTOM_AFTER_JUMP':'';process.stdout.write('\\u001b[2J\\u001b[HAPP_POS_'+p+bottom+' RX['+s.replace(/\\u001b/g,'E')+']')}})"\r`,
  });
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.modes.mouseTrackingMode === 'any';
  }, sessionId), 'Chromium mouse-tracking mode');
  const sawWheelReport = waitForOutput(client, sessionId, 'E[<64;', 'Chromium touch wheel report');
  await dispatchTouchDrag(page, cdp);
  await sawWheelReport;
  await waitFor(async () => /APP_POS_[1-9]\d*/.test(await terminalText(page, sessionId)),
    'Chromium asymmetric app moved away from latest');
  const echoed = await terminalText(page, sessionId);
  if (echoed.includes('NaN')) {
    throw new Error('Chromium touch wheel reports carried NaN coordinates');
  }
  // The app owns this scrollback, so the jump-to-latest button must be driven
  // by the emitted wheel reports rather than xterm's (frozen) viewport.
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const btn = document.querySelector('.term-wrap.active .tmx-jump-latest');
    const actions = document.querySelector('.terminal-input-actions');
    const mic = document.querySelector('.terminal-input-action[data-plugin-id="voice-input"]');
    return (state.terms.get(id)?.appScrollDebt || 0) > 0
      && btn?.classList.contains('is-visible')
      && !!mic
      && actions?.classList.contains('is-hidden');
  }, sessionId), 'Chromium mouse-mode jump button visible');
  // Prompt submission is not proof that an arbitrary TUI returned to latest.
  // Let momentum settle, submit harmless input, and require the conservative
  // debt and mic-to-jump handoff to remain intact.
  await new Promise(resolve => setTimeout(resolve, 1300));
  const debtBeforeCommit = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.appScrollDebt || 0;
  }, sessionId);
  await page.locator('#mobile-composer-text').fill('x');
  await page.locator('#mobile-composer-send').click();
  await waitFor(async () => page.evaluate(async ({ id, expected }) => {
    const { state } = window.__clideckTest;
    const btn = document.querySelector('.term-wrap.active .tmx-jump-latest');
    const actions = document.querySelector('.terminal-input-actions');
    return document.getElementById('mobile-composer-text')?.value === ''
      && state.terms.get(id)?.appScrollDebt === expected
      && btn?.classList.contains('is-visible')
      && actions?.classList.contains('is-hidden');
  }, { id: sessionId, expected: debtBeforeCommit }),
  'Chromium prompt commit preserved uncertain app scrollback');
  const sawUnwind = waitForOutput(client, sessionId, 'E[<65;', 'Chromium jump unwind wheel reports');
  const reachedBottom = waitForOutput(client, sessionId, 'AT_BOTTOM_AFTER_JUMP',
    'Chromium conservative jump reached app bottom');
  await page.evaluate(() => document.querySelector('.term-wrap.active .tmx-jump-latest').click());
  await sawUnwind;
  await reachedBottom;
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const btn = document.querySelector('.term-wrap.active .tmx-jump-latest');
    const actions = document.querySelector('.terminal-input-actions');
    const mic = document.querySelector('.terminal-input-action[data-plugin-id="voice-input"]');
    return (state.terms.get(id)?.appScrollDebt || 0) === 0
      && !btn?.classList.contains('is-visible')
      && !!mic
      && !actions?.classList.contains('is-hidden');
  }, sessionId), 'Chromium mouse-mode jump button hidden after click');
  const focus = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      composer: document.activeElement?.id === 'mobile-composer-text',
      terminal: document.activeElement === state.terms.get(id)?.term?.textarea,
    };
  }, sessionId);
  if (focus.composer || focus.terminal) {
    throw new Error(`Chromium mouse-mode touch scroll opened a keyboard input: ${JSON.stringify(focus)}`);
  }
  // Let flick momentum decay fully before quitting the reader, so no wheel
  // reports land on the shell prompt afterwards.
  await new Promise(resolve => setTimeout(resolve, 1300));
  client.send({ type: 'input', id: sessionId, data: 'q' });
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.modes.mouseTrackingMode === 'none';
  }, sessionId), 'Chromium mouse-tracking reset');
  client.send({ type: 'input', id: sessionId, data: '\u0003' });
  await writeMarker(client, sessionId, `MOUSE_CLEAN_${Date.now()}`);
}

// Mouse tracking on the primary buffer (for example Grok --no-alt-screen).
// xterm would otherwise send wheel reports and freeze native scroll. The
// intercept must move viewportY and must not leak SGR wheel reports to the PTY.
async function verifyNativeWheelWithMouseTracking(page, client, sessionId, browserName) {
  const marker = `NATIVE_WHEEL_READY_${Date.now()}`;
  const markerSplit = Math.floor(marker.length / 2);
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "for(let n=0;n<120;n++)console.log('NATIVE_WHEEL_'+n);console.log('${marker.slice(0, markerSplit)}'+'${marker.slice(markerSplit)}')"\r`,
  });
  await waitForOutput(client, sessionId, marker, `${browserName} native-wheel scrollback`);
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return (state.terms.get(id)?.term?.buffer.active.baseY || 0) > 0;
  }, sessionId), `${browserName} native-wheel baseY`);
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "process.stdout.write('\\u001b[?1000h\\u001b[?1002h\\u001b[?1003h\\u001b[?1006hTRACK');process.stdin.setRawMode(true);process.stdin.resume();var seen=false;process.stdin.on('data',d=>{var s=d.toString('latin1');if(s.indexOf('q')>=0){process.stdout.write('\\u001b[?1006l\\u001b[?1003l\\u001b[?1002l\\u001b[?1000l');process.exit(0)}if(seen===false&&/\\x1b\\[<6[45];/.test(s)){seen=true;process.stdout.write('GOT_WHEEL\\n')}})"\r`,
  });
  await waitForOutput(client, sessionId, 'TRACK', `${browserName} native-wheel tracking on`);
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    return term
      && term.modes.mouseTrackingMode !== 'none'
      && buffer?.type === 'normal';
  }, sessionId), `${browserName} primary-buffer mouse tracking`);
  const before = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term.buffer.active;
    const smoothScrollDuration = term.options.smoothScrollDuration;
    term.options.smoothScrollDuration = 0;
    term.scrollToBottom();
    return {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      type: buffer.type,
      smoothScrollDuration,
    };
  }, sessionId);
  if (before.viewportY !== before.baseY || before.type === 'alternate') {
    throw new Error(`${browserName} native-wheel fixture was not at the primary-buffer bottom: ${JSON.stringify(before)}`);
  }
  await page.evaluate(() => {
    const screen = document.querySelector('.term-wrap.active .xterm-screen');
    if (!screen) throw new Error('active xterm screen is missing');
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -720,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  });
  const wheelHitsBefore = count(await terminalText(page, sessionId), 'GOT_WHEEL');
  await waitFor(async () => page.evaluate(async ({ id, viewportY }) => {
    const buffer = window.__clideckTest.state.terms.get(id)?.term?.buffer.active;
    return buffer && buffer.viewportY < viewportY;
  }, { id: sessionId, viewportY: before.viewportY }), `${browserName} native wheel moved viewport`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const wheelHitsAfter = count(await terminalText(page, sessionId), 'GOT_WHEEL');
  if (wheelHitsAfter > wheelHitsBefore) {
    throw new Error(`${browserName} leaked wheel reports to a primary-buffer mouse-tracking app`);
  }
  await page.evaluate(async ({ id, smoothScrollDuration }) => {
    const term = window.__clideckTest.state.terms.get(id)?.term;
    if (term) term.options.smoothScrollDuration = smoothScrollDuration;
  }, { id: sessionId, smoothScrollDuration: before.smoothScrollDuration });
  client.send({ type: 'input', id: sessionId, data: 'q' });
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return state.terms.get(id)?.term?.modes.mouseTrackingMode === 'none';
  }, sessionId), `${browserName} native-wheel mouse-tracking reset`);
  client.send({ type: 'input', id: sessionId, data: '\u0003' });
  await writeMarker(client, sessionId, `NATIVE_WHEEL_CLEAN_${Date.now()}`);
  await page.evaluate(async id => {
    window.__clideckTest.state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
}

// Scrolling the terminal is reading, not typing: a vertical drag must drop
// the composer keyboard.
async function verifyScrollDismissesKeyboard(page, cdp, sessionId) {
  await page.evaluate(() => document.getElementById('mobile-composer-text').focus());
  const focused = await page.evaluate(() => document.activeElement?.id === 'mobile-composer-text');
  if (!focused) throw new Error('Chromium composer textarea did not take focus');
  await dispatchTouchDrag(page, cdp);
  await waitFor(
    async () => page.evaluate(() => document.activeElement?.id !== 'mobile-composer-text'),
    'Chromium terminal drag composer blur',
  );
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
}

// Drawer keys are for keyboard-less navigation: they must keep focus if the
// keyboard is up and never summon it otherwise.
async function verifyDrawerKeysKeepKeyboardState(page, browserName) {
  const toolsButton = page.locator('#mobile-composer-tools');
  await toolsButton.click();
  const key = page.locator('[data-terminal-key]').first();
  if (!(await key.isVisible())) {
    throw new Error(`${browserName} terminal key drawer did not open`);
  }
  await page.evaluate(() => document.getElementById('mobile-composer-text').blur());
  await key.click();
  if (await page.evaluate(() => document.activeElement?.id === 'mobile-composer-text')) {
    throw new Error(`${browserName} drawer key summoned the keyboard`);
  }
  await page.evaluate(() => document.getElementById('mobile-composer-text').focus());
  await key.click();
  if (!(await page.evaluate(() => document.activeElement?.id === 'mobile-composer-text'))) {
    throw new Error(`${browserName} drawer key dropped an open keyboard`);
  }
  await page.evaluate(() => document.getElementById('mobile-composer-text').blur());
  await toolsButton.click();
}

// The drawer's Attach control feeds the clipboard-image pipeline: the saved
// path must be bracket-pasted into the session like a desktop image paste.
async function verifyMobileAttachImage(page, browserName, client, sessionId) {
  const toolsButton = page.locator('#mobile-composer-tools');
  await toolsButton.click();
  const attach = page.locator('#mobile-composer-attach');
  if (!(await attach.isVisible())) {
    throw new Error(`${browserName} attach control is not visible`);
  }
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const outputBefore = client.outputText(sessionId).length;
  await page.setInputFiles('#mobile-composer-file', {
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  });
  await waitFor(
    () => client.outputText(sessionId).slice(outputBefore).includes('uploads'),
    `${browserName} attach path paste`,
  );
  await clearPromptAfterAttach(client, sessionId, `${browserName.toUpperCase()}_ATTACH_DONE`);
  await toolsButton.click();
}

// OSC 52 clipboard copies must come from live output only: replayed
// scrollback re-parses old sequences on reconnects and cold loads, and every
// replayed copy pops Android's clipboard chip.
async function verifyOsc52ReplaySafety(page, context, client, sessionId) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const marker = `OSC52_${Date.now()}`;
  client.send({
    type: 'input',
    id: sessionId,
    data: `printf '\\033]52;c;%s\\007' "$(printf '${marker}' | base64)" && printf 'OSC52_SENT\\n'\r`,
  });
  await waitForOutput(client, sessionId, 'OSC52_SENT', 'Chromium OSC52 emission');
  await waitFor(
    async () => (await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === marker,
    'Chromium live OSC52 clipboard copy',
  );
  await page.evaluate(() => navigator.clipboard.writeText('OSC52_SENTINEL'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(
    async () => (await terminalText(page, sessionId)).includes('OSC52_SENT'),
    'Chromium OSC52 scrollback replay',
  );
  await waitFor(() => socketOpen(page), 'Chromium socket after OSC52 reload');
  await new Promise(resolve => setTimeout(resolve, 800));
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  if (clip !== 'OSC52_SENTINEL') {
    throw new Error(`Chromium replay re-copied OSC52 content to the clipboard: ${JSON.stringify(clip)}`);
  }
}

// A half-typed draft survives reloads: phones discard tabs constantly and
// the update banner itself asks for one.
async function verifyComposerDraftPersistence(page, browserName, sessionId) {
  const textarea = page.locator('#mobile-composer-text');
  const draft = `DRAFT_${Date.now()} keep me`;
  await textarea.fill(draft);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => socketOpen(page), `${browserName} socket after draft reload`);
  await waitFor(
    async () => (await page.evaluate(() => document.getElementById('mobile-composer-text')?.value)) === draft,
    `${browserName} composer draft restore`,
  );
  await textarea.fill('');
}

// The install control appears only while a captured beforeinstallprompt is
// available and consumes it on tap.
async function verifyInstallAffordance(page, browserName) {
  if (await page.evaluate(() => !document.getElementById('mobile-composer-install').hidden)) {
    throw new Error(`${browserName} install control visible without a prompt`);
  }
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => Promise.resolve();
    window.dispatchEvent(event);
  });
  const toolsButton = page.locator('#mobile-composer-tools');
  await toolsButton.click();
  const install = page.locator('#mobile-composer-install');
  if (!(await install.isVisible())) {
    throw new Error(`${browserName} install control did not appear`);
  }
  await install.click();
  if (await page.evaluate(() => !document.getElementById('mobile-composer-install').hidden)) {
    throw new Error(`${browserName} install control did not consume the prompt`);
  }
  await toolsButton.click();
}

async function verifyTouchScrolling(page, cdp, client, sessionId) {
  const marker = `CHROMIUM_TOUCH_SCROLL_${Date.now()}`;
  const markerSplit = marker.length - 8;
  client.send({
    type: 'input',
    id: sessionId,
    data: `node -e "for(let n=0;n<160;n++)console.log('TOUCH_SCROLL_'+n);console.log('${marker.slice(0, markerSplit)}'+'${marker.slice(markerSplit)}')"\r`,
  });
  await waitForOutput(client, sessionId, marker, 'Chromium touch-scroll output');
  await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer?.baseY > 0;
  }, sessionId), 'Chromium terminal scrollback');
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
  const before = await waitFor(async () => page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer && buffer.viewportY === buffer.baseY
      ? { baseY: buffer.baseY, viewportY: buffer.viewportY }
      : null;
  }, sessionId), 'Chromium terminal bottom');
  const beforeRefit = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    const buffer = entry?.term?.buffer.active;
    if (!entry || !buffer) return null;
    const smoothScrollDuration = entry.term.options.smoothScrollDuration;
    entry.term.options.smoothScrollDuration = 0;
    entry.term.scrollLines(-12);
    const snapshot = {
      distanceFromBottom: buffer.baseY - buffer.viewportY,
      rows: entry.term.rows,
      smoothScrollDuration,
    };
    entry.el.style.bottom = '148px';
    return snapshot;
  }, sessionId);
  if (!beforeRefit || beforeRefit.distanceFromBottom <= 0) {
    throw new Error(`Chromium did not establish a scrollback anchor: ${JSON.stringify(beforeRefit)}`);
  }
  await page.waitForFunction(async ({ id, rows, distance }) => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    return term && buffer && term.rows < rows
      && buffer.baseY - buffer.viewportY === distance;
  }, { id: sessionId, rows: beforeRefit.rows, distance: beforeRefit.distanceFromBottom });
  await page.evaluate(async ({ id, smoothScrollDuration }) => {
    const { state } = window.__clideckTest;
    const entry = state.terms.get(id);
    entry?.el?.style.removeProperty('bottom');
    if (entry) entry.term.options.smoothScrollDuration = smoothScrollDuration;
  }, { id: sessionId, smoothScrollDuration: beforeRefit.smoothScrollDuration });
  await page.waitForFunction(async ({ id, rows, distance }) => {
    const { state } = window.__clideckTest;
    const term = state.terms.get(id)?.term;
    const buffer = term?.buffer.active;
    return term && buffer && term.rows === rows
      && buffer.baseY - buffer.viewportY === distance;
  }, { id: sessionId, rows: beforeRefit.rows, distance: beforeRefit.distanceFromBottom });
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
  await page.waitForFunction(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer && buffer.viewportY === buffer.baseY;
  }, sessionId);
  await dispatchTouchDrag(page, cdp);

  await page.waitForFunction(async ({ id, beforeYdisp }) => {
    const { state } = window.__clideckTest;
    return (state.terms.get(id)?.term?.buffer.active.viewportY ?? beforeYdisp) < beforeYdisp;
  }, { id: sessionId, beforeYdisp: before.viewportY });
  await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    state.terms.get(id)?.term?.scrollToBottom();
  }, sessionId);
  await page.waitForFunction(async id => {
    const { state } = window.__clideckTest;
    const buffer = state.terms.get(id)?.term?.buffer.active;
    return buffer && buffer.viewportY === buffer.baseY;
  }, sessionId);
  const inputFocus = await page.evaluate(async id => {
    const { state } = window.__clideckTest;
    return {
      composer: document.activeElement?.id === 'mobile-composer-text',
      terminal: document.activeElement === state.terms.get(id)?.term?.textarea,
    };
  }, sessionId);
  if (inputFocus.composer || inputFocus.terminal) {
    throw new Error(`Chromium touch scrolling opened a keyboard input: ${JSON.stringify(inputFocus)}`);
  }
}

async function run(browserName) {
  const engine = { chromium, firefox }[browserName];
  if (!engine) throw new Error(`Unsupported browser: ${browserName}`);

  const sandbox = new Sandbox();
  // Exercise the real floating microphone action in the isolated browser run.
  // No API key or audio backend is used; only the enabled client control loads.
  sandbox.seedConfig([], {
    pluginSettings: {
      'voice-input': { enabled: true, backend: 'openai' },
    },
  });
  const client = new Client();
  let browser;
  try {
    const port = await sandbox.start();
    client.port = port;
    await client.connect();
    await client.waitFor('config');

    const commandId = client.commandIdFor('shell');
    if (!commandId) throw new Error('Sandbox shell command is unavailable');
    client.send({
      type: 'create',
      commandId,
      name: `${browserName}-recovery`,
      cwd: sandbox.workDir(browserName),
      cols: 80,
      rows: 24,
    });
    const { id } = await client.waitFor('created');
    const base = `${browserName.toUpperCase()}_BASE_${Date.now()}`;
    await writeMarker(client, id, base);
    const sessionIds = [id];
    for (let index = 1; index < 10; index += 1) {
      client.send({
        type: 'create', commandId, name: `${browserName}-quiet-${index}`,
        cwd: sandbox.workDir(`${browserName}-quiet-${index}`), cols: 80, rows: 24,
      });
      const quiet = await client.waitFor(
        message => message.type === 'created' && message.name === `${browserName}-quiet-${index}`,
      );
      sessionIds.push(quiet.id);
    }
    client.messages.length = 0;
    client.subscribe(id, { replay: 'resume' });
    await client.waitFor(message => message.type === 'session.subscribed' && message.id === id);

    const executablePath = process.env.CLIDECK_BROWSER_PATH
      || (browserName === 'chromium' && existsSync('/usr/bin/chromium')
        ? '/usr/bin/chromium'
        : undefined);
    browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    await verifyNarrowDesktopTouchUi(
      browser,
      `http://127.0.0.1:${port}/?clideckPerf=1`,
      browserName,
      id,
      sessionIds,
      base,
    );
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '',
    }));
    const browserErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?clideckPerf=1`, { waitUntil: 'domcontentloaded' });
    await waitFor(
      async () => (await terminalText(page, id)).includes(base),
      `${browserName} initial replay`,
    );
    await verifyProvisionalTerminalSize(page, browserName, { touch: true });
    await verifyTranscriptQuery(page, browserName, id, base, 'initial');
    await setTranscriptQuery(page, '');
    await verifyTouchRendererLifecycle(page, browserName, id, sessionIds);
    await verifyInactiveUnread(page, browserName, client, id, sessionIds[1]);
    await verifyTerminalQueryExactlyOnce(client, id);
    await verifyTouchFirstDesktopOverride(page, browserName);
    await verifyBottomActionClearance(page, browserName);
    await verifyVisualViewportHeight(page, browserName, id);
    const renderer = await verifyAcceleratedRenderer(page, browserName);
    await verifyStableRendererReconciliation(page, browserName, id);
    await verifyMobileReloadControl(page, browserName, id, base);
    await verifyMobileComposer(page, browserName, client, id);

    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      await verifyDirectModeLinkTap(page, browserName, client, id, cdp);
      await verifyMobileSelection(page, browserName, client, id, cdp);
      await verifyTouchScrolling(page, cdp, client, id);
      await verifyTouchScrollDuringStream(page, cdp, client, id);
      await verifyTouchScrollWithMouseTracking(page, cdp, client, id);
      await verifyNativeWheelWithMouseTracking(page, client, id, browserName);
      await verifyScrollDismissesKeyboard(page, cdp, id);
      await verifyDrawerKeysKeepKeyboardState(page, browserName);
      await verifyMobileAttachImage(page, browserName, client, id);
      await verifyOsc52ReplaySafety(page, context, client, id);
      await verifyComposerDraftPersistence(page, browserName, id);
      await verifyInstallAffordance(page, browserName);
      await verifyDrawerControlsReachable(page, browserName);
      // Start from a known-clean prompt: earlier attach checks leave pasted
      // paths on the line if their echo lands late.
      client.send({ type: 'input', id, data: '\u0003' });
      await writeMarker(client, id, `CHROMIUM_PRE_FREEZE_${Date.now()}`);
      const lifecycleBefore = await page.evaluate(() => {
        const snapshot = window.__clideckPerfSnapshot();
        return {
          opens: snapshot.counters.healthySocketOpenCount || 0,
          syncs: snapshot.counters.terminalSyncStarted || 0,
        };
      });
      await page.evaluate(() => {
        globalThis.__clideckVisibilityState = 'hidden';
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => globalThis.__clideckVisibilityState,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      const frozen = `CHROMIUM_FROZEN_${Date.now()}`;
      await writeMarker(client, id, frozen);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await page.evaluate(() => {
        globalThis.__clideckVisibilityState = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const recovered = await waitFor(async () => {
        const text = await terminalText(page, id);
        return text.includes(frozen) ? text : '';
      }, 'Chromium frozen-page recovery');
      if (count(recovered, frozen) !== 1) {
        throw new Error('Chromium frozen output was duplicated');
      }
      const lifecycleAfter = await page.evaluate(() => {
        const snapshot = window.__clideckPerfSnapshot();
        return {
          opens: snapshot.counters.healthySocketOpenCount || 0,
          syncs: snapshot.counters.terminalSyncStarted || 0,
          recentSyncs: snapshot.events.filter(event => event.name === 'terminalSyncStarted').slice(-4),
        };
      });
      if (lifecycleAfter.opens !== lifecycleBefore.opens) {
        throw new Error('Chromium healthy foreground return opened another WebSocket');
      }
      if (lifecycleAfter.syncs !== lifecycleBefore.syncs + 1) {
        throw new Error(`Chromium foreground storm made ${lifecycleAfter.syncs - lifecycleBefore.syncs} subscriptions: ${JSON.stringify(lifecycleAfter.recentSyncs)}`);
      }
    } else {
      await verifyMobileSelection(page, browserName, client, id);
      await verifyNativeWheelWithMouseTracking(page, client, id, browserName);
      await verifyDrawerKeysKeepKeyboardState(page, browserName);
      await verifyMobileAttachImage(page, browserName, client, id);
      await verifyComposerDraftPersistence(page, browserName, id);
      await verifyInstallAffordance(page, browserName);
      await verifyDrawerControlsReachable(page, browserName);
    }

    await context.setOffline(true);
    await waitFor(async () => !(await socketOpen(page)), `${browserName} socket disconnect`);
    const missed = `${browserName.toUpperCase()}_MISSED_${Date.now()}`;
    await writeMarker(client, id, missed);
    await new Promise(resolve => setTimeout(resolve, 400));
    await setTranscriptQuery(page, missed);
    await context.setOffline(false);
    const recovered = await waitFor(async () => {
      const text = await terminalText(page, id);
      return text.includes(missed) ? text : '';
    }, `${browserName} offline recovery`);
    if (!recovered.includes(base)) throw new Error(`${browserName} lost existing scrollback`);
    if (count(recovered, missed) !== 1) throw new Error(`${browserName} duplicated recovered output`);
    await verifyTranscriptQuery(page, browserName, id, missed, 'reconnected');
    await setTranscriptQuery(page, '');
    const recoveryMs = await page.evaluate(() => {
      const events = window.__clideckPerfSnapshot().events;
      const opened = [...events].reverse().find(event => event.name === 'webSocketOpen');
      const painted = opened && events.find(event =>
        event.name === 'terminalCurrentPainted' && event.at >= opened.at);
      return painted ? painted.at - opened.at : null;
    });
    if (!Number.isFinite(recoveryMs) || recoveryMs > 500) {
      throw new Error(`${browserName} foreground terminal recovery used ${recoveryMs}ms after WebSocket open`);
    }

    await page.evaluate(() => {
      for (let index = 0; index < 12; index += 1) {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const storm = `${browserName.toUpperCase()}_STORM_${Date.now()}`;
    await writeMarker(client, id, storm);
    const afterStorm = await waitFor(async () => {
      const text = await terminalText(page, id);
      return text.includes(storm) ? text : '';
    }, `${browserName} lifecycle-storm recovery`);
    if (count(afterStorm, storm) !== 1) {
      throw new Error(`${browserName} duplicated output after lifecycle events`);
    }
    if (!(await socketOpen(page))) {
      throw new Error(`${browserName} WebSocket did not recover`);
    }

    await verifyRestartSnapshot(page, browserName, client, id);

    if (browserName === 'firefox') {
      // Close only the application socket. Firefox's Playwright offline
      // emulation may reload the page when network access is restored, which
      // would replace the guarded terminal before this assertion can inspect it.
      await page.evaluate(async () => {
        const { state } = window.__clideckTest;
        state.ws?.close(4001, 'buffer gap probe');
      });
      await waitFor(async () => !(await socketOpen(page)), 'Firefox gap socket disconnect');
      const gapDone = `FIREFOX_GAP_DONE_${Date.now()}`;
      client.send({
        type: 'input',
        id,
        data: `node -e "let n=0;const emit=()=>{if(n++<48){process.stdout.write('X'.repeat(65536));setTimeout(emit,3)}else{process.stdout.write('\\n${gapDone}\\n')}};emit()"\r`,
      });
      await waitForOutput(client, id, gapDone, 'Firefox buffer-gap output');
      if ((await terminalText(page, id)).includes(gapDone)) {
        throw new Error('Firefox received gap output while its application socket was disconnected');
      }
      const gapReport = await waitFor(() => page.evaluate(async ({ sessionId, marker }) => {
        const { state } = window.__clideckTest;
        if (state.protocolBlocked || state.ws?.readyState !== WebSocket.OPEN) return null;
        const buffer = state.terms.get(sessionId)?.term?.buffer.active;
        let markerCount = 0;
        for (let index = 0; buffer && index < buffer.length; index += 1) {
          const line = buffer.getLine(index)?.translateToString(true);
          if (line) markerCount += line.split(marker).length - 1;
        }
        return markerCount ? { markerCount } : null;
      }, { sessionId: id, marker: gapDone }), 'Firefox snapshot recovery after buffer gap');
      if (gapReport.markerCount !== 1) throw new Error('Firefox duplicated snapshot recovery output');
    }
    if (browserErrors.length) {
      throw new Error(`${browserName} browser errors: ${browserErrors.join(' | ')}`);
    }

    await context.close();
    const gapCheck = browserName === 'firefox' ? ', snapshot gap recovery' : '';
    const touchCheck = browserName === 'chromium' ? ', touch scrolling' : '';
    console.log(`${browserName}: ${renderer} renderer, composer auto-submit, mobile selection, recovery, scrollback${touchCheck}, lifecycle storm${gapCheck}, and protocol checks passed`);
  } finally {
    client.close();
    if (browser) await browser.close();
    await sandbox.cleanup();
  }
}

(async () => {
  for (const browserName of browserNames) await run(browserName);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
