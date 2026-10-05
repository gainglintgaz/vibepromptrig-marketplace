# Secrets and Sensitive Data v1

Trigger: credentials, environment configuration, PII/PHI, auth tokens, logs, prompts, or external providers.

Required: inspect names/config shape without exposing values; keep secrets out of source, output, URLs, and client bundles; minimize and sanitize sensitive data before external calls; retain server-side authorization.

Prohibited: reading or dumping secret-bearing files, echoing environment values, claiming regex proves complete PII removal, or weakening provider/tool permission boundaries.

Verify: secret-bearing files were not dumped; changed paths pass the repository’s secret/PII checks; unknown exposure remains unknown.

Exception: none for disclosure. If exposure occurs, stop using the credential and report rotation need without repeating it.

References: `docs/rules-reference/context-v2-safeguards.md#secrets-and-sensitive-data`.
