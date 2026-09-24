<#
.SYNOPSIS
    forge doctor -- factory health check with plain-English output.

.DESCRIPTION
    Runs all verify-factory checks + additional smoke tests. Output mirrors
    the plain-English convention from `forge profile show` (Day 1 lesson).

    Checks:
      1. verify-factory --check all  (6 truth-drift checks)
      2. Profile resolver smoke test (resolves config end-to-end)
      3. Plan translations JSON valid
      4. forge CLI dispatch smoke test
      5. Mirror regeneration dry-run (sync-rules-to-platforms.ps1 -DryRun)

.PARAMETER FactoryRoot
    Defaults to $env:VIBE_ROOT, else the factory root derived from the script location.

.PARAMETER Json
    Machine-readable output.

.PARAMETER FailFast
    Exit on first failure.

.EXAMPLE
    forge doctor
    forge doctor --json
#>
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json,
    [switch]$FailFast
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ErrorActionPreference = "Stop"

# Packaged runtimes omit the authoring corpus. Share the Node runtime health checks,
# while retaining the existing PowerShell path for a full source factory.
# Same predicate as isPackagedRuntime() in context-contract.mjs: the source factory has no
# .claude/rules tree either (Context V2 Delivery 3b), so only the build's distribution marker plus a
# relocated corpus holding exactly the marker's packaged references selects runtime mode.
function Test-PackagedRuntime([string]$Root) {
    if (Test-Path -LiteralPath (Join-Path $Root '.claude/rules')) { return $false }
    $markerPath = Join-Path $Root '.forge/distribution.json'
    if (-not (Test-Path -LiteralPath $markerPath)) { return $false }
    try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { return $false }
    if ($marker.kind -ne 'packaged-runtime' -or $null -eq $marker.packaged_factory_refs) { return $false }
    $corpusDir = Join-Path $Root 'docs/rules-reference/factory'
    $corpus = @()
    if (Test-Path -LiteralPath $corpusDir) {
        # FullName expands Windows 8.3 aliases, matching the FullName values below.
        $corpusRoot = (Get-Item -LiteralPath $corpusDir).FullName
        $corpus = @(Get-ChildItem -LiteralPath $corpusDir -Recurse -File -Force | ForEach-Object {
            $_.FullName.Substring($corpusRoot.Length + 1) -replace '\\', '/' })
    }
    $declared = @($marker.packaged_factory_refs | ForEach-Object { ([string]$_) -replace '\\', '/' })
    return ((@($corpus | Sort-Object) -join '|') -eq (@($declared | Sort-Object) -join '|'))
}
$runtimeMode = Test-PackagedRuntime $FactoryRoot
if ($runtimeMode) {
    $nodeDoctor = Join-Path $PSScriptRoot 'doctor.mjs'
    if (-not (Test-Path -LiteralPath $nodeDoctor)) { Write-Error "Runtime doctor missing: $nodeDoctor"; exit 1 }
    $doctorArgs = @($nodeDoctor, '--factory-root', $FactoryRoot)
    if ($Json) { $doctorArgs += '--json' }
    if ($FailFast) { $doctorArgs += '--fail-fast' }
    & node @doctorArgs
    exit $LASTEXITCODE
}

$results = @()
$failureCount = 0

function Add-Section {
    param([string]$Name, [string]$Status, [string]$Message, [string[]]$Details = @())
    $script:results += [PSCustomObject]@{
        section = $Name
        status  = $Status
        message = $Message
        details = $Details
    }
    if ($Status -eq "fail") { $script:failureCount++ }
    if (-not $Json) {
        $color = switch ($Status) {
            "pass" { "Green" }
            "fail" { "Red" }
            "warn" { "Yellow" }
            "skip" { "DarkGray" }
            default { "White" }
        }
        $glyph = switch ($Status) {
            "pass" { "OK   " }
            "fail" { "FAIL " }
            "warn" { "WARN " }
            "skip" { "SKIP " }
            default { "?    " }
        }
        Write-Host ("  [{0}] {1,-32} {2}" -f $glyph, $Name, $Message) -ForegroundColor $color
        foreach ($d in $Details) {
            Write-Host ("                                              {0}" -f $d) -ForegroundColor DarkGray
        }
    }
}

if (-not $Json) {
    Write-Host ""
    Write-Host "VibePromptRig factory doctor" -ForegroundColor Cyan
    Write-Host "  Factory root: $FactoryRoot" -ForegroundColor DarkGray
    Write-Host ""
}

# ----------------------------------------------------------------
# Section 1: 6 truth-drift checks (delegate to verify-factory.ps1)
# ----------------------------------------------------------------
$verifyScript = Join-Path $FactoryRoot "scripts\verify-factory.ps1"
if (Test-Path $verifyScript) {
    $verifyOutput = & $verifyScript -Json 2>&1 | ConvertFrom-Json
    foreach ($r in $verifyOutput.results) {
        Add-Section -Name "verify $($r.check)" -Status $r.status -Message $r.message -Details ($r.details | Select-Object -First 3)
        if ($FailFast -and $r.status -eq "fail") { break }
    }
} else {
    Add-Section -Name "verify-factory.ps1" -Status "fail" -Message "Missing: $verifyScript"
}

# ----------------------------------------------------------------
# Section 2: Profile resolver smoke test
# ----------------------------------------------------------------
$resolverScript = Join-Path $FactoryRoot "scripts\forge\profile-resolver.ps1"
if (Test-Path $resolverScript) {
    try {
        $profileJson = & $resolverScript -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String
        $parsed = $profileJson | ConvertFrom-Json
        if ($parsed.effective.profile) {
            Add-Section -Name "profile resolver" -Status "pass" -Message ("resolves to '{0}' (session budget {1:N0} tokens)" -f $parsed.effective.profile, $parsed.effective.session_budget_tokens)
        } else {
            Add-Section -Name "profile resolver" -Status "fail" -Message "JSON output missing 'effective.profile'"
        }
    } catch {
        Add-Section -Name "profile resolver" -Status "fail" -Message "Error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "profile resolver" -Status "fail" -Message "Missing: $resolverScript"
}

# ----------------------------------------------------------------
# Section 3: Plan translations JSON validity
# ----------------------------------------------------------------
$translationsPath = Join-Path $FactoryRoot ".forge\plan-translations.json"
if (Test-Path $translationsPath) {
    try {
        $t = Get-Content $translationsPath -Raw | ConvertFrom-Json
        $planCount = ($t.plans.PSObject.Properties | Measure-Object).Count
        Add-Section -Name "plan-translations" -Status "pass" -Message "$planCount AI plans documented"
    } catch {
        Add-Section -Name "plan-translations" -Status "fail" -Message "Invalid JSON: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "plan-translations" -Status "warn" -Message "Missing (optional but recommended for forge profile show plain-English)"
}

# ----------------------------------------------------------------
# Section 4: Profile preset count
# ----------------------------------------------------------------
$presetsDir = Join-Path $FactoryRoot ".forge\profiles"
if (Test-Path $presetsDir) {
    $presetCount = (Get-ChildItem $presetsDir -Filter "*.json").Count
    if ($presetCount -ge 5) {
        Add-Section -Name "profile presets" -Status "pass" -Message "$presetCount presets available"
    } else {
        Add-Section -Name "profile presets" -Status "warn" -Message "Only $presetCount presets (expected 5: indie-free, solo-pro, senior-dev, agency, enterprise)"
    }
} else {
    Add-Section -Name "profile presets" -Status "fail" -Message ".forge/profiles/ directory missing"
}

# ----------------------------------------------------------------
# Section 4.5: enforcement coverage (enforcement-first.md meta-rule)
# ----------------------------------------------------------------
$enfScript = Join-Path $FactoryRoot "scripts\verifiers\verify-enforcement.ps1"
if (Test-Path $enfScript) {
    try {
        $enfRaw = & $enfScript -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String
        $enf = $enfRaw | ConvertFrom-Json
        Add-Section -Name "enforcement coverage" -Status $enf.status -Message $enf.message -Details ($enf.details | Select-Object -First 3)
    } catch {
        Add-Section -Name "enforcement coverage" -Status "fail" -Message "verifier error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "enforcement coverage" -Status "warn" -Message "Missing: $enfScript (enforcement-first.md not active yet)"
}

# ----------------------------------------------------------------
# Section 4.6: traceability + composable-outputs (composable-outputs.md)
# ----------------------------------------------------------------
$tracScript = Join-Path $FactoryRoot "scripts\verifiers\verify-traceability.ps1"
if (Test-Path $tracScript) {
    try {
        $tracRaw = & $tracScript -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String
        $trac = $tracRaw | ConvertFrom-Json
        Add-Section -Name "traceability + composable-outputs" -Status $trac.status -Message $trac.message -Details ($trac.details | Select-Object -First 3)
    } catch {
        Add-Section -Name "traceability + composable-outputs" -Status "fail" -Message "verifier error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "traceability + composable-outputs" -Status "warn" -Message "Missing: $tracScript (composable-outputs.md not active yet)"
}

# ----------------------------------------------------------------
# Section 4.7: foundational requirements (architect-first.md SS0.5 inception gate)
# Node verifier (.mjs) on purpose -- it dogfoods the cross-platform lesson it enforces.
# ----------------------------------------------------------------
$foundScript = Join-Path $FactoryRoot "scripts\verifiers\verify-foundational-requirements.mjs"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Add-Section -Name "foundational requirements" -Status "skip" -Message "node not found -- cannot run verify-foundational-requirements.mjs (CI/dev gate)"
} elseif (Test-Path $foundScript) {
    try {
        $foundRaw = & node $foundScript --root $FactoryRoot --json 2>&1 | Out-String
        $found = $foundRaw | ConvertFrom-Json
        Add-Section -Name "foundational requirements" -Status $found.status -Message $found.message -Details ($found.details | Select-Object -First 3)
    } catch {
        Add-Section -Name "foundational requirements" -Status "fail" -Message "verifier error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "foundational requirements" -Status "warn" -Message "Missing: $foundScript (architect-first.md SS0.5 not active yet)"
}

# ----------------------------------------------------------------
# Section 5: forge CLI dispatch smoke
# ----------------------------------------------------------------
$forgeScript = Join-Path $FactoryRoot "scripts\forge.ps1"
if (Test-Path $forgeScript) {
    try {
        # Capture stdout fully into variable; suppress streaming to host
        $smokeOutput = (powershell -NoProfile -File $forgeScript profile show --terse 2>&1) -join "`n"
        if ($smokeOutput -match "forge:\s+\w+") {
            Add-Section -Name "forge CLI dispatch" -Status "pass" -Message "smoke test passes (forge profile show --terse)"
        } else {
            Add-Section -Name "forge CLI dispatch" -Status "warn" -Message "Unexpected smoke test output: $($smokeOutput.Substring(0, [Math]::Min(60, $smokeOutput.Length)))"
        }
    } catch {
        Add-Section -Name "forge CLI dispatch" -Status "fail" -Message "Error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "forge CLI dispatch" -Status "fail" -Message "Missing: $forgeScript"
}

# ----------------------------------------------------------------
# Section 6: Mirror regeneration dry-run
# ----------------------------------------------------------------
$syncScript = Join-Path $FactoryRoot "scripts\sync-rules-to-platforms.ps1"
if (Test-Path $syncScript) {
    try {
        # sync-rules-to-platforms.ps1 uses Write-Host (doesn't flow through 2>&1 capture),
        # so check exit code: 0 = clean dry-run, 2 = verification failure.
        & $syncScript -DryRun 2>&1 | Out-Null
        $syncExit = $LASTEXITCODE
        if ($syncExit -eq 0) {
            Add-Section -Name "mirror sync dry-run" -Status "pass" -Message "ready to regenerate mirrors"
        } elseif ($syncExit -eq 2) {
            Add-Section -Name "mirror sync dry-run" -Status "fail" -Message "Verification failures (re-run sync-rules-to-platforms.ps1 -DryRun for detail)"
        } else {
            Add-Section -Name "mirror sync dry-run" -Status "warn" -Message "Unexpected exit code: $syncExit"
        }
    } catch {
        Add-Section -Name "mirror sync dry-run" -Status "fail" -Message "Error: $($_.Exception.Message)"
    }
} else {
    Add-Section -Name "mirror sync dry-run" -Status "warn" -Message "Missing sync-rules-to-platforms.ps1"
}

# ----------------------------------------------------------------
# Section 7: scheduler routines (routines.json -> OS tasks; last-run freshness)
# Mirrors doctor.mjs. WARNs (never fails) on: a schedulable routine with no matching task; a task
# whose last run is older than 2x its cadence; and every enabled AGENT routine that has no local
# runner (belongs on cloud Routines -- docs/architecture/agent-routines-cloud-routines.md).
# ----------------------------------------------------------------
$routinesFile = Join-Path $FactoryRoot ".forge\routines.json"
if (-not (Test-Path $routinesFile)) {
    Add-Section -Name "scheduler routines" -Status "skip" -Message ".forge/routines.json missing -- cannot check schedulers"
} else {
    function Get-CronCadenceHours {
        param([string]$Cron)
        $f = $Cron.Trim() -split "\s+"; if ($f.Count -ne 5 -or $f[3] -ne "*") { return $null }
        if ($f[2] -eq "*" -and $f[4] -eq "*") { return 24 }
        if ($f[2] -eq "*" -and $f[4] -match "^[0-7]$") { return 168 }
        if ($f[4] -eq "*" -and $f[2] -match "^\d{1,2}$") { return 720 }
        return $null
    }
    $schedDetails = @(); $schedWorst = "pass"
    $routines = (Get-Content -Raw -Path $routinesFile | ConvertFrom-Json).routines
    foreach ($r in $routines) {
        if ($r.PSObject.Properties.Name -contains "enabled" -and $r.enabled -eq $false) { continue }
        if ($r.schedule -eq "stop-hook") { $schedDetails += "$($r.name): event routine (stop-hook) -- not OS-scheduled by design"; continue }
        $script = Join-Path (Join-Path $FactoryRoot "scripts") "$($r.name).mjs"
        if (-not (Test-Path $script)) {
            $schedDetails += "$($r.name): enabled agent routine, no local runner -- belongs on cloud Routines (probe: docs/architecture/agent-routines-cloud-routines.md)"
            $schedWorst = "warn"; continue
        }
        $taskName = "VibePromptRig-$($r.name)"
        # schtasks writes to stderr + exits non-zero when the task is absent; guard so it never throws.
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
        $q = schtasks /query /tn $taskName /v /fo LIST 2>&1
        $rc = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($rc -ne 0) { $schedDetails += "$($r.name): no OS task '$taskName' -- run node scripts/setup-scheduler.mjs"; $schedWorst = "warn"; continue }
        $lastLine = $q | Where-Object { $_ -match "Last Run Time:" } | Select-Object -First 1
        $cad = Get-CronCadenceHours $r.schedule
        if ($lastLine -and $lastLine -match "Last Run Time:\s*(.+)$") {
            $raw = $Matches[1].Trim()
            if ($raw -match "N/A|11/30/1999") { $schedDetails += "$($r.name): registered, awaiting first run" }
            else {
                # PowerShell 7 cannot resolve DateTime.TryParse(string, ref null)
                # because the by-reference type is ambiguous. Seed a typed value so
                # both Windows PowerShell 5.1 and PowerShell 7 select the same overload.
                [DateTime]$parsed = [DateTime]::MinValue
                if ([DateTime]::TryParse($raw, [ref]$parsed) -and $cad) {
                    $ageH = ((Get-Date) - $parsed).TotalHours
                    if ($ageH -gt (2 * $cad)) { $schedDetails += "$($r.name): last run $($parsed.ToString('yyyy-MM-dd HH:mm')) -- older than 2x cadence ($cad h)"; $schedWorst = "warn" }
                } else { $schedDetails += "$($r.name): registered; last-run unparseable ($raw)" }
            }
        } else { $schedDetails += "$($r.name): registered; no last-run reported yet" }
    }
    Add-Section -Name "scheduler routines" -Status $schedWorst -Message "routines.json vs registered OS tasks" -Details ($schedDetails | Select-Object -First 10)
}

# ----------------------------------------------------------------
# Output
# ----------------------------------------------------------------
if ($Json) {
    @{
        factory_root = $FactoryRoot
        timestamp    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        passes       = @($results | Where-Object { $_.status -eq "pass" }).Count
        warnings     = @($results | Where-Object { $_.status -eq "warn" }).Count
        failures     = $failureCount
        skips        = @($results | Where-Object { $_.status -eq "skip" }).Count
        results      = $results
    } | ConvertTo-Json -Depth 6
} else {
    Write-Host ""
    $passes = @($results | Where-Object { $_.status -eq "pass" }).Count
    $warns  = @($results | Where-Object { $_.status -eq "warn" }).Count
    $skips  = @($results | Where-Object { $_.status -eq "skip" }).Count
    $color = if ($failureCount -gt 0) { "Red" } else { "Green" }
    Write-Host ("  Doctor verdict: {0} pass / {1} warn / {2} skip / {3} fail" -f $passes, $warns, $skips, $failureCount) -ForegroundColor $color
    Write-Host ""
    if ($failureCount -gt 0) {
        Write-Host "  Run 'forge doctor --json' for machine-readable output, or review individual failures above." -ForegroundColor DarkGray
        Write-Host ""
    }
}

exit $failureCount
