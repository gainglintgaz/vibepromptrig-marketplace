<#
.SYNOPSIS
    Validate compact context, or install it only to an explicit target.

.DESCRIPTION
    Historical sync reactivated AGENTS-<profile>.md and could recreate a full native dump.
    This compatibility entrypoint is intentionally validation-only without -TargetRoot.
#>
param(
    [string]$FactoryRoot = "",
    [string]$TargetRoot = "",
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$sync = Join-Path (Split-Path $PSScriptRoot -Parent) "sync-rules-to-platforms.ps1"
if (-not (Test-Path $sync)) { Write-Error "Synchronizer missing: $sync"; exit 1 }
$syncOptions = @{ FactoryRoot = $FactoryRoot }
if ($TargetRoot) { $syncOptions.TargetRoot = $TargetRoot }
if ($DryRun) { $syncOptions.DryRun = $true }
& $sync @syncOptions
exit $LASTEXITCODE
