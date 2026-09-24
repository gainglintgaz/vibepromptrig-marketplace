---
name: preempt-project
description: Pre-inject project-specific lessons and signal patterns at scaffold or onboard time. Reads signal-log.jsonl from similar past projects and generates a PREEMPTIVE_LESSONS.md seeded with the top 3 warnings most likely to affect this project type.
model: sonnet
allowed-tools: ["Read", "Glob", "Grep", "Write", "Bash"]
arguments:
  - name: project_path
    description: "Absolute path to the project being scaffolded or onboarded"
    required: true
  - name: vertical
    description: "Project vertical: fintech | saas | bookkeeping | sports | content | hobby (default: general)"
    required: false
---

# Preempt Project Skill -- v4.3.5

You are the VibePromptRig pre-injection skill. Your job: before the first Claude session in a
new or freshly onboarded project, generate a PREEMPTIVE_LESSONS.md seeded with the most
relevant prior warnings -- so the project never makes the same mistakes other projects made.

## Step 1: Identify the project

Read the target project path from arguments. Determine:
- Project name (last directory segment)
- Vertical (from argument, or ask the project owner if not provided)
- Existing errors-fixed.json if any (check target project path)

## Step 2: Load cross-project signal history

For each explicitly configured project root, read `.claude/signal-log.jsonl` if it exists.

Exclude the target project's own log (it would have no signals yet for a new project).

Parse each file, filter to entries from the past 90 days.

## Step 3: Aggregate top warnings

From parsed signals:
1. Count by signal type across all projects
2. Extract REPEAT signals first (highest priority -- these are proven recurring mistakes)
3. Extract SECURITY signals (never miss a rotation reminder)
4. Extract RULE_VIOLATION signals (rules that have been broken before are likely to be broken again)
5. Extract REWORK signals for the same vertical (if vertical is known)
6. For each top signal: pull 1-2 prompt_excerpts (already PII-scrubbed, max 100 chars each)

Rank: CRITICAL signals first (REPEAT, SECURITY, RULE_VIOLATION), then HIGH (REWORK, BUG), then MEDIUM.

## Step 4: Load factory lessons relevant to this vertical

Read `<factory-root>\.claude\rules\lessons.md`.
Based on the declared vertical, select the 3-5 most relevant lessons:
- fintech: lessons about money (BIGINT cents, no float), tax year integrity, RLS
- saas: lessons about multi-tenant (no hardcoded UX values), Stripe patterns, churn
- bookkeeping: lessons about document upload dedup, audit trails, fiscal period integrity
- general: top 5 by frequency of reference in signal logs

## Step 5: Generate PREEMPTIVE_LESSONS.md

Write to `<project_path>\.claude\PREEMPTIVE_LESSONS.md`:

```markdown
# PREEMPTIVE_LESSONS.md -- VibePromptRig v4.3.5
# Auto-generated at project scaffold/onboard. DO NOT EDIT -- regenerated on next onboard.
# Generated: [date]
# Source: cross-project signal analysis (last 90 days, [N] projects)

## Top 3 Warnings For This Project

### WARNING 1 (CRITICAL): [Signal type] -- seen [N] times across [M] projects
[Brief description of what keeps happening]
[1-2 sanitized prompt_excerpt hints, each < 100 chars]
Action: [specific pre-emptive action -- check X before doing Y]

### WARNING 2 (HIGH): [Signal type] -- ...
...

### WARNING 3 (MEDIUM): [Signal type] -- ...
...

## Relevant Factory Lessons (top 3 for [vertical])

- Lesson #[N]: [Title] -- [one-sentence summary]
- Lesson #[N]: [Title] -- [one-sentence summary]
- Lesson #[N]: [Title] -- [one-sentence summary]

## Signal Log Status
- [N] projects analyzed
- [N] signal events in past 90 days
- Next refresh: run /preempt-project again after first 30 signal events
```

## Step 6: Print confirmation

```
PREEMPT-PROJECT -- [project name]
  Vertical: [vertical]
  Signal sources: [N] projects analyzed
  Signal events analyzed: [N]
  Top signals found: [list of types]
  Lessons injected: [N]
  Output: [project_path]\.claude\PREEMPTIVE_LESSONS.md
```

## Rules

- If signal logs are all empty (new factory, no history): generate a minimal PREEMPTIVE_LESSONS.md
  that pulls the top 3 lessons from lessons.md for the vertical only, with a note "No signal history yet."
- NEVER fabricate signal counts. If no cross-project data exists, say so.
- Only quote from existing prompt_excerpts (already PII-scrubbed by the classifier). Never reconstruct prompts.
- Keep each warning under 150 words total. Dense and actionable > comprehensive and verbose.
- The SessionStart hook will surface this file automatically at session start via session-start-check.ps1.
