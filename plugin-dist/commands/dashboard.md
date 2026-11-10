---
description: Show current project status, goals, blockers and spending with measured and declared facts clearly labeled.
argument-hint: [--refresh | --help]
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs" --help)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs" --refresh)
---

> **Needs Claude Code with your project open and Node.js 18+.** Run `/vibepromptrig:dashboard` to display the current project's status. In chat, it cannot run: open the project in Claude Code first.

# /dashboard -- current project status

Run the packaged Node dashboard and show its output verbatim. It reuses the packaged cockpit
for status data; do not recompute or reformat the results yourself. Keep the working directory
at the user's project. The script derives the customer data root from its working directory, isolating that project's cache and data even if an inherited VIBE_ROOT points elsewhere. Executable dependencies remain package-relative.

**Args:** $ARGUMENTS

Run exactly one of these via Bash, choosing only the documented flags from the args:
- args contain `--help` / `help` -> `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs" --help`
- args contain `--refresh` / `refresh` -> `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs" --refresh`
- otherwise (default, fast/cached) -> `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs"`

Do not append raw arguments to a shell command. If CLAUDE_PLUGIN_ROOT is unavailable, report
that the installed plugin path is missing; do not guess a path or run a project-local script.

Present the script's terminal output directly. The default uses a cached snapshot;
`--refresh` refreshes it and reruns the packaged doctor. Customer preferences live in
`.forge/cockpit.json`. The shipped package supports the terminal data source; optional MCP
servers are not included. Full guide: `${CLAUDE_PLUGIN_ROOT}/docs/tutorials/dashboard.md`.

Preserve all [MEASURED], [DECLARED], [NOT-TRACKED], [ESTIMATED] and [PARTIAL] labels.
Missing cost or token measurements must never be presented as measured zero.
