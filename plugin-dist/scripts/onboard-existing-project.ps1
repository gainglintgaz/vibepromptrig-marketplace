<#
.SYNOPSIS
    Onboard an existing project into VibePromptRig (compact context, tracking files, gates, factory brief).
    Thin wrapper over scripts/onboard-existing-project.mjs; requires Node.js and never copies full rule bodies.
.EXAMPLE
    .\scripts\onboard-existing-project.ps1 -Path "C:\path\to\some-project"
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Path,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Preserve the PowerShell interface while routing all installation through the compact Node
# installer (the historical full-rule-copy body was removed in Context V2 Delivery 3b).
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeOnboard = Join-Path $PSScriptRoot "onboard-existing-project.mjs"
if ($node -and (Test-Path $nodeOnboard)) {
    $delegateArgs = @($nodeOnboard, "--path", $Path)
    if ($Force) { $delegateArgs += "--force" }
    & node @delegateArgs
    exit $LASTEXITCODE
}

# Context V2 Delivery 3b: there is no PowerShell-only onboard path. The historical fallback copied
# the factory's full .claude/rules tree into the project; the compact Node installer is now the only
# writer of native instruction files, so without Node this entrypoint fails before touching anything.
if (-not $node) {
    Write-Error "Node.js >= 18 is required: onboard installs compact context through scripts/onboard-existing-project.mjs. Nothing was written. Install Node.js and re-run."
    exit 1
}
Write-Error "Canonical Node onboard not found: $nodeOnboard. Nothing was written."
exit 1
