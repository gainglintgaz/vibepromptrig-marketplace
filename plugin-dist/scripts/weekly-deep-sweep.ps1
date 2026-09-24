<#
.SYNOPSIS
    Weekly deep sweep. Cross-project pattern analysis.
    Runs headless via Windows Task Scheduler at 8am Sundays.
    Output: <factory-root>\WEEKLY_INSIGHTS.md
#>

$ErrorActionPreference = "SilentlyContinue"

$FactoryRoot = if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }
$ProjectsDir = "$FactoryRoot\projects"
$OutputPath = "$FactoryRoot\WEEKLY_INSIGHTS.md"
$WeekOf = Get-Date -Format "yyyy-MM-dd"

# Collect all errors across projects
$errorSources = @()
$totalErrors = 0

# Scan factory projects dir
Get-ChildItem -Path $ProjectsDir -Recurse -Filter "errors-fixed.json" | ForEach-Object {
    $projName = $_.Directory.Name
    $content = Get-Content $_.FullName -Raw
    if ($content -and $content.Trim() -ne "[]") {
        $errors = $content | ConvertFrom-Json
        if ($errors) {
            $totalErrors += $errors.Count
            $errorSources += "$projName ($($errors.Count) entries)"
        }
    }
}

# Scan active projects
$projectDir = Join-Path $env:USERPROFILE "Projects"
if (Test-Path $projectDir) {
    Get-ChildItem -Path $projectDir -Directory | ForEach-Object {
        $efPath = "$($_.FullName)\errors-fixed.json"
        if (Test-Path $efPath) {
            $content = Get-Content $efPath -Raw
            if ($content -and $content.Trim() -ne "[]") {
                $errors = $content | ConvertFrom-Json
                if ($errors) {
                    $totalErrors += $errors.Count
                    $errorSources += "$($_.Name) ($($errors.Count) entries)"
                }
            }
        }
    }
}

# Collect golden paths
$allPaths = @()
$pathSources = @($ProjectsDir)
if (Test-Path $projectDir) { $pathSources += $projectDir }

foreach ($searchDir in $pathSources) {
    Get-ChildItem -Path $searchDir -Recurse -Filter "golden-paths.md" | ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        if ($content -and $content.Length -gt 100) {
            $parentName = $_.Directory.Name
            $allPaths += "- **$parentName**: has documented patterns"
        }
    }
}

# Check lessons growth: lessons.md was split into lessons-critical.md + reference/lessons-archive.md
# (both in the relocated corpus). Count UNIQUE lesson numbers, same as weekly-deep-sweep.mjs.
$lessonNumbers = @{}
foreach ($lessonsPath in @("$FactoryRoot\docs\rules-reference\factory\lessons-critical.md", "$FactoryRoot\docs\rules-reference\factory\reference\lessons-archive.md")) {
    if (Test-Path $lessonsPath) {
        foreach ($m in (Select-String -Path $lessonsPath -Pattern '^(\d+)\.')) { $lessonNumbers[$m.Matches[0].Groups[1].Value] = $true }
    }
}
$lessonCount = $lessonNumbers.Count

# Scan for projects needing attention
$needsAttention = @()
Get-ChildItem -Path $ProjectsDir -Directory | ForEach-Object {
    $projName = $_.Name
    $briefPath = "$($_.FullName)\BRIEF.md"
    if (-not (Test-Path $briefPath)) {
        $needsAttention += "| $projName | No BRIEF.md | Create project brief or remove from projects/ |"
        return
    }
    $briefContent = Get-Content $briefPath -Raw
    if ($briefContent -match "DISCUSSED" -and $briefContent -match "\[.+\]") {
        $needsAttention += "| $projName | Still in DISCUSSED state | Decide: build, park with reason, or remove |"
    }
}

# Rule freshness check across known project paths (factory version stamp comparison)
$currentFactoryVersion = "v4.0"
if (Test-Path "$FactoryRoot\VERSION.md") {
    $vFile = Get-Content "$FactoryRoot\VERSION.md" -Raw
    if ($vFile -match "##\s+v(\d+\.\d+(?:\.\d+)?)") { $currentFactoryVersion = "v$($Matches[1])" }
}

# Discover local projects and optional configured external roots.
$projectRoots = [System.Collections.Generic.List[string]]::new()
foreach ($parent in @((Join-Path $FactoryRoot 'projects'), (Join-Path $env:USERPROFILE 'Projects'))) {
    if (Test-Path -LiteralPath $parent) {
        Get-ChildItem -LiteralPath $parent -Directory | ForEach-Object { $projectRoots.Add($_.FullName) }
    }
}
$configPath = Join-Path $FactoryRoot '.forge\agent-configs\synthesizer.json'
if (Test-Path -LiteralPath $configPath) {
    $configured = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($path in @($configured.config.projects)) {
        if ($path -is [string] -and [IO.Path]::IsPathRooted($path)) { $projectRoots.Add($path) }
    }
}
$knownProjects = @($projectRoots | Select-Object -Unique | Where-Object { $_ -ne $FactoryRoot } | ForEach-Object {
    @{ name = (Split-Path $_ -Leaf); path = $_ }
})

$staleRules = @()
foreach ($p in $knownProjects) {
    if (-not (Test-Path $p.path)) {
        $staleRules += "| $($p.name) | MISSING | Path does not exist: $($p.path) |"
        continue
    }
    # Context V2: onboarding installs the compact kernel, never a .claude/rules copy (Delivery 3b).
    if (-not (Test-Path "$($p.path)\.forge\context\kernel.md")) {
        $staleRules += "| $($p.name) | NOT ONBOARDED (no compact context) | Run: .\scripts\onboard-existing-project.ps1 -Path `"$($p.path)`" |"
        continue
    }
    $rulesDir = "$($p.path)\.claude\rules"
    $legacyCopies = 0
    if (Test-Path $rulesDir) { $legacyCopies = (Get-ChildItem $rulesDir -Filter "*.md" | Measure-Object).Count }
    if ($legacyCopies -gt 0) {
        $staleRules += "| $($p.name) | $legacyCopies file(s) in .claude/rules (may be legacy factory copies) | Review: forge legacy-rules plan --project-root `"$($p.path)`" --out <plan.json> |"
    }
    $claudeMd = "$($p.path)\.claude\CLAUDE.md"
    if (Test-Path $claudeMd) {
        $claudeMdContent = Get-Content $claudeMd -Raw
        if ($claudeMdContent -match "VibePromptRig factory (v\d+\.\d+(?:\.\d+)?)") {
            $projectVersion = $Matches[1]
            if ($projectVersion -ne $currentFactoryVersion) {
                $staleRules += "| $($p.name) | $projectVersion (factory is $currentFactoryVersion) | Re-run onboard to refresh |"
            }
        } else {
            $staleRules += "| $($p.name) | No version stamp | Re-run onboard to add stamp |"
        }
    }
}

$ruleSection = "All known projects are at factory $currentFactoryVersion."
if ($staleRules.Count -gt 0) {
    $ruleSection = "| Project | Status | Action |`n|---------|--------|--------|`n$($staleRules -join "`n")"
}

# Operational SLA checks
$slaItems = @()
$backupStamp = "$FactoryRoot\logs\pg-dump-offsite.last-run.stamp"
if (Test-Path $backupStamp) {
    $age = ((Get-Date) - (Get-Item $backupStamp).LastWriteTime).TotalHours
    if ($age -gt 30) {
        $slaItems += "- [WARN] pg-dump-offsite last ran $([math]::Round($age,1))h ago (SLA: <24h)"
    } else {
        $slaItems += "- [OK] pg-dump-offsite ran $([math]::Round($age,1))h ago"
    }
} else {
    $slaItems += "- [WARN] pg-dump-offsite has never run -- see scripts\backup-targets.json"
}

$decisionsPath = "$FactoryRoot\DECISIONS.md"
if (Test-Path $decisionsPath) {
    $age = ((Get-Date) - (Get-Item $decisionsPath).LastWriteTime).TotalDays
    if ($age -gt 14) {
        $slaItems += "- [WARN] DECISIONS.md is $([math]::Round($age,1))d stale (log recent decisions)"
    } else {
        $slaItems += "- [OK] DECISIONS.md is $([math]::Round($age,1))d old"
    }
}

$slaSection = $slaItems -join "`n"

# ---- Signal synthesis (P1a approved 2026-06-04: synthesizer cadence, pure PS, $0) ----
# Implements self-reflection.md "Synthesizer Agent" detection rules without LLM cost:
# reads signal-log.jsonl from factory + known projects (past 7 days), aggregates,
# flags: REPEAT in 2+ projects, REWORK >=3 per project, SECURITY anywhere,
# FRUSTRATION >5 per project, APPROVAL in 3+ projects.
$signalWindowDays = 7
$signalCutoff = (Get-Date).AddDays(-$signalWindowDays)
$signalPaths = @(@{ name = "factory"; path = $FactoryRoot }) + $knownProjects
$sigByProject = @{}
$sigTotals = @{}
$sigProjects = @{}
foreach ($sp in $signalPaths) {
    $slPath = Join-Path $sp.path ".claude\signal-log.jsonl"
    if (-not (Test-Path $slPath)) { continue }
    foreach ($line in (Get-Content $slPath -Encoding UTF8)) {
        if (-not $line -or $line.Trim().Length -eq 0) { continue }
        try {
            $e = $line | ConvertFrom-Json
            if (-not $e.ts -or -not $e.signals) { continue }
            # RoundtripKind tolerates pre-2026-06-04 local-labeled-Z entries (max 4h skew,
            # immaterial against a 7-day window) and post-fix real-UTC entries alike.
            $t = [DateTime]::Parse($e.ts, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
            if ($t -lt $signalCutoff) { continue }
            foreach ($s in $e.signals) {
                if (-not $sigByProject.ContainsKey($sp.name)) { $sigByProject[$sp.name] = @{} }
                if (-not $sigByProject[$sp.name].ContainsKey($s)) { $sigByProject[$sp.name][$s] = 0 }
                $sigByProject[$sp.name][$s]++
                if (-not $sigTotals.ContainsKey($s)) { $sigTotals[$s] = 0; $sigProjects[$s] = @{} }
                $sigTotals[$s]++
                $sigProjects[$s][$sp.name] = $true
            }
        } catch { continue }
    }
}

$signalFindings = @()
if ($sigProjects.ContainsKey("REPEAT") -and $sigProjects["REPEAT"].Count -ge 2) {
    $signalFindings += "- [SYNTH] REPEAT fired in $($sigProjects['REPEAT'].Count) projects ($(($sigProjects['REPEAT'].Keys | Sort-Object) -join ', ')) -- cross-project rule promotion candidate"
}
foreach ($proj in $sigByProject.Keys) {
    if ($sigByProject[$proj].ContainsKey("REWORK") -and $sigByProject[$proj]["REWORK"] -ge 3) {
        $signalFindings += "- [SYNTH] REWORK x$($sigByProject[$proj]['REWORK']) in $proj -- architectural review suggested"
    }
    if ($sigByProject[$proj].ContainsKey("FRUSTRATION") -and $sigByProject[$proj]["FRUSTRATION"] -gt 5) {
        $signalFindings += "- [SYNTH] FRUSTRATION x$($sigByProject[$proj]['FRUSTRATION']) in $proj -- run /half-baked-scan"
    }
}
if ($sigTotals.ContainsKey("SECURITY")) {
    $signalFindings += "- [SYNTH] SECURITY fired $($sigTotals['SECURITY'])x this week -- check signal-log for secret_in_prompt:true; rotate per secrets-handling.md SS3"
}
if ($sigProjects.ContainsKey("APPROVAL") -and $sigProjects["APPROVAL"].Count -ge 3) {
    $signalFindings += "- [SYNTH] APPROVAL fired in $($sigProjects['APPROVAL'].Count) projects -- golden-path generalization candidate"
}

$sigTableRows = @()
foreach ($s in ($sigTotals.Keys | Sort-Object { $sigTotals[$_] } -Descending)) {
    $sigTableRows += "| $s | $($sigTotals[$s]) | $(($sigProjects[$s].Keys | Sort-Object) -join ', ') |"
}
$signalSection = "No signals captured in the past $signalWindowDays days."
if ($sigTableRows.Count -gt 0) {
    $signalSection = "| Signal | Count (7d) | Projects |`n|---|---|---|`n$($sigTableRows -join "`n")"
    if ($signalFindings.Count -gt 0) {
        $signalSection += "`n`n**Patterns detected:**`n" + ($signalFindings -join "`n")
    } else {
        $signalSection += "`n`nNo cross-project patterns crossed thresholds this week."
    }
}

# Propose detected patterns to PENDING_APPROVALS -- ONE open entry per signal type
# (class-key dedup, same discipline as signal-batch-analyzer fix R2).
if ($signalFindings.Count -gt 0) {
    $pendingPath = "$FactoryRoot\PENDING_APPROVALS.md"
    $pendingRaw = ""
    if (Test-Path $pendingPath) { $pendingRaw = Get-Content $pendingPath -Raw -Encoding UTF8 }
    $newProposals = @()
    foreach ($f in $signalFindings) {
        $body = $f -replace '^- \[SYNTH\] ', ''
        $sigName = ($body -split ' ')[0]
        $classKey = "[SYNTH-AUTO] $sigName"
        if ($pendingRaw -notmatch [regex]::Escape($classKey)) {
            $newProposals += "### $classKey -- $body ($WeekOf)"
            $pendingRaw += " $classKey"   # in-loop guard: one entry per type per run
        }
    }
    if ($newProposals.Count -gt 0) {
        try {
            Add-Content -Path $pendingPath -Value "`n`n---`n`n## Synthesizer Proposals (week of $WeekOf)`n" -Encoding UTF8
            foreach ($np in $newProposals) { Add-Content -Path $pendingPath -Value ($np + "`n") -Encoding UTF8 }
        } catch {}
    }
}

# Build sections
$errorSection = "No errors logged in any project. Consider: are bugs being tracked?"
if ($errorSources.Count -gt 0) {
    $errorSection = ($errorSources | ForEach-Object { "- $_" }) -join "`n"
}

$pathSection = "No golden paths documented yet. After each successful pattern, add to golden-paths.md."
if ($allPaths.Count -gt 0) {
    $pathSection = $allPaths -join "`n"
}

$attentionSection = "All projects have proper briefs and active statuses."
if ($needsAttention.Count -gt 0) {
    $attentionSection = "| Project | Issue | Suggested Action |`n|---------|-------|-----------------|`n$($needsAttention -join "`n")"
}

# Write report
$report = @"
# VibePromptRig Weekly Insights — Week of $WeekOf
Generated automatically. All suggestions require the project owner's approval.

## Cross-Project Error Sources
$errorSection

## Total Errors Across All Projects: $totalErrors

## Golden Paths Documented
$pathSection

## Learning Velocity
- lessons.md: $lessonCount rules
- Target: Add at least 1 lesson per week from real project work

## Projects Needing Attention
$attentionSection

## Rule Freshness (factory $currentFactoryVersion vs project stamps)
$ruleSection

## Operational SLA
$slaSection

## Signal Synthesis (past $signalWindowDays days, all projects)
$signalSection

## Suggested Lesson Additions
Review the errors and patterns above. If any pattern appeared in 2+ projects, it should become a lesson in lessons.md.

## Suggested VIBE Rule Updates
If any bug pattern recurred across sessions (Bug twice = VIBE Rule, per Post-Mortem Protocol), draft the new rule here.
"@

$report | Set-Content -Path $OutputPath -Force
Write-Host "Weekly insights generated: $OutputPath"
