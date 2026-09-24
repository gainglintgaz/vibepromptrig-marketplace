# Completion Claims v2

Trigger: release, production, completion claims, or receipt requests.

Required: freeze scope; bind evidence to an immutable tested revision and configuration; verify evidence files, dates, environment, deployment identity, gaps and independent approval. Keep receipts outside the revision attested.

Prohibited: agent-issued absolute completion certificates; invented human approval; self-referential receipt SHA; reviewer names treated as approval; irrelevant browser/DB/deploy gates; production claims without live smoke.

Verify: run the claim blocker and receipt validator where installed: factory scripts/completion/, adopted projects tools/. Only the human release owner may issue an absolute declaration.

Exception: routine implementation reports may state locally verified with evidence and gaps, without a receipt.

References: `docs/rules-reference/context-v2-safeguards.md#completion-claims`.
