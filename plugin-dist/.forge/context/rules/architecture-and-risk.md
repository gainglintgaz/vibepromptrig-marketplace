# Architecture and Risk v1

Trigger: new behavior, schema/API changes, cross-cutting work, or expensive ambiguity.

Required: classify W0 read-only/tiny, W1 bounded feature, W2 auth/schema/AI/sensitive/cross-cutting, or W3 production/destructive/regulated release. Use one proportionate spec artifact; make expensive unknowns explicit. W2 gets targeted independent review; W3 gets applicable security/release gates.

Prohibited: duplicate mandatory discovery artifacts, fixed persona counts, ritual questions unrelated to risk, or treating file count as risk.

Verify: risk, assumptions, acceptance, rollback, and review requirement are recorded.

Exception: known tiny fixes may record W0 and proceed without a full spec.

References: `docs/rules-reference/context-v2-safeguards.md#architecture-and-risk`.
