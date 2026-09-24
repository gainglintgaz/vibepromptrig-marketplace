---
name: case-study-generate
description: Draft a case study for any VibePromptRig project by reading its git log since the last case study, signal-log entries, errors-fixed.json closed entries, and outcome-tracked commits. Outputs a Markdown draft following the Example Finance App/Example Agent App/Example Bookkeeping App template that needs less than 30% manual editing.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
---

# /case-study-generate -- auto case study drafter

## When to invoke

- Quarterly per project (or after a major milestone like v1.0 ship)
- When a new client engagement closes successfully
- Pre-launch as part of marketing prep
- Manually: ``/case-study-generate <project-name>`` (e.g. ``/case-study-generate example-finance-app``)

## What it produces

A draft Markdown file at ``docs/case-studies/<project>-<YYYY-MM-DD>.md`` following the existing
Example Finance App/Example Agent App/Example Bookkeeping App template. Target: <30% manual editing before publish.

## Algorithm

### Step 1: Resolve project path

Resolve ``<project-name>`` from the explicit project path supplied by the user or the active project's configured repository list. If the name is ambiguous or the path is absent, ask for the exact repository path before reading or writing. Never infer a home-directory path.

### Step 2: Collect raw inputs

For each source, harvest:

1. **git log since last case study** -- check ``docs/case-studies/<project>-*.md`` for the
   newest existing file; use its date as ``--since``. If none, use 90 days ago.
2. **errors-fixed.json closed entries** -- read ``<project>/.claude/errors-fixed.json``,
   filter status=CLOSED, sort by date desc
3. **outcome-tracked commits** -- grep git log for ``[rule: X]`` entries; aggregate which
   rules paid off
4. **signal-log highlights** -- read ``<project>/.claude/signal-log.jsonl``, surface:
   - APPROVAL signals (what worked)
   - High-severity REPEAT/BUG counts (what was hard)
5. **BRIEF.md** -- read for the elevator pitch + current status
6. **README.md** -- read for the public-facing summary

### Step 3: Apply the template

Read an existing well-polished case study (preferably ``docs/case-studies/example-finance-app-*.md``)
as the structural template. The standard sections are:

```markdown
# <Project name> -- Case study

## TL;DR (3 bullets)
- One sentence: what the project does
- One sentence: the hard problem it solves
- One sentence: a quantifiable outcome

## The problem
2-3 paragraphs. Plain-language description of the user's pain. NO product positioning.

## The constraint
What made this hard: scale, privacy, compliance, deadline, team size of one.

## What we built
- Stack (one line, no marketing)
- Architecture (one diagram or 2-3 bullets)
- The 2-3 design decisions that mattered most (cite errors-fixed entries that drove them)

## Outcomes
- Quantifiable wins (number, percentage, time saved)
- Rule outcomes: ``rule X prevented N bugs of class Y``
- User quotes (if any -- from APPROVAL signals or testimonials)

## What we'd do differently
2-3 honest "we'd skip this / we should have done X sooner" bullets. From signal-log REPEAT entries.

## Reuse
What from this project promoted to factory rules or vertical packs.
Link to the rule or pack file.
```

### Step 4: Draft generation rules

- **No banned words** -- per consulting.md anti-slop list: revolutionize, unleash, delve,
  harness, elevate, empower, seamless, cutting-edge, groundbreaking, game-changing, supercharge.
  If draft contains any, replace before output.
- **No first-person product voice** -- the case study is a third-party-style account.
  Use "the team built X" / "the system tracks Y" not "we built our amazing X."
- **Numbers must be REAL** -- pulled from signal counts, commit counts, outcome data.
  If a number is not in source data, write ``[insert: <metric>]`` placeholder, NOT a guess.
- **Quotes must be REAL** -- only quote actual APPROVAL signal excerpts (already PII-scrubbed)
  or explicitly-saved testimonials. Never fabricate.

### Step 5: Output

Write the draft to ``docs/case-studies/<project>-<YYYY-MM-DD>.md``.

Console:
```
==== /case-study-generate <project> ====
  Source data:
    git commits since last case study: N
    closed errors-fixed entries: N
    outcome-tracked commits: N
    APPROVAL signals: N
    [insert: X] placeholders that need manual filling: N
  Draft written to: docs/case-studies/<project>-<date>.md
  Banned words found: 0 (auto-replaced)
  Suggested next actions:
    - Fill in [insert: ...] placeholders (~10-15 min)
    - Read aloud to check for product-voice slips
    - Add one screenshot or diagram
    - Get the project owner's review before publishing
```

### Step 6: factory_metrics.jsonl event

```json
{"ts":"2026-XX-XX","event":"case_study_generated","project":"<name>","commits_window":N,"placeholders":N,"draft_path":"docs/case-studies/<project>-<date>.md"}
```

## What this skill does NOT do

- Does NOT auto-publish (the project owner reviews + edits before any external sharing)
- Does NOT make up metrics, quotes, or outcomes (placeholders only)
- Does NOT include source code (uses summaries + links to public repos if any)
- Does NOT include private project state (BRIEF.md is read but only the public-facing parts surface)

## Privacy

- errors-fixed.json + signal-log are project-internal; only summarized counts + APPROVAL
  excerpts (PII-scrubbed) surface in the case study draft
- Never include user IDs, internal table names, RLS policy details
- Never include unredacted error messages from production
- If the project deals with regulated data (Example Finance App financial, Example Bookkeeping App client docs), strip
  any reference to specific user actions; aggregate only

## Failure modes

- Project path missing -> error with corrective hint
- No prior case study + 0 commits -> output placeholder skeleton, note "low signal"
- errors-fixed.json malformed -> warn + skip; still draft from git + BRIEF
- signal-log.jsonl missing -> warn + skip APPROVAL extraction
