# SaaS — Hostile Architect Scenarios

> **Pack:** `saas`. Stacks on global hostile-architect.md.

## SaaS-specific stress-test scenarios

| # | Scenario | Severity | What breaks | Mitigation |
|---|---|---|---|---|
| 1 | Shared-API-key quota burn | CRITICAL | Single tenant burns Finnhub/Perplexity quota for everyone | Per-tenant BYOK gateway OR per-tenant rate-limiter at app layer |
| 2 | Per-tenant cron explosion | HIGH | Adding N tenants = N+ pg_cron rows; doesn't scale | Dispatcher pattern (saas-multi-tenant.md §2) |
| 3 | RLS bypass via service role | CRITICAL | App code uses service-role accidentally; cross-tenant leak | Service role NEVER reaches app server; only Edge Functions, never anon-key + service-role together |
| 4 | Feature-flag drift | MEDIUM | Tenants upgraded to Pro but feature_flags JSONB stale | Plan-change webhook MUST update feature_flags transactionally |
| 5 | BYOK rotation expiry | HIGH | Tenant's key expires; their cron jobs start failing silently | last_rotated_at + 75-day warning + 95-day auto-disable with clear UI |
| 6 | Budget breach without circuit-breaker | CRITICAL | Tenant agent runs unchecked; $5K AWS bill before billing day | tenant_agent_runs + nightly dispatch cost-audit (GP-017) + hard cap |
| 7 | Tenant downgrade keeps features | HIGH | Downgrade endpoint forgot to update feature_flags; user keeps Pro features | Transactional update of plan_tier + feature_flags + budget in one txn |
| 8 | Cross-tenant data leak via JOIN | CRITICAL | RLS misses a JOINed table; user sees other tenants | Cross-tenant isolation test (§6 of saas-multi-tenant.md) before every release |
| 9 | Tenant deletion cascade gone wrong | HIGH | DELETE tenant → orphaned rows OR cascade deletes other tenants' data | RESTRICT on tenants.id FK; explicit cascade only on tenant_users; audit log retained |
| 10 | Webhook replay attack | HIGH | Stripe webhook replayed = duplicate plan upgrade | Idempotency key on every webhook handler (event.id from Stripe) |
| 11 | Onboarding without payment method = AI burn | HIGH | Free trial activates AI features; bad actor signs up 100 accounts | Free tier capped at low budget; AI features gated by payment_method_attached or admin approval |
| 12 | Email provider IP reputation | MEDIUM | Tenant sends spam through your transactional pipeline; your domain blacklisted | Per-tenant email queue + reputation scoring + suspension trigger |
| 13 | Compliance per region | MEDIUM | EU tenant onboards; you've stored their data US-only; GDPR exposure | Tenant region declared at create; data residency policy honored |
| 14 | Backup blast-radius | CRITICAL | One Supabase backup = all tenants in one file; restore restores everyone | Per-tenant pg_dump filtering OR accept and document the global restore behavior |
| 15 | Schema migration locks production | HIGH | ALTER TABLE on large multi-tenant table locks reads for all tenants | Use pg_repack / online migrations; never raw ALTER on multi-million-row tables |

**All 15 mandatory before SaaS ships.** Cross-reference with global HA Phase 1.6 (AI Recommendation Attack) if the SaaS includes AI recommendations.
