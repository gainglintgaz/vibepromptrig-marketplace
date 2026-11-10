---
name: checkup
description: Read-only project checkup paired with the user's goal. Compare documented commands and paths against current local files, explain what is known and unknown, and suggest one next action. No tests, connections, fixes or writes run automatically.
allowed-tools:
  - Read
  - AskUserQuestion
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" read)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" inspect)
disable-model-invocation: true
---

> **Needs Claude Code with your project folder open and Node.js 18+.** Git is optional. In chat, open Claude Code to inspect your actual project files; no file check or save is performed here.

# Check this project

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" read` from the chosen project. Use confirmed
intent only; if missing, follow `${CLAUDE_PLUGIN_ROOT}/skills/project-goal/SKILL.md` conversationally.
Explain the bounded inspection scope there before reading files. Ask only unanswered relevant questions.
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" inspect` with a reviewed goal on stdin,
or omit stdin to use the saved goal. This is a zero-write, offline check; no-Git projects are supported.

Explain VERIFIED as the narrow claim evidenced (for example, a script declaration or existing literal
path), WRONG as a demonstrated mismatch, and UNVERIFIED as insufficient evidence. A declaration is
not a passing test. A configured connector is not a successful sign-in, invocation or verified result.
For physical products distinguish concept, CAD, simulation, manufactured prototype and real tests.
CI costs remain UNKNOWN without actual jobs API durations; do not turn a workflow matrix into measured
spend. Remote reads require separately scoped user authority and source/date evidence.

Supported automated claims: npm/pnpm/yarn run script names, literal node script paths, documented PR
open/closed/merged assertions (UNVERIFIED offline), and inline/dynamic commands (UNVERIFIED, never run).
Other prose, stack/version assertions, arbitrary paths and unfamiliar manifest formats need manual
evidence review and remain UNVERIFIED; this is not certification of every claim. Never execute a
documented command to clear an observation. Preserve custom instructions and credentials.

Show a short goal, relevant findings with file:line and evidence, unresolved questions, then one next
action. scoped_fresh covers only the declared inspection scope. Runtime evidence freshness stays
UNVERIFIED unless separately bound to its actual inputs; fresh is false when such unbound evidence is
present. Do not promote an old runtime result because the documents still match.
Propose instruction fixes as a reviewable diff in the conversation; do not apply them here.
No addition needed is valid. If files/goal changed, rerun inspection and reconcile; a timestamp alone
is not freshness. A saved record never grants action authority. Report unreadable files plainly and
offer questions instead without repairing or saving. No raw parser text, file bodies or stack traces.

Default: no persistence. If explicitly requested, follow project-goal's reviewed save/undo protocol
for the ONE `.vibepromptrig/checkup.json` shared record. Do not write a second report or silently import
prototype records. Native relevance/comprehension and real runtime outcomes stay pending until observed.
