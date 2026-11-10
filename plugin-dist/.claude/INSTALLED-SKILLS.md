# INSTALLED-SKILLS.md — canonical factory-skill registry

> **Authority:** Single source of truth for which skills exist in `.claude/skills/`.
> `forge doctor verify skills-list` compares this list (by name) against the actual
> `.claude/skills/<name>/SKILL.md` directories. Drift in either direction fails the check.
>
> **Scope:** factory-owned skills only (those under `.claude/skills/` in this repo).
> Project-level skills (Example Finance App's catchup/ship/today, etc.) live in their own project
> `.claude/skills/` and are NOT counted here. Global user-level skills (vercel:*, figma:*,
> anthropic-skills:*, superpowers:*) are installed under `~/.claude/skills/` and are
> tracked separately — they are not factory deliverables.
>
> **Why this file exists:** the previous check scraped skill counts from CURRENT_SPRINT.md
> prose. This canonical list is name-aware and stable. Fulfills v4.4.5 ARCHITECTURE.md
> assumption A13 (INSTALLED-* as source of truth).
>
> **To add a skill:** create `.claude/skills/<name>/SKILL.md` AND add a `- \`<name>\`` line here.
> **To remove a skill:** delete both. Keep this list and the directory in lockstep.

## Installed factory skills (19)

- `architect-probe` — 6-persona pre-build probing protocol (runnable Senior Council)
- `case-study-generate` — drafts a project case study from git log + signals + outcomes
- `checkup` — read-only goal-aware evidence check with one optional reviewed findings record
- `cross-pollinate` — finds bug-classes / golden-paths shared across 2+ projects
- `gear` — advises which model + effort fits a task, per gear-shift.md + model-router.json (read-only, never switches the seat itself)
- `half-baked-scan` — stuck-project detector via signal density + sprint staleness
- `handoff` — reviewed local session context; transfers no execution permission
- `import-history` — preview factual local Git commit IDs and dates without identities or invented lessons
- `migrate-existing-projects` — one-shot rule refresh across all projects
- `next` — the owner's standing "what is next" question answered from live evidence: queue, commands and paste prompts per tool, decisions with norms, evidence-backed gaps, tracker updates
- `preempt-project` — pre-injects project-specific lessons at scaffold/onboard time
- `project-goal` — conversational goal intake for software and non-software projects; reviewed local summary only
- `project-author` — draft one project-specific native skill, agent or instruction section for review
- `refresh-context` — propose source-linked minimal instruction changes and preserve customized text
- `resume` — recheck saved session context against current files and goal without executing work
- `rule-decay-scan` — quarterly rule-rot detector (uncited / stale rules)
- `second-look` — writes read-only outside-diagnosis prompts for 2+ rotated tools plus a COMPARE.md after a review FAIL/HOLD
- `setup` — project-aware outfitting: scans stack, proposes MCP servers + rule packs from a curated catalog, equips after approval
- `truth-audit` — shared checkup's documentation view; proposed diffs without executing commands or editing instructions
