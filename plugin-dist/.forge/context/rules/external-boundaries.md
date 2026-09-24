# External Boundaries v1

Trigger: webhooks, email, third-party APIs, deploy targets, or paid services.

Required: authenticate/sign boundaries, deduplicate retries, bound cost/rate, fail visibly, protect secrets, retain relevant audit evidence, and verify actual deployment/runtime when claimed.

Prohibited: unsigned webhooks, non-idempotent retry effects, uncapped external calls, synchronous slow webhook work, or deployment-output-as-live-proof.

Verify: valid/invalid signature, duplicate, timeout/retry, cost cap, observability, and post-deploy smoke paths as applicable.

Exception: read-only offline references need no network proof; mark external behavior unverified.

References: `docs/rules-reference/context-v2-safeguards.md#external-boundaries`.
