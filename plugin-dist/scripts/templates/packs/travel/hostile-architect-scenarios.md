# Travel — Hostile Architect Scenarios

> **Pack:** `travel`. Stacks on global hostile-architect.md + AI Purchase Research Phase 1.6.

| # | Scenario | Severity | What breaks | Mitigation |
|---|---|---|---|---|
| 1 | Hallucinated hotel URLs | CRITICAL | AI returns plausible hotel URLs that 404 or point to defunct domains | URL validator subagent (same as AI Purchase Research §1) |
| 2 | Stale X sentiment | HIGH | 6-mo-old "destination dangerous" tweet drives present-day rec | `valid_until` column + ignore expired rows + 7-day refresh cron |
| 3 | Missing X_BEARER_TOKEN in prod | HIGH | Pipeline silently fails; sentiment never updates | Health check on every cron run; alert if env var missing |
| 4 | Destination ambiguity (Paris TX vs FR) | HIGH | User sees recommendations for wrong city | Canonical resolution + disambiguation UI before API calls |
| 5 | Family PII leaked to LLM | CRITICAL | Names / ages / allergies sent raw to AI in prompt | Hash + truncate; aggregate profile only; never raw PII |
| 6 | X API quota burn from open-topic stream | HIGH | Forgot keyword filter; budget burned in hours | Wrapper validates ≥1 destination + ≥1 sentiment keyword before call |
| 7 | Sentiment from spam / bot accounts | MEDIUM | Spam tweets skew sentiment toward bot operator's agenda | Filter by account age + tweet count + verified-or-followers-threshold |
| 8 | Flight price from LLM (not real API) | CRITICAL | "$439 flight" hallucinated; user books trusting it, real price $890 | Flight prices ONLY from airline / aggregator API; never AI-generated |
| 9 | Activity URL points to spam review site | MEDIUM | Random blogspot URL with thin content | URL canonical-domain whitelist; non-whitelisted → "verification pending" badge |
| 10 | Currency conversion off | HIGH | $200 displayed as €200 for EU users | Detect user locale + conversion via canonical rate API + show source currency too |
| 11 | Seasonal data shown out-of-season | MEDIUM | "Best ski resorts" in July; "Beach destinations" in January for southern hemisphere | Seasonal tagging on destination + suppress out-of-season recs without explicit query |
| 12 | Cached recommendation stale across booking gap | HIGH | User saved a recommendation; days later prices/availability shifted | Recommendation TTL + "refresh" button + warn before booking |

Run all 12 + the global HA Phase 1.6 (8) = 20 scenarios stress-tested before launch.
