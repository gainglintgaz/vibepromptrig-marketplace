<#
.SYNOPSIS
    Session-start briefing for VibePromptRig. Runs read-only freshness checks
    scoped to the CURRENT PROJECT and prints a single-screen status so Claude
    (or the project owner) can pick up cold. Does not modify any files.

    Scoping rule (VRA-trading friction #4, 2026-06-12): every freshness /
    approvals / signal line is read from the CURRENT project's directory.
    A tracked file that is missing in-project reports "not present in this
    project" -- NEVER a factory-level timestamp. Each banner line carries a
    [project] or [factory] provenance label so mis-attribution is impossible.

.PARAMETER FactoryRoot
    Defaults to $env:VIBE_ROOT, else derived from the script location.

.PARAMETER ProjectDir
    The project this session is running in. Defaults to $env:CLAUDE_PROJECT_DIR,
    else the current working directory. When this equals FactoryRoot the session
    is a factory session and factory-level state is shown (labeled [factory]).

.PARAMETER Json
    Emit machine-readable JSON for hook consumers.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Read-only.
    Designed to run quickly (<2s) at session start.
#>

[CmdletBinding()]
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [string]$ProjectDir,
    [switch]$Json
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path $PSScriptRoot -Parent }
if (-not $ProjectDir) {
    if ($env:CLAUDE_PROJECT_DIR -and (Test-Path $env:CLAUDE_PROJECT_DIR)) {
        $ProjectDir = $env:CLAUDE_PROJECT_DIR
    } else {
        $ProjectDir = (Get-Location).Path
    }
}

$ErrorActionPreference = "SilentlyContinue"

# Canonical-compare so "factory session" detection survives trailing slashes / case.
function Get-CanonicalPath {
    param([string]$Path)
    try { return (Resolve-Path $Path).Path.TrimEnd('\').ToLowerInvariant() }
    catch { return $Path.TrimEnd('\').ToLowerInvariant() }
}

$isFactorySession = ((Get-CanonicalPath $ProjectDir) -eq (Get-CanonicalPath $FactoryRoot))
$scope    = if ($isFactorySession) { "factory" } else { "project" }
$scopeTag = "[$scope]"
# Every state file below is read from HERE -- the current project, never the factory.
$stateRoot = $ProjectDir

# Project identity (banner step 1 -- VRA friction #1). Leaf dir name; factory flagged.
$projectName = Split-Path $ProjectDir -Leaf
if ($isFactorySession) { $projectName = "$projectName (THE FACTORY)" }

# Helper: file freshness in hours, returns -1 if missing.
function Get-AgeHours {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return -1.0 }
    $age = (Get-Date) - (Get-Item $Path).LastWriteTime
    return [Math]::Round($age.TotalHours, 1)
}

# Helper: status emoji-free label.
# $IsFactorySession was previously (mis)named $InProject yet passed the
# factory-session flag -- inverted and confusing. Renamed (Desktop audit #5).
# $Required marks a mandatory tracking file (VIBE Rule 40): when one is absent in
# a PROJECT session it is a WARNING ("create it"), not the soft "not present" info
# we use for optional state files (PENDING_APPROVALS, SESSION_DEBRIEF, ...).
function Get-FreshnessLabel {
    param([double]$Hours, [double]$WarnAt, [double]$StaleAt, [bool]$IsFactorySession, [bool]$Required)
    if ($Hours -lt 0) {
        if ($IsFactorySession) { return "MISSING" }          # factory: absent watched file = real 404
        if ($Required)         { return "MISSING-REQUIRED" }  # project: mandatory tracker absent = WRN
        return "NOT-IN-PROJECT"                               # project: optional state file absent = info
    }
    if ($Hours -le $WarnAt)  { return "fresh" }
    if ($Hours -le $StaleAt) { return "warn" }
    return "STALE"
}

# Inventory of files to check -- different per scope.
if ($isFactorySession) {
    # R3 (wiring audit 2026-06-04): STATE.md + DAILY_DIGEST.md had NO generator wired
    # (vacation-mode infra dormant; no 6:50am digest task exists) -> permanent false
    # [404] alarms. Watch what the live crons actually produce instead:
    # STATUS_REPORT.md (VibePromptRig-DailyStatus, 8am) + WEEKLY_INSIGHTS.md (Sunday 8am).
    $watched = @(
        @{ name="STATUS_REPORT.md";   path="STATUS_REPORT.md";   warn=30; stale=72 }
        @{ name="WEEKLY_INSIGHTS.md"; path="WEEKLY_INSIGHTS.md"; warn=192; stale=360 }
        @{ name="CURRENT_SPRINT.md";  path="CURRENT_SPRINT.md";  warn=168; stale=336 }  # weekly cadence
        @{ name="NEXT_SESSION.md";    path="NEXT_SESSION.md";    warn=72; stale=168 }
        @{ name="PENDING_APPROVALS";  path="PENDING_APPROVALS.md"; warn=168; stale=336 }
        @{ name="SESSION_DEBRIEF.md"; path="SESSION_DEBRIEF.md"; warn=72; stale=168 }
        @{ name="VERSION.md";         path="VERSION.md";         warn=336; stale=720 }
    )
} else {
    # Project sessions watch the PROJECT's own tracking files (scaffold set).
    # Factory cron products (STATUS_REPORT, WEEKLY_INSIGHTS) are factory-only noise here.
    $watched = @(
        @{ name="CURRENT_SPRINT.md";     path="CURRENT_SPRINT.md";     warn=168; stale=336; required=$true }
        @{ name="V1_FEATURE_BACKLOG.md"; path="V1_FEATURE_BACKLOG.md"; warn=336; stale=720; required=$true }
        @{ name="NEXT_SESSION.md";       path="NEXT_SESSION.md";       warn=72;  stale=168 }
        @{ name="PENDING_APPROVALS";     path="PENDING_APPROVALS.md";  warn=168; stale=336 }
        @{ name="SESSION_DEBRIEF.md";    path="SESSION_DEBRIEF.md";    warn=72;  stale=168 }
        @{ name="errors-fixed.json";     path="errors-fixed.json";     warn=336; stale=720 }
        @{ name="golden-paths.md";       path="golden-paths.md";       warn=336; stale=720 }
    )
}

$rows = @()
foreach ($w in $watched) {
    $full = Join-Path $stateRoot $w.path
    $h = Get-AgeHours -Path $full
    $rq = if ($w.ContainsKey('required')) { [bool]$w.required } else { $false }
    $rows += [PSCustomObject]@{
        name      = $w.name
        path      = $w.path
        age_hours = $h
        required  = $rq
        status    = Get-FreshnessLabel -Hours $h -WarnAt $w.warn -StaleAt $w.stale -IsFactorySession $isFactorySession -Required $rq
        scope     = $scope
    }
}

# Git state -- the CURRENT project's repo, never the factory's.
$branch    = $null
$ahead     = $null
$dirtyCount = $null
try {
    $branch = (& git -C $ProjectDir rev-parse --abbrev-ref HEAD 2>$null)
    if ($branch) { $branch = ([string]$branch).Trim() }
    if ($branch) {
        $statusOut = & git -C $ProjectDir status --porcelain 2>$null
        if ($null -ne $statusOut) { $dirtyCount = @($statusOut).Count } else { $dirtyCount = 0 }
        $aheadOut = & git -C $ProjectDir rev-list --count "origin/$branch..HEAD" 2>$null
        if ($aheadOut) { $ahead = [int]$aheadOut }
    }
} catch { }

# PENDING_APPROVALS open count -- the CURRENT project's file only.
# Missing in a project session = "not present in this project", never the factory count.
$pendingCount  = $null
$pendingPath   = Join-Path $stateRoot "PENDING_APPROVALS.md"
$pendingExists = Test-Path $pendingPath
if ($pendingExists) {
    $pendingCount = 0
    $content = Get-Content $pendingPath -Raw -Encoding UTF8
    $headMatches = [regex]::Matches($content, '(?m)^### ')
    $pendingCount = $headMatches.Count
    # Subtract any in a "Recently Resolved" section
    $resolvedSection = [regex]::Match($content, '(?ms)^## Recently Resolved.*$')
    if ($resolvedSection.Success) {
        $resolvedHeads = [regex]::Matches($resolvedSection.Value, '(?m)^### ').Count
        $pendingCount -= $resolvedHeads
        if ($pendingCount -lt 0) { $pendingCount = 0 }
    }
}

# Signal-log critical recent (last 24h) -- the CURRENT project's log only.
# Reading another project's (or the factory's) log here would mis-attribute signals.
$signalCritical  = 0
$signalProjects  = @()
$signalLogPath   = Join-Path $stateRoot ".claude\signal-log.jsonl"
$signalLogExists = Test-Path $signalLogPath
if ($signalLogExists) {
    $cutoffIso = ((Get-Date).AddHours(-24)).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $lines = Get-Content $signalLogPath -Encoding UTF8 -ErrorAction SilentlyContinue
    foreach ($l in $lines) {
        if (-not $l) { continue }
        try { $entry = $l | ConvertFrom-Json } catch { continue }
        if (-not $entry.ts) { continue }
        if ($entry.ts -lt $cutoffIso) { continue }
        $crits = @($entry.signals | Where-Object { $_ -in @('SECURITY','REPEAT','RULE_VIOLATION') })
        if ($crits.Count -gt 0) {
            $signalCritical += $crits.Count
            $signalProjects += $entry.project
        }
    }
}
# @(...) keeps this a real array: PS 5.1 'Sort-Object' on empty input yields no
# output (not @()), which ConvertTo-Json then renders as {} instead of []
# (Desktop audit #5). @() coerces the empty case to a proper JSON array.
$signalProjects = @($signalProjects | Sort-Object -Unique)

# ---- JSON output mode (for hooks) ----
if ($Json) {
    $payload = [ordered]@{
        project_name   = $projectName
        ts             = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        scope          = $scope
        project_dir    = $ProjectDir
        state_root     = $stateRoot
        factory_root   = $FactoryRoot
        git_branch     = if ($branch) { [string]$branch } else { $null }  # string or null, never {}
        git_dirty      = $dirtyCount
        git_ahead      = $ahead
        files          = @($rows)
        pending_count  = $pendingCount      # null = PENDING_APPROVALS.md not present in this project
        pending_scope  = $scope
        signal_log_present   = $signalLogExists
        critical_signals_24h = $signalCritical
        critical_projects    = @($signalProjects)   # always a JSON array, [] when empty
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# ---- Human-readable output ----
# STEP 1 -- project identity. This block prints BEFORE any other output so a
# wrong-folder launch is unmissable (VRA friction #1: acting in the wrong repo
# on a money project = cross-project contamination, secrets-handling.md SS7).
$branchDisp = if ($branch) { $branch } else { "(not a git repository)" }
Write-Host ""
Write-Host "########################################################" -ForegroundColor Yellow
Write-Host ("#  PROJECT: {0}" -f $projectName) -ForegroundColor Yellow
Write-Host ("#  PATH:    {0}" -f $ProjectDir) -ForegroundColor Yellow
Write-Host ("#  BRANCH:  {0}" -f $branchDisp) -ForegroundColor Yellow
Write-Host "########################################################" -ForegroundColor Yellow
Write-Host "  ^ Confirm this is the project you intend to work on."
Write-Host ""
Write-Host "===== VibePromptRig session start =====" -ForegroundColor Cyan
Write-Host ("  scope:   {0} (state below is read from this {0}'s own files)" -f $scope)
if (-not $isFactorySession) {
    Write-Host ("  factory: {0} [factory]" -f $FactoryRoot)
}
if ($branch) {
    $gitLine = "  git: branch=$branch"
    if ($null -ne $dirtyCount -and $dirtyCount -gt 0) { $gitLine += " dirty=$dirtyCount" }
    if ($null -ne $ahead -and $ahead -gt 0)           { $gitLine += " ahead=$ahead" }
    Write-Host ($gitLine + " " + $scopeTag)
} else {
    Write-Host ("  git: not a git repository " + $scopeTag)
}

# WORKTREE HYGIENE (worktree-sweep 2026-08-08; Example Finance App ai-apis.md #worktree-hygiene, L82).
# Derived LIVE from git, never from a hand-maintained doc (L95 applied to coordination state).
$wtWarnTotal = 25
$wtWarnAgeDays = 14
if ($branch) {
    $wtBlocks = ((& git -C $ProjectDir worktree list --porcelain 2>$null) -join "`n") -split "`n`n" | Where-Object { $_ -match 'worktree ' }
    $wtTotal = @($wtBlocks).Count
    if ($wtTotal -gt 1) {
        $mergedCold = 0; $mergedDirty = 0; $oldestDays = 0; $oldestPath = ''; $dirtyExample = ''
        $skipDetail = ($wtTotal -gt 80)  # keep session start fast in the pathological case
        if (-not $skipDetail) {
            $trunkRefs = @('origin/v1.1-master', 'origin/main', 'origin/master') | Where-Object {
                & git -C $ProjectDir show-ref --verify --quiet "refs/remotes/$_" 2>$null; $LASTEXITCODE -eq 0
            }
            foreach ($b in ($wtBlocks | Select-Object -Skip 1)) {
                $wp = (($b -split "`n") | Where-Object { $_ -like 'worktree *' } | Select-Object -First 1)
                $wsha = (($b -split "`n") | Where-Object { $_ -like 'HEAD *' } | Select-Object -First 1)
                if (-not $wp -or -not $wsha) { continue }
                $wp = $wp.Substring(9); $wsha = $wsha.Substring(5)
                $isMerged = $false
                foreach ($tr in $trunkRefs) {
                    & git -C $ProjectDir merge-base --is-ancestor $wsha $tr 2>$null
                    if ($LASTEXITCODE -eq 0) { $isMerged = $true; break }
                }
                $ageDays = 0
                if (Test-Path $wp) {
                    try { $ageDays = [int]((Get-Date) - (Get-Item "$wp/.git" -Force).LastWriteTime).TotalDays } catch {}
                }
                if ($isMerged) {
                    # "Merged" is NOT "safe to retire" -- candidacy requires (merged AND clean),
                    # matching the guard scripts/worktree-retire.ps1 already applies at line ~97
                    # ($dirty.Count -gt 0 -and -not $Force -> SKIP). Before 2026-08-14 this list
                    # counted merged alone, so it advertised data-bearing worktrees as disposable.
                    # Real near-miss (Example Wellness App P-11 / errors-fixed #14): two cert worktrees were
                    # fully merged (0 commits ahead) while holding the ONLY copy of a Google Place
                    # Details enrichment wave across 22 destinations -- uncommitted, so invisible to
                    # git's merge check AND excluded from the G1 scan ('.claude/worktrees/' is in
                    # its ignore list). They sat in this candidate count for 18 days.
                    # Status check is scoped to already-merged worktrees so session start pays for
                    # `git status` only on the candidate set, not on every worktree.
                    $isDirty = $false
                    if (Test-Path $wp) {
                        $wtDirty = @(& git -C $wp status --porcelain 2>$null)
                        if ($wtDirty.Count -gt 0) { $isDirty = $true }
                    }
                    if ($isDirty) {
                        $mergedDirty++
                        if (-not $dirtyExample) { $dirtyExample = $wp }
                    } else {
                        $mergedCold++
                        if ($ageDays -gt $oldestDays) { $oldestDays = $ageDays; $oldestPath = $wp }
                    }
                }
            }
        }
        $hyLine = "  WORKTREE HYGIENE: total=$wtTotal"
        if (-not $skipDetail) {
            $hyLine += " merged-removal-candidates=$mergedCold oldest-merged-age=${oldestDays}d"
            if ($mergedDirty -gt 0) { $hyLine += " merged-but-DIRTY=$mergedDirty (not candidates)" }
        }
        Write-Host $hyLine
        if (-not $skipDetail -and $mergedDirty -gt 0) {
            Write-Host ("  [WRN] $mergedDirty merged worktree(s) hold UNCOMMITTED work -- excluded from the retirement count above." +
                $(if ($dirtyExample) { " e.g. $dirtyExample" })) -ForegroundColor Yellow
            Write-Host "        Merged + dirty is the worst quadrant: git calls the branch fully integrated while the worktree holds the only copy." -ForegroundColor Yellow
            Write-Host "        Commit or harvest before retiring. 'worktree-retire.ps1 -Force' WOULD destroy these." -ForegroundColor Yellow
        }
        if ($wtTotal -gt $wtWarnTotal -or (-not $skipDetail -and $oldestDays -gt $wtWarnAgeDays)) {
            Write-Host ("  [WRN] WORKTREE PILE: $wtTotal worktrees (warn > $wtWarnTotal), oldest merged $oldestDays d (warn > $wtWarnAgeDays d)" +
                $(if ($oldestPath) { " -- e.g. $oldestPath" })) -ForegroundColor Yellow
            Write-Host "        Retire merged worktrees via scripts/worktree-retire.ps1 (NEVER bare 'git worktree remove' -- 2026-08-08 node_modules incident)." -ForegroundColor Yellow
        }
    }
}
Write-Host ""

Write-Host ("Freshness " + $scopeTag + ":")
foreach ($r in $rows) {
    if ($r.status -eq "NOT-IN-PROJECT") {
        Write-Host ("  [ - ] {0,-22} not present in this project" -f $r.name)
        continue
    }
    if ($r.status -eq "MISSING-REQUIRED") {
        Write-Host ("  [WRN] {0,-22} not present -- create it (VIBE Rule 40, mandatory tracker)" -f $r.name) -ForegroundColor Yellow
        continue
    }
    $ageDisp = if ($r.age_hours -lt 0) { "  -- " } else { "{0,5:N1}h" -f $r.age_hours }
    $tag = switch ($r.status) {
        "fresh"   { "[OK ]" }
        "warn"    { "[WRN]" }
        "STALE"   { "[OLD]" }
        "MISSING" { "[404]" }
        default   { "[??]" }
    }
    Write-Host ("  {0} {1,-22} {2}" -f $tag, $r.name, $ageDisp)
}
Write-Host ""

if ($null -ne $pendingCount) {
    Write-Host ("Open approvals : {0} {1}" -f $pendingCount, $scopeTag)
} else {
    Write-Host ("Open approvals : PENDING_APPROVALS.md not present in this project")
}
if ($signalLogExists) {
    Write-Host ("CRITICAL signals last 24h: {0} {1}" -f $signalCritical, $scopeTag)
} else {
    Write-Host ("CRITICAL signals last 24h: no signal log in this " + $scope)
}
if ($signalProjects.Count -gt 0) {
    Write-Host ("  in projects: {0}" -f ($signalProjects -join ", "))
}

# Recommendations -- scoped: never recommend factory-level actions from project staleness.
$recs = [System.Collections.Generic.List[string]]::new()
$stale = @($rows | Where-Object { $_.status -eq 'STALE' -or $_.status -eq 'MISSING' })
$missingReq = @($rows | Where-Object { $_.status -eq 'MISSING-REQUIRED' })
if ($isFactorySession) {
    if ($stale.Count -gt 0) {
        $recs.Add("Run /catchup -- one or more factory state files are stale or missing.")
    }
    if ($null -ne $pendingCount -and $pendingCount -ge 5) {
        $recs.Add("Run /review-pending -- $pendingCount open approvals.")
    }
    if ($signalCritical -gt 0) {
        $recs.Add("Read PENDING_APPROVALS.md tail -- $signalCritical CRITICAL signals in the last 24h.")
    }
} else {
    if ($missingReq.Count -gt 0) {
        $reqNames = ($missingReq | ForEach-Object { $_.name }) -join ", "
        $recs.Add("Create $reqNames -- VIBE Rule 40 requires these persistent tracking files in every project (context-drift guard).")
    }
    if ($stale.Count -gt 0) {
        $staleNames = ($stale | ForEach-Object { $_.name }) -join ", "
        $recs.Add("Project tracking files stale: $staleNames -- update them before new work (VIBE Rule 40).")
    }
    if ($null -ne $pendingCount -and $pendingCount -ge 5) {
        $recs.Add("This project's PENDING_APPROVALS.md has $pendingCount open items -- review them.")
    }
    if ($signalCritical -gt 0) {
        $recs.Add("This project logged $signalCritical CRITICAL signals in the last 24h -- read .claude/signal-log.jsonl.")
    }
}
if ($null -ne $dirtyCount -and $dirtyCount -gt 10) {
    $recs.Add("git status: $dirtyCount uncommitted files. Consider committing or stashing before new work.")
}

if ($recs.Count -gt 0) {
    Write-Host ""
    Write-Host "Recommendations:" -ForegroundColor Yellow
    foreach ($r in $recs) { Write-Host ("  - " + $r) }
}

Write-Host ""
exit 0
