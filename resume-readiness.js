const { lineageOf } = require('./lineage');

function initialResumeReady(presetId, savedToken) {
  return !!savedToken || lineageOf(presetId) !== 'codex';
}

function markCodexUserPrompt(session, serviceName, eventName, conversationId) {
  if (!session
      || serviceName !== 'codex_cli_rs'
      || eventName !== 'codex.user_prompt'
      || !conversationId) {
    return false;
  }

  // Codex emits a provisional conversation ID during startup, before it has
  // accepted a user turn. It can then switch threads through the interactive
  // resume picker. The prompt event is the first point where the ID is both
  // durable and known to be the thread the user is actually working in.
  session.sessionToken = conversationId;
  session._resumeReady = true;
  return true;
}

function hasUsableResumeToken(session) {
  return !!session?.sessionToken && session._resumeReady !== false;
}

module.exports = { initialResumeReady, markCodexUserPrompt, hasUsableResumeToken };
