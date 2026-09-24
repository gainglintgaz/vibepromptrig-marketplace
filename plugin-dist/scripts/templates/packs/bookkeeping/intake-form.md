# Bookkeeping / Document Portal — Client Intake Form

> **Pack:** `bookkeeping`. For any bookkeeper / CPA / agency portal serving multiple end-clients.

## 1. Practice scope

- **Firm size** (solo / 2-5 / 6-20 / 20+ bookkeepers):
- **End-client count** (10s / 100s / 1000s):
- **End-clients log in directly?** (self-serve portal vs bookkeeper-only):
- **Geographic scope** (US / state-specific / multi-state):

## 2. Client mix

- **Industry mix** (services, retail, manufacturing, restaurants, real estate, mixed):
- **Fiscal calendar variants** (Gregorian-only? 4-4-5 retail? 5-4-4? non-Jan FY-start?):
- **Entity types** (S-corp, C-corp, partnership, sole prop, LLC, mixed):
- **Tax filing scope** (federal only? state? multi-state? international?):

## 3. Document flow

- **Source documents handled** (paystubs, W-2s, 1099s, bank statements, GL exports, invoices, receipts, ...):
- **OCR provider** (Gemini Vision / Claude Vision / AWS Textract / custom):
- **Document dedup at ingest** (content_hash UNIQUE on (firm_id, client_id, content_hash)): yes / no (must be yes)
- **Storage** (Supabase Storage / S3 / private NAS for compliance):

## 4. Workflow stages

- **Stages enabled** (upload → OCR → categorize → review → report → export):
- **Trust-Ladder gating** (which stages require Data Maturity Gate Level N?):
- **Bookkeeper review required before client sees report?** yes / no
- **Approval workflow** (single-bookkeeper / 4-eyes / partner-sign-off):

## 5. Reports / exports

- **Report types** (P&L, balance sheet, cash flow, AR aging, AP aging, 1099-NEC summary, payroll summary):
- **Export formats** (PDF, CSV, QuickBooks IIF, ProSystem fx, UltraTax CS, manual):
- **Export relevance enforcement** (tax export = tax items only, audit export = movements only): yes / no
- **Period selectors** (calendar year, fiscal year, custom range, prior-year comparison):

## 6. Regulatory data

- **Year-keyed tax_year_constants table** populated for at least current + previous year? yes / no (must be yes)
- **Constants tracked** (SS wage base, HSA caps, IRA caps, SEP-IRA cap, 401k limit, Section 179, mileage rate, 1099-NEC threshold, 1099-K threshold, EITC AGI floors, state-specific):
- **Citation URLs** in tax_year_constants for every constant: yes / no

## 7. Compliance + audit

- **Two-level RLS template applied** (firm → client → document): yes / no (must be yes)
- **admin_audit_log migration applied**: yes / no
- **Per-client audit log** (who-read-what scoped per client): yes / no
- **Off-platform backup** running daily (pg_dump → B2/S3): yes / no
- **Retention policy** (years documents kept; tied to IRS / state retention requirements):

## 8. Data confidence + Provenance

- **Every currency display has Provenance ancestor**: yes / no (must be yes)
- **OCR confidence threshold** below which numbers DON'T render: e.g., < 0.85 → "review required" flag
- **Manual-entry watermark** (manual-entered numbers always tagged): yes / no

## 9. Recurring detection

- **Cycle-detection respects fiscal_calendars** (4-4-5 etc.): yes / no
- **Recurring rules** (AJEs, AR/AP recurring, payroll recurring): documented per client

## 10. Pre-launch QA gates

- [ ] Two-level RLS applied + cross-tenant + cross-client isolation tests pass
- [ ] All 13 bookkeeping bug-greps clean (or HIT-fixed / HIT-false-positive documented)
- [ ] Provenance component on every currency display
- [ ] tax_year_constants populated + tested with current + previous year data
- [ ] Edge Functions ALL deployed (`supabase functions list` matches `supabase/functions/*`)
- [ ] Document dedup tested — same file twice uploads succeeds + returns existing doc id, no duplicate row
- [ ] Trust-Ladder gating tested — Cold/Warm/Mature transitions render correct stages
- [ ] Export relevance verified — every export contains only items relevant to its context
- [ ] get_advisors clean post-migration

---

*Reference: Example Bookkeeping App harvest at `<example-bookkeeping-app project>/.claude/v4.3-harvest.md` for source intake content + `example-bookkeeping-app-knowledge-transfer-from-example-finance-app.md`.*
