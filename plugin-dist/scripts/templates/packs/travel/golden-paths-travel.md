# Golden Paths — Travel (vertical pack)

> **Stacks on:** `scripts/templates/shared/golden-paths.md` (factory-level) + `ai-purchase-research` golden paths (URL validation overlaps).

## GP-TR-001 — X sentiment pipeline with keyword + cost guard

**When:** Pulling X sentiment for any destination.
**Pattern:** Wrapper validates query has ≥1 destination keyword + ≥1 sentiment keyword + `lang:en -is:retweet` + max_results ≤ 100 + cents-spent logged.
**Files:** `src/lib/xSentiment.ts`, `supabase/functions/refresh-sentiment/index.ts`.
**Why it works:** open-topic streams burn budget in hours; keyword-gated calls scale linearly.

## GP-TR-002 — Destination canonicalization

**When:** User enters any destination text.
**Pattern:** Fuzzy match against `destinations_canonical.name` + aliases array. Multiple matches → disambiguation UI with population + region. Single match → store canonical id, NEVER use raw user input downstream.
**Files:** `src/lib/destinationResolver.ts`.
**Why it works:** "Paris" / "Springfield" / "Portland" all ambiguous; passing raw text to APIs produces wrong-city recommendations.

## GP-TR-003 — Sentiment TTL (valid_until + 7d default)

**When:** Storing sentiment scores.
**Pattern:** `valid_until` column; read path WHERE `valid_until > NOW()`; nightly refresh of top-N destinations.
**Why it works:** stale sentiment misinforms users; 7-day TTL balances cost vs freshness.

## GP-TR-004 — Anti-fabrication for travel quotes

**When:** AI generates hotels, activities, flight prices.
**Pattern:** Flight prices ONLY from airline/aggregator API. Hotels validated against canonical DB OR Booking/Hotels.com API. Activity URLs HEAD-validated + canonical-domain whitelist.
**Why it works:** travel misinformation is high-cost (user books, can't get refund); aggressive validation gates trust.

## GP-TR-005 — Family PII via hash + aggregate

**When:** Personalization for family-travel products with traveler ages, allergies, accessibility needs.
**Pattern:** Hash + truncate per-traveler PII before storing. Aggregate family profile (age bands, count, common-restrictions) is what reaches the LLM, never raw traveler records.
**Files:** `src/lib/familyProfileAggregator.ts`.
**Why it works:** privacy.md compliant + AI gets enough signal to personalize without raw PII exposure.

## GP-TR-006 — Per-trip-plan budget cap

**When:** AI agent does multi-source research for one trip plan.
**Pattern:** Hard cap on cents spent per plan (default 30 cents); track in `tenant_agent_runs` (if SaaS) or `x_api_usage` (single-user); on cap → finalize partial + upsell.
**Why it works:** prevents single high-research trip from costing $5 in API calls; revenue-per-plan stays predictable.
