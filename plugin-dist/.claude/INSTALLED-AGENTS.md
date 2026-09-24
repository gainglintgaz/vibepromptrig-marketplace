# INSTALLED-AGENTS.md — canonical agent registry

> **Authority:** Single source of truth for which agents exist in `.claude/agents/`.
> `forge doctor verify agents-list` compares this list (by name) against the actual
> `.claude/agents/*.md` files. Drift in either direction fails the check.
>
> **Why this file exists:** the previous check scraped agent counts from VERSION.md
> changelog prose, which is append-only history — any past aspirational claim
> ("20 agents will land") permanently broke the check. This canonical list is
> name-aware and stable against changelog growth. Fulfills v4.4.5 ARCHITECTURE.md
> assumption A13 (INSTALLED-* as source of truth).
>
> **To add an agent:** create `.claude/agents/<name>.md` AND add a `- \`<name>\`` line here.
> **To remove an agent:** delete both. Keep this list and the directory in lockstep.

## Installed agents (14)

- `auditor` — runs the CLAUDE.md §9.2 audit gate; emits an AUDIT GATE block per §9.3
- `coder` — ship-pipeline stage 2: implements EXACTLY the Planner's kickoff (sonnet, surgical, additive-first)
- `debrief` — session-end summary writer; maintains SESSION_DEBRIEF.md
- `hostile-architect` — 9-phase pre-build stress-test protocol
- `marketer` — anti-slop marketing drafter (DRAFT-only, 4-gate self-audit)
- `mcp-advisor` — enforces VIBE Rule 24 (MCP/Skill-first before custom build)
- `outcome-tracker` — extracts `[rule: X]` / `[outcome: Y]` commit tags into factory-effectiveness
- `planner` — ship-pipeline stage 1: task → kickoff or Bridge Brief (opus, read-only, architect-first gate)
- `resolver` — VIBE Rule 22 conflict resolution (picks one pattern, explains why)
- `reviewer` — ship-pipeline stage 4: adversarial Definition-of-Done gate → PASS/HOLD verdict (opus, read-only)
- `schema-auditor` — DB schema / RLS coverage / Supabase advisor / FK-index audit
- `synthesizer` — weekly cross-project signal synthesis
- `tech-radar` — weekly scan of new models / MCPs / deprecations / pricing
- `tester` — ship-pipeline stage 3: intent-tests + tsc/vitest + verify-with-SELECT (sonnet)

## Ship pipeline (planner → coder → tester → reviewer)

The 4 ship-pipeline agents + the `/ship` command (`.claude/commands/ship.md`) form one
orchestrated loop. They are **project-aware**: each reads the host project's `CLAUDE.md` +
`.claude/rules/*` + `docs/specs/` at runtime, so the same agent files enforce Example Finance App's
compliance/data-flow/traceability discipline in Example Finance App and a different project's rules
elsewhere — no per-project rewrite. Model routing mirrors `model-router.json`
(architecture→opus for planner/reviewer, code_build→sonnet for coder/tester).

**To install into a project:** copy these 4 `agents/*.md` + `commands/ship.md` into the
project's `.claude/`. They activate immediately; no other wiring. (A project may override any
of the 4 with its own `.claude/agents/<name>.md` for project-specific stage behavior.)
