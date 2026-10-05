# The `/dashboard` -- your factory's status in one screen

`/dashboard` shows the current branch and commit, recent activity, factory health, goals,
blockers, and spend. The customer package includes the terminal dashboard. Its optional MCP
servers are not included in this distribution, so use `dashboard.data_source: "terminal"`.

## Quickstart

In a VibePromptRig factory session, run:

```text
/dashboard
```

The command reads Git history and `.forge/cockpit.json`. It reports measured facts, declared
goals, and missing measurements with distinct labels. To refresh the cached status and rerun
`forge doctor`:

```text
/dashboard --refresh
```

For command help:

```text
/dashboard --help
```

The command runs `scripts/dashboard.ps1`, which reuses `scripts/cockpit.ps1` as its status
source.

## Choose what appears

Edit the `dashboard` block in `.forge/cockpit.json`:

```json
"dashboard": {
  "sections": ["status", "goals", "blockers", "spend"],
  "data_source": "terminal",
  "refresh_cache_minutes": 10
}
```

Remove unwanted sections from the list. The cache interval controls when a snapshot is
refreshed; `/dashboard --refresh` forces a refresh. Keep `data_source` at `terminal` for
this package. An MCP-backed cost source requires separately distributed servers and is not a
setup path offered by this marketplace.

## Honesty labels

| Label | Meaning |
|---|---|
| **[MEASURED]** | A fact read from Git, factory metrics, or `forge doctor`. |
| **[ESTIMATED]** | An approximate value, labeled as such. |
| **[DECLARED]** | A goal or milestone judgment you set in `.forge/cockpit.json`. |
| **[NOT-TRACKED]** | The package has no measurement for this value yet. |

On a fresh installation, spend can be **[NOT-TRACKED]**. The dashboard does not replace
missing measurements with a fabricated zero.

## Cheatsheet

| You want | Do this |
|---|---|
| Status table | `/dashboard` |
| Live refresh | `/dashboard --refresh` |
| Help | `/dashboard --help` |
| Fewer sections | Edit `dashboard.sections` in `.forge/cockpit.json` |
