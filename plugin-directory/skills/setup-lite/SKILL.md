---
name: setup-lite
description: Set up a project for AI-assisted work with five questions. Writes a short CLAUDE.md and a GOAL.md only after you approve the exact text. Needs no scripts.
disable-model-invocation: true
---

# setup-lite: five questions, two small files

Use this once per project, from the project folder. It replaces the full edition's guided setup with a conversation. It installs nothing and runs no scripts.

## Steps

1. **Look first.** Read the project's README, any existing CLAUDE.md or GOAL.md, and the top-level file list. Never overwrite what exists; propose additions instead.
2. **Ask five questions** (all at once is fine; skip any the files already answer clearly):
   - Goal: what should this project do, in one sentence?
   - Stack: languages, frameworks, database, hosting.
   - Audience: only you, a team, or the public? Anyone paying?
   - Risk: does it touch money, personal data, production systems or secrets?
   - Done means: what must be true before you call the first version finished?
3. **Draft CLAUDE.md** (under 40 lines): project name and goal, stack, audience, how to run and check the work, and house rules. Always include these rules: never print or commit a secret; ask before any destructive, production or paid action; say what was verified and what was not.
4. **Draft GOAL.md**: goal, what is out of scope, the done criteria from question five, and one next action.
5. **Show both drafts in full** with their exact file paths. Ask for approval. If a file already exists, show only the lines you would add.
6. **Write only what was approved.** Report the paths written.

## Rules

- Never invent facts about the project. Mark unknowns as "to confirm".
- Do not run commands or install anything.
- Suggest the next steps: `status` to see where the project stands, `handoff-lite` when stopping.
