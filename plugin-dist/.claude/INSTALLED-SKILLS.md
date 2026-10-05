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

## Installed factory skills (9)

- `architect-probe` — 6-persona pre-build probing protocol (runnable Senior Council)
- `case-study-generate` — drafts a project case study from git log + signals + outcomes
- `cross-pollinate` — finds bug-classes / golden-paths shared across 2+ projects
- `gear` — advises which model + effort fits a task, per gear-shift.md + model-router.json (read-only, never switches the seat itself)
- `half-baked-scan` — stuck-project detector via signal density + sprint staleness
- `migrate-existing-projects` — one-shot rule refresh across all projects
- `preempt-project` — pre-injects project-specific lessons at scaffold/onboard time
- `rule-decay-scan` — quarterly rule-rot detector (uncited / stale rules)
- `setup` — project-aware outfitting: scans stack, proposes MCP servers + rule packs from a curated catalog, equips after approval
