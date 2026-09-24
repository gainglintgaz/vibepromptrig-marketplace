# Golden Paths — AI Purchase Research (vertical pack)

> **Stacks on:** `scripts/templates/shared/golden-paths.md` (factory-level GPs).
> **Source:** Example Research App sessions. GP-011 through GP-016 already promoted to shared/golden-paths.md by harvest.

---

## GP-011 — 3-layer fabrication defense pipeline

**When:** AI returns product/source/URL recommendations.
**Pattern:** LLM with structured-output schema → URL validator subagent (HEAD requests, browser-UA fallback for 403) → citation cross-check → render.
**File reference:** `src/lib/recommendationPipeline.ts` (3-stage validator chain).
**Why it works:** ~95% reduction in user-visible hallucinated recommendations vs single-pass LLM output.

## GP-012 — Browser-UA fallback for retailer 403

**When:** HEAD request returns 403 to non-browser User-Agent.
**Pattern:** Retry with realistic browser UA + Accept headers. If still 403, render with "verification pending" badge. NEVER drop.
**Why it works:** Major retailers rate-limit non-browser HEAD requests. False-invalidation kills user trust faster than a pending-verification badge.

## GP-013 — Schema fingerprint per prompt_version

**When:** Using structured-output APIs (Anthropic tools, OpenAI structured outputs, Perplexity citations).
**Pattern:** SHA256 of top-level response keys + types stored in `recommendation_audit` table; nightly cron alerts when fingerprint changes for a fixed `prompt_version`.
**Why it works:** Catches silent provider schema changes before parser silently drops fields.

## GP-014 — 90-day blocklist re-review cron

**When:** Maintaining brand/category/merchant blocklists.
**Pattern:** `recommendation_blocklist` table with `last_reviewed_at`. Weekly cron flags entries `last_reviewed_at < NOW() - INTERVAL '90 days'` to PENDING_APPROVALS for re-review.
**Why it works:** Stale blocklists rot; competitor brands appear after acquisitions/rebrands without anyone noticing.

## GP-015 — Per-report scrape budget

**When:** AI agent uses Firecrawl / headless browser per recommendation.
**Pattern:** Per-report cap (e.g., 25 scrapes + 50 cents). Hit either limit → graceful partial-results with "expanded research available" upsell.
**Why it works:** Single runaway report can spike costs 10×. GP-017 (tenant-level) doesn't catch this; per-report cap is the local guard.

## GP-016 — Bot-protection-aware HTTP client

**When:** Verifying retailer URLs.
**Pattern:** Custom HTTP client with: realistic browser UA, Accept-Language, Accept-Encoding, cookie jar, 1-retry policy, and 403/404/timeout differential handling.
**File reference:** `src/lib/retailerVerify.ts`.

---

## GP-AI-PR-001 — Deal score gating by data confidence

**When:** Rendering "PRICE DROP / BEST DEAL" UI.
**Pattern:** Render gate requires (a) min price points per category, (b) min window-days per category, (c) `data_confidence ∈ { high, medium }`. Below threshold renders "tracking — not enough history" instead of a percent.
**Files:** `src/lib/dealScore.ts`, `src/components/DealBadge.tsx`.

## GP-AI-PR-002 — Affiliate URL fallback chain

**When:** Affiliate links rot or get cookie-blocked.
**Pattern:** Daily cron audits all affiliate URLs. On validation fail, renderer falls back to non-affiliate URL with a `affiliate_link_failed_at` timestamp. Manual review queue for repeated failures.
**Why it works:** Affiliate revenue loss without user-experience degradation.
