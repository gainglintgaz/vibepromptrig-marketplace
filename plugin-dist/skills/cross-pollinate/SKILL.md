---
name: cross-pollinate
description: Find bug classes or golden paths that appear in 2+ projects. Surfaces global-rule promotion candidates and golden-path generalization candidates for the project owner's review. Reads each project's errors-fixed.json + golden-paths.md and aggregates by root-cause similarity.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
---

# /cross-pollinate -- cross-project pattern detector

## When to invoke

- Quarterly (every 90 days) as part of factory rule review
- After two projects ship the same fix in the same week
- When the synthesizer agent surfaces REPEAT signals in 2+ projects (synth flags this candidate)
- Manually: ``/cross-pollinate`` (no args -- scans everything)
- Filter: ``/cross-pollinate <pattern>`` to focus on one keyword (e.g., ``/cross-pollinate "rls"``)

## What it does

Per CLAUDE.md SS11 (Self-Improvement Loop):
- Bug fixed once = note it
- Bug fixed twice = becomes a project rule
- **Bug fixed twice across DIFFERENT projects = becomes a global rule**

This skill detects the third case and proposes promotion to a factory rule.

## Inputs

For each known project + factory:
- ``errors-fixed.json`` -- bug history
- ``golden-paths.md`` -- proven patterns

Use only project roots explicitly configured for this installation. Skip unavailable roots and never traverse unrelated home directories.

## Algorithm

### Step 1: Load all errors-fixed.json files

For each project path:
1. Look for ``./.claude/errors-fixed.json`` OR ``./errors-fixed.json``
2. Read the JSON; expected shape: array of ``{id, title, root_cause, fix, prevention_rule, status, date}``
3. Tag every entry with its source ``project`` field for the join step.

### Step 2: Load all golden-paths.md files

For each project path, find ``./.claude/golden-paths.md`` OR ``./golden-paths.md``. Extract each pattern (headed by ``##`` or ``### GP-``).

### Step 3: Find duplicates across 2+ projects

For errors-fixed:
- Build a normalized key from each entry: lowercase, strip punctuation, take 5 most distinctive nouns from ``root_cause``.
- Bucket by normalized key.
- A bucket with entries from 2+ distinct projects = a cross-project pattern.

For golden-paths:
- Use the section heading as the key (already normalized).
- Bucket by heading similarity (Levenshtein <= 30% of length, or exact substring match).

### Step 4: Propose promotions

For each cross-project bucket, append to ``PENDING_APPROVALS.md``:

```
### [CROSS-POLLINATE] Bug class appearing in N projects -- <date>
- **Pattern:** <short description from one of the matched entries>
- **Projects:** project-a, project-b
- **Existing rule (if any):** <rule file + section>
- **Proposed action:**
  - Option A: promote to ``docs/rules-reference/factory/<topic>.md`` factory-wide (plus a `.claude/rules-manifest.json` entry and compact card)
  - Option B: strengthen existing rule X with the new evidence
  - Option C: not a true duplicate -- close as no-op
- **Evidence:**
  - project-a: <errors-fixed.json id> -- "<first 80 chars of root_cause>"
  - project-b: <errors-fixed.json id> -- "<first 80 chars of root_cause>"
- **Priority:** HIGH if 3+ projects, MEDIUM if 2 projects
```

For golden-path duplicates, append:

```
### [CROSS-POLLINATE] Golden path generalization candidate -- <date>
- **Pattern:** <heading>
- **Found in:** project-a, project-b
- **Proposed action:** promote to ``scripts/templates/shared/golden-paths.md`` so new scaffolds inherit it
```

### Step 5: Console summary

```
==== /cross-pollinate report ====
  Projects scanned: N
  errors-fixed entries: total / by project
  golden-paths entries: total / by project

  Cross-project bug-class buckets: N
  Cross-project golden-path buckets: M
  Proposals queued in PENDING_APPROVALS.md: N + M
```

## Privacy

- ``errors-fixed.json`` and ``golden-paths.md`` are project-internal but may reference table names, API surface, or business logic
- Do NOT include user data even if the entry mentions a user
- Strip stack trace lines containing file paths from other users' systems before emitting

## Failure modes

- Project path missing: skip with warning
- ``errors-fixed.json`` malformed: skip that file, log to stdout
- ``golden-paths.md`` missing: skip silently

## What this skill does NOT do

- Does NOT auto-create rule files (proposals only)
- Does NOT propose deletion of existing rules (rule-decay-scan does that)
- Does NOT modify project errors-fixed.json files (read-only on those)
- Does NOT promote based on a single project's duplicates (within-project promotion is the project's own job)

## Output

Two new sections in ``PENDING_APPROVALS.md`` (under ``## Pending Rule Updates``):
1. Bug-class promotions
2. Golden-path generalizations

Plus a summary line in ``factory_metrics.jsonl``:

```json
{"ts":"2026-05-16T15:45:00Z","event":"cross_pollinate","projects":7,"bug_classes_2plus":3,"golden_paths_2plus":1}
```
