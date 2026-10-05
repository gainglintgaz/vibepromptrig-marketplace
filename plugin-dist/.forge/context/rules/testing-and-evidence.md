# Testing and Evidence v1.1

Trigger: any implementation or completion report.

Required: run affected checks and relevant release gates; use real services for live claims. For runtime, integration, privacy or release work, read the production-truth reference below. Observe before hypothesis; reproduce with the real builder; enumerate boundaries; verify comments against code. Make silent failures observable without logging sensitive bodies.

Prohibited: invented error causes; mocks as live proof; weakened safeguards or baselines to pass tests; duplicate usage counts; unsupported no-charge claims.

Verify: exact revision, surface, exit results, denominators and gaps; production needs separate artifact observation and real invocation evidence.

Exception: irrelevant checks are explicit N/A; unavailable checks stay not_run.

References: `docs/rules-reference/context-v2-safeguards.md#production-truth`.
