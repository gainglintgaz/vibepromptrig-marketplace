# Portable Delivery v1

Trigger: factory CLI, generators, adapters, plugins, scaffolding, onboarding, or context installation.

Required: prefer the canonical portable implementation with compatible wrappers; keep bundles self-contained; preserve custom content; use deterministic output, path containment, backup, changed-since-review detection, rollback, and idempotent reruns.

Prohibited: operator-specific paths, symlink/network dependence in clean clones, duplicate active adapter trees, or older entrypoints resurrecting full rule dumps.

Verify: clean/moved/offline fixture, paths with spaces, dry-run zero writes, second-run no diff, rollback, and actual caller wiring.

Exception: platform-specific behavior is labeled and tested only on supported platforms.

References: `docs/rules-reference/context-v2-safeguards.md#portable-delivery`.
