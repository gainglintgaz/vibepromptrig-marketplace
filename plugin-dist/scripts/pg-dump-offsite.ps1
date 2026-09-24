<#
.SYNOPSIS
    Compatibility launcher for the VibePromptRig encrypted offsite backup engine.

.DESCRIPTION
    The implementation lives in pg-dump-offsite.mjs so Windows, macOS, and Linux share one
    custody contract: local age encryption, ciphertext SHA-256 sidecars, provider receipts,
    and fail-loud verification. This wrapper deliberately contains no backup logic and never
    reads, prints, or stores credentials.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$Target,
    [switch]$DryRun,
    [switch]$Init,
    [string]$PgDumpPath,
    [string]$RcloneRemote,
    [int]$RetainLocalDays = 3,
    [string]$LocalDumpDir,
    [string]$RclonePath,
    [string]$AgePath,
    [switch]$StartupCatchup
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error '[FAIL] pg-dump-offsite requires Node.js. Install Node 18+ and rerun.'
    exit 1
}

$engine = Join-Path $PSScriptRoot 'pg-dump-offsite.mjs'
if (-not (Test-Path $engine)) {
    Write-Error "[FAIL] encrypted backup engine not found: $engine"
    exit 1
}

$nodeArgs = @($engine, '--retain-local-days', $RetainLocalDays)
if ($ConfigPath) { $nodeArgs += @('--config', $ConfigPath) }
if ($Target) { $nodeArgs += @('--target', $Target) }
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($Init) { $nodeArgs += '--init' }
if ($PgDumpPath) { $nodeArgs += @('--pg-dump-path', $PgDumpPath) }
if ($RcloneRemote) { $nodeArgs += @('--rclone-remote', $RcloneRemote) }
if ($LocalDumpDir) { $nodeArgs += @('--local-dump-dir', $LocalDumpDir) }
if ($RclonePath) { $nodeArgs += @('--rclone-path', $RclonePath) }
if ($AgePath) { $nodeArgs += @('--age-path', $AgePath) }
if ($StartupCatchup) { $nodeArgs += '--startup-catchup' }

& $node.Source @nodeArgs
exit $LASTEXITCODE
