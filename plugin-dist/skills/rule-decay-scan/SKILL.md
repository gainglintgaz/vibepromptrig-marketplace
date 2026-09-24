---
name: rule-decay-scan
description: Quarterly rule-rot detector. Surfaces factory rules that have no outcome data (never invoked, never cited) and rules whose last edit is older than 6 months. Proposes archival to docs/rules-reference/archived/ for the project owner's review. Reads docs/factory-effectiveness.md + git log of the rule corpus.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
---

# /rule-decay-scan -- quarterly rule rot detector

## When to invoke

- Quarterly (1st of Jan/Apr/Jul/Oct) via scheduled-tasks MCP
- Manually before any v.X.Y minor release
- After the synthesizer reports 0 invocations for a previously-active rule

## Reads

- ``docs/rules-reference/factory/**/*.md`` -- all current factory rules (plus the project's own ``.claude/rules/*.md`` if scanning a project)
- ``docs/factory-effectiveness.md`` -- per-rule invocation counts (from outcome-tracker)
- ``git log --since='6 months ago' -- docs/rules-reference/factory/ .claude/rules/`` -- rule edit cadence (the factory corpus moved out of `.claude/rules/` in Context V2 Delivery 3; include both paths so pre-move history counts)
- ``factory_metrics.jsonl`` -- last 30 days of outcome_scan events

## Detection criteria

A rule is a DECAY CANDIDATE if all of:

1. **Zero invocations** in last 90 days per ``factory-effectiveness.md``
2. **No edits** in last 6 months (per ``git log`` on the rule file)
3. **Not referenced** in any of:
   - ``CLAUDE.md`` SS15 auto-loaded rules list
   - Other rules' ``See also:`` or ``citations``
   - Any vertical pack's ``rules/`` directory
   - Any skill or agent definition

A rule is a STALE CANDIDATE if:
- It has been edited in the last 6 months BUT has 0 invocations AND 0 references anywhere
- Likely never actually deployed; consider promoting to draft or removing

A rule is a STRENGTHEN CANDIDATE if (handled by outcome-tracker, not this skill):
- Has invocations >= 3 but effectiveness < 0.6 -- the rule is being cited but not catching the bug

## Algorithm

### Step 1: Inventory

```
all_rules = list docs/rules-reference/factory/**/*.md
rule_table = {}
for each rule_file:
  read frontmatter (tier, required, profiles)
  rule_table[basename] = { path, last_edit_iso, tier, required, references_to_count }
```

### Step 2: Cross-reference

For each rule:
- Grep ``CLAUDE.md`` for the rule's basename
- Grep other rules in ``docs/rules-reference/factory/**/*.md`` for the basename
- Grep ``scripts/templates/packs/**/rules/`` for the basename
- Grep ``.claude/agents/*.md`` and ``.claude/skills/**/SKILL.md`` for the basename
- Sum into ``rule.references_to_count``

### Step 3: Outcome data

Read ``docs/factory-effectiveness.md`` table, extract per-rule invocations.

### Step 4: Classify

```
for each rule:
  if rule.required == true: SKIP (cannot be archived; promoted to factory baseline)
  invocations = factory_effectiveness[rule.name] or 0
  age_months = (now - rule.last_edit) / 30
  references = rule.references_to_count

  if invocations == 0 and age_months >= 6 and references == 0:
    classify as DECAY (propose archival)
  elif invocations == 0 and age_months < 6 and references == 0:
    classify as STALE-NEW (propose draft tag)
  else:
    classify as ACTIVE (no action)
```

### Step 5: Propose

Append to ``PENDING_APPROVALS.md``:

```
### [RULE-DECAY] <rule-name> appears unused -- <date>
- **Path:** docs/rules-reference/factory/<file>.md
- **Tier:** <tier>
- **Last edit:** <iso-date> (<N> months ago)
- **Invocations (90d):** 0
- **References elsewhere:** 0
- **Proposed action:** archive to docs/rules-reference/archived/<file>.md and remove its `.claude/rules-manifest.json` entry (the corpus directory must match the manifest one-to-one)
- **Override:** if this rule is intentionally dormant (e.g., a contingency rule
  for a feature not yet shipped), add a frontmatter field
  ``decay_exempt: true`` with a one-line reason and re-run the scan.
```

### Step 6: Console summary

```
==== /rule-decay-scan ====
  Rules in factory: N
  ACTIVE:           N (recent edits OR invocations)
  STALE-NEW:        N (recent edit, no use yet)
  DECAY candidates: N (>= 6 months no edits, no use, no refs)
  PROPOSALS queued: N
```

### Step 7: factory_metrics.jsonl

```json
{"ts":"2026-XX-XX","event":"rule_decay_scan","total_rules":N,"active":N,"stale_new":N,"decay":N}
```

## What this skill does NOT do

- Does NOT delete or move any rule file (proposals only -- the project owner approves)
- Does NOT scan project-level rules (those decay independently; each project scans its own)
- Does NOT use ``invocations < threshold`` -- a rule can earn its keep at 1 invocation if effectiveness is 1.0
- Does NOT score effectiveness (that's outcome-tracker's domain)

## Output

Up to N proposals appended to ``PENDING_APPROVALS.md`` under section ``## Rule Decay``.
One ``rule_decay_scan`` event appended to ``factory_metrics.jsonl``.

## Privacy

No user data involved. Rule files are repo-internal. Git log is local.
