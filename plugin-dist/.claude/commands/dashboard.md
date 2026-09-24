---
description: Live "where things stand" status table -- forge doctor, commits, goals/milestones, blockers, spend -- printed in the terminal. Reuses cockpit.ps1; honest labels (MEASURED/ESTIMATED/DECLARED/NOT-TRACKED).
argument-hint: [--refresh | --help]
allowed-tools: Bash(powershell *)
---

# /dashboard -- live factory status

Run the dashboard status script and show its output verbatim. The script
(`scripts/dashboard.ps1`) is the single source of truth -- it REUSES `scripts/cockpit.ps1`
(`-Json`) for the status data and only formats it, so do NOT re-compute or re-format anything
yourself.

**Args:** $ARGUMENTS

Run exactly one of these via Bash, choosing flags from the args:
- args contain `--help` / `help`  -> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard.ps1 -Help`
- args contain `--refresh` / `refresh` -> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard.ps1 -Refresh`
- otherwise (default, fast/cached) -> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dashboard.ps1`

Then present the script's terminal output directly to the user. The default is a fast cached
snapshot; `--refresh` re-runs `forge doctor` live. To customize what shows or the data source,
the user edits the `dashboard` block in `.forge/cockpit.json` (sections, data_source:
terminal|mcp|both, refresh_cache_minutes). Full guide: `docs/tutorials/dashboard.md`.

Honesty contract is non-negotiable: the script never fabricates a number -- cost/token figures
stay [NOT-TRACKED] / [ESTIMATED] until the provider router has logged real `ai_call` events
(data_source=mcp). Relay the labels as-is.
