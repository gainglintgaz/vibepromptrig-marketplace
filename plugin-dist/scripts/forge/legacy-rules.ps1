param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RestArgs = @())

# forge legacy-rules -- thin wrapper over the canonical Node implementation (Context V2 Delivery 3b).
# There is no PowerShell-only cleanup path: without Node nothing is planned, removed or restored.
$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "legacy-rules.mjs"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js >= 18 is required for forge legacy-rules. Nothing was changed."
    exit 2
}
if (-not (Test-Path -LiteralPath $nodeScript)) {
    Write-Error "Canonical Node legacy-rules cleanup is missing: $nodeScript"
    exit 2
}

& node $nodeScript @RestArgs
exit $LASTEXITCODE
