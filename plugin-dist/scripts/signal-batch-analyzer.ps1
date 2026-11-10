<#
.SYNOPSIS
    VibePromptRig v4.3.5 -- Stop-hook signal batch analyzer.
    Runs at session end. Reads signal-log.jsonl from the current project.
    Summarizes signals fired this session and proposes PENDING_APPROVALS entries
    for critical patterns (REPEAT, SECURITY, RULE_VIOLATION, 3+ REWORK).
    Appends signal summary to SESSION_DEBRIEF.md (created by post-session-enforcer.ps1).
.NOTES
    No API calls in V1. Pure signal aggregation + pattern detection.
    Runs AFTER post-session-enforcer.ps1 so SESSION_DEBRIEF.md already exists.
#>

param()
$ErrorActionPreference = "SilentlyContinue"

# --- Double-fire guard (Desktop audit 2026-06-13) -----------------------------
# In a FACTORY session the repo's .claude/settings.json wires this Stop hook AND
# the globally-enabled vibepromptrig plugin wires the same hook -- so it fires
# twice (double PENDING_APPROVALS proposals). When THIS copy is the plugin
# DISTRIBUTION copy (under plugin-dist/ or the plugins cache) and the session is
# running in the factory itself, defer to the repo-local copy. Customer sessions
# are unaffected (their cwd is not the factory).
if (($PSScriptRoot -match '[\\/]plugin-dist([\\/]|$)') -or ($PSScriptRoot -match '[\\/]plugins[\\/]cache[\\/]')) {
    $vfCwd = (Get-Location).Path
    if ((Test-Path (Join-Path $vfCwd '.claude-plugin\plugin.json')) -and (Test-Path (Join-Path $vfCwd 'plugin-dist'))) {
        exit 0
    }
}

# ---- Config ----
$FactoryRoot       = if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }
$SessionWindowHrs  = 6      # look back N hours to find this session's signals
$ReworkThreshold   = 3      # suggest /audit-gate if REWORK fires >= N times

# ---- Resolve paths ----
$cwd              = (Get-Location).Path
$projectId        = Split-Path $cwd -Leaf
if ($cwd -ieq $FactoryRoot) { $projectId = "factory" }

$logPath          = Join-Path $cwd ".claude\signal-log.jsonl"
$debriefPath      = Join-Path $cwd "SESSION_DEBRIEF.md"
$pendingPath      = Join-Path $cwd "PENDING_APPROVALS.md"

# ---- Nothing to analyze ----
if (-not (Test-Path $logPath)) { exit 0 }

# ---- Read signals from this session window ----
$cutoffTime = (Get-Date).AddHours(-$SessionWindowHrs)

$allLines = Get-Content $logPath -Encoding UTF8 -ErrorAction SilentlyContinue
if (-not $allLines) { exit 0 }

$sessionSignals = [System.Collections.Generic.List[object]]::new()

foreach ($line in $allLines) {
    if (-not $line -or $line.Trim().Length -eq 0) { continue }
    try {
        $entry = $line | ConvertFrom-Json
        if (-not $entry.ts) { continue }

        # Parse timestamp
        $entryTime = [System.DateTime]::Parse($entry.ts, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        if ($entryTime -ge $cutoffTime) {
            $sessionSignals.Add($entry)
        }
    } catch { continue }
}

if ($sessionSignals.Count -eq 0) { exit 0 }

# ---- Aggregate by signal type ----
$signalCounts = @{}
$signalStrengths = @{}

foreach ($entry in $sessionSignals) {
    if (-not $entry.signals) { continue }
    foreach ($sig in $entry.signals) {
        if (-not $signalCounts.ContainsKey($sig)) {
            $signalCounts[$sig] = 0
            $signalStrengths[$sig] = 0
        }
        $signalCounts[$sig]++
        $signalStrengths[$sig] += [int]$entry.strength
    }
}

if ($signalCounts.Count -eq 0) { exit 0 }

# ---- Build signal summary section ----
$ts        = Get-Date -Format "yyyy-MM-dd HH:mm"
$totalFired = ($signalCounts.Values | Measure-Object -Sum).Sum

$summaryLines = @()
$summaryLines += ""
$summaryLines += "---"
$summaryLines += ""
$summaryLines += "## Passive-Listening Signal Summary -- $ts"
$summaryLines += ""
$summaryLines += "Total signal events this session: $totalFired"
$summaryLines += ""
$summaryLines += "| Signal | Count | Total Strength | Priority |"
$summaryLines += "|--------|-------|---------------|----------|"

$priorityMap = @{
    "REPEAT"         = "CRITICAL"
    "SECURITY"       = "CRITICAL"
    "RULE_VIOLATION" = "CRITICAL"
    "REWORK"         = "HIGH"
    "CORRECTION"     = "HIGH"
    "BUG"            = "HIGH"
    "PIVOT_STRATEGIC"= "HIGH"
    "CLARIFY_NEEDED" = "MEDIUM"
    "FRUSTRATION"    = "MEDIUM"
    "MISSING"        = "MEDIUM"
    "CONFUSION"      = "LOW"
    "APPROVAL"       = "LOW"
}

# Sort by priority then count (CRITICAL first)
$priorityOrder = @{ "CRITICAL" = 0; "HIGH" = 1; "MEDIUM" = 2; "LOW" = 3 }

$sortedSignals = $signalCounts.Keys | Sort-Object {
    $pri = if ($priorityMap.ContainsKey($_)) { $priorityMap[$_] } else { "LOW" }
    [int]$priorityOrder[$pri]
}, { -[int]$signalCounts[$_] }

foreach ($sig in $sortedSignals) {
    $count    = $signalCounts[$sig]
    $strength = $signalStrengths[$sig]
    $priority = if ($priorityMap.ContainsKey($sig)) { $priorityMap[$sig] } else { "MEDIUM" }
    $summaryLines += "| $sig | $count | $strength | $priority |"
}

# ---- Generate PENDING_APPROVALS proposals ----
$proposals = [System.Collections.Generic.List[string]]::new()
$todayDate = Get-Date -Format "yyyy-MM-dd"

# REPEAT >= 1: auto-promote candidate
if ($signalCounts.ContainsKey("REPEAT") -and $signalCounts["REPEAT"] -ge 1) {
    $proposals.Add(@"
### [SIGNAL-AUTO] REPEAT signal fired $($signalCounts["REPEAT"])x -- rule promotion candidate ($todayDate)
- **Project:** $projectId
- **Signal count:** $($signalCounts["REPEAT"]) REPEAT events this session
- **Action:** Review signal-log.jsonl for what was repeated. If a prior lesson exists for this pattern, promote it to a factory rule in docs/rules-reference/factory/ (plus its rules-manifest entry).
- **File:** .claude/signal-log.jsonl (search session_id from this session)
- **Priority:** HIGH
"@)
}

# SECURITY >= 1: rotation reminder
if ($signalCounts.ContainsKey("SECURITY") -and $signalCounts["SECURITY"] -ge 1) {
    $proposals.Add(@"
### [SIGNAL-AUTO] SECURITY signal fired $($signalCounts["SECURITY"])x -- verify no token exposure ($todayDate)
- **Project:** $projectId
- **Signal count:** $($signalCounts["SECURITY"]) SECURITY events this session
- **Action:** Review signal-log.jsonl for entries with secret_in_prompt:true. If any found, rotate the affected token immediately per secrets-handling.md SS3.
- **File:** .claude/signal-log.jsonl
- **Priority:** CRITICAL -- the project owner action required
"@)
}

# RULE_VIOLATION >= 1: audit
if ($signalCounts.ContainsKey("RULE_VIOLATION") -and $signalCounts["RULE_VIOLATION"] -ge 1) {
    $proposals.Add(@"
### [SIGNAL-AUTO] RULE_VIOLATION signal fired $($signalCounts["RULE_VIOLATION"])x -- rule audit ($todayDate)
- **Project:** $projectId
- **Action:** Identify which rule was violated. Strengthen it per self-reflection.md Rule Gap Scanner.
- **File:** .claude/signal-log.jsonl (check prompt_excerpt fields)
- **Priority:** CRITICAL
"@)
}

# REWORK >= threshold: suggest architectural review
if ($signalCounts.ContainsKey("REWORK") -and $signalCounts["REWORK"] -ge $ReworkThreshold) {
    $proposals.Add(@"
### [SIGNAL-AUTO] REWORK fired $($signalCounts["REWORK"])x -- architectural review suggested ($todayDate)
- **Project:** $projectId
- **Signal count:** $($signalCounts["REWORK"]) REWORK events (threshold: $ReworkThreshold)
- **Action:** Run /audit-gate or Hostile Architect review. Frequent rewrites signal under-specified requirements.
- **Priority:** HIGH
"@)
}

# APPROVAL >= 3: golden path candidate
if ($signalCounts.ContainsKey("APPROVAL") -and $signalCounts["APPROVAL"] -ge 3) {
    $proposals.Add(@"
### [SIGNAL-AUTO] APPROVAL fired $($signalCounts["APPROVAL"])x -- golden path candidate ($todayDate)
- **Project:** $projectId
- **Action:** Identify the pattern that earned approval. If it recurs across projects, add to golden-paths.md.
- **Priority:** LOW
"@)
}

# ---- Append to SESSION_DEBRIEF.md ----
if (Test-Path $debriefPath) {
    try {
        Add-Content -Path $debriefPath -Value ($summaryLines -join "`n") -Encoding UTF8
    } catch {}
} else {
    # Create minimal debrief if enforcer didn't run
    try {
        $summaryLines | Set-Content -Path $debriefPath -Encoding UTF8
    } catch {}
}

# ---- Dedup: drop proposal classes already open in PENDING_APPROVALS ----
# (self-improvement wiring audit R2, 2026-06-04: 48 session-end blocks / 77 duplicate
#  proposals had accumulated. Class key = title up to the fire-count; one open entry
#  per class is signal enough.)
if ($proposals.Count -gt 0 -and (Test-Path $pendingPath)) {
    try {
        $pendingRaw = Get-Content -Path $pendingPath -Raw -Encoding UTF8
        if ($pendingRaw) {
            $kept = [System.Collections.Generic.List[string]]::new()
            foreach ($p in $proposals) {
                $firstLine = ($p -split "`r?`n")[0]
                $classKey  = $firstLine -replace '(fired) \d+x.*$', '$1'
                if ($pendingRaw -notmatch [regex]::Escape($classKey)) { $kept.Add($p) }
            }
            $proposals = $kept
        }
    } catch {}
}

# ---- Append proposals to PENDING_APPROVALS.md ----
if ($proposals.Count -gt 0) {
    try {
        $header = @"


---

## Signal-Auto Proposals ($todayDate, project: $projectId)

"@
        if (Test-Path $pendingPath) {
            Add-Content -Path $pendingPath -Value $header -Encoding UTF8
        } else {
            Set-Content -Path $pendingPath -Value ("# PENDING_APPROVALS`n" + $header) -Encoding UTF8
        }
        foreach ($p in $proposals) {
            Add-Content -Path $pendingPath -Value ($p + "`n") -Encoding UTF8
        }
    } catch {}
}

# ---- Print brief summary to stdout (appears in Claude's Stop output) ----
Write-Output ""
Write-Output "SIGNAL BATCH ANALYZER -- $projectId"
Write-Output "  Signals this session: $($signalCounts.Keys -join ', ')"
Write-Output "  Total events: $totalFired"
if ($proposals.Count -gt 0) {
    Write-Output "  Proposals added to PENDING_APPROVALS.md: $($proposals.Count)"
}
if ($signalCounts.ContainsKey("SECURITY")) {
    Write-Output "  [!] SECURITY signals fired. Review signal-log.jsonl for token exposure."
}

exit 0
