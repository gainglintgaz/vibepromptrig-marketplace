---
name: migrate-existing-projects
description: One-shot migration. For each of the project owner's projects under <factory-root>\projects\, runs onboard-existing-project.ps1 -Force to install the compact Context V2 entry points + verifier scripts, then reports (never applies) the reviewed legacy-rule cleanup. Outputs per-project pass/fail report. Use when the factory ships new compact context or verifier scripts that existing projects need to absorb.
model: sonnet
allowed-tools: ["Read", "Glob", "Bash"]
arguments:
  - name: target_projects
    description: "Comma-separated list of project directory names. Required for write mode; omitted means discovery and dry run only."
    required: false
  - name: dry_run
    description: "If 'true', list what would happen without running onboard. Default: false."
    required: false
---

# migrate-existing-projects -- v4.4

Bridge skill: existing projects may predate the compact Context V2 entry points.
This walks each project, runs `onboard-existing-project.ps1 -Force`, reports outcomes and the
zero-write legacy-rule cleanup plan.

## Step 1 -- enumerate target projects

Factory root: `<factory-root>`.
Projects dir: `<factory-root>\projects\`.

If `target_projects` argument is set, split by comma and use those names.
Otherwise glob all directories under `projects/` that contain a `.claude/` subdirectory --
that filter excludes scratch dirs and one-off prototypes.

Build the list with `Glob`:
- pattern: `projects/*/.claude` (parent dirs are the candidates)

When no `target_projects` argument is provided, discovery is read-only: report candidate names and pre-flight status, then stop. Write mode requires an explicit list of project names. Do not infer which projects are production or safe to migrate from their names.

## Step 2 -- pre-flight per project

For each target:
1. Confirm `projects/<name>/.claude/` exists. If not, this project hasn't been onboarded
   even once -- skip with a `not-onboarded` status (don't auto-onboard fresh; that's a different flow).
2. Compact context (Context V2): if `projects/<name>/.forge/context/kernel.md` AND
   `projects/<name>/.claude/CLAUDE.md` exist -> record as `up-to-date`; otherwise -> needs migration.
   Onboarding no longer copies full rule files into `.claude/rules/` (Context V2 Delivery 3b).

## Step 3 -- migrate (unless dry_run)

If `dry_run == 'true'` or `target_projects` is absent:
- Print the list of projects + their pre-flight status (up-to-date / needs-migration / not-onboarded).
- DO NOT run the onboard script.
- Exit with summary count.

Otherwise, for each project needing migration:

```powershell
& "<factory-root>\scripts\onboard-existing-project.ps1" -Path "<factory-root>\projects\<name>" -Force
```

Capture stdout + stderr. Record exit code. If exit code != 0, mark project as `failed` and
include the last 20 lines of output in the report.

## Step 4 -- post-flight verification per project

After each onboard run, verify:
1. `projects/<name>/.forge/context/kernel.md` and `projects/<name>/.claude/CLAUDE.md` exist, and the
   onboard output reported no compact-context conflict (a conflict means a customized native entry
   was preserved -- report it, do not overwrite it).
2. Legacy rule copies (report only): run
   `node "<factory-root>\scripts\forge\legacy-rules.mjs" plan --project-root "<project>"`
   and record its `summary` (remove / conflicts / keep). This is zero-write. Do NOT run `apply`: the
   project owner reviews the plan and runs `apply --plan <file>` (backup-first, `rollback --backup <id>`).
3. If `projects/<name>/.forge/profile.json` exists, leave alone; do NOT overwrite per-project
   profile choices.

Record per-project pass/fail.

## Step 5 -- output report

Format:

```
migrate-existing-projects report -- 2026-MM-DD HH:MM

  example-finance-app           [OK]      compact context installed, profile preserved; legacy copies: <n> removable, <n> conflicts (plan only)
  example-research-app          [OK]      already up-to-date (no action taken)
  example-finance-app-local     [FAIL]    onboard exited 1 -- see log below
  example-wellness-app          [SKIP]    not-onboarded yet (run scaffold-new-project first)
  ...

Summary: 4 migrated, 1 up-to-date, 1 failed, 1 skipped
```

If any failures, include the last 20 lines of onboard output for the failed project at the
bottom of the report under `## Failure details`.

## Plain-English convention

Mirror the Day 1 forge profile show convention:
- Glyphs: `[OK]`, `[FAIL]`, `[SKIP]`, `[WARN]` (5-char fixed width)
- Color: pass = Green, fail = Red, skip = DarkGray, warn = Yellow
- Each row: one project, one line, status + short message
- No emoji, ASCII only

## What NOT to do

- Don't auto-create projects that don't have `.claude/` yet -- that's `scaffold-new-project.ps1`'s job.
- Don't overwrite existing `.forge/profile.json` files. Project-level profile choices are sacred.
- Don't run if `forge doctor` reports failures BEFORE migration -- surface the doctor errors first
  and ask the project owner to clear them.
- Don't commit changes automatically. Onboard script writes files; the project owner reviews + commits.
- Don't delete or apply the legacy-rule cleanup. Only the owner applies a reviewed plan.

## Exit conditions

- Exit 0 on full success (all projects either migrated or already up-to-date).
- Exit 1 if any project failed onboard.
- Exit 2 if pre-flight detected that `onboard-existing-project.ps1` itself is missing.
