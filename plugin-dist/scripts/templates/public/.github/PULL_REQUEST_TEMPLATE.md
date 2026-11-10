# Pull Request

## What this PR does

<!-- One sentence. Be specific. "Fix authentication" is vague; "Add 2FA enrollment + enforcement check to auth.md rule" is specific. -->

## Why

<!--
Was this a bug class hit 2+ times? A missing rule? A pack improvement?
Reference the issue this closes (closes #N).
-->

Closes #

## Type

- [ ] Bug fix (rule didn't catch what it should have)
- [ ] New rule
- [ ] New agent
- [ ] New skill
- [ ] New vertical pack
- [ ] New hook
- [ ] Doc / clarification
- [ ] Refactor
- [ ] Breaking change (requires migration steps for existing users)

## Tier

<!-- Which profile tier does this load in? -->

- [ ] Essential (loads in indie-free + all others)
- [ ] Standard (loads in solo-pro and above)
- [ ] Full (loads in senior-dev and above)
- [ ] N/A (doc / tooling / not profile-gated)

## Verifier checks

<!-- Run `forge doctor` before submitting. Paste the output below. -->

```
forge doctor output
```

Must pass:
- [ ] `rules-list` (CLAUDE.md §15 entries match `.claude/rules/*.md` files)
- [ ] `agents-list` (VERSION.md claims match `.claude/agents/*.md` files)
- [ ] `skills-list` (VERSION.md claims match `.claude/skills/<dir>/SKILL.md`)
- [ ] `scripts-list` (referenced scripts exist)
- [ ] `mirror-freshness` (mirrors regenerated if rules changed)
- [ ] `version-citations` (VERSION.md entries have commit-hash references)

## Profile / load matrix update

<!--
If this adds a rule/agent/skill, did you update `.forge/profiles/*.json`?
The agent/skill must be added to `agents_enabled` / `skills_enabled` arrays
for the profiles where it should auto-load.
-->

- [ ] Updated `.forge/profiles/indie-free.json`
- [ ] Updated `.forge/profiles/solo-pro.json`
- [ ] Updated `.forge/profiles/senior-dev.json`
- [ ] Updated `.forge/profiles/agency.json`
- [ ] Updated `.forge/profiles/enterprise.json`

## Docs updated

- [ ] `CLAUDE.md §15` (if new rule)
- [ ] `VERSION.md` (always — with commit hash citation per truth-drift rule)
- [ ] `NEXT_SESSION.md` (if this changes the next-session handoff)
- [ ] `CURRENT_SPRINT.md` (if this completes a sprint task)
- [ ] Per-project README updates if user-facing

## Rule + lesson process compliance

<!--
Per CLAUDE.md §4 Rule 11 (Self-Improvement Loop):
- Bug fixed once = note it
- Bug fixed twice = becomes a rule
- Bug fixed twice across DIFFERENT projects = becomes a global rule

What stage is this PR at?
-->

- [ ] First instance (added to errors-fixed.json only)
- [ ] Second instance (this PR creates a new rule)
- [ ] Class-of-bug across 2+ projects (this PR promotes to global rule)
- [ ] N/A

## Anti-slop check

<!--
Marketing copy + landing page MUST avoid banned words:
Revolutionize, Unleash, Delve, Harness, Elevate, Empower, Seamless,
Cutting-edge, Groundbreaking, Game-changing, Supercharge.
-->

- [ ] No banned words in any user-facing copy
- [ ] N/A (this PR doesn't touch user-facing copy)

## Mirror regeneration

<!--
If this PR adds / removes / renames any `.claude/rules/*.md` file,
mirrors MUST be regenerated.
-->

- [ ] Ran `forge sync` (sync-rules-to-platforms.ps1) and committed updated mirrors
- [ ] N/A (no rule files changed)

## Breaking changes (if any)

<!--
If this changes how existing users' projects behave:
- What changes?
- What's the migration path?
- Is there a `migrate-existing-projects` skill update?
-->
