# AI Purchase Research — Hostile Architect Scenarios

> **Pack:** `ai-purchase-research`. Stacks on global `hostile-architect.md` Phase 1.6 (same 8 scenarios, applied as full HA pass per project).

## Domain-specific stress-test additions

| # | Scenario | Severity | What breaks | Mitigation |
|---|---|---|---|---|
| 1 | Hallucinated URLs | CRITICAL | AI returns plausible-looking but non-existent product URLs | URL validator subagent + 3-layer fabrication defense (see purchase-research-rules.md §1) |
| 2 | Retailer 403 as false-invalid | HIGH | Walmart/Amazon return 403 to HEAD; validator drops good products | Treat 403 separately from 404. Retry with browser UA. Render with "verification pending" badge. |
| 3 | Citation/body URL mismatch | HIGH | LLM hallucinates URL in body that doesn't appear in citations array | Cross-check: every body URL must appear in citations. Body-only = drop. |
| 4 | Double-rating inflation | MEDIUM | User submits same rating twice (refresh / race); aggregate inflated | UNIQUE constraint + 23505-skip (VIBE Rule 37) |
| 5 | Structured-output schema drift | HIGH | Provider quietly changes response schema; parser drops picks silently | Schema fingerprint per `prompt_version` + nightly diff alert |
| 6 | Stale blocklist | MEDIUM | Competitor brand appears as recommendation because blocklist not updated | `last_reviewed_at` column + 90-day weekly cron alert |
| 7 | Uncapped scrape budget | HIGH | Single report triggers 50+ headless browser calls; cost spike | Per-report scrape cap (count + cents) + partial-results graceful degradation |
| 8 | Deal score with <3 price points | HIGH | "BEST DEAL!" rendered for product with only 2 prices; false confidence | Per-category render gate: groceries N=3+14d, electronics N=5+30d, vehicles N=10+90d. Below threshold → "tracking" |

**All 8 scenarios are mandatory in HA Phase 1.6 (see global `hostile-architect.md`).** Failure of any check = CRITICAL hold before ship.

## Additional pack-specific scenarios

| # | Scenario | Severity | What breaks | Mitigation |
|---|---|---|---|---|
| 9 | Affiliate link rot | MEDIUM | Affiliate URLs expire / change format / get cookie-blocked | Daily affiliate link audit; renderer falls back to non-affiliate URL on validation fail |
| 10 | Cross-region price confusion | HIGH | UK / CA / AU users see USD prices without conversion | Detect user locale; render in user currency OR flag "USD only" prominently |
| 11 | Out-of-stock at moment of click | MEDIUM | User clicks → "out of stock" → bounce | Stock-check before render OR clearly labeled "stock not verified" |
| 12 | Refurb / used vs new conflation | HIGH | "$199 deal!" turns out to be used; user reads new | Always tag condition explicitly in product card; never strip from response |

Run all 12 before launch. Document any HIT in `errors-fixed.json` per `bug-checklist.md` Section 7.
