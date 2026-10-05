---
name: Bug report
about: Report a bug in VibePromptRig — a rule that didn't fire, a script that broke, a verifier that lied
title: '[BUG] '
labels: bug, needs-triage
assignees: ''
---

## What broke

<!-- One sentence. What did you expect? What happened instead? -->

## How to reproduce

<!-- Steps anyone on the team can follow. Include the exact commands. -->

1.
2.
3.

## Environment

- Operating system + version:
- PowerShell version (`$PSVersionTable.PSVersion`):
- AI tool + version (Claude Code / Cursor / Codex / Copilot CLI / etc.):
- VibePromptRig factory version (from `forge profile show --verbose`):
- Profile in use (indie-free / solo-pro / senior-dev / agency / enterprise):

## Doctor output

<!-- Paste output of `forge doctor` here so we see verifier state. -->

```
forge doctor output here
```

## Errors-fixed.json check

<!--
Have you searched `errors-fixed.json` (in the project's `.claude/` folder)
for similar past bugs? If yes, share the matching entry. If no, that's OK.
-->

## Was a rule meant to catch this?

<!--
VibePromptRig rules are supposed to PREVENT bug classes, not just document them.
If this bug shape should have been caught, which rule failed to catch it?
We may need to strengthen that rule (lessons.md #7 — "bug fixed once = note it,
bug fixed twice = becomes a rule").
-->

## Anything else

<!-- Screenshots, log excerpts, git commit hashes. -->
