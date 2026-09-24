<#
.SYNOPSIS
    Safe Windows launcher for the cross-platform restore drill.

.DESCRIPTION
    This file intentionally contains no restore implementation and accepts no connection string
    or URI parameter. It delegates only a fixed allowlist of non-secret options to its sibling
    restore-drill.mjs, which reads every sensitive endpoint from its configured environment name.
    Child output is streamed directly and the Node exit code is preserved.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,62}$')]
    [string]$Target,
    [string]$ConfigPath,
    [ValidateRange(1, 3650)]
    [int]$MaxAgeDays = 2,
    [switch]$DryRun,
    [string]$ConfirmTarget
)

$ErrorActionPreference = 'Stop'
$engine = Join-Path $PSScriptRoot 'restore-drill.mjs'
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
    Write-Error '[FAIL] restore drill engine is missing.'
    exit 1
}

# Array invocation keeps every forwarded value one argv element. Do not add a URI-bearing option
# here: the Node engine accepts protected database and Storage settings through named env vars only.
$nodeArgs = @($engine, '--target', $Target, '--max-age-days', [string]$MaxAgeDays)
if ($ConfigPath) { $nodeArgs += @('--config-path', $ConfigPath) }
if ($ConfirmTarget) { $nodeArgs += @('--confirm-target', $ConfirmTarget) }
if ($DryRun) { $nodeArgs += '--dry-run' }

try {
    & node @nodeArgs
    exit $LASTEXITCODE
} catch {
    Write-Error '[FAIL] restore drill launcher could not start Node.'
    exit 1
}
