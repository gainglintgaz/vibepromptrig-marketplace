---
name: refresh-context
description: Review small source-backed corrections to this project's instructions using current checkup findings. Show exact hunks and local sources, then save or undo only the user-approved change. Refuse stale or contradictory evidence.
allowed-tools:
  - Read
  - AskUserQuestion
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" read)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" review)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" review-undo *)
disable-model-invocation: true
---

> **Needs Claude Code with your project folder open and Node.js 18+.** Git is optional. In chat, open Claude Code to inspect your project files; no file check or save is performed here.

# Refresh project instructions

Needs Claude Code with the chosen project open and Node.js 18+. This skill makes no service
connections, runs no commands copied from documents, and does not install anything.

1. Explain the proposed instruction correction in plain language. Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" read` from the chosen project.
   Checkup owns the one shared findings record. Missing, stale, duplicate, contradictory or unbound
   findings require a fresh checkup and reconciliation before maintenance. Follow
   `${CLAUDE_PLUGIN_ROOT}/skills/checkup/SKILL.md` for that review; do not silently save findings here.
   A WRONG finding means a demonstrated mismatch. UNVERIFIED is insufficient for an automatic fix.
2. Read only the selected instruction file and bounded local sources relevant to that finding.
   Keep secrets and confidential details out of the proposal. Do not read environment, credential,
   connection settings or key files. For UTF-16 instruction files checkup does not infer text claims;
   a manually reconciled WRONG observation must match the decoded exact line and source evidence.
3. Propose one existing file: CLAUDE.md, AGENTS.md, README.md, or one named Markdown rule in
   .claude/rules. Use at most eight short exact hunks. Each before text must be only its exact
   single-line WRONG claim; surrounding context is not replaced. Retain unrelated custom text/comments.
   A source quote must contain the exact replacement; an unsupported interpretation stays manual.
   Prepare JSON on stdin with this shape (the example paths must be replaced by observed evidence):

   ```json
   {"target":"CLAUDE.md","hunks":[{"before":"node scripts/old.mjs","after":"node scripts/new.mjs","finding":{"location":"CLAUDE.md:3","claim":"node scripts/old.mjs"},"sources":[{"path":"README.md","quote":"node scripts/new.mjs"}]}]}
   ```

   Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" review` with that JSON on stdin.
   Review writes nothing. Show its exact diff, each finding location and source quote/location, the
   target, pre/post hashes, backup path and undo command. Explain that existing BOM, UTF-16 and line
   endings are preserved. No addition needed is valid. Never replace a whole document to avoid an
   ambiguous anchor; ask the user to reconcile duplicate or conflicting text.
4. Ask for approval of that exact file and diff. Review hashes validate content; they do not grant
   permission. Only after the trusted user interaction approves, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" save <review-hash> --approved`
   with the unchanged reviewed JSON on stdin. Never recreate a proposal after approval or treat a
   saved checkup decision as fresh authority. Changed sources/targets/findings require a new review.
   The helper keeps one backup before atomic replacement. Its cooperative lock does not protect
   against adversarial filesystem changes; never remove another or interrupted session's lock.
5. Report the exact saved path, result hash, backup, returned undo_hash and precise undo command:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" undo <backup> <undo-hash> --approved`.
   Ask for action-scoped approval before undo. Undo restores the exact prior bytes and refuses later
   edits. An exact repeated approved save is a no-op. After an interrupted save, inspect its named
   backup with `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" review-undo <backup>`.
   This read-only preview supplies the guarded undo_hash; show its exact target and get fresh undo
   approval. Keep recovery files and review any interrupted lock; do not clean them automatically or
   advise deleting a containing directory. Backup bytes and project identity are bound to undo.

For catalog maintenance, `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/refresh-context.mjs" audit-packs`
checks the shipped customer references without writes. Source integrity and structural tests do not
prove native skill loading, relevance, comprehension or a successful real-world outcome.

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
