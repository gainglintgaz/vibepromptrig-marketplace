# Unknown Scope Safety v1

Trigger: unknown paths/capabilities, ambiguous repository identity, unclassified sensitive behavior, or stale selection after scope expansion.

Required: fail safe into review; retain scope, secrets, safe-actions, and testing cards; inspect bounded evidence; reselect after learning semantics.

Prohibited: treating unknown as low risk, silently dropping cards to fit a budget, guessing project identity, or using zero for unavailable measurements.

Verify: uncertainty and retained safety cards are explicit; selection remains deterministic; unresolved observations are null/unverified.

Exception: none for silent omission. A reviewed exclusion needs evidence and rationale.

References: `docs/rules-reference/context-v2-safeguards.md#unknown-scope`.
