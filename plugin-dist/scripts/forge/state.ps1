param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RestArgs = @())

# Launcher only (decision 0: PowerShell files are launchers). Logic lives in state.mjs.
$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "state.mjs"
if (-not (Test-Path -LiteralPath $nodeScript)) {
    Write-Error "forge state Node CLI is missing: $nodeScript"
    exit 2
}

& node $nodeScript @RestArgs
exit $LASTEXITCODE
