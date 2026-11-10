<#
.SYNOPSIS
    VibePromptRig project scaffolding. Thin wrapper over scripts/scaffold-new-project.mjs;
    requires Node.js and never copies full rule bodies.
.EXAMPLE
    .\scripts\scaffold-new-project.ps1 -Name "Example Research App" -Template vite
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Name,

    [ValidateSet("vite", "nextjs", "empty")]
    [string]$Template = "vite",

    [ValidateSet("", "ai-purchase-research", "saas", "bookkeeping", "travel")]
    [string]$Pack = "",

    [switch]$ClientReady
)

$ErrorActionPreference = "Stop"

# Canonical compact scaffold lives in Node.  Keep this PowerShell entrypoint for callers, but
# delegate (the historical full-rule copy implementation was removed in Context V2 Delivery 3b).
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeScaffold = Join-Path $PSScriptRoot "scaffold-new-project.mjs"
if ($node -and (Test-Path $nodeScaffold)) {
    $delegateArgs = @($nodeScaffold, "--name", $Name, "--template", $Template)
    if ($Pack) { $delegateArgs += @("--pack", $Pack) }
    if ($ClientReady) { $delegateArgs += "--client-ready" }
    & node @delegateArgs
    exit $LASTEXITCODE
}

# Context V2 Delivery 3b: there is no PowerShell-only scaffold path. The historical fallback copied
# the factory's full .claude/rules tree into the project; the compact Node installer is now the only
# writer of native instruction files, so without Node this entrypoint fails before touching anything.
if (-not $node) {
    Write-Error "Node.js >= 18 is required: scaffold installs compact context through scripts/scaffold-new-project.mjs. Nothing was written. Install Node.js and re-run."
    exit 1
}
Write-Error "Canonical Node scaffold not found: $nodeScaffold. Nothing was written."
exit 1
