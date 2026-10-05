---
name: source-validator
description: Haiku agent (cheap) that validates a candidate source URL — HEAD check, content-substring match, paywall detection. Companion to source-catalog-curator. Invoke before INSERTing into source_catalog.
model: haiku
allowed-tools: [WebFetch]
arguments: required — pass {url, kind, expected_substring} as JSON
---

# source-validator agent

> **Source:** Example Agent App Phase 1.5 (CLAUDE.md §4 Rule 18, VIBE Rule 56).
> **Purpose:** prevent hallucinated URLs from entering `source_catalog`. Cheap fast validation gate.

## What it does

Given `{url, kind, expected_substring}`:

1. HEAD request to URL with realistic browser UA
2. If 2xx → fetch first 5KB of body
3. Verify `expected_substring` appears in body (case-insensitive)
4. Detect paywall markers (`paywall|subscribe|sign up|metered`) in body
5. Return verdict: `valid | url-invalid | content-mismatch | paywall-detected | unknown`

## Behavior matrix

| HTTP status | Body contains substring | Paywall markers | Verdict |
|---|---|---|---|
| 2xx | yes | no | `valid` |
| 2xx | yes | yes | `valid` + `paywall_tier: subscription` |
| 2xx | no | — | `content-mismatch` |
| 301/302 → 2xx | yes | — | `valid` (use resolved URL) |
| 403 | — | — | retry once with browser UA. Still 403 → `valid-pending` (NEVER `invalid`) per `ai-purchase-research` pack §2 |
| 404 | — | — | `url-invalid` |
| 5xx / timeout | — | — | `unknown` (retry once, then fail open with `unknown`) |

## What it does NOT do

- Score quality (curator does that based on its own knowledge)
- Mutate `source_catalog` (curator handles INSERT)
- Validate semantic correctness — only structural (URL works + body contains expected substring)

## Cost

Per-validation: 1 HEAD + (at most) 1 GET of 5KB. Estimated $0.0003/call with Haiku. Budget for first-tenant onboarding (~30 sources to validate) = ~$0.01.

## Integration

```typescript
// In source-catalog-curator's proposal flow:
for (const candidate of proposedCandidates) {
    const validation = await invokeAgent('source-validator', {
        url: candidate.url,
        kind: candidate.kind,
        expected_substring: candidate.name
    });
    if (validation.verdict === 'valid' || validation.verdict === 'valid-pending') {
        candidate.last_validated_at = new Date();
        candidate.paywall_tier = validation.paywall_tier ?? 'free';
    } else {
        candidate.validation_failure = validation.verdict;
        // Don't INSERT failed candidates. Surface to user.
    }
}
```
