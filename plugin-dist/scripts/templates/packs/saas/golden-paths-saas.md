# Golden Paths — SaaS (vertical pack)

> **Stacks on:** `scripts/templates/shared/golden-paths.md` (factory-level). GP-017 is the canonical dispatcher cost-audit pattern; promoted there 2026-05-13.

## GP-017 — SaaS Dispatcher Cost-Audit (already in shared)

See `scripts/templates/shared/golden-paths.md` GP-017.

## GP-SAAS-001 — Tenant model bootstrap migration

**When:** Bootstrapping any SaaS project on day 1.
**Pattern:** Single migration creates `tenants` + `tenant_users` + `tenant_preferences` + helper functions (`is_tenant_member`, `is_tenant_admin`, `is_tenant_owner`) + a `create_tenant` SECURITY DEFINER RPC that inserts the tenant + owner membership transactionally. Every subsequent tenant-scoped table gets `tenant_id UUID NOT NULL REFERENCES tenants(id)` + RLS using the helpers.
**Why it works:** retrofitting tenancy is a multi-day project + data-loss risk. Day-1 cost is ~2h.

## GP-SAAS-002 — BYOK gateway pattern

**When:** Tenants want to use their own AI API keys.
**Pattern:** `tenant_api_keys` table with KMS-encrypted `encrypted_key`; gateway function reads + decrypts at invocation only; falls back to platform key when BYOK absent; `billed_to` column on `tenant_agent_runs` separates platform-billed from tenant-billed.
**Files:** `supabase/functions/ai-gateway/index.ts`, `src/lib/aiGateway.ts`.
**Why it works:** sells to enterprise (they want to use their own contracts), reduces your platform spend, isolates rotation/billing concerns.

## GP-SAAS-003 — Plan-tier change transactional update

**When:** User upgrades / downgrades plan.
**Pattern:** Single transaction: `UPDATE tenants SET plan_tier = NEW`, `UPDATE tenants SET feature_flags = compute_flags(NEW)`, `UPDATE tenants SET monthly_budget_cents = budget_for(NEW)`, `INSERT INTO tenant_plan_history`. Send Resend email after commit. Reset `budget_exceeded` runs.
**Why it works:** prevents downgrades where feature_flags drift (free tier with Pro features visible).

## GP-SAAS-004 — Cross-tenant isolation test (pre-release gate)

**When:** Before every release that touches RLS, schema, or tenant-scoped tables.
**Pattern:** Run cross-tenant isolation SQL (saas-multi-tenant.md §6) as a CI step. CI fails on ANY non-zero `leaked_rows` count.
**Why it works:** catches RLS regressions at PR time, not production.

## GP-SAAS-005 — Idempotent Stripe webhook handler

**When:** Receiving Stripe webhooks (or any payment-provider webhooks).
**Pattern:** Webhook handler reads `event.id`; checks `webhook_processed (event_id PK, processed_at)` table; if row exists → 200 OK with no work; otherwise INSERT and process in same transaction; rollback on error so retry will re-process.
**Files:** `supabase/functions/stripe-webhook/index.ts`.
**Why it works:** Stripe retries delivery; without idempotency you get duplicate plan upgrades, double refunds, ghost subscriptions.

## GP-SAAS-006 — Dispatcher with timezone + cadence + active-hours

**When:** Scheduled per-tenant work.
**Pattern:** Single pg_cron job ticks every 5 min; SELECTs from `tenant_preferences` where (a) current time in tenant's TZ is within active_hours, (b) `now() - last_dispatched_at > cadence_minutes`, (c) plan_tier allows. Fires per-tenant HTTP POST. Updates `last_dispatched_at` atomically.
**Why it works:** scales linearly with tenant count + respects per-tenant config without proliferating cron rows.
