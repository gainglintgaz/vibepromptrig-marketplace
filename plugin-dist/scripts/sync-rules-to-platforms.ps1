<#
.SYNOPSIS
    PowerShell entry point for the canonical flat rule-mirror renderer.

.DESCRIPTION
    The Node implementation is the single renderer of record. Delegating prevents PowerShell
    encoding defaults and profile filtering from drifting from the UTF-8/no-BOM canonical output.
    It deliberately does not implement Context Kernel appendices or parse `group:` metadata.
#>
param(
    [string]$FactoryRoot = "",
    [string]$TargetRoot = "",
    [switch]$DryRun,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
if (-not $FactoryRoot) { $FactoryRoot = Split-Path $PSScriptRoot -Parent }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js is required for canonical mirror generation."
    exit 1
}

$renderer = Join-Path $PSScriptRoot "sync-rules-to-platforms.mjs"
if (-not (Test-Path $renderer)) {
    Write-Error "Canonical Node renderer not found: $renderer"
    exit 1
}

$rendererArgs = @($renderer, "--factory-root", $FactoryRoot)
if ($DryRun) { $rendererArgs += "--dry-run" }
if ($TargetRoot) { $rendererArgs += @("--target-root", $TargetRoot) }
if ($Quiet) { $rendererArgs += "--quiet" }

& node @rendererArgs
exit $LASTEXITCODE
