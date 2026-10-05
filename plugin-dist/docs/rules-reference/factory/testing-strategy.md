---
tier: standard
required: false
profiles: [solo-pro, senior-dev, agency, enterprise]
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "**/tests/**/*"
  - "**/__tests__/**/*"
  - "**/test/**/*"
  - "supabase/tests/**/*"
enforcement_tier: 2
load_bearing: true
enforcement_ref: "vibe-standard.md Rule 35 gates 2-4 (tests green before done; tester agent veto)"
---

# testing-strategy.md -- Test Pyramid, Real-DB Integration, Coverage Floors

> **Authority:** Auto-loaded global rule. Cross-cutting across every project that ships user-facing code.
> **Last updated:** 2026-05-15
> **Companion rules:** `data-protection.md` (dev project not prod for test DBs), `secrets-handling.md` (no real credentials in tests), `data-integrity.md` (100% coverage on money helpers), `auth.md` (real-provider integration, mocked-provider units).
>
> **Standing rule:** Tests that pass against mocks while production breaks are worse than no tests -- they manufacture false confidence. Real DB in integration. Real auth in integration. Mocks only where the external boundary is genuinely out of scope.

---

## Section 1 -- The shape: trophy, not pyramid

The project owner builds V1s -- many small projects, short lifecycles, fast iteration. The classic 70/20/10 pyramid (lots of unit, some integration, few e2e) was designed for monolithic apps with deep domain logic. It is overkill for a V1 with 30 components and 8 Edge Functions.

**Default for VibePromptRig projects: the Kent C. Dodds trophy.** Many integration tests, fewer unit tests, fewer e2e tests, plus a static base (TypeScript + ESLint). Integration tests deliver the most signal per minute at this scale because they hit the seams where bugs actually live (DB, RLS, Edge Function HTTP, auth provider).

Reach for the classic pyramid only when (a) the project has heavy pure-logic surface -- tax calculators, debt amortization, cohort statistics, OCR parsers -- where unit tests pay back faster than integration, or (b) the project is past V2 and unit coverage of business helpers is the cheapest defense against regression.

---

## Section 2 -- What unit tests are for

Pure functions. Money math. Date logic. Validators. Parsers. Business rules with branching. Anything you can call with arguments and assert against a return value, no I/O.

Speed budget: under 10ms each. No DB, no network, no filesystem, no real clock. If a unit test needs to mock a database client or HTTP library to work, the function under test has the wrong shape -- it is doing two jobs (logic plus I/O) and should be split. The pure half gets unit-tested; the I/O half gets integration-tested.

Examples that belong in units: `dollarsToCents(amount)`, `nextBillingDate(plan, anchor)`, `validateRoutingNumber(input)`, `categorizeTransaction(merchant, amount, history)`, `calcEffectiveTaxRate(year, filingStatus, agi)`.

---

## Section 3 -- What integration tests are for

The seams between your code and a real backing service: Supabase Postgres, Edge Function HTTP handlers, RLS policies, auth provider sign-in flows, Stripe webhook receivers (against Stripe test mode), Resend send calls (against the sandbox).

Run against the dev Supabase project (per `data-protection.md` Section 2.2) or a local Supabase instance via `supabase start`. Never against prod. Test data is seeded per-test and torn down after; never assumed to exist.

Integration tests are where you catch RLS misconfiguration, missing indexes producing slow queries, column-name drift between code and live schema (per VIBE Rule 35 gate 5), and migrations that succeed in CLI but break the JS SDK because role grants got stripped (lessons-critical.md #96).

---

## Section 4 -- The real-DB rule (non-negotiable)

**Integration tests MUST hit a real database. Never mock the Supabase client, never mock the Postgres driver, never mock the query builder in integration tests.**

Founder rule: a prior incident had mocked tests passing for weeks while the actual production migration was broken -- the mock had the old schema baked in, so every test exercised an imaginary database that no longer matched reality. The deploy went out green. Production broke on the first real query. Never again.

What this prohibits:
- `jest.mock('@supabase/supabase-js')` in integration tests
- Hand-rolled `MockSupabaseClient` classes returning canned rows
- In-memory stub DBs that pretend to be Postgres but don't run real SQL
- Snapshotting query results and replaying them on subsequent runs

What is acceptable to mock in integration tests:
- **External HTTP APIs** you do not own -- Stripe (use Stripe test mode), Resend (sandbox), Anthropic / OpenAI / Gemini (record-replay or fake endpoint), Twilio
- **Filesystem on Windows CI** when path semantics diverge from prod -- mock the FS adapter, not the business logic
- **Real-time clocks** -- inject a clock dependency (`{ now: () => Date }`) and override in tests; do NOT mock global `Date`
- **Network egress** in test environments that block outbound -- use a local stub server, not in-code mocks

Unit tests CAN mock the DB client because unit tests are not testing DB behavior; they are testing the function above the DB layer. The line is bright: unit = no I/O, integration = real I/O.

---

## Section 5 -- What e2e tests are for

The top 3 to 5 golden-path flows per project. Sign-up plus log-in. Onboarding plus first save. Core action plus result visible. Checkout plus webhook plus paid-tier unlock. Account deletion (per `compliance.md`).

Playwright is the default. Real browser, real DOM, real network to a deployed preview environment or local stack. Headless in CI, headed locally for debugging.

E2e runs on every PR, not on every commit. They are slow (30 seconds to 5 minutes per flow) and flaky relative to integration. Five flows times two minutes equals ten minutes of CI -- acceptable as a gate before merge, prohibitive as a per-commit gate.

Do not write e2e tests for edge cases, validation messages, or error states. Those belong in integration. E2e proves the happy path is wired end-to-end; integration proves every branch.

---

## Section 6 -- Coverage minimums

- **`src/lib/` (business logic helpers): 80% line coverage minimum.** Gate the CI build on it.
- **`src/components/` (UI): no coverage requirement.** UI churns faster than tests can keep up; rely on e2e for golden paths and visual review for the rest. A coverage gate on components produces snapshot rot and tests written to satisfy the percentage rather than catch bugs.
- **Money / tax / financial / cohort statistics helpers: 100% line coverage AND 100% branch coverage.** Required by `data-integrity.md` -- these are the surfaces where a single edge-case miss costs user trust permanently. If you cannot reach 100%, the function is too big or its inputs are too unconstrained; refactor first.
- **Edge Functions: integration coverage on every endpoint.** No line-coverage target; instead, every endpoint has at least one happy-path test and one auth-rejection test (per `auth.md` and `webhook-handling.md`).

Report coverage in CI but do not block on it for components or experimental modules. Block on it for `src/lib/` and money helpers.

---

## Section 7 -- Fixtures, not snapshots

Snapshot tests rot. They lock in whatever behavior existed when the snapshot was first taken -- nobody verifies the snapshot was correct, and the moment something changes intentionally, the snapshot diff is approved without reading. By month six the snapshot is a record of a bug that everyone forgot to look at.

Use named fixtures instead. Store realistic test data in `fixtures/<domain>/<scenario>.json` -- for example `fixtures/transactions/q3-2025-mixed-categories.json`. Tests reference fixtures by id and assert against specific fields, not whole-document equality. When the shape changes, update the fixture deliberately as a separate commit, with a message explaining what changed and why.

Fixtures are versioned in git. Their authorship is auditable. A failing fixture test points at a specific data assumption that broke, not "the output is different than last time."

---

## Section 8 -- What NEVER goes in tests

- **Production credentials** -- no prod Supabase service-role keys, no prod Stripe live keys, no prod Anthropic / OpenAI keys
- **Real user PII** -- no real names, real emails, real addresses, real SSNs, real bank accounts
- **Real customer data** -- never copy a production row into a test fixture, even sanitized; the audit trail is impossible to maintain
- **Live API keys of any kind in committed code** -- test keys go in `.env.test` (gitignored) and CI secrets; per `secrets-handling.md` Section 2, AI sessions never read `.env*` files
- **Real Stripe keys** -- use Stripe test mode (`sk_test_...`) exclusively in test environments; production keys never enter CI
- **Hardcoded tokens for replay** -- if a test needs an auth token, mint a fresh one against the dev auth provider per test

If a test fails because a real-data dependency is missing, the test was wrong. Real data dependencies are integration smoke tests run manually, not automated tests.

---

## Section 9 -- Five-gate Definition of Done reminder

Tests passing is gate 3 of 5. The full gate per VIBE Rule 35:

1. `npx tsc --noEmit` passes (catches what bundlers skip)
2. `npm run lint` passes
3. `npx vitest run` passes (unit + integration)
4. DB round-trip verified -- for any feature that writes data, a SELECT confirms the row exists with correct columns
5. Column-drift grep -- `.from("table").select("col")` strings audited against live `information_schema.columns`

Tests passing alone is not "feature done." A feature with 100% green tests that fails the DB round-trip gate has either a missing test or a bug. The DB round-trip is part of integration testing, not separate from it -- if your integration suite hits a real DB (Section 4), gates 3 and 4 collapse into one and gate 5 stays as a separate grep.

---

## Section 10 -- Verification before launch

Every project must pass these before V1 ship:

- [ ] `npx tsc --noEmit` -- zero errors
- [ ] `npm run lint` -- zero errors
- [ ] `npx vitest run` -- 100% pass on unit + integration suites
- [ ] `npx playwright test` -- 100% pass on the 3-5 golden-path flows
- [ ] Manual smoke of top 3 golden paths in a fresh browser tab (per `auth.md` Section 8 OAuth Fresh Tab Test)
- [ ] Browser DevTools console clean on primary flows (zero errors, zero red warnings)
- [ ] `src/lib/` coverage at or above 80%; money / tax helpers at 100%
- [ ] No real credentials in any test file (grep for `sk_live_`, `sbp_`, `sk-ant-` returns zero)
- [ ] Integration tests run against dev Supabase, never prod (verified via project ID in test config)
- [ ] Stripe webhook tests run against Stripe test mode (verified via `sk_test_` prefix)

If any check fails, ship is blocked. Per Rule 93 in `lessons-critical.md`: never ship with known bugs, errors, dead code, or type-debt.

---

*See `data-protection.md` for the dev-vs-prod rule that test DBs inherit. See `secrets-handling.md` for the prohibition on real credentials in any committed file. See `data-integrity.md` for the 100% coverage requirement on money math. See `auth.md` for auth-flow integration patterns.*
