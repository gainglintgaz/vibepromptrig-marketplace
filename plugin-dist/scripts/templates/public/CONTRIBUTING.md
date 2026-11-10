# Contributing to VibePromptRig

Thank you for considering a contribution. VibePromptRig is an open-core AI development factory — the engine is MIT licensed and contributions are welcome.

This guide covers what we accept, how to propose changes, and what we won't merge.

---

## What we accept

### Most welcome
- **Bug fixes** for things that should work but don't
- **New factory rules** that prevent a bug class you've hit 2+ times
- **Documentation improvements** (typos, clarity, missing examples)
- **Test additions** for existing rules / agents / skills
- **Per-platform compatibility** (macOS / Linux PowerShell shims, alternative shell support)
- **Translations of public docs** (after v5.1 stable)

### Welcome with discussion first (open an issue)
- New agents
- New skills
- New `forge` CLI subcommands
- New hooks (especially anything that fires on every prompt)

### Vertical packs
- See [vertical pack proposal template](.github/ISSUE_TEMPLATE/pack_request.md) for the process
- Custom packs are co-built with paying Enterprise customers
- Open-core packs are built when there's clear cross-customer demand

### Not accepted
- **Rule changes that loosen safety gates** (e.g., disabling the destructive SQL blocker, removing secret-scanning)
- **Anti-VIBE patterns** (silent catch blocks, hardcoded secrets, fake data, `dangerouslyAllowBrowser: true`)
- **Anything that breaks `forge doctor` 11/0/0/0 baseline**
- **Marketing/SEO additions to factory rules** (rules are about preventing bugs, not promoting anything)
- **Vendor lock-in** (don't add Anthropic-only patterns; if a rule mentions a provider, it must work cross-provider)

---

## Process

### For bugs (small)

1. Search [existing issues](../../issues) first
2. Open a [bug report](.github/ISSUE_TEMPLATE/bug_report.md)
3. If you have a fix: open a PR referencing the issue

### For new rules / agents / skills

1. Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.md) FIRST
2. Wait for discussion + green light
3. Build per the spec patterns in `docs/v4.4/week2-build-specs.md` + `week3-mcp-specs.md`
4. Open PR with full verifier output

### For docs

Just open a PR. No issue needed for docs improvements.

---

## Development setup

```powershell
# 1. Clone
git clone https://github.com/[ORG]/[REPO].git
cd [REPO]

# 2. Install Node (if you want to build the custom MCPs)
# Node 20+

# 3. Verify factory health
.\scripts\forge.ps1 doctor

# Expected (clean v5.0 state):
#   Doctor verdict: 11 pass / 0 warn / 0 skip / 0 fail

# 4. Make your changes
# 5. Run doctor again — verdict must NOT regress
# 6. Run sync if you changed rules
.\scripts\sync-rules-to-platforms.ps1

# 7. Commit + PR
```

---

## Style guide

### PowerShell scripts
- **ASCII only** (no em-dashes, no smart quotes, no emoji). Per CLAUDE.md SS10 — Windows-1252 fallback breaks otherwise.
- **Use bracket dict access**, not dotted (e.g., `$dict['ai-systems']` not `$dict.ai-systems` because hyphens break parsing).
- **Frontmatter on agents + skills** — required fields per `docs/v4.4/week2-build-specs.md` §2.

### Markdown rule files
- **Mirror the voice** of `compliance.md` (terse, prescriptive, examples-driven)
- **Section headers use `## §N` style** OR `## N.` — pick one consistently per file
- **Length budget:** standard tier ~800-1100 words; full tier ~900-1200 words
- **Frontmatter is required** (tier / required / profiles)

### Anti-slop in marketing/copy
Never use:
- Revolutionize, Unleash, Delve, Harness, Elevate, Empower
- Seamless, Cutting-edge, Groundbreaking, Game-changing
- Supercharge

These trigger immediate reviewer rejection in landing copy + case studies + Pack descriptions.

---

## Commit message format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat` / `fix` / `chore` / `docs` / `refactor` / `style` / `test` / `perf` / `security` / `breaking`

Scope: `forge`, `rules`, `agents`, `skills`, `hooks`, `mcp`, `pack-<name>`, `docs`, `ci`, etc.

Subject: imperative, lowercase, no period at end.

Body: explain WHY, not just WHAT. Reference issue numbers (`Closes #N`).

Footer (recommended): commit-hash citation if this is updating something — per `secrets-handling.md` SS9 truth-drift rule.

Example:
```
feat(rules): add accessibility.md (commit references performance.md 9b8df96)

Closes #12

Adds WCAG 2.1 AA mechanical gates as a new factory rule. Loads in
senior-dev+ profile only (full tier) because indie-free + solo-pro
projects often skip a11y until V2.

References Anthropic design:accessibility-review skill.
Cites compliance.md §5.4 for AI-generated UI accessibility scrubbing.
```

---

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). TL;DR: be respectful, be specific, be technical.

---

## Questions

- Discord: [link]
- Email: [maintainer-email]
- Twitter/X: [handle]

For paid support (Enterprise / AI Webmaster customers), see [contracts](../../contracts).
