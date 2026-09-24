<#
.SYNOPSIS
    InstructionsLoaded hook: append every rule-load event to factory_metrics.jsonl.

.DESCRIPTION
    Validation tool for the v4.4.5 token-burn fix sprint, Step A of Commit 1.5
    per docs/v4.4.5/architect-probe-first-run.md §6.

    Reads JSON payload from stdin per Claude Code InstructionsLoaded hook spec
    (https://code.claude.com/docs/en/hooks). Appends one event=instruction_loaded
    row to factory_metrics.jsonl with file_path, memory_type, load_reason, and
    matched paths globs.

    Used to empirically validate that `paths:` frontmatter actually scopes rule
    loading as documented BEFORE adding paths: to ~16 production rule files.

.NOTES
    PowerShell 5.1 compatible. ASCII only.
    Hook output: exit code ignored per spec; this hook is observability-only.
    No decision control; cannot block loading.
#>

[CmdletBinding()]
param()
$ErrorActionPreference = "SilentlyContinue"

try {
    # Read stdin JSON payload
    $stdinRaw = [Console]::In.ReadToEnd()
    if (-not $stdinRaw) { exit 0 }

    $payload = $stdinRaw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $payload) { exit 0 }

    # Resolve factory root via the cwd field (or fall back to script dir)
    $factoryRoot = if ($payload.cwd) { $payload.cwd } else { Split-Path -Parent $PSScriptRoot }
    $metricsPath = Join-Path $factoryRoot "factory_metrics.jsonl"

    # Fallback to canonical factory metrics if cwd doesn't have one
    if (-not (Test-Path (Split-Path -Parent $metricsPath))) {
        $metricsPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "factory_metrics.jsonl"
    }

    $entry = [ordered]@{
        ts                 = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        event              = "instruction_loaded"
        session_id         = $payload.session_id
        cwd                = $payload.cwd
        file_path          = $payload.file_path
        memory_type        = $payload.memory_type
        load_reason        = $payload.load_reason
        globs              = $payload.globs
        trigger_file_path  = $payload.trigger_file_path
        parent_file_path   = $payload.parent_file_path
    }

    $line = $entry | ConvertTo-Json -Compress -Depth 5
    Add-Content -Path $metricsPath -Value $line -Encoding UTF8
} catch {
    # Swallow errors silently per hook contract; never block loading
}

exit 0
