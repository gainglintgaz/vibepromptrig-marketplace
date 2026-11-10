# Handling incoming service updates safely

Audience: software that receives or sends service notifications, commonly called webhooks, such as payment confirmations or repository events.

This reference does not create an endpoint, connect to a provider or enforce a check. Use the provider's current supported verification library and documented delivery contract.

- Verify the signature against the exact raw request bytes before parsing trusted data or performing business actions. Use the provider's algorithm, timestamp tolerance and replay protection; generic signing examples do not fit every provider.
- Reject invalid, unsigned, expired or wrong-environment notifications without changing business data. If the route cannot require a normal user session, signature verification and appropriate network/rate controls must compensate; disabling user-session verification alone is unsafe.
- Never log signing secrets, authorization headers or unnecessary payload/customer data. Keep secrets in supported service secret storage; plan rotation and incident revocation appropriate to the provider.
- Use the provider and event ID as a unique deduplication key. Make recording the event and creating durable work atomic: if the queue fails, retry must still be possible. A duplicate may acknowledge completed or durably queued work; do not acknowledge a lost job as success.
- Acknowledge only after verification and durable acceptance, within the provider's timeout. Process slow work asynchronously. Make side effects idempotent, meaning retries cannot charge twice, send duplicate refunds or apply the same update again.
- Expect retries and out-of-order delivery. Check the provider's authoritative current state where ordering matters; record processed state and safe transition rules.
- Bound retry attempts, use backoff and alert an operator when work remains failed. Preserve enough non-sensitive event identity to investigate; do not silently drop failed payments or account updates.
- Put manual replay behind administrator authorization. Show the exact event and effect, get appropriate approval, record the actor/event/time and recheck deduplication. Replay must not bypass normal checks.
- For outgoing notifications, use HTTPS, a documented signing contract and delivery IDs. Reject destinations that resolve to loopback, private or infrastructure addresses where users can configure a destination; validate again after DNS resolution and redirects. Limit redirects, payloads, timeouts and retries.

First-use check in the provider's test environment: accept one valid event, reject a tampered/expired event, deliver the same event twice without duplicate effects, simulate a queue failure followed by retry, deliver out of order, and observe the failed-work alert and authorized replay. Record what was checked; configuration alone is not a verified delivery.
