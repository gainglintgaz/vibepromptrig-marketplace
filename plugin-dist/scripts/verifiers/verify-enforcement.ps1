<#
.SYNOPSIS
    Enforcement-coverage verifier (enforcement-first.md). HONEST COVERAGE PROXY:
    v0.1 confirms a gate is DECLARED + REFERENCED for every load-bearing rule --
    it does NOT prove the gate actually catches violations (a rule could still
    reference a weak gate). The real rule->verifier registry is the v0.2 north-star.

    Checks every .claude\rules\**\*.md frontmatter:
      enforcement_tier: 1|2|3   load_bearing: true|false   enforcement_ref: <gate>
    - load_bearing:true + tier 1|2  -> requires non-empty enforcement_ref AND a
      gate/tripwire section in the body; any path-like ref must exist on disk.
    - tier 3 / load_bearing:false   -> skipped (advisory is legitimate).
    - UNTAGGED                      -> WARN in warn-mode, FAIL in fail-mode.
    - load_bearing:true + tier 3    -> ALWAYS a finding (the ghost-rule signature).

.NOTES
    PS 5.1, ASCII. Exit 0 = pass/warn, exit 1 = fail.
    $Mode below is the migration switch: shipped as 'warn'; flipped to 'fail'
    after the one-time corpus classification (enforcement-first-spec.md SS6).
#>
[CmdletBinding()]
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$ErrorActionPreference = "Stop"

# MIGRATION SWITCH: 'warn' on first ship -> 'fail' after corpus classification.
# FLIPPED 2026-06-05: corpus fully classified (42/42 tagged, 0 ghosts) -- untagged
# or ghost rules now turn forge doctor RED.
$Mode = 'fail'

# Every legacy rule body lives in the relocated reference corpus (Context V2 Delivery 3b).
$rulesDir = Join-Path $FactoryRoot "docs\rules-reference\factory"
$ruleFiles = @()
if (Test-Path -LiteralPath $rulesDir) {
    $ruleFiles = @(Get-ChildItem -Path $rulesDir -Filter "*.md" -File -Recurse | Sort-Object FullName)
}

$untagged  = @()
$failures  = @()
$ghosts    = @()   # load_bearing:true + tier 3
$tier12    = 0
$tier3     = 0

$gateSectionPattern = '(?i)(tripwire|audit gate|pre-commit|interlock|verifier|hook|mechanical gate|hard gate|blocking gate|veto|sign-off gate|checklist)'

foreach ($f in $ruleFiles) {
    $raw = Get-Content -Path $f.FullName -Raw -Encoding UTF8
    $rel = $f.FullName.Substring((Resolve-Path -LiteralPath $rulesDir).Path.Length + 1)

    # frontmatter block (leading --- ... ---)
    $fm = ""
    if ($raw -match '(?s)^\s*---\r?\n(.*?)\r?\n---') { $fm = $Matches[1] }

    $tier = $null; $lb = $null; $ref = $null
    if ($fm -match '(?m)^enforcement_tier:\s*([123])\s*$') { $tier = [int]$Matches[1] }
    if ($fm -match '(?m)^load_bearing:\s*(true|false)\s*$') { $lb = ($Matches[1] -eq 'true') }
    if ($fm -match '(?m)^enforcement_ref:\s*"?([^"\r\n]+)"?\s*$') { $ref = $Matches[1].Trim() }

    if ($null -eq $tier -or $null -eq $lb) {
        $untagged += $rel
        continue
    }

    if ($lb -and $tier -eq 3) {
        $ghosts += ("{0} : load_bearing:true with enforcement_tier:3 -- a load-bearing rule with no gate (the ghost-rule signature)" -f $rel)
        continue
    }

    if (-not $lb -or $tier -eq 3) { $tier3++; continue }

    # load_bearing:true + tier 1|2 -> coverage requirements
    $tier12++
    if (-not $ref) {
        $failures += ("{0} : tier {1} load-bearing rule with EMPTY enforcement_ref" -f $rel, $tier)
        continue
    }
    # any path-like token in the ref must exist on disk
    $pathTokens = @([regex]::Matches($ref, '[\w./\\-]+\.(ps1|sh|json|js|ts|mjs)') | ForEach-Object { $_.Value })
    foreach ($pt in $pathTokens) {
        $cand = Join-Path $FactoryRoot ($pt -replace '/', '\')
        if (-not (Test-Path $cand)) {
            $failures += ("{0} : enforcement_ref points at missing file '{1}'" -f $rel, $pt)
        }
    }
    if ($raw -notmatch $gateSectionPattern) {
        $failures += ("{0} : tier {1} rule body has no tripwire/gate section" -f $rel, $tier)
    }
}

# ---- verdict ----
$details = @()
$status = 'pass'
$msgParts = @()
# An empty or missing corpus is not coverage: never report a vacuous pass.
if ($ruleFiles.Count -eq 0) { $status = 'fail'; $details += "no rule files found in $rulesDir" }

if ($ghosts.Count -gt 0) { $status = 'fail'; $details += $ghosts }
if ($failures.Count -gt 0) { $status = 'fail'; $details += $failures }
if ($untagged.Count -gt 0) {
    $details += ($untagged | ForEach-Object { "UNTAGGED: $_" })
    if ($Mode -eq 'fail') { $status = 'fail' } elseif ($status -eq 'pass') { $status = 'warn' }
}

$msgParts += ("{0} rules: {1} load-bearing gated (tier 1/2), {2} advisory (tier 3), {3} untagged, {4} ghost, {5} coverage failures" -f `
    $ruleFiles.Count, $tier12, $tier3, $untagged.Count, $ghosts.Count, $failures.Count)
$msgParts += "[COVERAGE PROXY: confirms gates are DECLARED+REFERENCED, not that they catch violations -- v0.2 registry hardens this]"
$message = $msgParts -join ' '

if ($Json) {
    [pscustomobject]@{
        check   = 'enforcement-coverage'
        status  = $status
        mode    = $Mode
        message = $message
        details = @($details | Select-Object -First 12)
    } | ConvertTo-Json -Depth 4
} else {
    Write-Host ("[{0}] enforcement-coverage ({1} mode): {2}" -f $status.ToUpper(), $Mode, $message)
    $details | Select-Object -First 20 | ForEach-Object { Write-Host ("    " + $_) }
}

if ($status -eq 'fail') { exit 1 } else { exit 0 }
