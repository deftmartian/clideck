const { join, resolve } = require('path');
const { mkdirSync, existsSync, copyFileSync, cpSync, readdirSync } = require('fs');
const os = require('os');

const EXPLICIT_DATA_DIR = String(process.env.CLIDECK_DATA_DIR || '').trim();
const DATA_DIR = EXPLICIT_DATA_DIR ? resolve(EXPLICIT_DATA_DIR) : join(os.homedir(), '.clideck');
const LEGACY_DIR = __dirname;
const OLD_DATA_DIR = join(os.homedir(), '.termix');
mkdirSync(DATA_DIR, { recursive: true });

// Migrate from ~/.termix/ to ~/.clideck/ (one-time rename migration)
if (!EXPLICIT_DATA_DIR && existsSync(OLD_DATA_DIR)) {
  for (const file of readdirSync(OLD_DATA_DIR, { withFileTypes: true })) {
    const src = join(OLD_DATA_DIR, file.name);
    const dest = join(DATA_DIR, file.name);
    if (existsSync(dest)) continue;
    try { cpSync(src, dest, { recursive: true }); } catch {}
  }
}

// Migrate legacy files from project root to ~/.clideck/ (one-time on upgrade)
const MIGRATE_FILES = ['config.json', 'sessions.json', 'custom-themes.json'];
for (const file of EXPLICIT_DATA_DIR ? [] : MIGRATE_FILES) {
  const src = join(LEGACY_DIR, file);
  const dest = join(DATA_DIR, file);
  if (existsSync(src) && !existsSync(dest)) {
    try { copyFileSync(src, dest); } catch {}
  }
}
// Migrate transcript JSONL files
const legacyTranscripts = join(LEGACY_DIR, 'data', 'transcripts');
const newTranscripts = join(DATA_DIR, 'transcripts');
if (!EXPLICIT_DATA_DIR && existsSync(legacyTranscripts) && !existsSync(newTranscripts)) {
  mkdirSync(newTranscripts, { recursive: true });
  try {
    for (const f of readdirSync(legacyTranscripts)) {
      copyFileSync(join(legacyTranscripts, f), join(newTranscripts, f));
    }
  } catch {}
}

module.exports = { DATA_DIR };
