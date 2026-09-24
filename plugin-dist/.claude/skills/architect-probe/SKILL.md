---
name: architect-probe
description: Optional deep probe for W2/W3 work (Context V2 architecture-and-risk card) when expensive unknowns remain after one proportionate spec. Can fan out risk-selected persona reviewers to surface specific questions, batch one clarification round with the project owner, and record the findings in the change's single spec artifact. Not required for W0/W1 work; persona count is chosen by risk, not fixed.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - Edit
  - Agent
  - AskUserQuestion
  - WebFetch
  - WebSearch
---

<!-- Justified: This skill orchestrates risk-selected persona-probe subagents (none to all of the menu). It does NOT itself
implement search/scrape/parse functionality. Where research is needed (Step 5),
it delegates to existing tools: firecrawl:firecrawl-search for doc-search,
mcp-registry:search_mcp_registry for tooling lookups, WebFetch for cited docs.
No new utility code; this is a behavioral protocol. -->

# /architect-probe -- risk-scaled pre-build probing (optional W2/W3 escalation)

## When to invoke

Risk decides, per the Context V2 card `.forge/context/rules/architecture-and-risk.md`
(W0 read-only/tiny, W1 bounded feature, W2 auth/schema/AI/sensitive/cross-cutting, W3
production/destructive/regulated release). Every non-W0 change gets ONE proportionate spec
artifact with risk, assumptions, acceptance, rollback and review requirement recorded.

This skill is an escalation tool, not a mandatory gate:

- **W0/W1:** do not invoke. Record the risk class and proceed with the proportionate spec.
- **W2/W3:** invoke when expensive unknowns remain after that spec (new project or sprint
  foundations, new domain entity, money/AI/regulated surfaces, multi-tenant boundaries). W2 still
  gets its targeted independent review and W3 its security/release gates either way.
- Choose personas by the risks actually open; the six below are a menu, not a quota. Skip
  questions unrelated to risk, and never produce a second discovery artifact for the same change.
- Output goes into the change's ONE spec (Step 7): the planner's `docs/specs/<slug>/spec.md`
  when it exists. Create a spec only when the change has none yet -- never a second one.

The legacy mandate text this replaces is preserved for reference in
`docs/rules-reference/factory/architect-first.md` (not auto-loaded).

## Inputs

Required:
- The verbatim founder request (whatever the project owner said)
- Project name (for domain primer loading)

Optional:
- Existing project state (the skill will read STATE.md / CURRENT_SPRINT.md / BRIEF.md if present)
- The change's existing spec (e.g. `docs/specs/<slug>/spec.md` from the planner) -- the probe
  writes into it
- Prior specs for related features (for consistency)

## Algorithm

### Step 0 -- Foundational Requirements (NEW PROJECT / NEW SPRINT ONLY) (3 min)

**Gate:** this step runs ONLY when the trigger is a **new project or a new V1.X sprint**.
For a feature-level probe inside an existing project, SKIP Step 0 -- the project's
foundations are already decided; record `Foundational scope: feature` in the spec
and go straight to Step 1.

**Why this exists (architect-first.md §0.5):** two ~95%-done retrofits in one session --
the Node cross-platform port and the de-personalization/identity scrub -- were the
silent-assumption failure applied to FOUNDATIONS, not features. The non-functional
foundations are the most expensive things to reverse, so they are decided FIRST,
before any feature persona runs.

Force EXPLICIT answers -- never defaulted -- to all six. Present them to the project
owner with a best-guess default + risk-if-wrong (same shape as a blocker question),
because these are the project owner's call, not the agent's:

```
==== architect-probe STEP 0: Foundational Requirements ====

These six are expensive to reverse. Decide them now, not at 95% done.
(best-guess default + risk-if-wrong shown; correct any line)

1. Target OS / platforms     -- default: <guess>   risk if wrong: full port later
2. Runtime / language        -- default: <guess>   (available on ALL targets above?)
3. Audience: me-only / others -- default: <guess>  risk if wrong: de-personalization retrofit
4. Tenancy: single / multi   -- default: <guess>   (per VIBE Rule 17)
5. Distribution model        -- default: <guess>   local / plugin / SaaS / installable
6. Data + privacy boundary   -- default: <guess>   what never leaves the device/tenant
```

Use `AskUserQuestion` (max 4 per call) for any of the six whose wrong-guess has HIGH
blast radius. The answers populate the **§0 Foundational Requirements** section of the
single inception spec (Step 7), whose header is set to `Foundational scope: inception`.

**Rule of thumb:** if the answer to #1 or #3 implies "others" or "cross-platform," the
project is built in the portable runtime (e.g. Node) and de-personalized from the FIRST
commit -- never as a retrofit. The verifier
`scripts/verifiers/verify-foundational-requirements.mjs` (forge doctor) flags an
inception spec under `docs/architecture/` or `docs/specs/` that declares `Foundational scope: inception` without all six
answers filled.

### Step 1 -- restate + ambiguity inventory (2 min)

Output to terminal:

```
==== architect-probe: <feature-name> ====

VERBATIM REQUEST:
> <paste exactly what the project owner said>

IMPLICIT INTERPRETATION CHOICES I would otherwise make silently:
1. <noun X> -- I'd default to <smaller interpretation>; ambitious read: <bigger>
2. <adjective Y> -- I'd default to <thing>; alternative: <thing>
3. <verb Z> -- I'd default to one-shot; alternative: continuous / scheduled
...

RISK CLASS: <W2 | W3>   OPEN RISKS: <the expensive unknowns still unanswered by the spec>
PERSONAS SELECTED: <name -- the open risk it covers>, ... (none if research alone closes them)
PERSONAS SKIPPED: <name -- why no open risk needs it>, ...
```

### Step 2 -- load domain primer (1 min)

Detect the project's pack from `<project>/.forge/profile.json` or `.claude/CLAUDE.md` header. Map to:

| Pack | Primer (factory reference; resolve under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root) |
|---|---|
| fintech, finance, Example Finance App | `docs/rules-reference/factory/domain-primers/finance.md` |
| saas, Example Agent App | `docs/rules-reference/factory/domain-primers/saas.md` |
| bookkeeping, Example Bookkeeping App | `docs/rules-reference/factory/domain-primers/bookkeeping.md` |
| ai-research, Example Research App | `docs/rules-reference/factory/domain-primers/ai-research.md` |
| travel, Example Wellness App | `docs/rules-reference/factory/domain-primers/travel.md` |
| (none / unknown) | `docs/rules-reference/factory/domain-primers/generic.md` |

Read the primer. Its universal-concerns checklist is added to the probe set.

**Project domain-persona question banks (progressive disclosure).** A project
may define extra domain personas beyond the menu below, keeping their question banks OUT of
the auto-loaded rules and in a reference file, so the banks cost tokens only when a probe
actually runs. The project's discovery protocol names each persona +
focus and points at the reference file; the banks themselves live there. **This skill is
the named loader** -- if the banks are not read here, they are never read at all.

Resolution (project-relative -- never hardcode an absolute or machine-specific path):

1. Read the project's own discovery protocol if it keeps one (`<project>/.claude/rules/discovery-protocol.md`
   or `<project>/docs/rules-reference/discovery-protocol.md`), else the factory reference
   `docs/rules-reference/factory/discovery-protocol.md` (resolved under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root,
   when packaged). If it points at a reference file
   (conventionally `<project>/docs/rules-reference/discovery-protocol-personas.md`), read
   that file and add its persona banks to the Step 3 menu.
2. Fallback: if the pointer exists but the file does not (reference tier not yet pulled into
   this checkout), read the banks from `discovery-protocol.md` itself -- pre-move versions
   retain them inline.
3. If neither has them, note it in the artifact and proceed with the primer alone.

Project domain personas join the Step 3 menu; select one when its trigger in the project's rule
file matches an open risk of this change (a trigger can make that persona BLOCKER tier for the
feature). Honor any ordering the rule file mandates for the personas you select. Also load the per-feature persona
scoring rubric (conventionally §5 of the same reference file) if present.

Worked example -- Example Finance App (`example-finance-app`), established by Example Finance App PR #61: four
personas at §1-§4 of the reference file (10a Senior CPA / Tax Specialist, 10b Senior Privacy /
Compliance Auditor, 10c Senior Plaid / Bank-Sync Integrator, 10d Senior Vault Integrator),
6 / 5 / 4 / 6 questions respectively = 21 in total, plus the §5 scoring rubric. (Counted from
the file, 2026-07-24 — the earlier "6 each = 24" was an estimate, and the count is a sanity
check on the load, not a quota: if a bank comes back short, the reference file moved or was
trimmed.) Per that rule file, 10c fires only for
features touching financial accounts, and 10d's first question is asked FIRST for any feature
displaying a dollar figure.

### Step 3 -- spawn the selected persona subagents (5-15 min)

Select personas from the menu below (plus any project domain personas from Step 2) by the open
risks named in Step 1 -- no fixed count. Typical W2: the one to three personas whose focus matches
the unknowns. W3 adds whichever of Hostile Architect / Auditor its security or release gates need.
If research alone closes every open risk, select none and go to Step 5.

Use the Agent tool with subagent_type=general-purpose (or Explore where read-only suffices). Send ONE message with one Agent tool call per selected persona, in parallel.

Each persona prompt has this shape:

```
You are <persona description>. You are reviewing a feature request before any code is written. Your job is to produce up to 10-15 SPECIFIC questions about THIS feature that a senior <persona> would ask, limited to these open risks: <open risks this persona covers>.

VERBATIM REQUEST: <restated above>

PROJECT CONTEXT: <one paragraph from BRIEF.md, plus pack name>

DOMAIN PRIMER LOADED: <name>

YOUR FOCUS AREAS: <persona-specific>

PRODUCE: specific questions in the form "When X happens, what Y?" or "How does the system handle Z?" or "Does the user expect A or B?" Each question must be answerable with a concrete decision, not "it depends."

CONSTRAINTS:
- Do NOT propose implementations. Only ask.
- Do NOT ask vague questions ("what data is needed?"). Be specific.
- Do NOT ask ritual questions unrelated to the open risks above.
- Each question should be answerable in <= 2 sentences of decision by the project owner.
- If you can confidently answer a question from the verbatim request + context, mark it (ANSWERED) and provide your read.
- If you need factual research (regulation text, API spec, third-party docs), mark it (NEEDS-RESEARCH).
- Otherwise mark (NEEDS-USER-INPUT).
```

#### Persona 1: Senior Architect

Focus: system design, integration points, data ownership, scale architecture, observability.

Sample shapes:
- "Does X own the data, or does Y, or do they share?"
- "Is the consumers index static or query-derived?"
- "What's the canonical helper for this metric -- new file or extend existing?"
- "Where does the cron live (Edge Function vs scheduled task vs pg_cron)?"
- "Multi-tenant: is the per-user setting in user_preferences or per-org?"

#### Persona 2: Senior Engineer

Focus: implementation reality, edge cases, failure modes, idempotency, deps.

Sample shapes:
- "What happens when <external dep> is down?"
- "Idempotency: what prevents <duplicate-creation scenario>?"
- "What's the failure mode when source_kind is unknown?"
- "How is this tested -- unit, integration, e2e?"
- "What does the schema migration look like -- DOWN included?"

#### Persona 3: Domain Expert

Picked by domain:
- Finance -> CPA + IRS auditor mindset (taxes, OBBBA, deductions, audit trail)
- Bookkeeping -> client-CPA workflow + state-board compliance
- SaaS -> SOC2 / GDPR controller + multi-tenant SLA
- Health -> HIPAA / HHS audit / PHI handling
- Legal -> bar association / privilege / state-specific
- Generic -> regulatory researcher

Sample shapes (finance):
- "Does this trigger SEC 'investment advisor' classification?"
- "Is the user shown a 'not advice' disclaimer per FINRA?"
- "What's the audit retention requirement?"
- "How is cost-basis tracked for tax-loss harvesting?"
- "Multi-state user: how does state-specific tax law surface?"

#### Persona 4: End User

Focus: literal usage, expectations, competing-product mental models, complaints.

Sample shapes:
- "If I click X, do I expect a sheet, a modal, or a navigation?"
- "Is this on the Dashboard, or only on a dedicated page?"
- "Can I see how today's number compares to last week / month / year?"
- "If I'm a family-tier user, does my spouse see the same thing?"
- "If I delete my account, is the historical data exportable first?"

#### Persona 5: Hostile Architect

Focus: second-time use, scale, failure, malicious user, edge data.

Sample shapes:
- "What happens with 200 accounts (advisor managing portfolios)?"
- "What if Plaid token expires mid-snapshot?"
- "What if two devices write simultaneously?"
- "What's perf with 10 years of monthly snapshots?"
- "What if a user uploads 50 receipts at once -- does the parser hold up?"

When selected for W3 work, or where failure at scale is the open risk, the Hostile Architect persona also runs the 8-phase stress-test from `hostile-architect.md` SS1-SS7 against the feature.

#### Persona 6: Auditor

Focus: trail, evidence, retention, recoverability, 30-second test.

Sample shapes:
- "If a tax auditor asks 'where did this $487 come from', can a non-engineer answer in 30 seconds?"
- "Is the AI insight logged with prompt_version + sources[] for forensic replay?"
- "What's the retention policy -- deletion right vs trail preservation?"
- "If a user disputes a balance, what's the audit chain?"
- "Can the auditor cross-reference this number to source documents the user uploaded?"

### Step 4 -- aggregate + dedupe + categorize (3 min)

Collect the selected persona outputs. Merge. Dedupe by semantic similarity (a question about "what happens with 200 accounts" from architect and a question about "scale with 200 accounts" from hostile arch are duplicates).

Categorize each surviving question into:

| Bucket | Action |
|---|---|
| ANSWERED-FROM-PROMPT | Note the answer; include in artifact directly |
| NEEDS-USER-INPUT | Group + present to the project owner in one batch |
| NEEDS-RESEARCH | Research before next step |

### Step 5 -- research the NEEDS-RESEARCH items (5-10 min)

For each NEEDS-RESEARCH question, pick the appropriate existing tool. This skill does NOT implement research; it delegates:

- Regulatory questions -> firecrawl:firecrawl-search on cited.gov / IRS.gov / SEC.gov / state-specific
- Third-party API questions -> WebFetch on the API docs page
- "Is there an MCP / skill that covers this" -> mcp-registry:search_mcp_registry + Anthropic Skills marketplace
- Competitor product questions -> firecrawl:firecrawl-search + firecrawl:firecrawl-scrape on competitor pricing pages
- Library / package questions -> WebFetch on npm/pypi page

Cap research at 10 minutes total. If a question needs more, mark it RESEARCH-DEFERRED and surface to the project owner.

### Step 6 -- batched the project owner clarification (one round)

Present NEEDS-USER-INPUT questions to the project owner in ONE structured message, grouped by topic. Format:

```
==== Clarifications needed before I can finalize the spec ====

GROUP A: Scope + ambitions (N questions)
A.1 ...
A.2 ...

GROUP B: Data + persistence (N questions)
B.1 ...

GROUP C: Stakeholder + UX (N questions)
C.1 ...

GROUP D: Failure modes + scale (N questions)
D.1 ...

For each, provide a one-line decision. If you want to defer, write [defer to V1.2] or [skip].
```

Wait for the project owner's batch response. ONE round. Do not chain 47 messages.

### Step 7 -- record findings in the single spec (5-10 min)

There is exactly ONE spec per change. Write the probe results into it; never create a second
discovery artifact next to it:

- **The change already has a spec** (normally the planner's `docs/specs/<slug>/spec.md`): add or
  update its probe sections in place -- open risks, the answers from Steps 4-6, assumptions and
  non-goals needing `[approved]`, acceptance, rollback, and the review requirement.
- **No spec exists yet** (the probe was invoked directly): create one. Feature work goes to
  `docs/specs/<slug>/spec.md`. A new project / new sprint (Step 0 ran) goes to
  `docs/architecture/<sprint-name>.md`; the inception gate scans both spec locations.

Use sections of `scripts/templates/ARCHITECTURE.md.template` only where they carry an open risk;
the architecture-and-risk card's minimum is risk, assumptions, acceptance, rollback and review
requirement. Present items needing the project owner's `[approved]` annotation prominently.

For a **new project / new sprint**: set the header's `Foundational scope: inception` and fill the **§0 Foundational Requirements** section from Step 0 (all six answers), including when updating an existing spec under `docs/specs/`. For a **feature probe**: omit §0 (a spec declares `Foundational scope: feature`). The `verify-foundational-requirements.mjs` gate (forge doctor) scans `docs/architecture/` and `docs/specs/` and flags an inception spec missing §0 or with any of the six fields left blank.

### Step 8 -- approval gate

Surface to the project owner:

```
==== Spec updated with probe findings ====

File: <path>

Assumptions you must approve before I write code (N total):
  1. [pending] <assumption 1>
  2. [pending] <assumption 2>
  ...

Non-goals (what I will NOT build):
  - <non-goal 1>
  - <non-goal 2>

Respond:
  - "[approve all]" -- proceed to code
  - "[approve except: 3, 7]" -- approve all but 3 and 7, ask follow-ups
  - "[reject 5: <correction>]" -- specific correction
  - "[scale-down]" -- I'll re-draft a smaller V1 with the rest deferred
```

Iterate ONCE if needed. After approval, commit the spec with message:

```
docs(spec): architect-probe findings for <feature>

<Risk class>. <N> persona probes ran (<names>; selected by open risk). <N> questions surfaced; <N> answered from prompt,
<N> from the project owner, <N> from research. <N> explicit assumptions approved.
Probing time: <minutes>.
```

### Step 9 -- log to factory_metrics

```json
{
  "ts": "...",
  "event": "architect_probe",
  "project": "...",
  "feature": "<slug>",
  "risk_class": "W2|W3",
  "personas_run": N,
  "personas_selected": ["..."],
  "questions_total": N,
  "answered_from_prompt": N,
  "needed_user_input": N,
  "needed_research": N,
  "assumptions_count": N,
  "rejections": N,
  "minutes_total": N
}
```

This lets the synthesizer track architect-probe usage and effectiveness over time. If features that USED architect-probe pivot less than features that didn't, the data proves the rule is earning its keep.

## What this skill does NOT do

- Does NOT write code. Code comes after the spec is approved.
- Does NOT chain 47 clarification messages. ONE batched round.
- Does NOT make assumptions silently. Every assumption surfaces.
- Does NOT run a fixed persona count. Personas follow the open risks; unrelated ones are skipped.
- Does NOT create a second discovery artifact. Findings go into the change's single spec.
- Does NOT replace hostile-architect.md. When selected for W3 or scale-failure risk, the Hostile Architect persona runs its 8-phase stress test.
- Is NOT a mandatory gate. The architecture-and-risk card decides when it runs (W2/W3 with expensive unknowns only).
- Does NOT implement research itself. Delegates to firecrawl + mcp-registry + WebFetch.

## Failure modes

- Persona subagent times out or errors -> capture the partial questions + flag for re-run; do not abort the whole probe
- The project owner doesn't respond to clarification batch -> wait; W2/W3 work is held for owner approval of the spec anyway
- No domain primer for the pack -> use generic primer; flag in the spec
- Research times out -> mark items RESEARCH-DEFERRED, surface to the project owner with "you may want to know X before approving Y"

## Integration with other rules

- `.forge/context/rules/architecture-and-risk.md` decides whether this runs; this skill is an optional escalation
- `hostile-architect.md` runs inside Persona 5 when that persona is selected
- `two-way-traceability.md` shapes the spec's forward + reverse data flow when data flow is an open risk
- `data-integrity.md` (DMG) drives the "is this data-maturity-gated" check when data maturity is an open risk
- `compliance.md` drives the disclosures section per detected domain
- `aggregate-design.md` drives the cohort design questions for any cross-user metric
- `ai-first-principles.md` drives the AI-at-core test
- `outcome-tracker.md` correlates feature pivot rate with whether architect-probe ran

## Privacy

- Never include user data in the spec
- Persona prompts can include public project context (BRIEF.md non-sensitive bits) but never user records
- Research findings are public-info-only

## Cost target

- Each selected Sonnet persona subagent: ~$0.05 (none to the full menu, by open risk)
- Aggregation + draft: $0.10
- Research (WebFetch + maybe Perplexity): $0.10
- Total per probe: ~$0.10-$0.50 depending on personas selected

vs cost of a mid-build pivot: 5-50 hours x $150/hr = $750-7,500.

ROI: 1500x to 15,000x.
