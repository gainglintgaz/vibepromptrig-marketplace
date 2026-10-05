# Discovery: <Feature Title>

> Initiated: <YYYY-MM-DD>
> Author: <AI session id or model>
> Triggered by: <which §2 pattern in discovery-protocol.md fired>
> Status: **DRAFT** | APPROVED | BUILT | VERIFIED
> Sign-off keyword: (set by founder when approved)

---

## 1. Charter

**One sentence:** <what this is>

**One paragraph:** <why this exists, who asked for it, what problem it solves>

---

## 2. Stakeholders + Job-to-be-Done

- **Primary user:** <persona description, real-life — not "users"; instead "a self-employed plumber in SC tracking 1099 income and Schedule C expenses">
- **Secondary users:** ...
- **The single job they're trying to get done:** ...
- **Success criteria (measurable):** ...
- **When they're done:** ...

---

## 3. In-scope (this build)

- [ ] ...
- [ ] ...

## 4. Out-of-scope (explicitly NOT this build)

Naming the anti-scope prevents scope creep mid-build.

- ❌ ...
- ❌ ...

## 5. Functional spec — what the user can do

Walk through every action the user can take.

1. User does X
2. User does Y
3. ...

## 6. Non-functional spec

| Dimension | Target / acceptance |
|---|---|
| Load (concurrent users) | |
| Load (records-per-user) | |
| Latency p95 | |
| Latency p99 | |
| Scale ceiling (records before strategy change) | |
| Auth level (per route) | |
| PII handling | |
| Threat model summary | |
| Accessibility (WCAG level) | |
| Keyboard navigation | |
| Screen reader support | |
| Cost per user / month (at launch) | |
| Cost per user / month (at year 1) | |
| Reliability target (SLO) | |
| Rollback time target | |

---

## 7. Data model

### New tables
```sql
-- minimum spec
CREATE TABLE ... (
  -- columns
);
```

### New columns on existing tables
- `table_name.new_column TYPE` — purpose

### RLS policies (matrix)
| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| Self | | | | |
| Household member (non-admin) | | | | |
| Household admin | | | | |
| Service role | | | | |

### Foreign keys + ON DELETE behavior
- ...

### Indexes
- On every WHERE/ORDER BY column used

---

## 8. Two-Way Traceability contract

Per `.claude/rules/two-way-traceability.md` (load-bearing).

For every quantitative output this feature displays:

| Output (number / claim) | Forward source(s) | Reverse consumer(s) | Vault drill? |
|---|---|---|---|
| | | | |
| | | | |

If AI generates any output:
- **sources[] schema:** required fields and contract
- **Substring-validation strategy:** what's enforced server-side
- **Logged to `ai_output_provenance`?** Yes / No (yes for V1.1+)

---

## 9. Surfaces affected (Gate 2 flow check)

Per `.claude/rules/feature-design.md` Gate 2.

| Surface | Affected? | How |
|---|---|---|
| Dashboard | | |
| Reports | | |
| Calendar | | |
| Tax Center | | |
| Notifications | | |
| Settings | | |
| Vault (receipts/invoices/statements) | | **CRITICAL** — connect every monetary feature to vault drill |
| Personal mode behavior | | |
| Business mode behavior | | |
| Household sharing | | |

If standalone, defend: STANDALONE — <reason>

---

## 10. Nine scenarios (Gate 1)

Per `.claude/rules/feature-design.md` Gate 1.

### Three common scenarios (happy path)
1. ...
2. ...
3. ...

### Three edge cases (unhappy path)
1. ...
2. ...
3. ...

### Three adjacent integrations (data flow elsewhere)
1. ...
2. ...
3. ...

---

## 11. Real-life complexity audit (Gate 4)

Per `.claude/rules/feature-design.md` Gate 4.

**User journey paragraph** with ACTUAL real-life data (a real paystub, a real
receipt, a real bank statement — be specific):

> ...

### Variants the parser/handler MUST support
- ...

### What's deferred (acknowledged, scoped out)
- ...

---

## 12. Compliance + legal exposure

| Check | Verdict |
|---|---|
| Risk tier (Track / Categorize / Export / Educate / Estimate / Prescribe) | |
| Attorney review before launch? | Yes / No |
| CPA review before launch? | Yes / No |
| Disclaimers required (and where placed) | |
| GDPR Article scope | |
| CCPA scope | |
| GLBA scope (if bank data) | |
| Banned-phrase grep clean? | |
| RIA / money transmitter / PTIN territory? | No (confirm) |

---

## 13. Tech stack + integrations

- **New dependencies (npm / Deno):** ...
- **External APIs called:** ...
- **New Edge Functions:** ...
- **New cron schedules:** ...
- **Vendor lock-in introduced + mitigation:** ...

---

## 14. Risks + mitigations

| Risk | Likelihood (L/M/H) | Blast radius (L/M/H) | Mitigation |
|---|---|---|---|
| | | | |
| | | | |

---

## 15. Estimate + timeline

- **Total effort:** Nh
- **Owner split:** Desktop MCP (Xh) / PowerShell client (Yh) / Founder action (Zh)
- **Sprint structure:** N commits, push after each, list:
  - Commit 1: ...
  - Commit 2: ...
- **Reversibility:** every commit revertable independently? Y/N + how

---

## 16. Verification plan

- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `npx vitest run` → ≥ current baseline + new regression tests pass
- [ ] `npm run build` → clean
- [ ] Supabase advisor scan → 0 new ERROR, no new WARN
- [ ] Manual journey: <specific real-life user flow>
- [ ] **Audit fitness (30-second test):** pick any number → drill to source <30s → drill to consumers <30s
- [ ] Anti-fabrication: every dollar wraps in SourceTrace or has `// no-source-needed: <reason>` annotation
- [ ] Vault drill: every monetary number can reach the originating receipt/invoice/statement in the vault
- [ ] Tripwire greps clean per `.claude/rules/traceability.md §4`
- [ ] Compliance banned-phrase grep clean

---

## 17. Roll-back plan

If launch reveals a critical bug:
- Feature flag to disable: `VITE_<FLAG_NAME>=false`
- Migration rollback: `<sql command>` or "additive — no rollback needed"
- Code revert: `git revert <commit-range>`
- User-data integrity: what happens to data created during the broken window?

---

## 18. Sign-off log

| Event | Date | Note / commit |
|---|---|---|
| DRAFT created by AI | YYYY-MM-DD | initial draft |
| BLOCKER questions answered | YYYY-MM-DD | <link to chat / commit> |
| APPROVED by founder | YYYY-MM-DD | verbatim approval: "..." |
| BUILT (commits) | YYYY-MM-DD | <SHAs> |
| VERIFIED (post-build) | YYYY-MM-DD | <link to verification chat> |
| POST-LAUNCH ISSUES | | (added if any) |

---

## 19. Post-build addendum

Filled out AFTER build, before marking VERIFIED:

- What was discovered during build that wasn't in the original spec?
  (If significant, spec is amended retroactively; if not, just noted here.)
- What assumptions in §8 / §10 / §11 turned out to be wrong?
- What's the lesson for the NEXT Discovery Doc?

This section is the feedback loop that makes the Protocol smarter over
time. Read by `rule-decay-scan` skill to surface decayed checks.
