# VibePromptRig Lite

Reusable planning, review and diagnosis workflows for AI-assisted development, as plain Markdown. This is the Claude plugin directory edition of VibePromptRig. It contains skills and specialist agents only. It runs no hooks, no scripts and no programs, pre-approves no tools, makes no network calls of its own, and reads no credentials.

This README describes VibePromptRig Lite 5.2.5.

## Start here

Three skills cover most work. Run each as `/vibepromptrig-lite:<skill>`.

1. `second-look`: when a review or fix has failed, get written prompts for two or more other AI tools (Grok, Codex, Antigravity, Claude) to diagnose the same problem independently, plus a file to compare their answers.
2. `architect-probe`: before building something risky or unclear, stress-test the plan and record the decisions in one spec.
3. `next`: after any milestone, get the current state, the exact next commands and a recommendation.

New project? Run `setup-lite` first. Stopping for the day or out of usage? Run `handoff-lite`, then `resume-lite` when you come back.

## Install

From the Claude plugin directory, choose VibePromptRig Lite. From the maintainer's marketplace, in Claude Code:

    /plugin install vibepromptrig-lite --marketplace gainglintgaz/vibepromptrig-marketplace

## What is included

Skills (run as `/vibepromptrig-lite:<skill>`):

- `architect-probe`: Stress-test a risky or unclear change before you build it.
- `case-study-generate`: Draft a project case study from git history, closed bug fixes and project notes.
- `cross-pollinate`: Find bug types and proven patterns that show up in two or more of your projects, and suggest which ones deserve a shared rule.
- `half-baked-scan`: Spot a stalled project: unfinished features, stale tasks, TODO markers and old open bugs.
- `next`: Answers \"what is next\" after a milestone: current state, exact commands and prompts for each AI tool, decisions with a recommendation, gaps and tracker updates.
- `preempt-project`: Before a new project starts, seed a short lessons file with the most likely mistakes, drawn from past projects and shared lessons.
- `rule-decay-scan`: Find project rules that were never used or not edited in over six months and propose which to archive.
- `second-look`: After a failed review or fix, write read-only prompts for two or more different AI tools to diagnose the same problem, plus a file to compare their answers.
- `setup-lite`: Set up a project for AI-assisted work with five questions.
- `status`: Print a one-screen project status from git and project files: goal, recent changes, uncommitted work, open to-dos and blockers.
- `handoff-lite`: Write a short HANDOFF.md so another AI tool or a later session can continue: goal, what is done, decisions, what failed and the next step.
- `resume-lite`: Pick up from HANDOFF.md: read the note, re-check the repository against it, and propose one next step.
- `pre-ship-check`: On-demand checklist before you commit, merge or deploy: secrets, scope, tests, risky changes and a diff review.

Agents (Claude Code picks them by task, or ask for one by name):

- `auditor`: Pre-ship audit: checks the build, tests, risky-pattern searches and registry freshness, then reports a structured pass or fail block.
- `coder`: Implements exactly the approved plan with small, additive changes and one commit per step.
- `debrief`: Writes an end-of-session summary from recent commits, open to-dos and notes into SESSION_DEBRIEF.md.
- `diagnostician`: Read-only root-cause analysis after a failed review: traces the exact failure, explains why tests missed it and proposes the smallest fix before anyone repairs it.
- `hostile-architect`: Stress-tests a plan or architecture before any code is written and returns findings ranked by severity.
- `marketer`: Drafts landing pages, case studies, posts and press copy in your voice, then self-checks for filler words and unsupported claims.
- `mcp-advisor`: Before you build a custom tool, checks whether an existing MCP server, skill or marketplace plugin already does the job, and asks for a written reason if you build anyway.
- `planner`: Turns a one-line task into an executable plan sized to the risk.
- `resolver`: When two existing patterns in your project contradict each other, picks one and explains why instead of blending them.
- `reviewer`: Final adversarial review of a diff against the project's done-criteria and risk searches, ending in a PASS or HOLD verdict.
- `schema-auditor`: Audits a Postgres or Supabase database: row-level security coverage, advisor findings, missing indexes, orphaned rows and drift between migrations and the live schema.
- `synthesizer`: Weekly look across projects for repeated pain points, matched against which rules helped, with specific rule changes proposed for your approval.
- `tech-radar`: Weekly scan of AI providers and marketplaces for new models, breaking changes, deprecations and price changes; anything needing your decision is flagged.
- `tester`: Writes tests that check intent, not just current behavior, runs the project's type-check and tests, and reports honestly when they fail.

Every skill and agent is an instruction file. When one of them wants to read your project, search it, or run a command such as `git log`, Claude asks for your approval in the normal way. Nothing is approved in advance.

## What is not included

The full edition adds project setup, context checkups, session handoff, an operating-mode switch, a status dashboard, guard hooks that stop destructive SQL and git commands, and the forge command-line tools. Those parts run packaged scripts, so they are not part of this edition. Lite has Markdown versions of several of them (`setup-lite`, `status`, `handoff-lite`, `resume-lite` and `pre-ship-check`) that do the same job by asking and reading, without scripts or guard hooks:

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

Privacy policy: `PRIVACY.md`. Terms of use: `TERMS.md`. Both ship in this plugin.

## License

MIT. See `LICENSE`.
