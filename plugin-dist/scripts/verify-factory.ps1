<#
.SYNOPSIS
    Factory health verification with multiple --check flags.

.DESCRIPTION
    Single script for all truth-drift prevention checks. Closes the class-of-bug
    where documentation (VERSION.md, CLAUDE.md §15, NEXT_SESSION.md) claims something
    exists that doesn't actually exist as a file.

    Six checks (all run by default with --check all):

      rules-list         CLAUDE.md §15 entries <-> .claude/rules/*.md files
                         Catches §15 drift (e.g., file removed but §15 still lists it,
                         or §15 lists file that doesn't exist).

      agents-list        VERSION.md agent claims <-> .claude/agents/*.md files
                         Catches the 11-missing-agents bug discovered 2026-05-15.

      skills-list        VERSION.md skill claims <-> .claude/skills/<dir>/SKILL.md
                         Catches the 13-missing-skills bug discovered 2026-05-15.

      scripts-list       Scripts referenced in docs <-> scripts/*.ps1 files exist
                         Catches "sync-rules-to-platforms.ps1 referenced everywhere
                         but never committed" bug from 2026-05-14.

      mirror-freshness   AGENTS.md / GEMINI.md / .windsurfrules / .cursor/rules
                         mtimes vs source rule mtimes
                         Catches stale mirrors after source-rule changes.

      version-citations  Every "Updated X" or "Added X" in VERSION.md has
                         (commit abc123) reference
                         Catches "claimed fixed but never actually committed"
                         class-of-bug (v4.2.3 onboard-refresh false claim).

.PARAMETER Check
    Which check to run. Default 'all' runs all six. Other values: rules-list,
    agents-list, skills-list, scripts-list, mirror-freshness, version-citations.

.PARAMETER FactoryRoot
    Factory root directory. Defaults to $env:VIBE_ROOT, else derived from the script location.

.PARAMETER Json
    Output machine-readable JSON instead of human-readable. For CI integration.

.PARAMETER Quiet
    Suppress per-pass output. Only show failures + final summary.

.PARAMETER FailFast
    Exit on first failure instead of running all checks.

.EXAMPLE
    .\scripts\verify-factory.ps1
    Run all checks with human-readable output. Exit non-zero on any failure.

.EXAMPLE
    .\scripts\verify-factory.ps1 -Check rules-list
    Run just the rules-list check.

.EXAMPLE
    .\scripts\verify-factory.ps1 -Json
    Machine-readable for CI.
#>
param(
    [ValidateSet("all", "rules-list", "agents-list", "skills-list", "scripts-list", "mirror-freshness", "version-citations", "rule-reference-integrity")]
    [string]$Check = "all",
    [string]$FactoryRoot = $(if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }),
    [switch]$Json,
    [switch]$Quiet,
    [switch]$FailFast
)

$ErrorActionPreference = "Stop"

# Results accumulator
$results = @()
$failureCount = 0

# ----------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------
function Add-Result {
    param(
        [string]$CheckName,
        [string]$Status,        # pass | fail | warn | skip
        [string]$Message,
        [string[]]$Details = @()
    )
    $script:results += [PSCustomObject]@{
        check   = $CheckName
        status  = $Status
        message = $Message
        details = $Details
    }
    if ($Status -eq "fail") { $script:failureCount++ }

    if (-not $Json -and -not $Quiet) {
        $color = switch ($Status) {
            "pass" { "Green" }
            "fail" { "Red" }
            "warn" { "Yellow" }
            "skip" { "DarkGray" }
            default { "White" }
        }
        $glyph = switch ($Status) {
            "pass" { "[OK]" }
            "fail" { "[FAIL]" }
            "warn" { "[WARN]" }
            "skip" { "[SKIP]" }
            default { "[??]" }
        }
        Write-Host ("  {0,-6} {1,-22} {2}" -f $glyph, $CheckName, $Message) -ForegroundColor $color
        foreach ($d in $Details) {
            Write-Host ("           {0}" -f $d) -ForegroundColor DarkGray
        }
    }
}

function Get-NamesFromDocList {
    <#
    Parse a markdown list like:
      - `vibe-standard.md` -- description
      - `compliance.md` -- description
    Returns the file basename (e.g., "vibe-standard").
    #>
    param([string]$DocPath, [string]$SectionPattern = $null)
    if (-not (Test-Path $DocPath)) { return @() }
    $content = Get-Content $DocPath -Raw

    # If a section pattern given, isolate that section
    if ($SectionPattern) {
        $sectionMatch = [regex]::Match($content, $SectionPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
        if ($sectionMatch.Success) {
            # Find content from match through next section header (## ...) or end
            $startIdx = $sectionMatch.Index + $sectionMatch.Length
            $rest = $content.Substring($startIdx)
            $nextSection = [regex]::Match($rest, '(?m)^##\s')
            if ($nextSection.Success) {
                $content = $rest.Substring(0, $nextSection.Index)
            } else {
                $content = $rest
            }
        }
    }

    # Match patterns like `- \`vibe-standard.md\`` or `- vibe-standard.md`
    $matches = [regex]::Matches($content, '(?m)^\s*-\s+`?([a-z0-9-]+)\.md`?')
    return @($matches | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
}

function Get-FilesInDir {
    param([string]$Dir, [string]$Pattern = "*.md")
    if (-not (Test-Path $Dir)) { return @() }
    return @(Get-ChildItem -Path $Dir -Filter $Pattern -File | ForEach-Object { $_.BaseName })
}

function Get-DirsInDir {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return @() }
    return @(Get-ChildItem -Path $Dir -Directory | ForEach-Object { $_.Name })
}

# ----------------------------------------------------------------
# Check 1: rules-list  (CLAUDE.md §15 <-> .claude/rules/*.md)
# ----------------------------------------------------------------

# Use the canonical Node verifier for compact contracts; retain legacy checks below.
function Test-CompactContext {
    if (Test-Path (Join-Path $FactoryRoot '.forge/context/kernel.md')) { return $true }
    $manifest = Join-Path $FactoryRoot '.claude/rules-manifest.json'
    if (-not (Test-Path $manifest)) { return $false }
    try { return ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).schema_version -eq 2) }
    catch { return $true }
}
function Check-CompactContext([string]$Name) {
    try {
        $output = & node (Join-Path $PSScriptRoot 'verify-factory.mjs') --factory-root $FactoryRoot --check $Name --json
        $data = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        $items = @($data.results | Where-Object { $_.check -eq $Name })
        if ($items.Count -ne 1 -or $items[0].status -notin @('pass', 'fail')) { throw 'Node compact verifier returned no valid result' }
        $item = $items[0]
        Add-Result -CheckName $Name -Status $item.status -Message $item.message -Details @($item.details)
    } catch { Add-Result -CheckName $Name -Status 'fail' -Message 'Compact context validation failed' -Details @($_.Exception.Message) }
}

function Check-RulesList {
    if (Test-CompactContext) { Check-CompactContext 'rules-list'; return }
    $claudeMd = Join-Path $FactoryRoot ".claude\CLAUDE.md"
    $rulesDir = Join-Path $FactoryRoot ".claude\rules"

    if (-not (Test-Path $claudeMd)) {
        Add-Result -CheckName "rules-list" -Status "fail" -Message "CLAUDE.md not found at $claudeMd"
        return
    }
    if (-not (Test-Path $rulesDir)) {
        Add-Result -CheckName "rules-list" -Status "fail" -Message ".claude/rules/ directory not found"
        return
    }

    $declared = Get-NamesFromDocList -DocPath $claudeMd -SectionPattern '##\s+§15\s+'
    $actual = Get-FilesInDir -Dir $rulesDir -Pattern "*.md"

    $missingFiles = @($declared | Where-Object { $actual -notcontains $_ })
    $missingFromDoc = @($actual | Where-Object { $declared -notcontains $_ })

    if ($missingFiles.Count -eq 0 -and $missingFromDoc.Count -eq 0) {
        Add-Result -CheckName "rules-list" -Status "pass" -Message ("CLAUDE.md §15 ({0} entries) matches .claude/rules/ ({1} files)" -f $declared.Count, $actual.Count)
        return
    }
    $details = @()
    if ($missingFiles.Count -gt 0) {
        $details += "Listed in §15 but file missing: $($missingFiles -join ', ')"
    }
    if ($missingFromDoc.Count -gt 0) {
        $details += "File exists but not in §15: $($missingFromDoc -join ', ')"
    }
    Add-Result -CheckName "rules-list" -Status "fail" -Message "§15 drift: $($declared.Count) listed vs $($actual.Count) files" -Details $details
}

# ----------------------------------------------------------------
# Check 2: agents-list  (VERSION.md / CURRENT_SPRINT.md claims <-> .claude/agents/*.md)
# ----------------------------------------------------------------
function Check-AgentsList {
    $agentsDir = Join-Path $FactoryRoot ".claude\agents"
    $actual = @(Get-FilesInDir -Dir $agentsDir -Pattern "*.md")

    # Canonical source of truth: .claude/INSTALLED-AGENTS.md (name-aware list).
    # Replaces the old VERSION.md/CURRENT_SPRINT.md count-scraping, which read
    # append-only changelog prose and failed permanently on stale claims.
    $canonicalPath = Join-Path $FactoryRoot ".claude\INSTALLED-AGENTS.md"
    if (-not (Test-Path $canonicalPath)) {
        Add-Result -CheckName "agents-list" -Status "warn" -Message "No .claude/INSTALLED-AGENTS.md canonical registry; actual: $($actual.Count) agents in .claude/agents/"
        return
    }
    $canonical = @(Get-Content $canonicalPath | ForEach-Object {
        if ($_ -match '^\s*-\s+`([a-z0-9-]+)`') { $matches[1] }
    } | Sort-Object)

    $missing = @($canonical | Where-Object { $actual -notcontains $_ })  # listed, no file
    $extra   = @($actual | Where-Object { $canonical -notcontains $_ })  # file, not listed

    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
        Add-Result -CheckName "agents-list" -Status "pass" -Message "INSTALLED-AGENTS.md ($($canonical.Count)) matches .claude/agents/ ($($actual.Count))"
    } else {
        $details = @()
        if ($missing.Count) { $details += "Listed in INSTALLED-AGENTS.md but file missing: $($missing -join ', ')" }
        if ($extra.Count)   { $details += "File exists but not in INSTALLED-AGENTS.md: $($extra -join ', ')" }
        Add-Result -CheckName "agents-list" -Status "fail" -Message "agents drift: canonical=$($canonical.Count) vs files=$($actual.Count)" -Details $details
    }
}

# ----------------------------------------------------------------
# Check 3: skills-list  (VERSION.md / CURRENT_SPRINT.md claims <-> .claude/skills/<dir>/SKILL.md)
# ----------------------------------------------------------------
function Check-SkillsList {
    $skillsDir = Join-Path $FactoryRoot ".claude\skills"
    if (-not (Test-Path $skillsDir)) {
        Add-Result -CheckName "skills-list" -Status "warn" -Message ".claude/skills/ does not exist"
        return
    }
    # Subdirs that contain a SKILL.md
    $actualSkills = @(Get-ChildItem -Path $skillsDir -Directory | Where-Object {
        Test-Path (Join-Path $_.FullName "SKILL.md")
    } | ForEach-Object { $_.Name } | Sort-Object)

    # Canonical source of truth: .claude/INSTALLED-SKILLS.md (name-aware list).
    # Replaces the old CURRENT_SPRINT.md count-scraping (append-only prose).
    $canonicalPath = Join-Path $FactoryRoot ".claude\INSTALLED-SKILLS.md"
    if (-not (Test-Path $canonicalPath)) {
        Add-Result -CheckName "skills-list" -Status "warn" -Message "No .claude/INSTALLED-SKILLS.md canonical registry; actual: $($actualSkills.Count) factory skills"
        return
    }
    $canonical = @(Get-Content $canonicalPath | ForEach-Object {
        if ($_ -match '^\s*-\s+`([a-z0-9-]+)`') { $matches[1] }
    } | Sort-Object)

    $missing = @($canonical | Where-Object { $actualSkills -notcontains $_ })  # listed, no dir
    $extra   = @($actualSkills | Where-Object { $canonical -notcontains $_ })  # dir, not listed

    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
        Add-Result -CheckName "skills-list" -Status "pass" -Message "INSTALLED-SKILLS.md ($($canonical.Count)) matches .claude/skills/ ($($actualSkills.Count))"
    } else {
        $details = @()
        if ($missing.Count) { $details += "Listed in INSTALLED-SKILLS.md but dir missing: $($missing -join ', ')" }
        if ($extra.Count)   { $details += "Dir exists but not in INSTALLED-SKILLS.md: $($extra -join ', ')" }
        Add-Result -CheckName "skills-list" -Status "fail" -Message "skills drift: canonical=$($canonical.Count) vs dirs=$($actualSkills.Count)" -Details $details
    }
}

# ----------------------------------------------------------------
# Check 4: scripts-list  (docs reference scripts/*.ps1 <-> scripts/*.ps1 exist)
# ----------------------------------------------------------------
function Check-ScriptsList {
    $scriptsDir = Join-Path $FactoryRoot "scripts"
    $actual = Get-FilesInDir -Dir $scriptsDir -Pattern "*.ps1"

    # Search docs for references to scripts/*.ps1
    $docFiles = @()
    foreach ($f in @("CLAUDE.md", "VERSION.md", "NEXT_SESSION.md", "POST_MERGE_ACTIONS.md", "CURRENT_SPRINT.md")) {
        $p = Join-Path $FactoryRoot $f
        if (-not (Test-Path $p)) { $p = Join-Path $FactoryRoot ".claude\CLAUDE.md" }
        if (Test-Path $p) { $docFiles += $p }
    }
    # Also include rule files (relocated out of native autoload by Context V2 Delivery 3)
    $docFiles += @(Get-ChildItem -Path (Join-Path $FactoryRoot "docs\rules-reference\factory") -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })

    $referencedScripts = @()
    foreach ($df in $docFiles) {
        if (-not (Test-Path $df)) { continue }
        $content = Get-Content $df -Raw
        $matches = [regex]::Matches($content, '(?:scripts[/\\])([a-z0-9-]+)\.ps1')
        foreach ($m in $matches) {
            $referencedScripts += $m.Groups[1].Value
        }
    }
    $referencedScripts = @($referencedScripts | Select-Object -Unique)

    $missing = @($referencedScripts | Where-Object { $actual -notcontains $_ })

    if ($missing.Count -eq 0) {
        Add-Result -CheckName "scripts-list" -Status "pass" -Message "$($referencedScripts.Count) script(s) referenced in docs, all present in scripts/"
    } else {
        $details = @("Missing: " + ($missing -join ", "))
        Add-Result -CheckName "scripts-list" -Status "fail" -Message "$($missing.Count) script(s) referenced in docs but file missing" -Details $details
    }
}

# ----------------------------------------------------------------
# Check 5: mirror-freshness  (AGENTS.md / GEMINI.md etc. mtimes vs source rules)
# ----------------------------------------------------------------
function Check-MirrorFreshness {
    if (Test-CompactContext) { Check-CompactContext 'mirror-freshness'; return }
    $rulesDir = Join-Path $FactoryRoot ".claude\rules"
    if (-not (Test-Path $rulesDir)) {
        Add-Result -CheckName "mirror-freshness" -Status "skip" -Message ".claude/rules/ does not exist"
        return
    }

    $newestRuleMtime = (Get-ChildItem -Path $rulesDir -Filter "*.md" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1).LastWriteTime
    if (-not $newestRuleMtime) {
        Add-Result -CheckName "mirror-freshness" -Status "skip" -Message "No rule files found"
        return
    }

    $mirrors = @{
        "AGENTS.md"                       = Join-Path $FactoryRoot "AGENTS.md"
        "GEMINI.md"                       = Join-Path $FactoryRoot "GEMINI.md"
        ".windsurfrules"                  = Join-Path $FactoryRoot ".windsurfrules"
        "PERPLEXITY_SPACE_INSTRUCTIONS.md" = Join-Path $FactoryRoot "PERPLEXITY_SPACE_INSTRUCTIONS.md"
    }

    $stale = @()
    foreach ($name in $mirrors.Keys) {
        $path = $mirrors[$name]
        if (-not (Test-Path $path)) { $stale += "$name (missing)"; continue }
        $mtime = (Get-Item $path).LastWriteTime
        if ($mtime -lt $newestRuleMtime) {
            $stale += "$name (mirror older than source rule by $([math]::Round(($newestRuleMtime - $mtime).TotalMinutes, 0)) min)"
        }
    }

    # Cursor: count .mdc files
    $cursorDir = Join-Path $FactoryRoot ".cursor\rules"
    if (Test-Path $cursorDir) {
        $cursorCount = (Get-ChildItem $cursorDir -Filter "*.mdc").Count
        $ruleCount = (Get-ChildItem $rulesDir -Filter "*.md").Count
        if ($cursorCount -ne $ruleCount) {
            $stale += ".cursor/rules ($cursorCount .mdc files vs $ruleCount source rules)"
        }
    }

    if ($stale.Count -eq 0) {
        Add-Result -CheckName "mirror-freshness" -Status "pass" -Message "All 5 mirror sets up-to-date with source rules"
    } else {
        Add-Result -CheckName "mirror-freshness" -Status "fail" -Message "$($stale.Count) stale mirror(s)" -Details $stale
    }
}

# ----------------------------------------------------------------
# Check 6: version-citations  (VERSION.md "Updated X" entries have commit hash)
# ----------------------------------------------------------------
function Check-VersionCitations {
    $versionMd = Join-Path $FactoryRoot "VERSION.md"
    if (-not (Test-Path $versionMd)) {
        Add-Result -CheckName "version-citations" -Status "skip" -Message "VERSION.md not found"
        return
    }
    $content = Get-Content $versionMd -Raw

    # Find lines that claim "Updated X" or "Added X" or "Fixed X" with action verb + filename
    # Pattern catches: "Updated onboard-existing-project.ps1 -- ..." OR "Added admin_audit_log migration -- ..."
    $actionLines = [regex]::Matches($content, '(?m)^\s*[-*]\s+\*?\*?(Updated|Added|Fixed|Changed)\s+`?[^`\n]+`?[^`\n]*$')

    $missingCitation = @()
    foreach ($m in $actionLines) {
        $line = $m.Value
        # Accept either a real commit hash OR a `(historical)` / `(pre-v4.3)` marker
        # for pre-policy entries that pre-date the citation requirement.
        $hasHash = $line -match '\(commit\s+[a-f0-9]{6,40}\)' -or $line -match '\[commit\s+[a-f0-9]{6,40}\]'
        $hasHistorical = $line -match '\((historical|pre-v[0-9.]+)\)'
        if (-not $hasHash -and -not $hasHistorical) {
            $missingCitation += $line.Trim()
        }
    }

    if ($missingCitation.Count -eq 0) {
        Add-Result -CheckName "version-citations" -Status "pass" -Message "All $($actionLines.Count) 'Updated/Added/Fixed/Changed' entries have commit hash citations"
    } else {
        Add-Result -CheckName "version-citations" -Status "warn" -Message "$($missingCitation.Count) entries lack commit hash citation" -Details @(($missingCitation | Select-Object -First 5))
    }
}

# ----------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------
function Check-RuleReferenceIntegrity {
    $verifierPath = Join-Path $FactoryRoot "scripts\verify-rule-reference-integrity.ps1"
    if (-not (Test-Path $verifierPath)) {
        Add-Result "rule-reference-integrity" "skip" "Verifier script not found at $verifierPath"
        return
    }
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $verifierPath -FactoryRoot $FactoryRoot 2>&1
    $brokenLines = @($output | Where-Object { $_ -match "^\s+\[missing" })
    if ($brokenLines.Count -eq 0) {
        Add-Result "rule-reference-integrity" "pass" "All cross-file rule references resolve"
    } else {
        Add-Result "rule-reference-integrity" "fail" "$($brokenLines.Count) broken cross-references" -Details $brokenLines
    }
}

$checks = @{
    "rules-list"               = ${function:Check-RulesList}
    "agents-list"              = ${function:Check-AgentsList}
    "skills-list"              = ${function:Check-SkillsList}
    "scripts-list"             = ${function:Check-ScriptsList}
    "mirror-freshness"         = ${function:Check-MirrorFreshness}
    "version-citations"        = ${function:Check-VersionCitations}
    "rule-reference-integrity" = ${function:Check-RuleReferenceIntegrity}
}

if (-not $Json -and -not $Quiet) {
    Write-Host ""
    Write-Host "VibePromptRig factory verification" -ForegroundColor Cyan
    Write-Host "  Factory: $FactoryRoot" -ForegroundColor DarkGray
    Write-Host ""
}

$checksToRun = if ($Check -eq "all") { $checks.Keys | Sort-Object } else { @($Check) }

foreach ($c in $checksToRun) {
    & $checks[$c]
    if ($FailFast -and $failureCount -gt 0) { break }
}

# Output
if ($Json) {
    @{
        factory_root = $FactoryRoot
        timestamp    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        check_arg    = $Check
        passes       = ($results | Where-Object { $_.status -eq "pass" }).Count
        warnings     = ($results | Where-Object { $_.status -eq "warn" }).Count
        failures     = $failureCount
        skips        = ($results | Where-Object { $_.status -eq "skip" }).Count
        results      = $results
    } | ConvertTo-Json -Depth 6
} else {
    if (-not $Quiet) {
        Write-Host ""
        $passes = @($results | Where-Object { $_.status -eq "pass" }).Count
        $warns  = @($results | Where-Object { $_.status -eq "warn" }).Count
        $skips  = @($results | Where-Object { $_.status -eq "skip" }).Count
        $color = if ($failureCount -gt 0) { "Red" } else { "Green" }
        Write-Host ("  Summary: {0} pass / {1} warn / {2} skip / {3} fail" -f $passes, $warns, $skips, $failureCount) -ForegroundColor $color
        if ($failureCount -gt 0) {
            Write-Host ""
            Write-Host "  Fix suggestions:" -ForegroundColor DarkCyan
            foreach ($r in $results | Where-Object { $_.status -eq "fail" }) {
                $hint = switch ($r.check) {
                    "rules-list"        { "Run: forge sync OR add missing rule files to .claude/rules/" }
                    "agents-list"       { "Either: build the missing agents OR update VERSION.md to claim only what exists" }
                    "skills-list"       { "Either: build the missing skills OR update VERSION.md/CURRENT_SPRINT.md to claim only what exists" }
                    "scripts-list"      { "Build the missing scripts OR remove references from docs" }
                    "mirror-freshness"  { "Run: .\scripts\sync-rules-to-platforms.ps1" }
                    "version-citations" { "Add (commit abc123) reference to each 'Updated X' / 'Added X' entry in VERSION.md" }
                    default             { "(no fix suggestion available)" }
                }
                Write-Host ("    {0,-20} {1}" -f $r.check, $hint) -ForegroundColor DarkGray
            }
        }
        Write-Host ""
    }
}

exit $failureCount
