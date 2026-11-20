---
name: status
description: Print a one-screen project status from git and project files: goal, recent changes, uncommitted work, open to-dos and blockers. Read-only.
---

# status: where does this project stand?

Read-only. Writes nothing. Run it from the project folder.

## Steps

1. **Goal.** Read GOAL.md if present, else the top of README.md and CLAUDE.md. Quote the goal in one line, or say none was found.
2. **Git facts** (read-only commands only): current branch, whether the working tree has uncommitted files (count and names), the last 10 commit subjects with dates, and the commits not yet pushed if an upstream exists. If the folder is not a git repository, say so and skip this step.
3. **Open work.** Search project files for TODO and FIXME markers (first 20 hits, with file and line). Read HANDOFF.md if present and list its next step and any blockers it names.
4. **Print the report** in this shape:

```
STATUS: <project folder name>
Goal: <one line>   [DECLARED: from the project's own notes]
Branch: <name>   Uncommitted files: <n>   [MEASURED: from git]
Recent changes: <up to 10 lines>   [MEASURED]
Open markers: <n shown of n found>   [MEASURED]
Blockers: <from HANDOFF.md, or none recorded>   [DECLARED]
Spend and token use: not tracked in this edition   [NOT-TRACKED]
Suggested next action: <one line, from the notes or the newest commits>
```

## Rules

- Label every line MEASURED (read from git or files just now) or DECLARED (taken from someone's notes). Never present a missing number as zero.
- Do not run tests, builds or any command that changes files.
