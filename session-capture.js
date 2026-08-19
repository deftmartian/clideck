const { MENU_LINES, SCROLLBACK_LINES } = require('./server-capture');

function createSessionCapture({
  getSession,
  transcript,
  telemetry,
  plugins,
  menuStartsWork,
  broadcast,
  input,
}) {
  function clearActivityTimer(session) {
    clearTimeout(session?._activityTimer);
    if (session) session._activityTimer = null;
  }

  function emitActivity(id, session) {
    if (getSession(id) !== session) return;
    const now = Date.now();
    const elapsed = now - (session._activitySentAt || 0);
    if (elapsed < 1000) {
      if (!session._activityTimer) {
        session._activityTimer = setTimeout(() => {
          session._activityTimer = null;
          emitActivity(id, session);
        }, 1000 - elapsed);
        session._activityTimer.unref?.();
      }
      return;
    }
    session._activitySentAt = now;
    broadcast({
      type: 'session.activity', id,
      generation: session.outputGeneration,
      atSeq: session.outputSeq,
      timestamp: new Date(now).toISOString(),
    });
  }

  function schedule(id, delay = 0, options = {}) {
    const session = getSession(id);
    if (!session) return;
    clearTimeout(session._captureTimer);
    session._captureTimer = setTimeout(() => capture(id, options), delay);
  }

  function mergeOptions(current, incoming) {
    if (!current) return { ...incoming };
    return {
      menuVersion: Math.max(Number(current.menuVersion) || 0, Number(incoming.menuVersion) || 0) || undefined,
      settled: !!current.settled || !!incoming.settled,
      atSeq: Math.max(Number(current.atSeq) || 0, Number(incoming.atSeq) || 0),
    };
  }

  async function capturePass(id, { menuVersion, settled, atSeq }) {
    const session = getSession(id);
    if (!session) return false;
    const captureRef = session.capture;
    const lines = await captureRef.lines({
      atSeq,
      limit: settled ? SCROLLBACK_LINES : MENU_LINES,
    });
    if (getSession(id) !== session || session.capture !== captureRef) return false;

    const rawChoices = transcript.detectMenu(lines.slice(-MENU_LINES), session.presetId);
    let choices = rawChoices;
    if (choices && session.presetId === 'codex') {
      const last = telemetry.getLastEvent(id);
      if (!last.startsWith('codex.sse_event:response.completed')) choices = null;
    }
    if (choices && session.presetId === 'claude-code' && menuVersion
      && (session._menuConsumedVersion || 0) >= menuVersion) choices = null;
    let key = choices ? JSON.stringify(choices) : '';
    if (choices && session.presetId === 'claude-code' && key === (session._resolvedMenuKey || '')) {
      choices = null;
      key = '';
    }
    const candidateLines = (choices || (rawChoices && session.presetId === 'claude-code'))
      ? transcript.stripMenu(lines, session.presetId)
      : lines;
    transcript.updateAgentCandidate(id, session.presetId, candidateLines);

    if (!session.working && session._finalizeOnIdle) {
      session._finalizeOnIdle = false;
      transcript.commitAgentCandidate(id, session.presetId);
    } else if (session._finalizeOnCapture && settled) {
      transcript.commitAgentCandidate(id, session.presetId);
    }
    if (choices && plugins.shouldAutoApproveMenu(id)) {
      setTimeout(() => input({ id, data: '\r' }), 500);
    }
    if (choices) transcript.commitAgentCandidate(id, session.presetId);
    if (key !== (session._menuKey || '')) {
      session._menuKey = key;
      session._menuStartsWork = menuStartsWork(session.presetId, !!menuVersion, session._finalizeOnCapture);
      broadcast({ type: 'session.menu', id, choices: choices || [] });
      if (choices) {
        if (session.presetId === 'claude-code' && menuVersion) session._menuActiveVersion = menuVersion;
        plugins.notifyMenu(id, choices);
        if (session.presetId === 'codex') telemetry.cancelCodexMenuPoll(id);
        broadcast({ type: 'session.status', id, working: false, source: 'menu' });
      }
    }

    const candidate = transcript.getAgentCandidate(id);
    const preview = String(candidate || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || '';
    if (preview && preview !== session.lastPreview) {
      session.lastPreview = preview;
      session.lastActivityAt = new Date().toISOString();
      broadcast({ type: 'session.preview', id, text: preview });
    }
    return true;
  }

  function capture(id, options = {}) {
    const session = getSession(id);
    if (!session) return Promise.resolve(false);
    const request = {
      ...options,
      settled: options.settled ?? !options.menuVersion,
      atSeq: Number.isSafeInteger(options.atSeq) ? options.atSeq : session.outputSeq,
    };
    const existing = session._captureFlight;
    if (existing) {
      if (existing.acceptingFollowup) {
        existing.followup = mergeOptions(existing.followup, request);
        return existing.promise;
      }
      return existing.promise.then(() => capture(id, request));
    }

    const flight = { acceptingFollowup: true, followup: null, promise: null };
    flight.promise = (async () => {
      let result = await capturePass(id, request);
      const followup = flight.followup;
      flight.followup = null;
      flight.acceptingFollowup = false;
      if (followup) result = await capturePass(id, followup);
      return result;
    })().finally(() => {
      if (session._captureFlight === flight) session._captureFlight = null;
    });
    session._captureFlight = flight;
    return flight.promise;
  }

  return { capture, clearActivityTimer, emitActivity, schedule };
}

module.exports = { createSessionCapture };
