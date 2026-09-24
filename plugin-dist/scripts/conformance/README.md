# Cross-OS conformance harness (cross-platform port P2)

> Built in **T0** (the proof harness). Spec: `docs/architecture/cross-platform-port.md` §11.
> Everything here is Node (`.mjs`) + JSON, dependency-free, Node >= 18, identical on
> Windows / macOS / Linux.

## What this is

The auditor persona's gating artifact for the port (arch doc §5): a **golden-fixture
conformance suite**. Each fixture is a captured hook-stdin shape plus the
**Windows-reference expectation** (`{exit_code, stdout/stderr routing, side_effects}`).
`run.mjs` replays a fixture into a gate and asserts the gate reproduces that record
**byte-identically on all three OS**. Windows (the existing `.ps1` gates) is the oracle;
every later tranche's Node twin must match it on every cell or the cell goes red.

## T0 scope (no gates yet)

The gate registry in `run.mjs` (`GATES`) is **intentionally empty** in T0 -- no gate is
ported, so nothing is replayed. The harness instead proves it **loads, runs, and
validates the entire corpus** (parse + base64-decode + schema) identically on all three
OS cells. Verdict `HARNESS-OK` = corpus valid, harness runs everywhere. T1 populates
`GATES` and the replay path lights up with **zero harness changes**.

```
node scripts/conformance/run.mjs          # human output
node scripts/conformance/run.mjs --json    # machine output (CI)
```

## Fixture schema (`fixtures/*.json`)

| field | meaning |
|---|---|
| `name` | unique fixture id |
| `hook_event` | `PreToolUse` \| `SessionStart` \| `Stop` \| `UserPromptSubmit` |
| `tool` | `Bash` \| `Write` \| `apply_migration` \| `null` (lifecycle) |
| `category` | `happy` \| `destructive` \| `lifecycle` \| `edge-empty` \| `edge-bom` \| `edge-malformed` |
| `gate` | the gate (T1+) this replays into; informational in T0 |
| `description` | what it proves |
| `stdin` | the envelope as a JSON object (the runner serializes it), OR `null` |
| `stdin_b64` | **exact bytes**, base64 -- used for BOM / empty / malformed / truncated cases where the payload is not clean JSON. Takes precedence over `stdin`. `""` = empty stdin. |
| `expect` | `{exit_code, stdout, stderr_contains, side_effects[]}` -- the Windows-reference oracle |
| `provenance` | how the shape/expectation was captured |

`stdin` keeps the common cases human-readable; `stdin_b64` makes the edge cases
**byte-exact** (a BOM is a byte fact, not a string fact). The runner prefers `stdin_b64`.

## The corpus (15)

Tool calls: `bash-innocuous`, `bash-destructive-drop-table`, `bash-delete-no-where`,
`bash-delete-with-where` (false-positive boundary), `write-innocuous`,
`apply-migration-destructive`, `apply-migration-safe`.
Lifecycle: `session-start`, `stop`, `user-prompt-submit`.
Edges (the malformed / BOM / empty cases the PS gates already tolerate, arch doc §6/§9):
`edge-empty-stdin`, `edge-whitespace-only`, `edge-bom-prefixed`, `edge-malformed-json`,
`edge-truncated-json`.

## Provenance (how these were captured)

Captured from a **live Windows Claude Code session (2026-06-13)**. Each envelope's field
contract was verified against the gate that consumes it -- `scripts/hooks/
pre-bash-destructive-sql-guard.ps1`, `pre-migration-destructive-guard.ps1`,
`pre-write-mcp-advisor.ps1`, `session-guard.ps1`, and `scripts/signal-classifier-tier1.ps1`
-- which read the same `[Console]::In.ReadToEnd()` stdin and key off `tool_name` /
`tool_input.*` / `hook_event_name` / `prompt` / `source`. The BOM and empty/malformed
expectations come straight from those scripts' tolerance paths (BOM strip; parse-fail ->
exit 0). Values are neutral (no machine paths / identity) so the corpus is OS-agnostic
and safe to ship in `plugin-dist`.

## Wiring a gate in T1

Add to `GATES` in `run.mjs` (the only change needed):

```js
'pre-bash-destructive-sql-guard': {
  invoke: (root) => process.platform === 'win32'
    ? { cmd: 'powershell', args: ['-NonInteractive','-ExecutionPolicy','Bypass','-File',
        join(root,'scripts/hooks/pre-bash-destructive-sql-guard.ps1')] }      // Windows oracle
    : { cmd: 'node', args: [join(root,'scripts/hooks/pre-bash-destructive-sql-guard.mjs')] }, // ported twin
}
```

The runner then replays every fixture whose `gate` matches and asserts `expect`.
