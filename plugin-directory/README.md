# VibePromptRig Lite

Reusable planning, review and diagnosis workflows for AI-assisted development, as plain Markdown. This is the Claude plugin directory edition of VibePromptRig. It contains skills and specialist agents only. It runs no hooks, no scripts and no programs, pre-approves no tools, makes no network calls of its own, and reads no credentials.

This README describes VibePromptRig Lite 5.2.3.

## Install

From the Claude plugin directory, choose VibePromptRig Lite. From the maintainer's marketplace, in Claude Code:

    /plugin install vibepromptrig-lite --marketplace gainglintgaz/vibepromptrig-marketplace

## What is included

Skills (run as `/vibepromptrig-lite:<skill>`):

- `architect-probe`: Optional deep probe for W2/W3 work (Context V2 architecture-and-risk card) when expensive unknowns remain after one proportionate spec.
- `case-study-generate`: Draft a case study for any VibePromptRig project by reading its git log since the last case study, signal-log entries, errors-fixed.json closed entries, and outcome-tracked commits.
- `cross-pollinate`: Find bug classes or golden paths that appear in 2+ projects.
- `half-baked-scan`: Stuck-project detector.
- `next`: The owner's standing end-of-milestone question, answered from live evidence in one fixed shape -- queue state, exact commands and paste prompts per tool, decisions with options/norm/recommendation, evidence-backed gaps (features, trends, APIs, competitors), and tracker updates.
- `preempt-project`: Pre-inject project-specific lessons and signal patterns at scaffold or onboard time.
- `rule-decay-scan`: Quarterly rule-rot detector.
- `second-look`: After a review FAIL/HOLD, or after one repair of the same cause already failed, writes read-only outside-diagnosis prompts for 2+ different tools (grok, antigravity, claude, codex) plus a COMPARE.md to reconcile their answers.

Agents (Claude Code picks them by task, or ask for one by name):

- `auditor`: Runs the CLAUDE.md section 9.2 audit gate -- build clean, tests green, tripwire greps, RLS advisor, registry freshness -- and outputs a structured AUDIT GATE block per section 9.3.
- `coder`: Implements EXACTLY the Planner's kickoff — surgical, additive-first, one commit per step.
- `debrief`: Session-end summary writer.
- `diagnostician`: Read-only root-cause stage.
- `hostile-architect`: Stress-tests plans, briefs, and architecture decisions across 9 phases (Tool Audit + 8 attack phases) before any code is written.
- `marketer`: Anti-slop marketing drafter.
- `mcp-advisor`: Enforces mcp-servers.md (MCP/Skill First).
- `planner`: Turns a one-line task into an executable kickoff after a Context V2 W0-W3 risk decision (one proportionate spec; W2/W3 stop for owner approval).
- `resolver`: When two existing patterns contradict, pick one and explain why.
- `reviewer`: Adversarial final gate.
- `schema-auditor`: Runs the database-schema audit -- RLS coverage, Supabase advisor scan (security + performance), missing FK indexes, FK orphans, and migration-vs-live schema drift.
- `synthesizer`: Weekly cross-project signal + metrics + outcomes intelligence.
- `tech-radar`: Weekly scan of AI providers, MCP registries, and marketplaces.
- `tester`: Writes tests that encode INTENT (not just behavior), runs the project's type-check + test suite, and verifies every DB write with a live SELECT round-trip.

Every skill and agent is an instruction file. When one of them wants to read your project, search it, or run a command such as `git log`, Claude asks for your approval in the normal way. Nothing is approved in advance.

## What is not included

The full edition adds project setup, context checkups, session handoff, an operating-mode switch, a status dashboard, guard hooks that stop destructive SQL and git commands, and the forge command-line tools. Those parts run packaged scripts, so they are not part of this edition:

- `checkup`: skill; runs scripts/forge/checkup.mjs
- `gear`: skill; reads the packaged model router and logs through a script
- `handoff`: skill; runs scripts/forge/session-context.mjs
- `import-history`: skill; runs scripts/forge/session-context.mjs
- `migrate-existing-projects`: skill; runs the onboarding script
- `project-author`: skill; runs scripts/forge/project-author.mjs
- `project-goal`: skill; runs scripts/forge/checkup.mjs
- `refresh-context`: skill; runs scripts/forge/refresh-context.mjs
- `resume`: skill; runs scripts/forge/session-context.mjs
- `setup`: skill; installs rule cards and hooks through packaged scripts
- `truth-audit`: skill; runs scripts/forge/checkup.mjs
- `outcome-tracker`: agent; runs scripts/extract-rule-outcomes.ps1
- `dashboard`: command; runs scripts/dashboard.mjs
- `mode`: command; runs scripts/forge.ps1
- `ship`: command; runs the ship-execute workflow script

## Installing the full edition

The full edition is published from the maintainer's own marketplace. In Claude Code:

1. `claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace`
2. `claude plugin install vibepromptrig@vibepromptrig`

The two editions have different plugin names (`vibepromptrig-lite` and `vibepromptrig`), so they can be installed side by side. The skills that exist in both then appear twice, once under each name. Most people want only one edition.

Source, issues and the full edition's documentation: <https://github.com/gainglintgaz/vibepromptrig-marketplace>.

## Requirements

Claude Code, or another Claude product that loads plugins with skills and agents. Several skills read git history or project files, so they are most useful in Claude Code with a project folder open. Each skill says at the top what it needs.

## Data handling

This edition contains no code. It sends nothing anywhere and stores nothing by itself. Some agents (for example `tech-radar`, `marketer` and `hostile-architect`) ask Claude to search or read web pages with Claude Code's own web tools; those requests follow your permission settings. Files that a skill asks Claude to write (for example a spec or a lessons file) are written into your project, after your approval.

## License

MIT. See `LICENSE`.
