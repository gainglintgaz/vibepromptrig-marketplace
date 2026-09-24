# Factory effectiveness report

> _Generated: 2026-05-16 from git log across 6 repos, window: 60 days ago._
> _Source: scripts/extract-rule-outcomes.ps1._

## Coverage

- Repos scanned: 6
- Commits in window: 1543
- Commits tagged with [rule: X]: 0
- Tag coverage: 0%

## Per-rule outcomes

| Rule | Invocations | Catches | Misses | Effectiveness |
|---|---:|---:|---:|---:|
| _(no tagged commits in window)_ |  |  |  |  |

## How to tag commits

Add to the commit body (not the subject):

```
fix(api): handle null tenant on lookup

[rule: VIBE-35]
[outcome: PREVENTED]
```

- `[rule: VIBE-35]` -- the rule that prevented worse / drove this fix
- `[outcome: PREVENTED]` -- the rule caught this class of bug at design time (default)
- `[outcome: MISSED]` -- the rule SHOULD have caught it but didn't -- candidate for strengthening
- Multiple rules allowed: `[rule: VIBE-2] [rule: VIBE-44]`

## Caveats

- A low effectiveness score indicates the rule is being invoked but not catching the bug -- candidate for strengthening
- A high invocation count + high effectiveness = the rule is earning its token cost
- A rule with zero invocations may be untriggered (not necessarily ineffective) -- review at next quarterly rule-decay scan
- This report is descriptive, not prescriptive -- it doesn't propose rule changes (that's the synthesizer's job)
