const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function updateClaudeSessionToken(sess, token, clideckId, options = {}) {
  const next = String(token || '').trim();
  if (!sess || sess.presetId !== 'claude-code' || !CLAUDE_SESSION_ID_RE.test(next)) return false;
  if (sess.sessionToken === next) return false;
  // Hooks report the session ID synchronously from the running process.
  // Telemetry batches can arrive out of order and must not thrash a
  // hook-established token back to a stale ID.
  const origin = options.origin || 'telemetry';
  if (origin !== 'hook' && sess.sessionTokenOrigin === 'hook') return false;
  const prev = sess.sessionToken;
  sess.sessionToken = next;
  sess.sessionTokenOrigin = origin;

  const label = options.label || 'Claude';
  const source = options.source ? ` via ${options.source}` : '';
  const previous = prev ? `${prev.slice(0, 12)}... -> ` : '';
  console.log(`${label}: updated Claude session ID for ${clideckId.slice(0, 8)}${source}: ${previous}${next.slice(0, 12)}...`);
  return true;
}

module.exports = { CLAUDE_SESSION_ID_RE, updateClaudeSessionToken };
