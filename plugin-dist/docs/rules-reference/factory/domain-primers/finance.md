---
paths:
  - "src/**"
  - "supabase/**"
  - "docs/architecture/**"
enforcement_tier: 3
load_bearing: false
---

# Domain primer -- finance / fintech

> **Used by:** /architect-probe when project pack is fintech / finance / Example Finance App.
> Loads automatically as a checklist of universal concerns to add to the persona-probe.
> **Authority:** Companion to `architect-first.md` SS8. Loaded into the probe set, not the auto-loaded rule set.

## Concerns every finance feature MUST address

Every architect-probe pass for a finance feature MUST surface answers to ALL of these. If the verbatim request doesn't answer, the question goes into NEEDS-USER-INPUT.

### Data integrity

- [ ] Money stored as BIGINT cents (per VIBE Rule 9). No float for currency.
- [ ] Money displayed as cents / 100 with explicit currency code. No bare `$3,000`.
- [ ] Two-way drill-down on every dollar number (per `two-way-traceability.md`):
  - Click number -> source rows with date + amount + last-4 of card + import method
  - Click source -> every downstream surface (income statement, cash flow, calendar, tax projection)
- [ ] AI-generated insights logged to `ai_output_provenance` with `sources[]` + `prompt_version`
- [ ] Source data verified via 4-layer DMG (per `data-integrity.md`):
  - Ghost / Cold / Warm / Mature
  - Mature requires verified-source (Plaid signed / Gemini OCR), NOT manual entry
- [ ] Document date != upload date (per lessons-critical.md #50). Documents attributed to the period they cover.

### Tax + regulatory

- [ ] OBBBA disclosures if affected (e.g., $500 housing-deduction cap from 2025+)
- [ ] Tax year explicit on every screen (per VIBE Rule 46): "2025 Federal Tax Return" not "Tax Center"
- [ ] AI disclosure visible at signup (not buried in settings) -- per `compliance.md`
- [ ] State-specific rules surfaced if applicable
- [ ] "Not investment advice" disclaimer if anything resembles SEC RIA territory
- [ ] CPA review workflow if any number is filed
- [ ] Filing status (Single / MFJ / MFS / HoH / QW) explicit on tax screens

### Trust signals

- [ ] Show data basis on every projection ("based on 1 of ~24 expected paystubs")
- [ ] Sparse-data gate: refuse to render confident number when source data is sparse
- [ ] Speculative Mode watermark on every number (not just header) when below Mature
- [ ] Numbers expressed as ranges if cohort agreement < threshold (per `aggregate-design.md`)
- [ ] Empty state copy explicit about what's missing: "Upload W-2 + 3 paystubs to unlock"
- [ ] Auditor 30-second test: "where did this $487 come from?" answerable in 30s from UI

### Production data protection

- [ ] Two Supabase projects: `<project>-dev` and `<project>-prod` (per CLAUDE.md SS5)
- [ ] PITR on Pro tier + daily off-platform pg_dump to B2/S3
- [ ] Restore drill quarterly (per `data-protection.md`)
- [ ] Pre-commit hook blocks destructive SQL without `[approved-destructive]`
- [ ] Migration gates: dev -> tested -> promoted to prod via PR review
- [ ] Audit log: every DDL/DML from MCP logs to `admin_audit_log`

### Privacy + PII

- [ ] NEVER send SSN / EIN / bank account / full-name / full-address to AI APIs (per `privacy.md`)
- [ ] Merchant names truncated to 20 chars before AI
- [ ] All AI calls server-side (no `VITE_` prefix; no `dangerouslyAllowBrowser: true`)
- [ ] Account deletion endpoint exists + tested ("DELETE" typed confirmation)
- [ ] Data export endpoint returns valid JSON of user's full data (GDPR Art 17 / CCPA 1798.105)
- [ ] Aggregate data: cohort_key computed server-side only; anonymous tables have no user_id

### Mode safety (Identity Firewall)

- [ ] currentMode confirmed at session boundary
- [ ] Personal vs Business data NEVER mixed across modes
- [ ] All arrays cleared on mode switch
- [ ] Per-mode helpers (don't share storage between modes)

### Multi-tenant readiness (per VIBE Rule 17)

- [ ] Every UX-affecting value is per-user-configurable from day 1
- [ ] No hardcoded magic numbers in components (`limit(50)`, `min_score = 4.5`)
- [ ] Cron uses dispatcher pattern (one global tick -> dispatch per-user)
- [ ] First test user is user #1 of N, not "the prototype"

### Failure modes specific to finance

- [ ] Plaid down during snapshot -- what happens?
- [ ] Receipt OCR returns garbage -- fallback?
- [ ] User uploads doc for wrong tax year -- silent miscategorize or surface choice?
- [ ] Bank reconciliation disagreement (Plaid says X, manual says Y)
- [ ] Currency conversion (multi-currency household)
- [ ] Account closed but historical data still in app
- [ ] User disputes a balance -- audit chain

### Scale stress tests

- [ ] 200 receipts/month per user -- OCR queue depth?
- [ ] 10 years of transactions -- query plan stays sane?
- [ ] Tax year switch (Jan 1) -- year-end balance frozen correctly?
- [ ] User invites family member -- shared data model exists?

### Auditor questions (always)

- [ ] CPA-readable export format (GAAP-shaped lines, double-entry if asked)
- [ ] Retention policy: deletion-right vs trail-preservation balance
- [ ] AI prompt_version retained per insight forever (or for documented retention period)
- [ ] Cost-basis tracking for tax-loss harvesting (if investment tier)
- [ ] FBAR / FATCA implications if foreign accounts in scope (defer to V2 unless explicit)

## Standard non-goals (suggest deferring unless explicitly in scope)

These commonly get added under scope creep. Default to NON-GOAL:

- Live trading / order execution (regulatory minefield; SEC RIA classification)
- Tax filing / e-file (regulated profession; PTIN required)
- Cryptocurrency cost-basis (complex; tax form 8949)
- International tax (FATCA / CFC / GILTI) -- only if explicitly in scope
- Insurance recommendations (state-licensed activity)
- Health-savings-account contribution advice (touches HIPAA)
- Estate planning / trust formation (legal advice)

## Standard disclosures every finance app needs at launch

- [ ] Privacy Policy reviewed by attorney within last 12 months
- [ ] Terms of Service reviewed by attorney within last 12 months
- [ ] AI Disclosure document (per `compliance.md` SS5)
- [ ] Three-layer disclaimer stack (inline + section + settings full)
- [ ] "Not tax/financial advice" inline on every projection
- [ ] OBBBA-specific notices on affected calculations
- [ ] Account-deletion workflow per state-specific (CA / NY / IL)

## Stakeholders to model in persona-probe (in addition to standard 6)

For finance features, ADD these to the Domain Expert persona's scope:

- CPA who would import the user's export
- IRS auditor doing a Schedule C verification
- State tax department (e.g., CA Franchise Tax Board)
- Banking partner (if any -- Plaid / Mercury / etc.)
- Insurance carrier (if integration in scope)
- Spouse / family member (family tier features)
- Estate executor (eventually -- year 5+ users)

## Cross-rule integration for finance

When this primer is loaded, the architect-probe automatically adds checklist items from:

- `compliance.md` SS3.1 (tax inline disclaimer) + SS4 (OBBBA) + SS5 (AI disclosure)
- `data-protection.md` SS5 (self-check)
- `data-integrity.md` (DMG 4 levels)
- `privacy.md` (PII boundaries)
- `aggregate-design.md` (cohort floors)
- `two-way-traceability.md` (drill-down spec)
- `secrets-handling.md` (token rotation, .env discipline)
