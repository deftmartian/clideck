# Session archives

Settings → General → Session archive lets you choose a folder and enable recording.
It is **off by default**. The folder is on the machine running the CliDeck engine,
not necessarily the computer displaying the browser. This machine-local setting
is deliberately excluded from workspace backup/restore.

Recording starts when enabled. Existing History is not imported. You can enable
it with agents running; this does not restart, send input to, or change an agent.
Disabling or changing folders ends the current archive runs. Old files stay put.
Deleting a CliDeck session does not delete its archive.

```
chosen-folder/
  Project--stable-id/
    Session--stable-id/
      2026-10-13/
        <run-uuid>.jsonl
        assets/
      2026-10-14/
        <same-run-uuid>.jsonl
```

Each line is a complete JSON value. Project/session folder names are chosen once;
renaming them in CliDeck does not split their archives. Stable IDs are shortened
SHA-256 identities. CliDeck keeps their path mapping and previous run IDs in its
data directory's `archive-index.json`; retain that file when moving engine data.

## Runs and days

- Starting/restarting an agent process creates a new linked run, including when
  resuming the same native conversation. A confirmed native conversation change
  or `/clear` creates another run.
- Compaction and automatic continued work stay in the same run unless the native
  conversation identity/path changes. The original compaction record is retained
  if the provider writes one.
- Browser refresh/reconnect and switching tabs do not create runs.
- Records are grouped by capture day in the engine's local timezone, recorded in
  segment headers. Midnight starts another file with the **same run ID** and a
  link to the previous segment. `sequence` orders records across those files;
  provider timestamps remain in original records. Queued events may carry an
  earlier capture timestamp than a preceding native-file read.

## What is captured

All sessions can contribute CliDeck user/final/intermediate events, lifecycle,
model/usage updates and the native hook payloads CliDeck receives. A run header
records the project, session, process, provider, engine build and available native
identity, plus the CliDeck guide supplied at launch. It does not dump environment
variables, credentials, arbitrary provider config files or terminal keystrokes.
Terminal repaint bytes are not treated as conversation messages.

**Claude Code and Codex:** the recorder also follows the JSONL path reported by
that session, inside its effective provider profile. It never searches other
conversations. It preserves original records, including available intermediate
text, tool names/arguments/results, reasoning summaries or thinking blocks,
instructions, compaction, errors and usage. Encrypted/redacted values stay as-is;
hidden reasoning and information omitted by the provider cannot be captured.
Native versions/settings are available only if those records expose them.

**Other providers:** native file capture is not implemented yet. CliDeck events
and received hooks are still recorded, and the header labels native coverage as
unsupported. A missing/unreadable transcript is recorded as unavailable and
retried. The archive never claims a complete model conversation.

On enablement/resume, a known transcript starts at its current byte offset. If a
path first becomes known later, the recorder scans in bounded chunks and keeps
only initial records whose timestamps are at or after recording began. Older,
undated or malformed initial records are counted as skipped. After that initial
scan, every appended record is retained, including unknown/malformed records.
Provider rewrites/replacements are explicitly marked and may repeat records.
Native records written after a run's final drain cannot be guaranteed captured.

Uploads and preview assets received through CliDeck are copied, hashed and linked
relative to their day's directory. Embedded native images remain in their raw
records. The recorder does not fetch URLs or copy external files merely because a
message mentions them. An upload records receipt, not proof it was sent to the
model. A preview records the file bytes available when copied, not later edits.

## Record format (schemaVersion 1)

Every record contains `type`, `capturedAt`, monotonic run `sequence`, `projectId`,
`sessionId`, `runId`, `provider`, `nativeId` and `data`.

| Type | Data |
| --- | --- |
| `segment.started` | Timezone, previous file and previous run links |
| `run.started` / `run.ended` | Metadata, reason and explicit coverage |
| `clideck.event` | Original CliDeck event, such as `turn.user` or `agent.final` |
| `native.hook` | Route and untouched received hook payload |
| `native.record` | Original JSONL line in `raw`, native type and source path/byte offset/generation |
| `native.fragment` | Lossless base64 pieces of a large native line, same source identity plus `index` and `final` |
| `source.*` | Attachment policy/offset, skipped history, replacement, unavailable/recovered or incomplete records |
| `asset.referenced` / `asset.saved` / `asset.unavailable` | Source, saved relative path/hash/size, or failure reason |

Parse `native.record.data.raw` for provider-specific fields. `raw` excludes only
the delimiting LF; CR and whitespace are preserved. Invalid UTF-8 additionally
has `rawBase64`. For large lines, concatenate decoded `native.fragment` bytes
by source path/generation/byte offset and index, check the final fragment's count,
byte length and SHA-256, then parse when `final=true`.
An incomplete line at shutdown is explicitly marked; do not treat it as a valid
complete record. There is no content-based deduplication: repeated prompts are
legitimate, and the hook/CliDeck/native streams can describe the same message.

## Failure and data handling

Writing and file reads are asynchronous and separate from agent lifecycle.
The writer caps queued event data at 32 MiB, reads native files in 256 KiB chunks,
splits large lines rather than truncating them, and copies individual assets up
to 100 MiB. An unavailable/oversize asset warns and leaves conversation recording
running. An archive write failure or overload pauses recording with a persistent
error notice and Settings status; agents continue. After fixing the cause, turn
archiving off and on. The pause is a gap, not automatically backfilled.

New files use mode 0600 and new directories 0700 where supported. Existing folder
permissions are not changed. Archives may include personal data, secrets pasted
into conversations and tool output. They are faithful source material, **not a
training-ready dataset**: select, reconcile, redact and convert records separately
before training or sharing. This feature has no automatic deletion/retention policy.
