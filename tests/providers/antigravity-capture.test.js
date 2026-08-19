// Antigravity (agy) has no push-status mechanism — no hook patching, no OTEL, no
// bridge — so it never hits the idle-finalize or menu-commit paths that save
// other agents' transcripts. Instead its preset carries `finalizeOnCapture`, and
// the server commits the transcript from each settled terminal capture.
//
// This covers the capture-and-commit path at the transcript layer (module-level,
// not through the WS handler or the client's terminal capture): a post-startup
// agent turn is captured AND persisted, a repeated identical capture is
// idempotent (no duplicate), and a later turn keeps saving without collapsing the
// earlier one. It drives the exact transcript calls the WS handler makes on a
// settled server capture (updateAgentCandidate → commitAgentCandidate) plus
// the PTY-driven user path (trackInput) — deliberately NOT a detectMenu() call.
// The menu → status side of the flow is covered by menu-status.test.js.
//
// If the capture-and-commit path regresses, this breaks first.
//
//   node tests/providers/antigravity-capture.test.js

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate the data dir to a throwaway home before requiring the transcript
// module (paths.js resolves DATA_DIR from os.homedir() at require time).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clideck-agy-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome; // Windows

const transcript = require('../../transcript');
transcript.init(null, null); // create the transcripts dir; no broadcast

const id = 'agy-capture-test';
const A1 = 'Recursion is a function that calls itself.';
const A2 = 'A base case is the condition that stops the recursion.';

// A settled antigravity frame renders claude-style ❯ user / ⏺ agent markers.
function frame(pairs) {
  const lines = [];
  for (const [q, a] of pairs) { lines.push('❯ ' + q); lines.push('⏺ ' + a); }
  return lines;
}

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) failed++;
}

// agy → claude-code via lineage: enables finalize + claude parsing.
transcript.setFinalizeOnIdle(id, 'antigravity');

// Turn 1: user asks, agent answers, a settled capture arrives.
transcript.trackInput(id, 'explain recursion\r');
transcript.updateAgentCandidate(id, 'antigravity', frame([['explain recursion', A1]]));
transcript.commitAgentCandidate(id, 'antigravity');
let replay = transcript.getReplayText(id, 'antigravity');
check('post-startup turn is captured and saved', replay.includes(A1));

// A repeated settled capture of the same turn must not duplicate the entry.
transcript.commitAgentCandidate(id, 'antigravity');
const afterRepeat = transcript.getReplayText(id, 'antigravity');
check('repeated identical capture is idempotent', afterRepeat === replay);

// Turn 2: next prompt + answer. The earlier turn must survive.
transcript.trackInput(id, 'what is a base case\r');
transcript.updateAgentCandidate(id, 'antigravity', frame([['explain recursion', A1], ['what is a base case', A2]]));
transcript.commitAgentCandidate(id, 'antigravity');
replay = transcript.getReplayText(id, 'antigravity');
check('later turn saves without collapsing the earlier one', replay.includes(A1) && replay.includes(A2));

// Cleanup the throwaway home.
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall antigravity capture-commit checks passed');
