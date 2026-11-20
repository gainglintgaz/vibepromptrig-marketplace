---
name: pre-ship-check
description: On-demand checklist before you commit, merge or deploy: secrets, scope, tests, risky changes and a diff review. Reports PASS, FAIL or UNVERIFIED for each item. Read-only.
---

# pre-ship-check: the guard hooks, as a checklist you run

The full edition blocks risky actions automatically with hooks. This edition has none, so run this before you commit, merge or deploy. It reads and reports only.

## Steps

1. **Find the change.** Use read-only git to list the files and lines changed against the base branch, or the staged and uncommitted changes if there is no base.
2. **Check each item** and mark it PASS, FAIL or UNVERIFIED with one line of evidence:
   - **Secrets:** no key-like strings, private keys or environment files in the change. Report file and line only; never print the value.
   - **Scope:** the change matches the task you stated. List files that look unrelated.
   - **Tests:** find the test script the project names in its package file or docs. Ask before running it. If it was not run this session, mark UNVERIFIED.
   - **Risky changes:** destructive database statements, force pushes, deleted files, production configuration, new paid services.
   - **Diff review:** leftover debug code, empty error handlers, fake or hard-coded data, unfinished markers.
3. **Print a table** of the five items and a one-line verdict: SHIP, FIX FIRST, or NEEDS A HUMAN CHECK.

## Rules

- UNVERIFIED is an honest answer. Never mark PASS without evidence from this session.
- This checklist does not replace review by a person for money, personal data or production changes.
