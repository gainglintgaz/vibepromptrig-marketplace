<#
.SYNOPSIS
    Daily status report generator. Scans all VibePromptRig projects.
    Runs headless via Windows Task Scheduler at 8am daily.
    Output: <factory-root>\STATUS_REPORT.md
#>

$ErrorActionPreference = "SilentlyContinue"

$FactoryRoot = if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }
$ProjectsDir = "$FactoryRoot\projects"
$OutputPath = "$FactoryRoot\STATUS_REPORT.md"
$Today = Get-Date -Format "yyyy-MM-dd"

function Get-RegistryField($Brief, $Field) {
    $match = [regex]::Match($Brief, "(?im)^Registry ${Field}:[ \t]*(.*)$")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ''
}

function Get-PathKey($Path) {
    if (-not $Path) { return $null }
    try {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
        return [System.IO.Path]::GetFullPath($resolved).TrimEnd('\', '/').ToLowerInvariant()
    } catch {
        try { return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant() }
        catch { return $Path.ToLowerInvariant() }
    }
}

function Get-RegisteredProjects($ProjectsDir) {
    $records = @()
    foreach ($proj in @(Get-ChildItem -Path $ProjectsDir -Directory)) {
        $briefPath = Join-Path $proj.FullName 'BRIEF.md'
        if (-not (Test-Path -LiteralPath $briefPath)) { continue }
        $brief = Get-Content -LiteralPath $briefPath -Raw
        if ($null -eq $brief) { continue }
        $location = ''
        $locationMatch = [regex]::Match($brief, '(?im)^## Location\s*\r?\n([^\r\n]+)')
        if ($locationMatch.Success) { $location = $locationMatch.Groups[1].Value.Trim() }
        $canonical = Get-RegistryField $brief 'Canonical'
        if (-not $canonical) { $canonical = $proj.Name }
        $status = 'Unknown'
        $statusMatch = [regex]::Match($brief, '(?im)^## Status:[ \t]*(.+)')
        if ($statusMatch.Success) { $status = $statusMatch.Groups[1].Value.Trim() }
        $records += [pscustomobject]@{
            DirName = $proj.Name; Brief = $brief; Location = $location; Canonical = $canonical
            Aliases = @((Get-RegistryField $brief 'Aliases').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            Status = $status; Owner = (Get-RegistryField $brief 'Owner'); Task = (Get-RegistryField $brief 'Task')
            Checkpoint = (Get-RegistryField $brief 'Checkpoint'); CheckpointDate = (Get-RegistryField $brief 'Checkpoint Date')
            Mode = (Get-RegistryField $brief 'Delivery Mode').ToLowerInvariant(); Conflict = $false; Duplicate = $false
        }
    }
    for ($i = 0; $i -lt $records.Count; $i++) {
        for ($j = $i + 1; $j -lt $records.Count; $j++) {
            $a = $records[$i]; $b = $records[$j]
            $aNames = @($a.Canonical, $a.DirName) + $a.Aliases | ForEach-Object { $_.ToLowerInvariant() }
            $bNames = @($b.Canonical, $b.DirName) + $b.Aliases | ForEach-Object { $_.ToLowerInvariant() }
            $overlap = @($aNames | Where-Object { $bNames -contains $_ }).Count -gt 0
            $samePath = $a.Location -and $b.Location -and ((Get-PathKey $a.Location) -eq (Get-PathKey $b.Location))
            if (-not $overlap -and -not $samePath) { continue }
            $declaredAlias = ($a.Aliases | Where-Object { $_.ToLowerInvariant() -eq $b.Canonical.ToLowerInvariant() }) -or
                ($b.Aliases | Where-Object { $_.ToLowerInvariant() -eq $a.Canonical.ToLowerInvariant() })
            $sameIdentity = $samePath -and (($a.Canonical -ieq $b.Canonical) -or $declaredAlias)
            $incompatible = $false
            foreach ($field in @('Owner', 'Task', 'Checkpoint', 'CheckpointDate', 'Mode')) {
                if ($a.$field -and $b.$field -and $a.$field -ne 'UNKNOWN' -and $b.$field -ne 'UNKNOWN' -and $a.$field -cne $b.$field) { $incompatible = $true }
            }
            if (-not $sameIdentity -or $incompatible) { $a.Conflict = $true; $b.Conflict = $true; continue }
            $aScore = [int]($a.DirName -ieq $a.Canonical) + [int][bool]$a.Owner + [int][bool]$a.Mode
            $bScore = [int]($b.DirName -ieq $b.Canonical) + [int][bool]$b.Owner + [int][bool]$b.Mode
            if ($aScore -ge $bScore) { $b.Duplicate = $true } else { $a.Duplicate = $true }
        }
    }
    return @($records | Where-Object { -not $_.Duplicate -or $_.Conflict })
}

function Get-RepositoryIdentity($RepoPath) {
    if (-not $RepoPath -or -not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
        return @{ Ok = $false; Reason = 'UNKNOWN: registered checkout missing' }
    }
    if (-not [System.IO.Path]::IsPathRooted($RepoPath)) {
        return @{ Ok = $false; Reason = 'UNKNOWN: registered checkout path is not absolute' }
    }
    try {
        $actualRoot = & git -C $RepoPath rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $actualRoot) {
            return @{ Ok = $false; Reason = 'UNKNOWN: registered checkout is not a repository' }
        }
        if ((Get-PathKey $RepoPath) -ne (Get-PathKey ([string]$actualRoot))) {
            return @{ Ok = $false; Reason = 'UNKNOWN: repository identity mismatch' }
        }
        return @{ Ok = $true }
    } catch { return @{ Ok = $false; Reason = 'UNKNOWN: repository identity unavailable' } }
}

function Format-ReportCell($Value) {
    if (-not $Value) { return 'UNKNOWN' }
    return ([string]$Value).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
}

# Local Git evidence only; synchronization never proves release or live acceptance.
function Get-DeliveryState($RepoPath, $Mode) {
    $unknown = @{ Label = 'UNKNOWN: repository/upstream unavailable'; Action = 'locate the checkout and verify its branch/upstream before starting more work' }
    if ($Mode -ne 'remote' -and $Mode -ne 'local-only') {
        return @{ Label = 'UNKNOWN: delivery mode missing or invalid'; Action = 'declare remote or local-only delivery mode in the project registration' }
    }
    if (-not (Test-Path -LiteralPath $RepoPath)) { return $unknown }
    $previousLocks = $env:GIT_OPTIONAL_LOCKS
    try {
        $env:GIT_OPTIONAL_LOCKS = '0'
        $lines = @(& git -C $RepoPath status --porcelain=v1 --branch --untracked-files=normal 2>$null)
        if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return $unknown }
        $header = [string]$lines[0]
        if (-not $header.StartsWith('## ')) { return $unknown }
        if ($Mode -eq 'local-only') {
            $dirty = $lines.Count - 1
            $action = if ($dirty -gt 0) { 'review uncommitted local work and its checkpoint' } else { $null }
            return @{ Label = "LOCAL ONLY: uncommitted entries $dirty; upstream N/A"; Action = $action }
        }
        if (-not $header.Contains('...') -or $header.Contains('[gone]')) {
            return @{ Label = 'UNKNOWN: upstream unavailable'; Action = 'verify the intended upstream or declare this checkout local-only' }
        }
        $ahead = 0; $behind = 0
        if ($header -match 'ahead (\d+)') { $ahead = [int]$Matches[1] }
        if ($header -match 'behind (\d+)') { $behind = [int]$Matches[1] }
        $dirty = $lines.Count - 1
        $action = if ($ahead -gt 0 -and $behind -gt 0) { 'reconcile diverged work without resetting or overwriting either side' }
            elseif ($ahead -gt 0) { 'review unpublished commits and advance the approved release, or explicitly park this work' }
            elseif ($behind -gt 0) { 'review upstream changes before continuing local work' }
            elseif ($dirty -gt 0) { 'review uncommitted work and finish or explicitly park the current change' }
            else { $null }
        return @{ Label = "Ahead $ahead; behind $behind; uncommitted entries $dirty"; Action = $action }
    } catch { return $unknown }
    finally { $env:GIT_OPTIONAL_LOCKS = $previousLocks }
}

# Scan projects
$projectRows = @()
$forgottenIdeas = @()
$staleFiles = @()
$deliveryActions = @()

foreach ($registration in @(Get-RegisteredProjects $ProjectsDir)) {
    $projName = $registration.Canonical
    $briefContent = $registration.Brief
    $status = $registration.Status
    $projPath = $registration.Location
    $issues = @()
    if ($registration.Conflict) { $issues += 'UNKNOWN: conflicting registration or alias' }
    if (-not $registration.Owner -or $registration.Owner -eq 'UNKNOWN') { $issues += 'UNKNOWN: accountable owner missing' }
    if (-not $registration.Task -or $registration.Task -eq 'UNKNOWN') { $issues += 'UNKNOWN: active task missing' }
    if (-not $registration.Checkpoint -or -not (Test-Path -LiteralPath $registration.Checkpoint)) { $issues += 'UNKNOWN: checkpoint missing' }
    $checkpointAge = $null
    try {
        $checkpointDate = [DateTime]::ParseExact($registration.CheckpointDate, 'yyyy-MM-dd', $null)
        $checkpointAge = ((Get-Date) - $checkpointDate).Days
    } catch { $issues += 'UNKNOWN: checkpoint date missing' }
    if ($null -ne $checkpointAge -and $checkpointAge -gt 7) { $issues += "STALE: checkpoint $checkpointAge days old" }
    if ($issues.Count -gt 0) { $deliveryActions += "**${projName}**: $($issues -join '; ')" }

    $lastCommit = "N/A"
    $daysSince = "N/A"
    $identity = if ($registration.Conflict) { @{ Ok = $false; Reason = 'UNKNOWN: conflicting registration or alias' } }
        else { Get-RepositoryIdentity $projPath }
    $delivery = if ($identity.Ok) { Get-DeliveryState $projPath $registration.Mode }
        else { @{ Label = $identity.Reason; Action = 'correct the registered checkout before using its Git activity' } }
    $blockers = $delivery.Label
    if ($delivery.Action) { $deliveryActions += "**${projName}**: $($delivery.Action)" }

    if ($identity.Ok) {
        Push-Location $projPath
        $lastLog = git log -1 --format="%ci" 2>$null
        if ($lastLog) {
            $lastDate = [DateTime]::Parse($lastLog.Substring(0, 10))
            $daysSince = ((Get-Date) - $lastDate).Days
            $lastCommit = $lastLog.Substring(0, 10)
        }
        Pop-Location

        # Check tracking file staleness
        foreach ($tf in @("CURRENT_SPRINT.md", "errors-fixed.json", "golden-paths.md")) {
            $tfPath = "$projPath\$tf"
            if (Test-Path $tfPath) {
                $tfDays = ((Get-Date) - (Get-Item $tfPath).LastWriteTime).Days
                if ($tfDays -gt 7) {
                    $staleFiles += [PSCustomObject]@{
                        File = $tf
                        Project = $projName
                        LastModified = (Get-Item $tfPath).LastWriteTime.ToString("yyyy-MM-dd")
                        DaysStale = $tfDays
                    }
                }
            }
        }
    }

    # Check for forgotten DISCUSSED ideas
    if ($status -match "DISCUSSED") {
        if ($briefContent -match "\((\d{4}-\d{2}-\d{2})\)") {
            $discussedDate = [DateTime]::Parse($Matches[1])
            $daysSinceDiscussed = ((Get-Date) - $discussedDate).Days
            if ($daysSinceDiscussed -gt 7) {
                $forgottenIdeas += "- **$projName**: discussed on $($Matches[1]), $daysSinceDiscussed days ago"
            }
        }
    }

    $projectRows += "| $(Format-ReportCell $projName) | $(Format-ReportCell $registration.Owner) | $(Format-ReportCell $registration.Task) | $(Format-ReportCell $registration.Checkpoint) | $(Format-ReportCell $registration.Mode) | $(Format-ReportCell $status) | $lastCommit | $daysSince | $blockers |"
}

# Count learning metrics -- lessons.md was split into lessons-critical.md + reference/lessons-archive.md;
# count UNIQUE lesson numbers across both (critical re-lists archive entries by number -> dedupe).
$lessonNums = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($lp in @("$FactoryRoot\docs\rules-reference\factory\lessons-critical.md", "$FactoryRoot\docs\rules-reference\factory\reference\lessons-archive.md")) {
    if (Test-Path $lp) {
        foreach ($mm in (Select-String -Path $lp -Pattern '^(\d+)\.')) { [void]$lessonNums.Add($mm.Matches[0].Groups[1].Value) }
    }
}
$totalLessons = $lessonNums.Count

# Approvals-queue summary (shared parser -- same source of truth as /dashboard)
$approvalsLine = $null
if (Get-Command node -ErrorAction SilentlyContinue) {
    $approvalsLine = (& node (Join-Path $PSScriptRoot "lib\pending-summary.mjs") (Join-Path $FactoryRoot "PENDING_APPROVALS.md") 2>$null)
}
if (-not $approvalsLine) { $approvalsLine = "Approvals: (node unavailable -- run node scripts/lib/pending-summary.mjs)" }

$totalErrors = 0
$totalPaths = 0

# Scan factory project dirs for learning files
Get-ChildItem -Path $ProjectsDir -Recurse -Filter "errors-fixed.json" | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    if ($content -and $content.Trim() -ne "[]") {
        $parsed = $content | ConvertFrom-Json
        if ($parsed) { $totalErrors += $parsed.Count }
    }
}

# Scan active project directories
$projectDir = Join-Path $env:USERPROFILE "Projects"
if (Test-Path $projectDir) {
    Get-ChildItem -Path $projectDir -Directory | ForEach-Object {
        $efPath = "$($_.FullName)\errors-fixed.json"
        if (Test-Path $efPath) {
            $content = Get-Content $efPath -Raw
            if ($content -and $content.Trim() -ne "[]") {
                $parsed = $content | ConvertFrom-Json
                if ($parsed) { $totalErrors += $parsed.Count }
            }
        }
    }
}

# Generate suggestions
$suggestions = @($deliveryActions)
if ($forgottenIdeas.Count -gt 0) {
    $suggestions += "Review forgotten ideas below -- decide: build, park, or delete"
}
if ($staleFiles.Count -gt 0) {
    $suggestions += "Update stale tracking files (see table below)"
}
if ($totalErrors -eq 0) {
    $suggestions += "No errors logged anywhere -- are bugs being tracked? Check errors-fixed.json discipline"
}

# Build stale files section
$staleSection = "All tracking files are current."
if ($staleFiles.Count -gt 0) {
    $staleRows = $staleFiles | ForEach-Object { "| $($_.File) | $($_.Project) | $($_.LastModified) | $($_.DaysStale) |" }
    $staleSection = "| File | Project | Last Modified | Days Stale |`n|------|---------|---------------|-----------|`n$($staleRows -join "`n")"
}

# Build suggestions section
$suggestSection = "No local Git or tracking alerts detected. Deployment and live acceptance were not checked."
if ($suggestions.Count -gt 0) {
    $i = 1
    $suggestSection = ($suggestions | ForEach-Object { "$i. $_"; $i++ }) -join "`n"
}

# Build forgotten ideas section
$forgottenSection = "None -- all ideas are being actioned."
if ($forgottenIdeas.Count -gt 0) {
    $forgottenSection = $forgottenIdeas -join "`n"
}

# Write report
$report = @"
# VibePromptRig Status Report — $Today
Generated automatically at $(Get-Date -Format "HH:mm"). Review and act on suggestions.

**$approvalsLine** (see PENDING_APPROVALS.md)

## Project Health
Git counts compare with the locally recorded upstream; remote freshness is unchecked because no server check or fetch is performed. Status is declared in BRIEF.md. Deployment and live acceptance were not checked. Only registered project checkouts are scanned, not every worktree.

| Project | Owner | Active Task | Checkpoint | Delivery Mode | Declared Status | Last Commit | Days Since Activity | Local Git Delivery State |
|---------|-------|-------------|------------|---------------|-----------------|-------------|--------------------:|--------------------------|
$($projectRows -join "`n")

## Forgotten Ideas (DISCUSSED > 7 days)
$forgottenSection

## Stale Tracking Files
$staleSection

## Learning Velocity
- Total lessons (lessons-critical.md + reference/lessons-archive.md, unique): $totalLessons
- errors-fixed.json entries across all projects: $totalErrors

## Suggested Actions
$suggestSection
"@

$report | Set-Content -Path $OutputPath -Force
Write-Host "Status report generated: $OutputPath"
