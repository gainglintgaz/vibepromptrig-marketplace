# Context v2 safeguards reference

Status: V2 contract reference with portable production-truth amendment. Version: 1.1.0. This file is intentionally outside native autoload paths.

The compact cards preserve normative behavior; this reference records provenance, disposition, enforcement claims, and coverage limits. Source rules remain active until later-session adapters are reviewed and installed. “Mechanical” below means a gate is declared; it does not prove the gate runs in every host.

## Compact safeguard definitions

<a id="scope-and-preservation"></a>
### Scope and preservation
Current scope, repository/worktree identity, read-before-write, reuse, preservation of unrelated work, bounded history lookup, and honest handoff.

<a id="architecture-and-risk"></a>
### Architecture and risk
One W0–W3 risk decision and one proportionate spec artifact replace overlapping mandatory architecture/discovery/council workflows. Unknown expensive assumptions remain explicit. No fixed persona count is compulsory.

<a id="secrets-and-sensitive-data"></a>
### Secrets and sensitive data
Never expose credential values. Data minimization and server authorization remain mandatory; regex is only a tripwire, never proof of complete PII removal.

<a id="safe-actions"></a>
### Safe actions
Destructive, production, and external actions require scoped authority, exact targets, reversibility, and verification. Safe failure is permitted when data/access is missing.

<a id="auth-and-privacy"></a>
### Auth and privacy
Use server-side authorization and project-native tenant controls. RLS is required where Postgres policy is the chosen boundary, not imposed on non-Postgres systems.

<a id="data-and-finance-truth"></a>
### Data and finance truth
Real sources, exact/reproducible derivations, provenance, completeness gates, time-period integrity, and applicable—not universal—domain rules.

<a id="ai-and-agent-safety"></a>
### AI and agent safety
Structured fail-closed output, source grounding, data sufficiency, PII boundary, registered actions, run provenance, metering, and human control for high stakes.

<a id="ui-quality"></a>
### UI quality
Project design system, accessibility, working actions, honest states, and actual visual/browser evidence when a UI is runnable.

<a id="testing-and-evidence"></a>
### Testing and evidence
Affected checks after coherent changes; full relevant gates at integration/release. Evidence proves only what was run. Docs/CLI work can justify browser/database/deploy as N/A.

<a id="completion-claims"></a>
### Completion claims
Receipts apply to release, production or explicit completion claims, not every routine report. Evidence binds an immutable tested revision and configuration; receipts live in a CI artifact or later evidence commit. Agents cannot issue absolute completion certificates or invent human approval. The remote Completion Truth Contract v2 and scripts/completion validators remain authoritative for scanned claims, receipt evidence, and human release decisions.

<a id="external-boundaries"></a>
### External boundaries
Signature/authentication, idempotency, bounded cost/retries, observability, and post-deploy evidence for webhooks, email, APIs, and deployment.

<a id="portable-delivery"></a>
### Portable delivery
Canonical Node logic with compatible wrappers; deterministic offline bundles, path containment, custom-content preservation, backup, conflict detection, rollback, and idempotence.

<a id="delegation"></a>
### Delegation
Solo default. A child gets one bounded responsibility, no recursive delegation, and normally <=400 words plus evidence paths. Authored brief target <=1 KiB when feasible. Required safety cards are never removed to hit it. Fresh-context dispatch is used only when the host supports it. Host/system/project/skill/tool injection is counted separately when observable or recorded as unknown; a small authored prompt does not cap total context or bypass higher instructions.

<a id="unknown-scope"></a>
### Unknown scope
Unknown paths or semantics fail safe into review and retain baseline safety cards. Missing measurements are null/unverified, never zero.

## Complete legacy safeguard disposition map

| Legacy source | Stable ID | Replacement card(s) | Outcome | Enforcement |
|---|---|---|---|---|
| <a id="accessibility"></a> accessibility.md | VF-RULE-ACCESSIBILITY | ui-quality | merged | tier 2 process |
| <a id="agent-native-spine"></a> agent-native-spine.md | VF-RULE-AGENT-NATIVE-SPINE | ai-and-agent-safety | merged | tier 2 process |
| <a id="aggregate-design"></a> aggregate-design.md | VF-RULE-AGGREGATE-DESIGN | data-and-finance-truth | merged | tier 2 process |
| <a id="ai-first-principles"></a> ai-first-principles.md | VF-RULE-AI-FIRST-PRINCIPLES | ai-and-agent-safety | merged | tier 3 advisory |
| <a id="ai-native"></a> ai-native.md | VF-RULE-AI-NATIVE | ai-and-agent-safety | mechanically_enforced | tier 1 mechanical |
| <a id="architect-first"></a> architect-first.md | VF-RULE-ARCHITECT-FIRST | architecture-and-risk | mechanically_enforced | tier 1 mechanical |
| <a id="auth"></a> auth.md | VF-RULE-AUTH | auth-and-privacy | merged | tier 2 process |
| <a id="builder-imperative"></a> builder-imperative.md (index-only) | n/a — no reviewed source body | scope-and-preservation pending provenance | unresolved inventory anomaly | none claimed |
| <a id="compliance"></a> compliance.md | VF-RULE-COMPLIANCE | auth-and-privacy, data-and-finance-truth, completion-claims | merged | tier 2 process |
| <a id="composable-outputs"></a> composable-outputs.md | VF-RULE-COMPOSABLE-OUTPUTS | ai-and-agent-safety | mechanically_enforced | tier 1 mechanical |
| <a id="consulting"></a> consulting.md | VF-RULE-CONSULTING | scope-and-preservation | merged | tier 3 advisory |
| <a id="data-citizenship"></a> data-citizenship.md | VF-RULE-DATA-CITIZENSHIP | data-and-finance-truth | merged | tier 2 process |
| <a id="data-flywheel"></a> data-flywheel.md | VF-RULE-DATA-FLYWHEEL | ai-and-agent-safety | merged | tier 3 advisory |
| <a id="data-integrity"></a> data-integrity.md | VF-RULE-DATA-INTEGRITY | data-and-finance-truth | merged | tier 2 process |
| <a id="data-protection"></a> data-protection.md | VF-RULE-DATA-PROTECTION | safe-actions, auth-and-privacy | mechanically_enforced | tier 1 mechanical |
| <a id="design-system"></a> design-system.md | VF-RULE-DESIGN-SYSTEM | ui-quality | mechanically_enforced | tier 1 mechanical |
| <a id="discovery-protocol"></a> discovery-protocol.md | VF-RULE-DISCOVERY-PROTOCOL | architecture-and-risk | mechanically_enforced | tier 1 mechanical |
| <a id="domain-primers-bookkeeping"></a> domain-primers/bookkeeping.md | VF-RULE-DOMAIN-PRIMERS-BOOKKEEPING | data-and-finance-truth | merged | tier 3 advisory |
| <a id="domain-primers-finance"></a> domain-primers/finance.md | VF-RULE-DOMAIN-PRIMERS-FINANCE | data-and-finance-truth | merged | tier 3 advisory |
| <a id="domain-primers-generic"></a> domain-primers/generic.md | VF-RULE-DOMAIN-PRIMERS-GENERIC | architecture-and-risk | merged | tier 3 advisory |
| <a id="domain-primers-saas"></a> domain-primers/saas.md | VF-RULE-DOMAIN-PRIMERS-SAAS | auth-and-privacy | merged | tier 3 advisory |
| <a id="email-deliverability"></a> email-deliverability.md | VF-RULE-EMAIL-DELIVERABILITY | external-boundaries | merged | tier 2 process |
| <a id="enforcement-first"></a> enforcement-first.md | VF-RULE-ENFORCEMENT-FIRST | testing-and-evidence | mechanically_enforced | tier 1 mechanical |
| <a id="error-monitoring"></a> error-monitoring.md | VF-RULE-ERROR-MONITORING | testing-and-evidence | merged | tier 2 process |
| <a id="execution"></a> execution.md | VF-RULE-EXECUTION | scope-and-preservation, architecture-and-risk, testing-and-evidence | mechanically_enforced | tier 1 mechanical |
| <a id="feature-flags"></a> feature-flags.md | VF-RULE-FEATURE-FLAGS | external-boundaries | merged | tier 2 process |
| <a id="gear-shift"></a> gear-shift.md | VF-RULE-GEAR-SHIFT | delegation | merged | tier 2 process |
| <a id="hostile-architect"></a> hostile-architect.md | VF-RULE-HOSTILE-ARCHITECT | architecture-and-risk | merged | tier 2 process |
| <a id="lessons-critical"></a> lessons-critical.md | VF-RULE-LESSONS-CRITICAL | scope-and-preservation | merged | tier 3 advisory |
| <a id="localization"></a> localization.md | VF-RULE-LOCALIZATION | ui-quality | merged | tier 3 advisory |
| <a id="mcp-servers"></a> mcp-servers.md | VF-RULE-MCP-SERVERS | external-boundaries | merged | tier 3 advisory |
| <a id="migration-strategy"></a> migration-strategy.md | VF-RULE-MIGRATION-STRATEGY | safe-actions, testing-and-evidence | merged | tier 2 process |
| <a id="observability"></a> observability.md | VF-RULE-OBSERVABILITY | testing-and-evidence | merged | tier 2 process |
| <a id="performance"></a> performance.md | VF-RULE-PERFORMANCE | ui-quality | merged | tier 2 process |
| <a id="privacy"></a> privacy.md | VF-RULE-PRIVACY | auth-and-privacy | merged | tier 2 process |
| <a id="reference-lessons-archive"></a> reference/lessons-archive.md | VF-RULE-REFERENCE-LESSONS-ARCHIVE | scope-and-preservation | merged | tier 3 advisory |
| <a id="secrets-handling"></a> secrets-handling.md | VF-RULE-SECRETS-HANDLING | secrets-and-sensitive-data | mechanically_enforced | tier 1 mechanical |
| <a id="self-reflection"></a> self-reflection.md | VF-RULE-SELF-REFLECTION | scope-and-preservation | mechanically_enforced | tier 1 mechanical |
| <a id="senior-council"></a> senior-council.md | VF-RULE-SENIOR-COUNCIL | architecture-and-risk | merged | tier 2 process |
| <a id="seo"></a> seo.md | VF-RULE-SEO | ui-quality | merged | tier 3 advisory |
| <a id="stack-optimizer"></a> stack-optimizer.md | VF-RULE-STACK-OPTIMIZER | external-boundaries | merged | tier 3 advisory |
| <a id="tech-defaults"></a> tech-defaults.md | VF-RULE-TECH-DEFAULTS | portable-delivery, scope-and-preservation | merged | tier 3 advisory |
| <a id="testing-strategy"></a> testing-strategy.md | VF-RULE-TESTING-STRATEGY | testing-and-evidence | merged | tier 2 process |
| <a id="two-way-traceability"></a> two-way-traceability.md | VF-RULE-TWO-WAY-TRACEABILITY | data-and-finance-truth, ai-and-agent-safety | merged | tier 2 process |
| <a id="vibe-standard"></a> vibe-standard.md | VF-RULE-VIBE-STANDARD | scope-and-preservation | mechanically_enforced | tier 1 mechanical |
| <a id="webhook-handling"></a> webhook-handling.md | VF-RULE-WEBHOOK-HANDLING | external-boundaries | merged | tier 2 process |
| <a id="wired-not-orphaned"></a> wired-not-orphaned.md | VF-RULE-WIRED-NOT-ORPHANED | scope-and-preservation, portable-delivery, testing-and-evidence | merged | tier 2 process |
| <a id="completion-truth-contract"></a> completion-truth-contract.md | VF-RULE-COMPLETION-TRUTH-CONTRACT | completion-claims | mechanically_enforced | tier 1 scoped claim/receipt checks |

Historical V2 candidate evidence used the reviewed 2026-09-04 draft and superseded its universal-receipt/self-referential-SHA requirements. The September factory delivery now integrates the newer remote Completion Truth Contract v2, its scoped validators, commit hook and release workflow. The compact card preserves those guards; it does not supersede the newer remote contract.

<a id="production-truth"></a>
## Production truth: portable adoption of PT-1 through PT-9

Version: 1.1.0, adopted into this source on 2026-09-12. Read this section for runtime,
integration, privacy and release work. It supplements the compact testing card and the
Completion Truth Contract; it grants no production, provider-spend or cross-project authority.

Provenance: Example Finance App's
[portable rules](https://github.com/gainglintgaz/example-finance-app/blob/claude/practical-franklin-abogli/docs/rules-reference/portable-production-truth-rules.md),
[observation lesson](https://github.com/gainglintgaz/example-finance-app/blob/claude/practical-franklin-abogli/docs/rules-reference/observe-before-hypothesis.md)
and [resume handoff](https://github.com/gainglintgaz/example-finance-app/blob/claude/practical-franklin-abogli/docs/handoff/2026-09-12-CODEX-RESUME-PROMPT.md),
retrieved 2026-09-12 and compared with the supplied attachments. Incident details in those
sources are reported evidence from Example Finance App, not a fresh production audit by this task.
Example Finance App's branch names, migrations, exception decisions and repair assignments do not become
VibePromptRig instructions.

### Rules that apply to the next change

1. **PT-1, truthful failures.** Preserve a structured error code across boundaries when
   callers need different recovery behavior. Unknown failures remain unknown. A 5xx alone
   does not establish a network fault, input quality or billing outcome. State that no work
   was charged only when the metering/billing boundary provides evidence; otherwise the
   charge state is unknown. Never expose raw sensitive errors as a shortcut.
2. **PT-2, live proof.** Server-path production claims need both observation of the actual
   running artifact and a real operation against the same target/revision. Record the
   returned code and sanitized result evidence. A deploy command or local mock proves
   neither. Implementation may be locally verified while production stays not_run.
   Obtain any required action authority before an invocation with side effects.
3. **PT-3, named contracts.** For string-keyed external resources, compare the names and
   signatures the actual callers use with a deliberate inventory of the target environment.
   Exclude tests and distinguish lookalike APIs. Record inventory time, environment, scope
   and freshness limit; a snapshot proves existence when observed, not current availability
   or permission. CI must fail missing/changed contracts and expired inventory where required.
   Never regenerate a gap baseline to clear red CI. Existing exceptions may only shrink:
   each names its caller, reason, owner, absence/failure behavior, closing condition and
   decision evidence. Remove exceptions whose dependency now exists. Seed a missing name
   and assert failure. A project without its extractor/inventory is explicitly unverified.
4. **PT-4, declared degradation.** Distinguish dependency absence from operational failure
   only with observed codes and a caller-specific decision. Security and money safeguards
   fail closed absent explicit scoped authority. A Example Finance App exception is not authority for
   another caller. Record parked dependencies before shipping their callers.
5. **PT-5, actual surface.** State the environment, client/version, relevant user mode and
   observed flow. For apps cover the primary journey, async/AI success or honest refusal,
   a sourced number, sparse data and an injected failure. For this factory use the real
   CLI/installer/client surface; a phone matrix is N/A until a phone UI is in scope.
   CLI resolution is not proof a native agent discovered or injected instructions.
6. **PT-6, a reader for failures.** Critical paths need a sanitized failure signal and a
   named reader with a cadence/escalation destination. Review actual signals before release;
   a dormant dashboard or an unread log is not monitoring. Do not schedule paid probes or
   send alerts without applicable authority.
7. **PT-7, observe before hypothesis.** Name evidence for the causal diagnosis. If it is
   missing, make the failing boundary observable first. Reproduce via the actual payload
   builder, preserving structural cases while excluding sensitive bodies. List all boundaries
   from caller to consumer, including response decoding. A theory or a test encoding the
   same theory cannot substitute for a runtime observation. After the bounded failed retries,
   stop and record the unresolved boundary.
8. **PT-8, policy-aligned privacy.** State the threat model and authoritative project
   decision. Owner access and third-party egress are different boundaries; keep authentication,
   authorization, tenant isolation, logging and retention controls. Do not silently relax
   protections or rewrite policy to fit code. If authorized ambiguous inputs use redaction,
   test that every detected value is actually transformed and compare all relevant callers.
   Example Finance App-specific allowlists and approvals are not copied.
9. **PT-9, verify assertions.** Check behavioral guarantees in comments, handoffs and other
   agents' reports against the current code and applicable evidence. Repair the behavior or
   explain the changed guarantee; deleting a comment does not prove a repair. Reuse unchanged,
   applicable evidence and do not restart already verified work without a contradiction.

### Required review answers

Every runtime-repair PR or local handoff records: observed cause and evidence location;
actual builder/caller and every boundary; failure code and user-facing consequence;
changed contract names and inventory/exception disposition; applicable privacy decision;
comments checked; exact tested revision and surface; and unavailable checks. If diagnosis is
not yet observed, say so and scope the change to instrumentation. Report local, CI, deployed
and live verification separately.

### Mechanical coverage and limits

| Obligation | Enforced here | What still requires project evidence or review |
| --- | --- | --- |
| PT-1, PT-7, PT-9 | Context routing and install tests preserve the instructions/reference. | Error semantics, actual observations, real builders, comment truth; no regex proves reasoning. |
| PT-2, PT-5 | The production receipt validator requires separate artifact_observation and live_invocation records, exact SHA/environment/target, recent timestamps and distinct digest-bound evidence. Mutation tests reject omissions, reuse, altered evidence and wrong scope. | Authenticity of records and actual user/device results. A typed receipt is not live certification. |
| PT-3 | Existing context manifest validation rejects missing declared rule/card/dependency names; context tests seed missing dependencies and root escapes. | This is a local context-contract inventory, not a live database/API inventory. Each external integration needs its own extractor, inventory, freshness policy and shrinking exception registry. |
| PT-4, PT-8 | Existing authorization, containment and schema tests remain mandatory. | Dependency-specific decisions and detector/redactor behavior tests in the affected project. |
| PT-6 | CI runs the receipt, installer and context regression suites. | A production signal reader/cadence is not provisioned by this change. |

The factory release workflow and cross-platform workflow run the completion self-tests;
the cross-platform workflow also runs the context/installer tests. The plugin generator
copies the validator, tests, compact card and this reference. The existing project installer
copies the reference and card and points Codex, Claude and Gemini entries to one resolver.
These are mechanical distribution and regression checks, not proof that any native host
obeyed a rule. Existing projects/global hosts receive nothing until explicitly installed.

Production v3 manifests now require two nested observations in production_verification:
artifact_observation and live_invocation. Both contain environment=production, target,
deployed_commit_sha, observed_at, evidence_id and evidence {path, sha256}. Invocation also
contains surface, operation, result_code and outcome (succeeded or honest_failure). Target
labels must agree; observations may not reuse check/summary evidence files. The surrounding
v3 production summary and acceptance criteria remain required. An honest_failure outcome
can establish an expected refusal, never success of a flow that required a successful result.
Legacy production v3 manifests without these fields fail; other environments are unchanged.

### Next adoption stages

1. Review and deliver this source revision with its local evidence. CI results and branch
   protection must be observed before claiming remote enforcement.
2. In one explicitly named disposable project/client, prove install, resolution, rejection
   and native discovery/injection/behavior separately. Record exact host/version; if access
   is unavailable, retain not_run and stop the same unavailable retry.
3. For each real external integration, build the PT-3 inventory/exception gate and its seeded
   negative tests; assign the PT-6 signal reader. Do not claim all nine rules are fully
   mechanically enforced by adopting this document.
4. Broader portfolio installation is a separately scoped delivery. Product bugs and project
   privacy decisions stay with their project manager.

## Earlier V2 evidence limits

- Existing source rules and generated full mirrors remain active in Session 1; compact selection is not yet a runtime adapter.
- Manifest tier metadata reports the legacy declaration. Session 2/3 must prove seeded violations, valid passes, and actual caller/CI wiring before claiming enforcement.
- Native host context, provider token use, cache behavior, and allowance impact are unobserved here. This contract makes no savings claim.
- builder-imperative appeared in a generated project index supplied with the request but no tracked source rule or reviewed normative body exists at the stabilized revision. It is recorded as an inventory anomaly, not fabricated into the manifest; Session 2 should resolve provenance before selection.
