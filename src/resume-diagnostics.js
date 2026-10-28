const { statSync } = require('fs');

function resumeHandleRequired(provider) {
  if (!provider) return false;
  if (provider.id === 'shell' || provider.id === 'antigravity') return false;
  if (provider.id === 'custom-command') return provider.canResume === true;
  return typeof provider.resumeMetadata === 'function';
}

function transcriptStatus(transcriptPath) {
  const path = String(transcriptPath || '').trim();
  if (!path) return null;
  try {
    const stat = statSync(path);
    return { path, exists: stat.isFile(), modifiedAt: stat.mtime.toISOString(), provesContinuity: false };
  } catch {
    return { path, exists: false, provesContinuity: false };
  }
}

function resolveResume(provider, entry = {}) {
  const handle = String(entry.resumeHandle || '').trim();
  const transcript = transcriptStatus(entry.transcriptPath);
  const required = resumeHandleRequired(provider);
  if (required && !handle) {
    const label = entry.name || entry.id || 'this session';
    return {
      ok: false,
      resumed: false,
      handle: '',
      transcript,
      code: 'missing_resume_handle',
      message: `Resume blocked for ${label}: no native conversation handle is saved. CliDeck will not start a new ${provider.id} conversation in this session. Run \`clideck resume ${entry.id || ''}\`. Handles are not repaired automatically.`,
      warnings: [],
    };
  }
  const warnings = [];
  if (handle && transcript && !transcript.exists) {
    warnings.push('The cached transcript path is missing. Resume still uses the saved native handle. The provider CLI may resolve the conversation. A missing file does not by itself prove the conversation is gone, and a present file would not prove continuity either.');
  }
  const passHandle = Boolean(handle)
    && (provider?.id !== 'custom-command' || provider.canResume === true);
  return {
    ok: true,
    resumed: passHandle,
    handle: passHandle ? handle : '',
    transcript,
    code: null,
    message: '',
    warnings,
  };
}

function diagnoseSession(entry) {
  const transcript = transcriptStatus(entry.transcriptPath);
  return {
    id: entry.id,
    name: entry.name || '',
    provider: entry.provider,
    resumeHandle: entry.resumeHandle ? String(entry.resumeHandle) : null,
    transcriptPath: transcript ? transcript.path : null,
    transcriptExists: transcript ? transcript.exists : null,
    transcriptModifiedAt: transcript?.modifiedAt || null,
    provesContinuity: false,
    createdAt: entry.createdAt || null,
    lastActive: entry.lastActive || null,
    lastAgentAt: Number(entry.lastAgentAt) > 0 ? Number(entry.lastAgentAt) : null,
    resume: entry.resumeHandle ? 'handle_saved' : 'no_handle',
  };
}

function diagnoseSessions(persistence, sessionId = '') {
  const id = String(sessionId || '').trim();
  const entries = persistence.list().filter((entry) => !id || entry.id === id);
  return {
    ok: true,
    sessions: entries.map(diagnoseSession),
    note: 'Metadata only. Transcript existence does not prove the saved handle continues that conversation. A missing cached path does not block a saved native handle. No handle is repaired or rewritten by this report.',
  };
}

module.exports = {
  diagnoseSessions,
  resolveResume,
  resumeHandleRequired,
  transcriptStatus,
};
