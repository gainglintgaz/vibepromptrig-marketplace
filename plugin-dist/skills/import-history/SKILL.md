---
name: import-history
description: Preview factual metadata from bounded local Git commits, then optionally save a reviewed local history record. No messages, identities, diffs, remote reads or inferred lessons.
allowed-tools:
  - Read
  - AskUserQuestion
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" history --preview *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" history --preview)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" undo-preview *)
disable-model-invocation: true
---

> **Needs Claude Code with your project folder open and Node.js 18+.** Git is optional. In chat, open Claude Code to inspect your project files; no file check or save is performed here.

Needs Claude Code with the local project root open and Node.js 18+. Local Git is needed for commits.

Explain: "I can preview recent local commit IDs and dates. I won't read commit messages, names,
emails or changed contents. This cannot tell us whether tests passed or what lessons were proven.
Nothing is saved unless you approve the exact local record."

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" history --preview`.
Default is up to 50 commits reachable from this project's current HEAD. For a requested smaller or
larger bounded scope use `history --preview --limit <1..200>`. Never scan other projects or remote
repositories. Empty Git and no Git return explicit empty previews; unavailable Git is an error,
not evidence of no history. Keep private factory history local. Do not request a paid model.

Show the complete decoded proposed JSON and reviewed proposal before any save. The separate target
is `.vibepromptrig/history.json`. Events have exact source IDs, Git committer dates, a fixed factual
summary and import provenance/date. Commit dates are repository-supplied metadata, not independently
verified occurrence times. No authors, emails, messages, diffs, remotes, raw transcripts or inferred
frustration, causes, failures, passed tests or lessons. Nothing is sent elsewhere.

Repeated source IDs deduplicate. Existing imported events retain provenance; exact ancestry is checked
again. An ID outside current HEAD history is `no-longer-reachable`, even if it remains on another
branch. Never guess equivalent replacement commits after a rewrite. With no Git, prior sources become
`unverified`. The total record is limited to 200 events; narrowing the preview never silently deletes
previous imports. Imported event types do not automatically become useful to learning consumers.

Show the exact target, before/after and review hashes, backup and temporary lock/file effects. Backup
retains the previous local record. Ask approval of exact content and path. Declining creates nothing.
Only with that action-scoped approval, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" save <review-hash> --approved`
with the complete unchanged proposal on stdin using the host's safe input facility. Do not make an
inline interpreter or undisclosed draft file. If safe stdin is unavailable, keep the preview in chat.
Native permission remains authoritative; stale Git/target state requires a fresh preview and review.
Do not bypass the helper with Write/Edit or automatically remove an interrupted writer's lock.

For undo, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" undo-preview <backup>`
without writes. Show the exact target, backup/preimage and returned undo_hash, then ask approval and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/session-context.mjs" undo <backup> <undo-hash> --approved`.
Undo restores exact preimage bytes or removes only the newly created history.json, preserving neighbors
and backups. Later target or backup edits refuse undo; interrupted saves require this fresh recovery
review. Keep the save result's undo_hash and backup. Git is rechecked before the shared file transaction; the
cooperative file lock is not an atomic Git lock or protection from an adversarial filesystem process.
Malformed/BOM input uses the shared strict decoder and a plain error; preserve broken files for review.
No closed-issue import, network request, cross-project scan, schedule or global-rule promotion here.

## Private local recovery records

Before saving, explain that `.vibepromptrig/` contains local notes and exact file backups.
Offer to add `.vibepromptrig/` to this project's `.gitignore` in a separate reviewed edit; do not
change it automatically or assume ignore rules erase already tracked files. Omit private details
from summaries. Secret-shape screening is limited and does not prove that a note is safe to share.

If a save or undo is blocked by an interrupted writer, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/reviewed-edits.mjs" review-lock`
and show owner status, age, exact temporary-file path and recovery hash. A live or unverifiable
owner cannot be recovered automatically. For a verified dead owner, obtain explicit approval
for `recover-lock <recovery-hash> --approved` through the native permission prompt. Recovery
backs up the lock and removes only the reviewed unchanged temporary file and dead lock; preserve
the edit backup for a separately reviewed undo. Never delete the lock by hand.
