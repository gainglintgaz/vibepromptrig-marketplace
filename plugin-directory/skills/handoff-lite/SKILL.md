---
name: handoff-lite
description: Write a short HANDOFF.md so another AI tool or a later session can continue: goal, what is done, decisions, what failed and the next step. Saved only after you approve.
disable-model-invocation: true
---

# handoff-lite: leave a note for the next session or tool

Use when you stop for the day, hit a usage limit, or want Codex, Grok, Cursor, Antigravity or a new Claude session to continue. The note is context, not instructions.

## Steps

1. **Gather.** From this conversation plus read-only git (branch, uncommitted files, last 10 commits), collect:
   - Goal: from GOAL.md or the conversation.
   - Done: only what was actually observed, such as a commit or a check that ran. Separate it from what was merely claimed.
   - Decisions: choices made and the reason.
   - Failed or blocked: what did not work and the exact error text.
   - Next step: one bounded action.
   - Permissions: any approval given earlier, written as history only.
2. **Leave out** raw conversation, credentials, customer data and confidential designs.
3. **Show the full text** and the target path HANDOFF.md in the project root. If the file exists, show what would change. Ask for approval.
4. **Write after approval only.** Then offer, as a separate step, to add HANDOFF.md to the project's ignore file when the note is private.

## Rules

- Approvals do not carry over. The note must say that the next session re-checks the repository and asks again before any install, merge, publish or spend.
- Never put a command in the note that the next session is expected to run on its own.
