# Bridge Brief — `<feature-slug>`

> The deliverable of the Senior Council (`senior-council.md`). One Bridge Brief per non-trivial feature, lives at `docs/specs/<feature-slug>/bridge-brief.md`, signed off by the founder with the exact phrase **"build approved"** before any code touches the repo.
>
> The six sections below are required. Don't skip any. If a section is "N/A," write why it's N/A explicitly — never leave it blank.

---

## 1. Job-to-be-Done (Product role)

**User:** [Specific persona, not "the user". Name a role, a moment, a context.]

**Sentence:** *"I want to ___ so that ___."* (in the user's own words, not internal jargon)

**Success criteria (one):** The user does X — a verb the user actively performs, NOT a thing they passively see.

**Five states + copy:**
- HIDDEN — when this feature is not in DOM
- LOCKED — when built but not yet earned; copy that says exactly what unlocks it
- PREVIEW — when partial signal exists; copy that discloses sample size
- AVAILABLE — when ready; the primary CTA the user sees
- RECOMMENDED — when proactive surface; copy + the undo escape hatch

**Reviewer test:** *"If I swapped this product's name for [competitor], would this copy still work?"* Answer: **NO** — because [story-specific reason].

---

## 2. Data Contract (Architect + Engineer joint)

**Input rows read:** [list every table/view this feature SELECTs from + the columns]

**Output rows written:** [list every table this feature INSERTs/UPDATEs + the columns]

**Schema additions (if any):**
```sql
-- DDL sketch. Include FK behavior + indexes + RLS policy + DOWN migration.
-- Per VIBE Rule 54 (Schema-First).
create table public.<table_name> (
  ...
);
```

**Indexes required:** [every WHERE / ORDER BY / JOIN column from above gets an index]

**Existing helpers/components/patterns being REUSED:** [per VIBE Rule 16; name them]

**Existing helpers/components/patterns being EXTENDED or CONFLICTED with:** [per VIBE Rule 59; if conflicting, which one wins and why]

**Data flow paragraph:** Input enters via X, persists at Y, is read later by Z. One paragraph max.

**Failure if a downstream layer goes down:** [what stops working — and how the user finds out]

---

## 3. Failure Modes (Engineer + Security joint)

For each failure mode below: **what happens by default**, then **what we'll do instead**.

| # | Failure mode | Default outcome | Our handling |
|---|---|---|---|
| 1 | Empty data (zero rows, zero history) | | |
| 2 | Sparse data (some but below threshold per `data-integrity.md` DMG) | | |
| 3 | Wrong-period data (e.g., 2024 receipt in 2025 view) | | |
| 4 | Concurrent writes (two tabs save at once) | | |
| 5 | RLS denial (user reads another user's row) | | |
| 6 | Network down mid-write | | |
| 7 | AI output malformed / hallucinated | | |
| 8 | Re-clicked button (idempotency) | | |
| 9 | Cron tick missed (window passes empty) | | |
| 10 | Schema drift (column renamed upstream) | | |

**Catch-block policy:** every `try/catch` must (a) re-throw, (b) log with feature-tagged context, or (c) render a user-visible error state. `catch(e) {}` is forbidden (VIBE Rule 52).

---

## 4. Senior Council Findings (the five roles)

### 4.1 Architect — sign-off / veto
- [ ] Data flow approved
- [ ] Reuse-vs-build decision documented
- [ ] No pattern conflicts left unresolved (VIBE Rule 59)
- [ ] Failure-domain mapping complete

**Open vetoes:** [or "none"]

### 4.2 Engineer — sign-off / veto
- [ ] Schema-first complete (PK + FK + indexes + RLS + DOWN migration)
- [ ] N+1 audit clean (VIBE Rule 53)
- [ ] No silent catch blocks (VIBE Rule 52)
- [ ] Test coverage for happy path + ≥1 failure mode
- [ ] `verify:columns` confirms zero drift for the touched tables

**Open vetoes:** [or "none"]

### 4.3 Product — sign-off / veto
- [ ] Job-to-be-Done sentence in user's words
- [ ] Five states designed + copy written
- [ ] Reviewer test passes (NOT a template)
- [ ] Success criterion is a verb the user does, not a thing they see

**Open vetoes:** [or "none"]

### 4.4 Security & Privacy — sign-off / veto
- [ ] Auth requirement specified for every new route/RPC/function
- [ ] RLS policy on every new table
- [ ] No PII to AI APIs (`privacy.md` §1)
- [ ] No `VITE_` prefix on secrets
- [ ] Token registry updated if new secrets added

**Open vetoes:** [or "none"]

### 4.5 Data Citizen — sign-off / veto (see §5 below for the full audit)
- [ ] Every displayed value has Source / Derivation / Destinations / Provenance
- [ ] Provenance component wired
- [ ] 30-second audit-fitness test passes
- [ ] AI outputs (if any) carry `sources[]` with substring-validation

**Open vetoes:** [or "none"]

### 4.6 AI Employee — sign-off / veto (AI-at-Core gate · L102 / VIBE 57, added 2026-06-05)
- [ ] **Removal test:** strip the AI from this feature — **≤50%** of its value remains (≥50% remaining = a bandage → redesign). State the % explicitly.
- [ ] Feature **ACTS** (drafts / automates / reconciles), **SURFACES proactively** (an action queue / on-load, not click-to-generate), and **LEARNS** from the user's corrections — not just displays.
- [ ] Reuses existing intelligence where one exists (no static view bolted over a buried engine) — names the engine.
- [ ] Any new intelligence engine is MOUNTED in the same arc (reachable from a UI surface) — `buriedIntelligence.test.ts` stays green.
- [ ] Sentence #1 of this brief LEADS with the AI capability, before any CRUD.

**Open vetoes:** [or "none"]

### Conflict Log

| # | Conflict | Roles | Resolution | Decided by |
|---|---|---|---|---|
| | | | | |

---

## 5. Data Citizenship Audit (Data Citizen role — see `data-citizenship.md`)

For each value this feature creates or displays, fill the four-trait row.

| Value displayed | Source | Derivation | Destinations | Provenance |
|---|---|---|---|---|
| | | | | |

**Provenance component coverage:** Where in the UI does the user drill from a value to its source row? [exact selector or component path]

**30-second audit-fitness test:** A user looking at <value X> can answer "where did this come from?" and "where else does this end up?" within 30 seconds, from the UI alone. **Pass / Fail / N/A — explain.**

---

## 6. Acceptance Criteria (the gates that block merge)

Before this feature can be marked done:

- [ ] All five Senior Council roles signed off (no open vetoes)
- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npm run lint` — 0 errors
- [ ] `npm run verify:columns` — 0 drift
- [ ] `verify:rls` — every new table RLS-on with policy
- [ ] Browser click-through with DevTools open — primary flow, 0 console errors
- [ ] DB SELECT round-trip — row written matches what the code thinks it wrote
- [ ] Migration applied to dev; `get_advisors` run; no new criticals
- [ ] Provenance component renders on every value listed in §5
- [ ] Bridge Brief signed off: founder reply **"build approved"** [date]

**Founder sign-off:** _____________________ **Date:** ___________

---

# ─────────────────────────────────────────────────────────
# Worked example — Example Agent App Phase 2.2 Outcome Capture UI
# (Real-world example, May 2026. Demonstrates the template
# under live conditions. This is the actual spec that fed the
# Phase 2.2 build session.)
# ─────────────────────────────────────────────────────────

# Bridge Brief — `phase-2.2-outcome-capture`

## 1. Job-to-be-Done

**User:** An alpha tester reading their first Example Agent App daily brief, mid-coffee on a weekday morning, with three minutes before their first meeting.

**Sentence:** *"I want to tell Example Agent App which of today's stories were worth my time, so tomorrow's brief is sharper without me writing a survey."*

**Success criteria (one):** The user **clicks one of {save, dismiss, rate}** on at least one article in the brief — and the click visibly persists across a page refresh.

**Five states + copy:**
- **HIDDEN** — Not in DOM when no brief is rendered (briefs index page; auth-redirect).
- **LOCKED** — Not applicable; outcome capture is available to every authenticated user from brief #1.
- **PREVIEW** — N/A; capture is binary (you did or didn't click).
- **AVAILABLE** — Default state. Three-button bar under each article card: `Save · Dismiss · Rate ★★★★★`. Initial copy hint on first brief: *"Tell me how this landed — your saves and dismisses tune tomorrow's picks."*
- **RECOMMENDED** — After three articles in a row without an outcome captured: gentle inline nudge *"One tap per story, no survey. Even a dismiss helps."* Dismissable.

**Reviewer test:** *"If I swapped 'Example Agent App' for a competitor like Brief.com, would this copy still work?"* **NO** — competitors don't promise the learning loop ("tunes tomorrow's picks"). The copy explicitly references the per-user flywheel.

---

## 2. Data Contract

**Input rows read:**
- `briefs (id, user_id, article_ids)` — the parent brief
- `raw_articles (id, title, source_name)` — for the article displayed
- `article_outcomes (article_id, outcome, rating)` WHERE user_id = current — to render initial bar state on first paint

**Output rows written:**
- `article_outcomes` — via `public.upsert_article_outcome` RPC (already migrated in `20260516000000_phase2_kickoff.sql`)
- `behavioral_events` — mirrored automatically by the RPC; no direct write from this feature

**Schema additions:** None. The `article_outcomes` table + RPC + indexes + RLS shipped in `20260516000000_phase2_kickoff.sql`. The Engineer role audited the migration and found no drift.

**Indexes required:** None new. `article_outcomes_user_idx` and `article_outcomes_user_article_uq` (already present) cover the read + upsert paths.

**Existing helpers/components/patterns being REUSED:**
- `<ArticleOutcomeBar />` component (already imported at `src/app/(dashboard)/briefs/[id]/page.tsx:6`)
- Supabase JS client via `createClient` (server) for read, browser client (RPC) for write
- `upsert_article_outcome` SECURITY DEFINER RPC

**Existing helpers/components/patterns being EXTENDED or CONFLICTED with:** None. The component shell exists; this feature wires it to the RPC.

**Data flow paragraph:** User opens `/briefs/[id]`. Server component reads brief + articles + pre-existing outcomes (RLS-scoped to caller) and paints the bar with stored state. User clicks Save / Dismiss / Rate. Browser calls `supabase.rpc('upsert_article_outcome', {...})`. RPC writes `article_outcomes` row AND mirrors to `behavioral_events` atomically. Server returns the new `outcome_id`. Optimistic UI flips immediately; reconciles to confirmed state on RPC success. On RPC error, UI reverts + shows toast.

**Failure if a downstream layer goes down:** If the Supabase rest endpoint is down, the bar shows a transient error toast and stays in its pre-click state. The user can retry. No data is lost because no optimistic-only path exists for state that isn't server-confirmed.

---

## 3. Failure Modes

| # | Failure mode | Default outcome | Our handling |
|---|---|---|---|
| 1 | Empty data | Bar renders in default `no_action` state | Correct; no special case |
| 2 | Sparse data | N/A | Outcome capture is per-article, not aggregated |
| 3 | Wrong-period data | N/A | Outcomes are immutable post-creation; period = brief_date implicitly |
| 4 | Concurrent writes (two tabs) | Last write wins via RPC `on conflict` upsert | Correct — RPC handles atomically |
| 5 | RLS denial | RPC raises; bar shows toast "Couldn't save — try refresh" | Caught + surfaced; never silent |
| 6 | Network down mid-write | Fetch rejects; UI reverts to pre-click state | Optimistic flip + revert pattern |
| 7 | AI output malformed | N/A — feature is non-AI |
| 8 | Re-clicked button | Same RPC call; idempotent via `(user_id, article_id)` UNIQUE | Correct by design |
| 9 | Cron tick missed | N/A — feature is user-driven, not cron-driven |
| 10 | Schema drift | `verify:columns` catches `article_outcomes` columns; RPC arg drift caught by tsc + integration test |

**Catch-block policy:** Component uses `try { await supabase.rpc(...) } catch (e) { toast.error(...); revertOptimisticState() }`. No silent catches.

---

## 4. Senior Council Findings

### 4.1 Architect
- [x] Data flow approved (read on server, write via RPC, mirror to behavioral_events)
- [x] Reuse-vs-build: REUSE component shell + RPC; no new files except wiring
- [x] No pattern conflicts left unresolved
- [x] Failure-domain mapping complete

**Open vetoes:** none

### 4.2 Engineer
- [x] Schema-first complete (shipped 16e73d3)
- [x] N+1 audit clean — one batch read for outcomes (`.in('article_id', articleIds)`), one RPC per click
- [x] No silent catch blocks
- [x] Test coverage: 1 happy-path click + 1 RPC-failure revert
- [x] `verify:columns` confirms zero drift

**Open vetoes:** none

### 4.3 Product
- [x] Job-to-be-Done sentence in user's words
- [x] Five states designed
- [x] Reviewer test passes (references per-user flywheel)
- [x] Success criterion: USER CLICKS (verb), not "user sees a bar" (noun)

**Open vetoes:** none

### 4.4 Security & Privacy
- [x] Auth requirement: RPC checks `auth.uid()` at entry (already in `20260516000000_phase2_kickoff.sql`)
- [x] RLS on `article_outcomes`: owner-only (already shipped)
- [x] No PII to AI APIs: feature is non-AI
- [x] No `VITE_` on secrets: no new secrets
- [x] Token registry: no changes

**Open vetoes:** none

### 4.5 Data Citizen
- [x] Outcome rows carry `user_id`, `article_id`, `brief_id`, `prompt_version` (nullable; user-direct = NULL), `created_at`, `updated_at` — full provenance
- [x] Provenance affordance: a small `ⓘ` next to the outcome bar reveals "saved by you at <time> · last updated <time>"
- [x] 30-second audit-fitness test passes (see §5)
- [x] No AI outputs in this feature

**Open vetoes:** none

### Conflict Log

| # | Conflict | Roles | Resolution | Decided by |
|---|---|---|---|---|
| 1 | Should `Rate` use ★ 1–5 OR thumbs-up/down? | Product / Engineer | ★ 1–5 — matches `article_outcomes.rating` column (smallint 1..5). Thumbs-up/down would force a column-level redesign. | Engineer (schema constraint) |
| 2 | Should optimistic UI persist across refresh? | Product / Architect | No — refresh always shows server state. Optimistic flip is in-session-only; the source of truth is `article_outcomes` rows. | Architect (no client-only state) |

---

## 5. Data Citizenship Audit

| Value displayed | Source | Derivation | Destinations | Provenance |
|---|---|---|---|---|
| Outcome state (saved/dismissed/no_action) per article | `article_outcomes.outcome` row for `(user_id, article_id)` | Identity (display directly) | `/briefs/[id]` outcome bar · future Voice DNA training (Phase 2.5) · per-user scoring weights (Phase 3) · behavioral_events mirror | `created_at` + `updated_at` on `article_outcomes` row; `behavioral_events` row mirrors each tap |
| Rating value (1–5 stars) | `article_outcomes.rating` smallint | Identity (display as N stars) | Same as above | Same as above |

**Provenance component coverage:** Hover/tap on the outcome bar reveals a `ⓘ` tooltip: *"Saved by you on <date> at <time> · last changed <time>"*. Click on the article title opens `raw_articles.url` in a new tab — the article is its own source row.

**30-second audit-fitness test:** A user looking at "I marked this article as Saved 3 days ago" can hover the bar → see the timestamp; can click the title → see the source article. **PASS.** Forward: future surfaces that consume saves (Voice DNA, scoring weights) are listed in the Destinations column and will themselves need to drill back to this row.

---

## 6. Acceptance Criteria

- [ ] All five Senior Council roles signed off (above) — **DONE in this brief**
- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npm run lint` — 0 errors
- [ ] `npm run verify:columns` — 0 drift on `article_outcomes`
- [ ] `verify:rls` — `article_outcomes` RLS-on with `article_outcomes_owner_all` policy (verified at migration apply)
- [ ] Browser click-through: click Save on one article → refresh → bar still shows "Saved" → check `behavioral_events` row exists with event_type `article_save`
- [ ] DB SELECT round-trip:
  ```sql
  select outcome, rating, created_at, updated_at
  from public.article_outcomes
  where user_id = '<test user>' and article_id = '<test article>';
  ```
  Returns the row written by the click, with matching `outcome` value.
- [ ] No migration in Phase 2.2 (all DDL shipped in `20260516000000`)
- [ ] Provenance affordance (`ⓘ`) renders on the outcome bar
- [ ] Bridge Brief signed off: founder reply **"build approved"** [date]

**Founder sign-off:** _____________________ **Date:** ___________
