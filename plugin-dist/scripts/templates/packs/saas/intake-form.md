# SaaS — Client Intake Form

> **Pack:** `saas`. For any B2B/B2C SaaS where multiple tenants share infrastructure.

## 1. Tenant model

- **Tenant unit** (per-user / per-team / per-org / per-firm):
- **User count target at launch** vs at 12 months:
- **Single-org-per-user OR multi-org?** (one user can belong to N orgs):
- **Roles within tenant** (owner / admin / member / viewer — list with permissions):

## 2. Plan tiers

- **Free tier** (capabilities + caps):
- **Paid tier names + prices + features per tier**:
- **BYOK supported?** (tenants supply their own AI API keys): yes / no
- **Region restrictions** (US-only? EU-data-residency requirement?):

## 3. Per-tenant configurable values (VIBE Rule 55)

List every UX-affecting value that varies per tenant. Anything hardcoded fails review.

- Schedule / cadence:
- Timezone:
- Recency window:
- Density (max items per surface):
- Filter thresholds (min score, excluded topics):
- Delivery channels (email / push / dashboard / webhook):
- Voice / tone:

## 4. AI / agent design (if applicable)

- **Per-tenant AI budget** (cents/month default per tier):
- **Cost-audit pattern** (80% warning + 100% hard cap → GP-017):
- **Prompt versions tracked** in `tenant_agent_runs` per `prompt_version` field:
- **Provider selection** (per `model-router.json` defaults OR tenant-override via `user_preferred`):
- **BYOK gateway implemented** before AI features ship?

## 5. Onboarding

- **AI-Assisted Discovery (VIBE Rule 56) used for source/config selection?** (default YES — manual forms only as power-user fallback)
- **First 60-second value** — what does the user see/do in their first minute?
- **Payment method required before AI features unlock?** (prevents free-tier abuse / AI burn)

## 6. Data isolation

- **All tenant-scoped tables have `tenant_id` column + RLS policy**: yes / no (must be yes)
- **Cross-tenant aggregate features** (benchmarks, "users like you"): see `aggregate-design.md` for k=N minimums per metric
- **Tenant deletion cascade** (which tables ON DELETE CASCADE, which RESTRICT): document.
- **Per-tenant backup strategy** (global pg_dump or per-tenant exports for portability):

## 7. Cron / scheduled work

- **Dispatcher pattern used** (one global tick per pipeline step → per-tenant dispatch)? (Default YES — see saas-multi-tenant.md §2)
- **Per-tenant timezone respected** in dispatch decisions: yes / no
- **Active-hours window** in tenant_preferences: yes / no

## 8. Compliance + trust

- **SOC2 timeline** (not at launch / 6mo / 12mo / N/A):
- **HIPAA scope** (any PHI? requires BAA):
- **GDPR scope** (any EU users? requires DPA + data export + right-to-erasure):
- **Per-tenant audit log** (admin_audit_log scoped per tenant): yes / no
- **Stripe / payment fraud guards** (Radar enabled, webhook idempotency):

## 9. Webhook / integration boundaries

- **Inbound webhooks** (Stripe / OAuth providers / 3rd-party APIs):
  - Idempotency strategy:
  - Signature verification:
- **Outbound webhooks** (tenant-configurable destinations):
  - Per-tenant rate limit:
  - Retry policy:

## 10. Pre-launch QA gates

- [ ] HA Phase 1.6 (if AI recommendations) + SaaS HA 15 scenarios stress-tested
- [ ] Cross-tenant isolation test query returns 0 rows for all tenants
- [ ] BYOK gateway tested with platform-key fallback (BYOK absent path)
- [ ] Plan upgrade/downgrade flow updates plan_tier + feature_flags + budget in one txn
- [ ] tenant_agent_runs populated for every AI call; budget cap exercised
- [ ] Dispatcher cron tested with N=5 tenants in 3 timezones, 2 cadence settings
- [ ] Webhook idempotency tested with duplicate Stripe event payload
- [ ] Tenant deletion cascade verified — no orphans, no cross-tenant deletion

---

*Reference: Example Agent App harvest at `<Example Agent App project>/.claude/v4.3-harvest.md` for source intake content.*
