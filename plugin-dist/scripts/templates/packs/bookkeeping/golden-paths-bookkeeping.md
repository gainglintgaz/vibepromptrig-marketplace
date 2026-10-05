# Golden Paths — Bookkeeping (vertical pack)

> **Stacks on:** `scripts/templates/shared/golden-paths.md`.

## GP-BK-001 — Two-level RLS bootstrap (firm → client → document)

**When:** Day 1 of any bookkeeping / agency-client portal project.
**Pattern:** Apply `scripts/templates/shared/supabase/two-level-rls.sql` as the first migration. Defines firms / firm_members / clients / documents + 4 helper functions + 5 policy sets. Storage bucket policy template included.
**Why it works:** firm and client isolation must exist before any feature touches data. Retrofitting tenancy is a multi-day project; day-1 cost is ~30 min.

## GP-BK-002 — Provenance component everywhere

**When:** Rendering ANY CPA-reportable number (currency, percent, ratio, dollar amount).
**Pattern:** Wrap or annotate with `<Provenance>` showing: source document, processed-by (OCR provider + prompt_version), confidence level, last-updated timestamp.
**Files:** `src/components/Provenance.tsx`, used in every financial card.
**Why it works:** every wrong number gets challenged → CPA can trace to source in 10 seconds; no Provenance = audit nightmare.

## GP-BK-003 — tax_year_constants table for ALL regulatory data

**When:** Storing any year-specific regulatory threshold or cap.
**Pattern:** Schema in bookkeeping-rules.md §6. NEVER inline literals like `168_600` for SS wage base. Always SELECT by (tax_year, constant_key). Include citation_url.
**Why it works:** thresholds change yearly. Inline literals create silent year-rollover bugs. Year-keyed table makes it explicit + auditable.

## GP-BK-004 — Document dedup via content_hash UNIQUE

**When:** Receiving uploaded documents.
**Pattern:** SHA256 hash of file bytes before storage upload. `UNIQUE (firm_id, client_id, content_hash)` constraint. On 23505 → return existing doc ID silently. NEVER retry with new UUID.
**Why it works:** users re-upload the same paystub when nothing happens visually. Without dedup → ghost duplicates everywhere. VIBE Rule 37.

## GP-BK-005 — Trust-Ladder gated workflow stages

**When:** Workflow with stages (upload → categorize → review → report → export).
**Pattern:** Each stage checks Data Maturity Gate level. Export stage hidden until DMG ≥ Mature (100% docs verified).
**Why it works:** half-complete tax export = lost client trust. Better to hide the button than ship the lie.

## GP-BK-006 — Fiscal-calendar table for non-Gregorian clients

**When:** Recurring detection in fiscal-year clients (retail, manufacturing, school districts).
**Pattern:** `fiscal_calendars` table with calendar_kind enum + fiscal_year_start_month. Recurring engine reads this table when computing cycles.
**Why it works:** 4-4-5 retail calendars silently break with calendar-month assumptions. One column unlocks an entire client segment.

## GP-BK-007 — Post-migration get_advisors gate (global rule, listed here for emphasis)

**When:** After every `apply_migration` for any bookkeeping project.
**Pattern:** Run `get_advisors`; surface findings; commit message contains `Advisors: clean` or finding-list.
**Why it works:** bookkeeping schemas evolve fast (every new report type, every new mapping table). Missing RLS gaps appear in the same session if you check; appear 3 sessions later if you don't.
