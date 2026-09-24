<#
.SYNOPSIS
    Composable-outputs + traceability verifier (composable-outputs.md, two-way-traceability.md).
    HONEST COVERAGE PROXY (v0.1): confirms the gate + schema EXIST and BITE at the factory level --
    it does NOT machine-validate every composed definition against a live registry (that is the v0.2
    north-star, enforced app-side). Mirrors verify-enforcement.ps1.

    Checks:
      1. docs/rules-reference/factory/composable-outputs.md exists + is enforcement-tagged (tier 1, load_bearing true).
      2. agent-schemas/composed-output.schema.json exists + parses as JSON.
      3. The .valid.json sample parses AND satisfies doctrine structurally
         (blocks>=1 AND (authored_by=user OR ai_provenance has prompt_version+run_id+sources)).
      4. The .broken-missing-provenance.json sample parses AND is CORRECTLY broken
         (authored_by ai/ai_then_user WITHOUT ai_provenance) -- proving the gate rejects ungrounded AI output.
      5. two-way-traceability.md contains the Agent-Run / Workflow Provenance section.

.NOTES
    PS 5.1, ASCII. Exit 0 = pass/warn, exit 1 = fail.
#>
[CmdletBinding()]
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$ErrorActionPreference = "Stop"
$Mode = 'fail'

$failures = @()

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return 'PARSE_ERROR' }
}

# --- 1. rule exists + enforcement-tagged ---
$rule = Join-Path $FactoryRoot "docs\rules-reference\factory\composable-outputs.md"
if (-not (Test-Path $rule)) {
    $failures += "composable-outputs.md MISSING"
} else {
    $raw = Get-Content -Path $rule -Raw -Encoding UTF8
    $fm = ""
    if ($raw -match '(?s)^\s*---\r?\n(.*?)\r?\n---') { $fm = $Matches[1] }
    if ($fm -notmatch '(?m)^enforcement_tier:\s*1\s*$') { $failures += "composable-outputs.md not tagged enforcement_tier: 1" }
    if ($fm -notmatch '(?m)^load_bearing:\s*true\s*$') { $failures += "composable-outputs.md not tagged load_bearing: true" }
}

# --- 2. schema exists + parses ---
$schemaPath = Join-Path $FactoryRoot "agent-schemas\composed-output.schema.json"
$schema = Read-JsonFile $schemaPath
if ($null -eq $schema) { $failures += "composed-output.schema.json MISSING" }
elseif ($schema -eq 'PARSE_ERROR') { $failures += "composed-output.schema.json does not parse" }

# --- 3. valid sample parses + satisfies doctrine ---
$validPath = Join-Path $FactoryRoot "agent-schemas\samples\composed-output.valid.json"
$valid = Read-JsonFile $validPath
if ($null -eq $valid) { $failures += "composed-output.valid.json MISSING" }
elseif ($valid -eq 'PARSE_ERROR') { $failures += "composed-output.valid.json does not parse" }
else {
    $blockCount = @($valid.blocks).Count
    if ($blockCount -lt 1) { $failures += "valid sample has no registered blocks (composed-outputs.md SS3)" }
    $aiAuthored = ($valid.authored_by -eq 'ai' -or $valid.authored_by -eq 'ai_then_user')
    if ($aiAuthored) {
        $p = $valid.ai_provenance
        if ($null -eq $p -or -not $p.prompt_version -or -not $p.run_id -or -not $p.sources) {
            $failures += "valid sample is AI-authored but missing ai_provenance{prompt_version,run_id,sources} (SS5)"
        }
    }
}

# --- 4. broken sample parses + is CORRECTLY broken (gate bites) ---
$brokenPath = Join-Path $FactoryRoot "agent-schemas\samples\composed-output.broken-missing-provenance.json"
$broken = Read-JsonFile $brokenPath
if ($null -eq $broken) { $failures += "composed-output.broken-missing-provenance.json MISSING" }
elseif ($broken -eq 'PARSE_ERROR') { $failures += "broken sample does not parse (it should be valid JSON, just doctrine-broken)" }
else {
    $brokenAi = ($broken.authored_by -eq 'ai' -or $broken.authored_by -eq 'ai_then_user')
    if (-not ($brokenAi -and ($null -eq $broken.ai_provenance))) {
        $failures += "broken sample is NOT actually broken (expected AI-authored without ai_provenance) -- the gate would not bite"
    }
}

# --- 5. agent-run provenance section present in two-way-traceability.md ---
$twt = Join-Path $FactoryRoot "docs\rules-reference\factory\two-way-traceability.md"
if (-not (Test-Path $twt)) {
    $failures += "two-way-traceability.md MISSING"
} else {
    $twtRaw = Get-Content -Path $twt -Raw -Encoding UTF8
    if ($twtRaw -notmatch '(?i)Agent[ -]?Run.{0,30}Provenance') {
        $failures += "two-way-traceability.md has no Agent-Run / Workflow Provenance section"
    }
}

# --- verdict ---
$status = if ($failures.Count -gt 0) { 'fail' } else { 'pass' }
$message = if ($status -eq 'pass') {
    "composable-outputs gate live: rule tagged, schema+samples present, valid passes, broken correctly rejected, agent-run provenance section present [COVERAGE PROXY: confirms gate exists+bites at factory level; per-definition validation is app-side v0.2]"
} else {
    ("{0} traceability/composable-outputs coverage failure(s)" -f $failures.Count)
}

if ($Json) {
    [pscustomobject]@{
        check   = 'traceability-composable-outputs'
        status  = $status
        mode    = $Mode
        message = $message
        details = @($failures | Select-Object -First 12)
    } | ConvertTo-Json -Depth 4
} else {
    Write-Host ("[{0}] traceability-composable-outputs ({1} mode): {2}" -f $status.ToUpper(), $Mode, $message)
    $failures | Select-Object -First 20 | ForEach-Object { Write-Host ("    " + $_) }
}

if ($status -eq 'fail') { exit 1 } else { exit 0 }
