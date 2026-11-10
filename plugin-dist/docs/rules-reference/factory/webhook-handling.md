---
tier: standard
required: false
profiles: [solo-pro, senior-dev, agency, enterprise]
paths:
  - "supabase/functions/**"
  - "src/api/**"
  - "src/**/webhook*"
enforcement_tier: 2
load_bearing: true
enforcement_ref: "in-rule idempotency/signature checklist enforced at the SS9 audit gate (auditor agent veto)"
---

# webhook-handling.md -- Inbound + Outbound Webhook Patterns

> **Authority:** Auto-loaded global rule. Cross-cutting across any project that receives or sends webhooks (Stripe, Resend, GitHub, OAuth providers, tenant-configurable destinations).
> **Last updated:** 2026-05-15
> **Source:** Promoted from `scripts/templates/packs/saas/golden-paths-saas.md` GP-SAAS-005 + intake-form Section 9. Generalized from Stripe-specific to provider-agnostic.
> **Companion rules:** `data-protection.md` (admin audit log for replay events), `secrets-handling.md` (signing-secret hygiene + rotation cadence).

---

## Section 1 -- The threat model (what bad webhook handling produces)

Four failure modes, all production-real:

1. **Duplicate side-effects from retries.** Stripe / GitHub / Resend retry deliveries on 5xx OR on missed 2xx ack. Without idempotency, a single event upgrades the plan twice, sends two refund emails, or double-credits a ledger.
2. **Forged events accepted.** Endpoint URL leaks (logs, CDN cache, browser history). Attacker POSTs a fake `invoice.paid` event. Without signature verification, the app trusts it.
3. **Events dropped silently.** Endpoint 500s during processing, sender retries 5 times, sender gives up, no operator alert, event is gone. The plan upgrade never happens.
4. **Sender blocked on slow processing.** Endpoint does the actual work synchronously (LLM call, batch SQL, third-party API), takes 12 seconds, sender times out at 5s and treats as failure -- now you have idempotency problems on top of latency problems.

Every webhook endpoint must defeat all four.

---

## Section 2 -- Inbound webhook contract

Every webhook receiver endpoint MUST satisfy ALL four:

1. **Idempotent via event-id dedup.** First action after parsing the body is dedup-check (Section 4). Re-deliveries return 200 immediately with no side-effect.
2. **Signature-verified.** Before any DB write or business logic, verify HMAC against the raw request body (Section 3). Reject unsigned / invalid-signature requests with 401.
3. **Fast.** Return 2xx within 5 seconds. Do NOT do the actual work in the request handler. Enqueue + return (Section 5).
4. **Auth-flagged at the network boundary.** Edge Function or route has `verify_jwt: false` (webhooks are unauthenticated) BUT a rate limit + IP allowlist (where the provider publishes one) at the edge. Never expose the receive endpoint without signature verification compensating for the missing JWT.

---

## Section 3 -- Signature verification

Pattern works for Stripe, Resend, GitHub, Shopify, and most HMAC-style providers:

```
1. Read raw request body as bytes (NEVER parsed JSON -- ordering breaks the hash)
2. Read signature header (Stripe-Signature, X-Hub-Signature-256, etc.)
3. Read timestamp header where provider sends one
4. Compute HMAC-SHA256(secret, timestamp + "." + raw_body)
5. Constant-time compare computed signature against header value
6. Reject timestamp older than 5 minutes (replay defense)
7. On mismatch -> 401, log event_type + sender_ip, NEVER log the secret value
```

**Constant-time compare is non-negotiable** -- use `crypto.timingSafeEqual` (Node) or `hmac.compare_digest` (Python). Naive `===` leaks bytes via timing.

**Never log the secret.** Not in error messages, not in debug output, not in the audit row. Per `secrets-handling.md` Section 2.3, the secret name (e.g. `STRIPE_WEBHOOK_SECRET`) is the only safe reference.

Rotation cadence for webhook signing secrets: 90 days (matches `secrets-handling.md` Section 3.1). Document each secret in the project's BRIEF.md Token Registry.

---

## Section 4 -- Idempotency

Every receiver writes the event_id to a dedup table FIRST. INSERT-conflict equals already-processed.

```sql
CREATE TABLE webhook_events (
    event_id         TEXT PRIMARY KEY,              -- provider's id (evt_xxx, delivery uuid)
    provider         TEXT NOT NULL,                 -- 'stripe', 'resend', 'github'
    event_type       TEXT NOT NULL,
    received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at     TIMESTAMPTZ,
    payload_hash     TEXT NOT NULL                  -- sha256 of raw body, for audit
);
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at DESC);
```

Handler flow:

```
1. Verify signature (Section 3). Reject on fail.
2. Parse JSON. Extract event_id.
3. INSERT INTO webhook_events (event_id, ...). On 23505 UNIQUE-violation -> return 200 immediately (already processed). VIBE Rule 37.
4. On successful INSERT, enqueue the actual work (Section 5).
5. Return 200.
```

`processed_at` is updated by the async worker, not the receive endpoint. The endpoint's job is dedup-and-ack, nothing else.

---

## Section 5 -- Async processing + retry

The receive endpoint returns 200 first. The work happens elsewhere:

- **Supabase target:** receive endpoint enqueues via `pg_net.http_post` to a worker Edge Function, OR writes a row to a `webhook_jobs` table that pg_cron drains every 30s.
- **Vercel target:** receive endpoint dispatches to a Vercel Workflow (WDK) step, or writes to a queue (Upstash / Inngest).

Retry policy for the worker (not the sender):

```
Attempt 1: immediate
Attempt 2: +5s
Attempt 3: +30s
Attempt 4: +5min
Attempt 5: +1h
Attempt 6: dead-letter (Section 6)
```

Exponential backoff with jitter. Max 5 retries. Worker updates `webhook_events.processed_at` on success. Worker writes failure details to `webhook_dead_letters` on attempt 6.

---

## Section 6 -- Dead-letter handling

Permanent failures land in a dead-letter table for human review:

```sql
CREATE TABLE webhook_dead_letters (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            TEXT NOT NULL REFERENCES webhook_events(event_id),
    provider            TEXT NOT NULL,
    error_message       TEXT NOT NULL,
    error_stack         TEXT,
    last_attempt_at     TIMESTAMPTZ NOT NULL,
    attempt_count       INT NOT NULL,
    original_payload    JSONB NOT NULL,
    replayed_at         TIMESTAMPTZ,                 -- set when admin replays
    replay_succeeded    BOOLEAN
);
```

Manual replay endpoint sits behind admin auth (JWT + role check, NOT just `verify_jwt: false`). Replay re-enqueues the original payload. Every replay action logs to `admin_audit_log` per `data-protection.md` Section 4.4 (operation = `webhook_replay`, sql_preview = event_id + provider).

Alert: any dead-letter row older than 24h without a `replayed_at` value fires a weekly-deep-sweep warning.

---

## Section 7 -- Outbound webhooks (when YOU send)

When the product sends webhooks to tenant-configurable destinations (Zapier, n8n, customer endpoints):

1. **Sign every payload with your own HMAC.** Each tenant has a per-destination signing secret stored encrypted at rest.
2. **Send three headers:** `Webhook-ID` (your event uuid for the receiver's dedup), `Webhook-Timestamp` (unix seconds), `Webhook-Signature` (HMAC-SHA256 hex).
3. **Include the timestamp inside the HMAC body** (`timestamp + "." + payload`) so receivers can replay-reject.
4. **Document on your receiver-side that timestamps older than 5 minutes must be rejected.** This is the contract you publish.
5. **Retry on receiver 5xx with the same Webhook-ID** so the receiver can dedup. Same 5-attempt exponential schedule as Section 5.
6. **Per-destination rate limit.** A misconfigured receiver should not allow one tenant to burn your egress budget.

---

## Section 8 -- Verification before launch

- [ ] Every inbound endpoint verifies signature against RAW body, not parsed JSON
- [ ] `webhook_events` table exists with `event_id` PRIMARY KEY
- [ ] Handler returns 200 within 5s in p95 (measured, not guessed)
- [ ] Duplicate-event test: same `event_id` POSTed twice -> first does work, second returns 200 with no side-effect
- [ ] Bad-signature test: payload with tampered body -> 401, no DB write, no enqueue
- [ ] Replay-attack test: valid signature with 10-min-old timestamp -> 401
- [ ] Dead-letter table exists; manual replay endpoint requires admin role
- [ ] Outbound webhooks sign with HMAC + Webhook-ID + Webhook-Timestamp
- [ ] Signing secrets in env vars only, never in code, never logged, on 90-day rotation per `secrets-handling.md`
- [ ] `admin_audit_log` row written for every dead-letter replay

---

*See `data-protection.md` Section 4 for audit log shape. See `secrets-handling.md` for signing-secret rotation cadence. Provider-specific event handling (Stripe `customer.subscription.updated`, GitHub `pull_request`, etc.) belongs in vertical-pack rule files, not here.*
