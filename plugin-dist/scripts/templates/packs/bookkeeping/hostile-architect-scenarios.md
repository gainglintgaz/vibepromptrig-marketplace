# Bookkeeping — Hostile Architect Scenarios (Example Bookkeeping App-derived)

> **Pack:** `bookkeeping`. 13 financial-grep patterns derived from Example Finance App V1 / Example Bookkeeping App. Each is a known bug shape with concrete grep + severity. See also global `hostile-architect.md` + `scripts/templates/shared/.claude/checklists/bug-checklist.md`.

Run all 13 before any release. Document hits in PR description + `errors-fixed.json`.

---

## Bug 1 — Source-doc YTD/period-totals dropped on upload (HIGH)
- **Shape:** Schema has the column; write path stores; read path's SELECT forgot it. UI never sees stored data.
- **Grep:** `grep -rn "ytd_\|period_total\|cumulative_\|year_to_date" src/ supabase/migrations/`
- **Fix:** verify every column that exists in `supabase/migrations/*.sql` appears in SOME `.select()` call.

## Bug 2 — Tax/effective rate hardcoded (CRITICAL — malpractice exposure)
- **Shape:** Marginal rate hardcoded `22%`/`12%` (no MFJ, no state, no actual brackets).
- **Grep:** `grep -rn "0\.22\|0\.12\|0\.32\|effectiveTaxRate\s*=\s*[0-9]" src/` then `grep -rn "marginalRate\|taxRate" src/ | grep -v "fromBrackets\|computeRate"`
- **Fix:** every rate derives from the tax engine reading `tax_year_constants`.

## Bug 3 — Statutory limits hardcoded with stale value (CRITICAL)
- **Shape:** SS wage base `168_600` for 2026 (correct: `181_800`) — undertaxes by $2,019/yr.
- **Grep:** `grep -rn "168_600\|181_800\|168600\|181800\|wage_base\|wageBase\|sec179\|ira_cap\|hsa_cap" src/`
- **Fix:** year-keyed `tax_year_constants` table (bookkeeping-rules.md §6).

## Bug 4 — Default tax rate baked into a feature (HIGH)
- **Shape:** Gig effective tax rate hardcoded `12%` across multiple files.
- **Grep:** `grep -rn "rate.*12\|rate.*22\|estimatedRate\|defaultRate" src/`
- **Fix:** derive every rate from the tax engine.

## Bug 5 — Form line / report line hardcoded zero (HIGH)
- **Shape:** Form 1040 Line 7 hardcoded `0`; CPA sees placeholder zero identical to real zero.
- **Grep:** `grep -rn "line[0-9]\+:\s*0\b\|line_[0-9]\+:\s*0\b\|line[0-9]\+:\s*null" src/` + `grep -rn "// TODO.*line\|// placeholder.*amount" src/`
- **Fix:** every form line derives from GL or tax engine; null = "no data" rendered explicitly, never silent 0.

## Bug 6 — Year hardcoded (HIGH — silent Jan-1 rollover bugs)
- **Shape:** Tax year hardcoded `2026` in calculations.
- **Grep:** `grep -rn "2024\|2025\|2026\|2027" src/ --include="*.ts" --include="*.tsx"` then `grep -rn "new Date()\.getFullYear()\|Date\.now()" src/`
- **Fix:** every year tied to user-selected period OR queried tax_year, not `Date.now()`.

## Bug 7 — AR/AP hardcoded zero in cash-flow (MEDIUM — CPAs catch fast)
- **Shape:** Business unpaid invoices hardcoded `0` in cash flow.
- **Grep:** `grep -rn "ar:\s*0\|ap:\s*0\|accountsReceivable\s*=\s*0\|invoicesUnpaid\s*=\s*0" src/`
- **Fix:** read AR/AP from real GL data; if missing, gate the cash-flow view.

## Bug 8 — `// Simulated` calculation in production (CRITICAL)
- **Shape:** Consulting billable hours = txCount × 40 with literal `// Simulated` comment shipped to prod.
- **Grep:** `grep -rn "// Simulated\|// simulated\|// fake\|// TODO real" src/` + `grep -rn "× 40\|\\* 40\|hours\s*=.*count" src/`
- **Fix:** remove all `// Simulated` blocks before any commit; pre-commit hook can block.

## Bug 9 — Threshold / cap hardcoded with year-specific value (HIGH)
- **Shape:** OBBBA `$500` housing-deduction threshold hardcoded; Section 179 cap, R&D credit cap, mileage rate, EITC AGI, 1099-NEC ($600), 1099-K threshold all year-specific.
- **Grep:** `grep -rn "section179\|sec_179\|de_minimis\|fringe" src/`
- **Fix:** all in tax_year_constants table.

## Bug 10 — Cycle-detection range too narrow (MEDIUM — fiscal-year clients)
- **Shape:** Recurring engine cycle-range default `25..32` days for monthly — misses 4-4-5 retail calendars.
- **Grep:** `grep -rn "25\s*\.\.\s*32\|cycleDays\|cycle_days\|monthlyRange\|weekly_range" src/` then check for `fiscal\|445\|4-4-5`.
- **Fix:** read calendar_kind from `fiscal_calendars` table (bookkeeping-rules.md §7).

## Bug 11 — Modal hardcodes object fields to 0 after parser returns values (HIGH)
- **Shape:** Edit modal initialized fields to `0` AFTER parser extracted them — overwrites parsed data with zeros.
- **Grep:** `grep -rn "useState.*0\|defaultValue=\\{0\\}\|defaultValues.*0" src/components/ src/pages/ --include="*.tsx"` then `grep -rn "const \\[.*\\] = useState<.*>(0)" src/`
- **Fix:** initialize from parsed data when available; null/undefined when not.

## Bug 12 — Read path drops fields write path stores (HIGH)
- **Shape:** Migration added a column. Write path inserts. SELECT clause forgot the column. Tests counted rows not fields.
- **Grep:** `diff <(grep -hoE "ADD COLUMN \w+" supabase/migrations/*.sql | sort -u) <(grep -hoE "select\\(['\"][^)]*['\"]\\)" src/lib/ -r | sort -u)`
- **Fix:** schema columns ⊆ select clauses. Add a CI check.

## Bug 13 — Edge Function / cron shipped but never deployed (CRITICAL — silent for weeks)
- **Shape:** Aggregate-rebuilder code complete (665 lines), migration applied, cron scheduled — `supabase functions deploy` never run. Cron fires into 404 for weeks.
- **Verification:** `supabase functions list` confirms function name appears; `curl -X POST <function-url>` returns 200; cron logs show ≥1 success after 24h.
- **Fix:** post-deploy CI check that runs `functions list` and asserts every function in `supabase/functions/*` is in the list.

---

*Static grep is necessary but NOT sufficient. Live verification of Edge Functions + cron is the only real check. Run the bookkeeping bug-greps AND verify deployment for any new serverless code before claiming a feature done.*
