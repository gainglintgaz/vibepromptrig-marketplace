<#
.SYNOPSIS
    validate-agent-schemas.ps1 -- validates every sample under agent-schemas/samples/
    against its schema. Passes valid samples; FAILS LOUD on broken ones (negative test).
.DESCRIPTION
    v5.0 Sprint 1, Commit 1. Arch artifact 9d7294c.
    Sample naming contract:
      <prefix>.valid.json          -> MUST validate clean.
      <prefix>.broken-<why>.json   -> MUST be rejected (negative test).
    <prefix> maps to agent-schemas/<prefix>.schema.json.

    Honors A3 (path jail), A4 (fail loud), A5 (schema_version const skew),
    A10 (secrets scan) via Test-ConfigArtifact in scripts/forge/config-lib.ps1.

    Exit 0 only if every valid sample passes AND every broken sample is rejected.
    Exit 1 otherwise. PowerShell 5.1 compatible, ASCII only.
.PARAMETER Json
    Emit a JSON summary instead of the text table.
#>

[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'

try {
    $u = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $u
} catch { }

$factoryRoot = Split-Path -Parent $PSScriptRoot
$schemaDir   = Join-Path $factoryRoot 'agent-schemas'
$sampleDir   = Join-Path $schemaDir 'samples'

. (Join-Path $PSScriptRoot 'forge\config-lib.ps1')

if (-not (Test-Path $sampleDir)) {
    Write-Error "Sample directory not found: $sampleDir"
    exit 2
}

$samples = @(Get-ChildItem -Path $sampleDir -Filter '*.json' -File | Sort-Object Name)
if ($samples.Count -eq 0) {
    Write-Error "No samples found in $sampleDir"
    exit 2
}

$results = @()

foreach ($s in $samples) {
    $name = $s.Name
    $prefix = ($name -split '\.')[0]
    $expectValid = $name -like '*.valid.*'
    $expectLabel = if ($expectValid) { 'valid' } else { 'reject' }
    $schemaPath = Join-Path $schemaDir ("{0}.schema.json" -f $prefix)

    $verdict = 'PASS'
    $detail  = ''

    if (-not (Test-Path $schemaPath)) {
        $verdict = 'FAIL'
        $detail  = "no schema for prefix '$prefix' ($schemaPath)"
        $results += [pscustomobject]@{ Sample = $name; Expect = $expectLabel; Verdict = $verdict; Detail = $detail }
        continue
    }

    # Parse schema + sample. A malformed VALID sample is itself a failure;
    # a malformed BROKEN sample counts as correctly-rejected (it is broken).
    $schema = $null; $data = $null; $parseErr = $null
    try { $schema = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json } catch {
        $verdict = 'FAIL'; $detail = "schema is not valid JSON: $($_.Exception.Message)"
        $results += [pscustomobject]@{ Sample = $name; Expect = 'valid'; Verdict = $verdict; Detail = $detail }
        continue
    }
    try { $data = Get-Content -Raw -LiteralPath $s.FullName | ConvertFrom-Json } catch { $parseErr = $_.Exception.Message }

    if ($null -ne $parseErr) {
        # Sample did not parse.
        if ($expectValid) {
            $verdict = 'FAIL'; $detail = "valid sample is not parseable JSON: $parseErr"
        } else {
            $verdict = 'PASS'; $detail = "rejected (unparseable JSON) -- $parseErr"
        }
        $results += [pscustomobject]@{ Sample = $name; Expect = $expectLabel; Verdict = $verdict; Detail = $detail }
        continue
    }

    $errs = @(Test-ConfigArtifact -Data $data -Schema $schema -Base $factoryRoot)

    if ($expectValid) {
        if ($errs.Count -eq 0) { $verdict = 'PASS'; $detail = 'valid sample accepted' }
        else { $verdict = 'FAIL'; $detail = ("valid sample REJECTED: {0}" -f ($errs -join ' | ')) }
    } else {
        if ($errs.Count -gt 0) { $verdict = 'PASS'; $detail = ("rejected as expected: {0}" -f ($errs[0])) }
        else { $verdict = 'FAIL'; $detail = 'broken sample was ACCEPTED (negative test failed)' }
    }

    $results += [pscustomobject]@{ Sample = $name; Expect = $expectLabel; Verdict = $verdict; Detail = $detail }
}

$passCount = (@($results | Where-Object { $_.Verdict -eq 'PASS' })).Count
$failCount = (@($results | Where-Object { $_.Verdict -eq 'FAIL' })).Count

if ($Json) {
    [pscustomobject]@{
        samples = $results.Count
        pass    = $passCount
        fail    = $failCount
        results = $results
    } | ConvertTo-Json -Depth 6
    if ($failCount -gt 0) { exit 1 } else { exit 0 }
}

Write-Host ''
Write-Host '==== validate-agent-schemas ===='
Write-Host ("  schema dir : {0}" -f $schemaDir)
Write-Host ("  samples    : {0}" -f $results.Count)
Write-Host ''
foreach ($r in $results) {
    $tag = if ($r.Verdict -eq 'PASS') { '[OK  ]' } else { '[FAIL]' }
    Write-Host ("  {0} {1,-44} ({2}) {3}" -f $tag, $r.Sample, $r.Expect, $r.Detail)
}
Write-Host ''
$color = if ($failCount -gt 0) { 'Red' } else { 'Green' }
Write-Host ("  Result: {0} pass / {1} fail" -f $passCount, $failCount) -ForegroundColor $color

if ($failCount -gt 0) { exit 1 } else { exit 0 }
