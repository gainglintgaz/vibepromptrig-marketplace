# Auth and Privacy v1

Trigger: sign-in/session/recovery/2FA, protected routes, tenant data, or personal data.

Required: use managed auth patterns; enforce authorization at every server boundary; define tenant/owner access; pair 2FA enrollment with enforcement; scrub sensitive data before AI/logging; test rejection and isolation paths.

Prohibited: client-only access control, long-lived browser-readable secrets, missing authorization/RLS-equivalent protection, or sending prohibited PII to AI APIs.

Verify: positive auth flow plus unauthenticated, unauthorized, cross-tenant, recovery/session, and logging checks applicable to the change.

Exception: non-Postgres systems use their native authorization mechanism; Postgres RLS is not universal.

References: `docs/rules-reference/context-v2-safeguards.md#auth-and-privacy`.
