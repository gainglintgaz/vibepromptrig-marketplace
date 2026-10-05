# AI and Agent Safety v1

Trigger: AI output, inference, autonomous action, recommendation, or learning claim.

Required: use structured fail-closed validation, grounded sources, provider abstraction, function-layer data sufficiency gates, prompt/run provenance, cost metering where spend occurs, and human approval for high-stakes actions.

Prohibited: raw model output writes, invented claims/URLs, model-to-database access, default-on high-risk agency, or “learned” claims without persisted evidence.

Verify: malformed output rejection, missing-source rejection, low-data refusal, PII boundary, audit linkage, and action tier.

Exception: simple non-AI tools may document an exemption instead of pretending to be AI-native.

References: `docs/rules-reference/context-v2-safeguards.md#ai-and-agent-safety`.
