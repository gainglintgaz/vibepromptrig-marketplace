# Safe Actions v1

Trigger: writes that are destructive, external, production-facing, or hard to reverse.

Required: resolve exact targets, use the least authority, distinguish dev/prod, surface destructive effects, require action-scoped approval when not already authorized, prefer reversible operations, and verify after mutation.

Prohibited: blanket production authority, recursive deletion of broad/computed targets, force-push/reset without approval, or using prose as a sandbox.

Verify: target, environment, authority, backup/rollback, and post-action evidence are recorded.

Exception: approved routine writes inside an already approved bounded implementation scope do not need repeated approval.

References: `docs/rules-reference/context-v2-safeguards.md#safe-actions`.
