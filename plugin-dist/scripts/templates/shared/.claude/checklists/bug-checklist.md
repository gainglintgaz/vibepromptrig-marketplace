# Bug Diagnosis Checklist (factory template)

> **Authority:** Auto-injected by `onboard-existing-project.ps1` + `scaffold-new-project.ps1` into every new project's `.claude/checklists/`. Generic to all VibePromptRig projects.
> **Source:** Promoted from Example Bookkeeping App 2026-05-13 (PENDING_APPROVALS #16).
> **Verticals:** Domain-specific bug-grep checklists live in `scripts/templates/packs/<vertical>/bug-checklist.md` and stack on top of this one.

---

## When to fill out this checklist

Before touching code on any reported bug, before opening a PR that closes a bug, and as part of the pre-merge gate. Goal: catch the root cause before the fix, prevent "same bug, different shape" recurrences (lessons.md #7).

Tripwire: PR that adds `closes #N` or `fixes:` in commit body without a filled-out copy of this checklist in PR description = pre-merge block.

---

## Section 1 — Reproduction

- [ ] **Steps to reproduce** (numbered, deterministic — anyone on the team can follow):
  1.
  2.
  3.
- [ ] **Environment** (dev / staging / prod, browser+version, OS, logged-in user role)
- [ ] **Frequency** (always / intermittent / first-occurrence / N-of-M attempts)
- [ ] **Data preconditions** (sample data state, RLS context, feature flags ON/OFF)

---

## Section 2 — Observed vs Expected

- [ ] **Actual behavior** (what happens — be specific, include exact error text or screenshot path)
- [ ] **Expected behavior** (what should happen — reference the spec / story / golden-paths.md entry if one exists)
- [ ] **First broken commit** (if known — `git bisect` or pinpoint suspicion)

---

## Section 3 — Layer Classification

Pick ONE primary layer (the layer that caused the bug, not where it surfaced):

- [ ] **UI** — component renders wrong / state management / event handler
- [ ] **API / Edge Function** — endpoint returns wrong data / auth / payload validation
- [ ] **Database** — schema mismatch / missing column in SELECT / FK violation / type drift
- [ ] **RLS / Auth** — policy too permissive or too restrictive / session not propagated
- [ ] **External service** — third-party API / webhook / OAuth / model provider
- [ ] **Build / Deploy** — Cloudflare / Vercel / env var drift / migration not deployed
- [ ] **Schedule / Cron** — task didn't fire / fired but no-op / wrong cron expression

Mark secondary layers that also need touching (multi-layer fixes are common).

---

## Section 4 — Knowledge Check

- [ ] **Have I seen this before?** Grep `errors-fixed.json` for similar root causes. If a match exists, the prior fix was insufficient or this is a NEW class of the same bug (lessons.md #7 — bug-fixed-twice = root cause was wrong).
- [ ] **Is there a related golden path?** Grep `golden-paths.md` for adjacent patterns the bug bypassed.
- [ ] **Is this in lessons.md?** If yes, cite the lesson number. If not and this bug is novel, add a draft lesson to PENDING_APPROVALS.md.

---

## Section 5 — Proposed Fix

- [ ] **One-line summary** of the fix (root cause + change vector)
- [ ] **Files to touch** (paths + reason per file)
- [ ] **Tests to add** (unit + integration + regression-grep)
- [ ] **Migration needed?** If yes, separate the migration commit from the code commit per VIBE Rule 38 + `data-protection.md` §4
- [ ] **Multi-Dimensional Flow check** — does this fix break the metric anywhere else? (Dashboard / Reports / Calendar / Tax / Settings)

---

## Section 6 — Verification (mechanical, not vibes)

Each item must produce a concrete pass/fail artifact:

- [ ] `npx tsc --noEmit` passes (catches what Vite/Turbopack skip — VIBE Rule 35 gate #1)
- [ ] `npm run lint` passes
- [ ] Unit tests added + passing for the regression case
- [ ] **DB SELECT round-trip** — for any data-write fix: run SELECT confirming the row exists with correct columns (VIBE Rule 2 — toast ≠ saved)
- [ ] **Browser click-through** with DevTools console open — primary user flow renders zero console errors
- [ ] **Column-drift grep** — for any data-shape fix: `.from("table").select("col")` strings audited against live `information_schema.columns`
- [ ] **Regression grep** — `grep -rn "<pattern from fix>" src/` returns zero new matches that share the bug shape
- [ ] **errors-fixed.json updated** — root cause + class-of-bug + golden rule appended
- [ ] **golden-paths.md updated** if a new reusable pattern emerged

---

## Section 7 — Vertical-pack bug greps

If this project has a vertical pack with a domain-specific bug-checklist (`bookkeeping`, `ai-purchase-research`, `saas`, `travel`, `example-finance-app-class`), run that checklist's greps now. List which patterns fired:

| Pattern | Result | Status |
|---|---|---|
| | | NO HITS / HIT-FIXED / HIT-FALSE-POSITIVE |

---

## CI integration

Pre-merge CI job template (`.github/workflows/bug-checklist.yml`):

```yaml
name: Bug Checklist Verification
on:
  pull_request:
    types: [opened, synchronize, edited]
jobs:
  verify-bug-checklist:
    if: contains(github.event.pull_request.title, 'fix') || contains(github.event.pull_request.body, 'closes #')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Require bug-checklist sections in PR body
        run: |
          REQUIRED="Section 1|Section 2|Section 3|Section 4|Section 5|Section 6"
          MISSING=$(echo "${{ github.event.pull_request.body }}" | grep -E -v "$REQUIRED" | head -1)
          if [ -n "$MISSING" ]; then
            echo "PR body missing required bug-checklist sections."
            exit 1
          fi
```

---

*Skipping this checklist is the #1 way the same bug gets fixed twice. Use it.*
