param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RestArgs = @())

$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "context.mjs"
if (-not (Test-Path -LiteralPath $nodeScript)) {
    Write-Error "Canonical Node context resolver is missing: $nodeScript"
    exit 2
}

& node $nodeScript @RestArgs
exit $LASTEXITCODE
