<#
.SYNOPSIS
    Cross-tool mirror content validator. For a compact (Context V2) factory it delegates to the
    Node twin; for a legacy v1 factory it asserts that every source rule in
    .claude/rules/ is represented in every mirror file used by AGENTS.md-
    compatible AI tools (Cursor, Gemini CLI, Codex, Windsurf, Copilot CLI).
    Complements verify-factory.ps1's mirror-freshness timestamp check by
    validating CONTENT integrity, not just mtimes.

.PARAMETER FactoryRoot
    Repository root containing .claude/rules and the mirrors (default: cwd or the worktree of this script).

.PARAMETER Strict
    Treat any warning as a failure (exit 1).

.PARAMETER Json
    Emit machine-readable JSON instead of human text.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Read-only.
    Exits 0 if all mirrors are consistent; 1 if any drift detected (or in strict mode).
#>

[CmdletBinding()]
param(
    [string]$FactoryRoot,
    [switch]$Strict,
    [switch]$Json
)

$ErrorActionPreference = "SilentlyContinue"

if (-not $FactoryRoot) {
    # Use the worktree this script lives in
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    $FactoryRoot = Split-Path -Parent $here   # parent of scripts/
}

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result {
    param([string]$Check, [string]$Status, [string]$Detail)
    $results.Add([PSCustomObject]@{ check=$Check; status=$Status; detail=$Detail })
}

# ---- Compact contract (Context V2): one strict Node implementation owns freshness ----
# A compact kernel or v2 manifest means there is no full-rule mirror set to compare. Delegate to
# the Node twin (which calls verify-factory mirror-freshness) and fail closed without Node.
$compactKernel = Join-Path $FactoryRoot ".forge\context\kernel.md"
$compactManifest = Join-Path $FactoryRoot ".claude\rules-manifest.json"
$isCompact = Test-Path -LiteralPath $compactKernel
if (-not $isCompact -and (Test-Path -LiteralPath $compactManifest)) {
    try { $isCompact = ((Get-Content -LiteralPath $compactManifest -Raw | ConvertFrom-Json).schema_version -eq 2) }
    catch { $isCompact = $true }
}
if ($isCompact) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $nodeTwin = Join-Path $PSScriptRoot "verify-cross-tool-mirrors.mjs"
    if (-not $node -or -not (Test-Path -LiteralPath $nodeTwin)) {
        Write-Host "[FAIL] compact mirror-freshness requires Node.js and $nodeTwin"
        exit 1
    }
    $twinArgs = @($nodeTwin, "--root", $FactoryRoot)
    if ($Json) { $twinArgs += "--json" }
    if ($Strict) { $twinArgs += "--strict" }
    & node @twinArgs
    exit $LASTEXITCODE
}

# ---- Source inventory (legacy v1 contract only) ----
$rulesDir = Join-Path $FactoryRoot ".claude\rules"
if (-not (Test-Path $rulesDir)) {
    Add-Result -Check "source-rules" -Status "FAIL" -Detail "no .claude/rules directory at $rulesDir"
    if ($Json) { @{ results=$results; pass=0; fail=1 } | ConvertTo-Json -Depth 5; exit 1 }
    Write-Host "[FAIL] No .claude/rules at $rulesDir"
    exit 1
}

$sourceRules = Get-ChildItem -Path $rulesDir -Filter "*.md" -ErrorAction SilentlyContinue |
               ForEach-Object { $_.BaseName }
if ($sourceRules.Count -eq 0) {
    Add-Result -Check "source-rules" -Status "FAIL" -Detail "no .md files in $rulesDir"
} else {
    Add-Result -Check "source-rules" -Status "OK" -Detail "found $($sourceRules.Count) rule files"
}

# ---- AGENTS.md check ----
$agentsPath = Join-Path $FactoryRoot "AGENTS.md"
if (Test-Path $agentsPath) {
    $agentsContent = Get-Content $agentsPath -Raw -Encoding UTF8
    $missingInAgents = @()
    foreach ($r in $sourceRules) {
        if ($agentsContent -notmatch [regex]::Escape($r)) { $missingInAgents += $r }
    }
    if ($missingInAgents.Count -gt 0) {
        Add-Result -Check "AGENTS.md content" -Status "FAIL" -Detail ("missing: " + ($missingInAgents -join ", "))
    } else {
        Add-Result -Check "AGENTS.md content" -Status "OK" -Detail "all $($sourceRules.Count) rules referenced"
    }
} else {
    Add-Result -Check "AGENTS.md" -Status "FAIL" -Detail "file missing at $agentsPath"
}

# ---- GEMINI.md check ----
$geminiPath = Join-Path $FactoryRoot "GEMINI.md"
if (Test-Path $geminiPath) {
    $geminiContent = Get-Content $geminiPath -Raw -Encoding UTF8
    $missingInGemini = @()
    foreach ($r in $sourceRules) {
        if ($geminiContent -notmatch [regex]::Escape($r)) { $missingInGemini += $r }
    }
    if ($missingInGemini.Count -gt 0) {
        Add-Result -Check "GEMINI.md content" -Status "FAIL" -Detail ("missing: " + ($missingInGemini -join ", "))
    } else {
        Add-Result -Check "GEMINI.md content" -Status "OK" -Detail "all $($sourceRules.Count) rules referenced"
    }
} else {
    Add-Result -Check "GEMINI.md" -Status "WARN" -Detail "file missing at $geminiPath (Gemini CLI users won't see rules)"
}

# ---- .cursor/rules/ check ----
$cursorDir = Join-Path $FactoryRoot ".cursor\rules"
if (Test-Path $cursorDir) {
    $cursorMdcs = Get-ChildItem -Path $cursorDir -Filter "*.mdc" -ErrorAction SilentlyContinue |
                  ForEach-Object { $_.BaseName }
    $missingInCursor = @($sourceRules | Where-Object { $_ -notin $cursorMdcs })
    $extraInCursor   = @($cursorMdcs   | Where-Object { $_ -notin $sourceRules })

    if ($missingInCursor.Count -gt 0) {
        Add-Result -Check ".cursor/rules coverage" -Status "FAIL" -Detail ("missing mdc: " + ($missingInCursor -join ", "))
    } else {
        Add-Result -Check ".cursor/rules coverage" -Status "OK" -Detail "all rules have .mdc mirrors"
    }
    if ($extraInCursor.Count -gt 0) {
        Add-Result -Check ".cursor/rules stale" -Status "WARN" -Detail ("orphan mdcs: " + ($extraInCursor -join ", "))
    }

    # Check each .mdc has alwaysApply: true frontmatter
    $missingFrontmatter = [System.Collections.Generic.List[string]]::new()
    foreach ($mdc in (Get-ChildItem -Path $cursorDir -Filter "*.mdc")) {
        $head = Get-Content $mdc.FullName -Encoding UTF8 -TotalCount 10 -ErrorAction SilentlyContinue
        if (-not ($head -join "`n" -match "(?m)^alwaysApply:\s*true")) {
            $missingFrontmatter.Add($mdc.BaseName)
        }
    }
    if ($missingFrontmatter.Count -gt 0) {
        Add-Result -Check ".cursor/rules frontmatter" -Status "WARN" -Detail ("missing alwaysApply: " + ($missingFrontmatter -join ", "))
    } else {
        Add-Result -Check ".cursor/rules frontmatter" -Status "OK" -Detail "all .mdc files have alwaysApply: true"
    }
} else {
    Add-Result -Check ".cursor/rules" -Status "WARN" -Detail "directory missing at $cursorDir (Cursor users won't see rules)"
}

# ---- .windsurfrules check (top-20 rules expected, not all) ----
$windsurfPath = Join-Path $FactoryRoot ".windsurfrules"
if (Test-Path $windsurfPath) {
    $wsContent = Get-Content $windsurfPath -Raw -Encoding UTF8
    # Windsurf expects the essential subset; verify at least vibe-standard + privacy are present
    $essentialChecks = @('vibe-standard', 'privacy', 'secrets-handling')
    $missingEssential = @()
    foreach ($e in $essentialChecks) {
        if ($wsContent -notmatch [regex]::Escape($e)) { $missingEssential += $e }
    }
    if ($missingEssential.Count -gt 0) {
        Add-Result -Check ".windsurfrules essentials" -Status "FAIL" -Detail ("missing: " + ($missingEssential -join ", "))
    } else {
        $size = (Get-Item $windsurfPath).Length
        Add-Result -Check ".windsurfrules essentials" -Status "OK" -Detail "size=$size bytes; essentials present"
    }
} else {
    Add-Result -Check ".windsurfrules" -Status "WARN" -Detail "file missing (Windsurf users won't see rules)"
}

# ---- PERPLEXITY_SPACE_INSTRUCTIONS.md sanity ----
$perpPath = Join-Path $FactoryRoot "PERPLEXITY_SPACE_INSTRUCTIONS.md"
if (Test-Path $perpPath) {
    $perpContent = Get-Content $perpPath -Raw -Encoding UTF8
    if ($perpContent.Length -lt 1000) {
        Add-Result -Check "PERPLEXITY mirror" -Status "WARN" -Detail "file is <1KB; might be empty/stub"
    } else {
        Add-Result -Check "PERPLEXITY mirror" -Status "OK" -Detail "size=$($perpContent.Length) chars"
    }
} else {
    Add-Result -Check "PERPLEXITY mirror" -Status "WARN" -Detail "file missing"
}

# ---- Output ----
$failCount = ($results | Where-Object { $_.status -eq 'FAIL' }).Count
$warnCount = ($results | Where-Object { $_.status -eq 'WARN' }).Count
$okCount   = ($results | Where-Object { $_.status -eq 'OK' }).Count

if ($Json) {
    @{
        ts            = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        factory_root  = $FactoryRoot
        source_rules  = $sourceRules.Count
        results       = $results
        pass          = $okCount
        warn          = $warnCount
        fail          = $failCount
    } | ConvertTo-Json -Depth 5
    if ($failCount -gt 0 -or ($Strict -and $warnCount -gt 0)) { exit 1 } else { exit 0 }
}

Write-Host ""
Write-Host "==== Cross-tool mirror validator ===="
Write-Host ("  factory root: {0}" -f $FactoryRoot)
Write-Host ("  source rules: {0}" -f $sourceRules.Count)
Write-Host ""
foreach ($r in $results) {
    $tag = switch ($r.status) {
        "OK"   { "[OK ]" }
        "WARN" { "[WRN]" }
        "FAIL" { "[FAIL]" }
        default { "[??]" }
    }
    Write-Host ("  {0} {1,-32}  {2}" -f $tag, $r.check, $r.detail)
}
Write-Host ""
Write-Host ("  Pass: {0}  Warn: {1}  Fail: {2}" -f $okCount, $warnCount, $failCount)

if ($failCount -gt 0) { exit 1 }
if ($Strict -and $warnCount -gt 0) { exit 1 }
exit 0
