<#
.SYNOPSIS
    Outcome tracker -- reads git log across factory + project dirs, finds commits
    tagged with [rule: RULE-ID] in the commit body, aggregates per-rule counts,
    and writes both a JSONL stream (for MCPs) and a human Markdown report.

.PARAMETER Since
    Git --since argument (default: "30 days ago"). Examples: "60 days ago", "2026-01-01".

.PARAMETER WriteReport
    Generate docs/factory-effectiveness.md (default: yes).

.PARAMETER OutputJson
    Print the aggregated counts as JSON to stdout (for MCP consumption).

.NOTES
    PowerShell 5.1 compatible. ASCII only. Read-only on git.

    Commit-tag conventions (recognized in commit body):
      [rule: VIBE-35]        -- a specific factory rule that this commit upholds/fixes
      [rule: vibe-standard]  -- a rule file name
      [outcome: PREVENTED]   -- this commit fixed a bug class the rule prevents (catch)
      [outcome: MISSED]      -- this commit fixed a bug the rule should have caught (miss)

    Effectiveness = catches / (catches + misses)
#>

[CmdletBinding()]
param(
    [string]$Since = "30 days ago",
    [switch]$WriteReport,
    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
$FactoryRoot = if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }
$MetricsPath = Join-Path $FactoryRoot "factory_metrics.jsonl"
$ReportPath  = Join-Path $FactoryRoot "docs\factory-effectiveness.md"

# Find every git repo to scan: factory root, projects/, and configured external roots
$repos = [System.Collections.Generic.List[string]]::new()
if (Test-Path (Join-Path $FactoryRoot ".git")) { $repos.Add($FactoryRoot) }

$projectsDir = Join-Path $FactoryRoot "projects"
if (Test-Path $projectsDir) {
    Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-Path (Join-Path $_.FullName ".git")) { $repos.Add($_.FullName) }
    }
}

# Optional configured external projects; the package contains no operator paths.
$configPath = Join-Path $FactoryRoot '.forge\agent-configs\synthesizer.json'
if (Test-Path -LiteralPath $configPath) {
    $configured = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($p in @($configured.config.projects)) {
        if ($p -is [string] -and [IO.Path]::IsPathRooted($p) -and (Test-Path -LiteralPath (Join-Path $p '.git'))) {
            if (-not $repos.Contains($p)) { $repos.Add($p) }
        }
    }
}

# Aggregations
$ruleCounts = @{}      # rule_id -> @{ total=N; catches=N; misses=N; commits=@()}
$commitCount = 0
$taggedCount = 0

foreach ($repo in $repos) {
    # Pull commits in window. Separator-based parsing (PowerShell-safe; no %x1f hex tricks).
    $sep    = "===COMMIT-VIBEPROMPTRIG==="
    $endSep = "===END-VIBEPROMPTRIG==="
    $fmt = "$sep%n%H%n%ad%n%s%n%b%n$endSep"
    $log = & git -C $repo log --since="$Since" --pretty=format:"$fmt" --date=short 2>$null
    if (-not $log) { continue }
    $logText = if ($log -is [array]) { $log -join "`n" } else { [string]$log }
    # Split into commit blocks
    $blocks = [regex]::Split($logText, [regex]::Escape($sep))
    foreach ($block in $blocks) {
        if (-not $block.Trim()) { continue }
        # Strip trailing $endSep
        $clean = ($block -replace [regex]::Escape($endSep), '').Trim("`r","`n"," ")
        if (-not $clean) { continue }
        $lines = $clean -split "`r?`n"
        if ($lines.Count -lt 3) { continue }
        $sha  = $lines[0].Trim()
        $date = if ($lines.Count -gt 1) { $lines[1].Trim() } else { "" }
        $subj = if ($lines.Count -gt 2) { $lines[2].Trim() } else { "" }
        $body = if ($lines.Count -gt 3) { ($lines[3..($lines.Count-1)] -join "`n").Trim() } else { "" }
        if ($sha.Length -lt 7) { continue }
        $commitCount++

        $tagMatches = [regex]::Matches($body, '(?i)\[rule:\s*([a-z0-9\-_]+(?:[:\.][a-z0-9\-_]+)?)\]')
        if ($tagMatches.Count -eq 0) { continue }
        $taggedCount++

        $outcome = "PREVENTED"
        if ($body -match '(?i)\[outcome:\s*MISSED\]')    { $outcome = "MISSED" }
        elseif ($body -match '(?i)\[outcome:\s*PREVENTED\]') { $outcome = "PREVENTED" }

        foreach ($m in $tagMatches) {
            $ruleId = $m.Groups[1].Value.ToLower()
            if (-not $ruleCounts.ContainsKey($ruleId)) {
                $ruleCounts[$ruleId] = @{
                    total   = 0
                    catches = 0
                    misses  = 0
                    commits = [System.Collections.Generic.List[object]]::new()
                }
            }
            $bucket = $ruleCounts[$ruleId]
            $bucket.total++
            if ($outcome -eq "MISSED") { $bucket.misses++ } else { $bucket.catches++ }
            $bucket.commits.Add(@{ sha=$sha.Substring(0,7); date=$date; repo=(Split-Path -Leaf $repo); subject=$subj })
        }
    }
}

# Compute effectiveness
$rulesData = [System.Collections.Generic.List[object]]::new()
foreach ($k in $ruleCounts.Keys | Sort-Object) {
    $b = $ruleCounts[$k]
    $denom = $b.catches + $b.misses
    $eff = if ($denom -eq 0) { 0.0 } else { [Math]::Round($b.catches / $denom, 3) }
    $rulesData.Add([PSCustomObject]@{
        rule          = $k
        invocations   = $b.total
        catches       = $b.catches
        misses        = $b.misses
        effectiveness = $eff
        commits       = $b.commits
    })
}

# JSON output mode
if ($OutputJson) {
    @{
        ts             = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        since          = $Since
        repos_scanned  = $repos.Count
        commits_total  = $commitCount
        commits_tagged = $taggedCount
        rules          = $rulesData
    } | ConvertTo-Json -Depth 6 -Compress
    exit 0
}

# Always append a summary entry to factory_metrics.jsonl
$summary = [ordered]@{
    ts             = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    event          = "outcome_scan"
    since          = $Since
    repos_scanned  = $repos.Count
    commits_total  = $commitCount
    commits_tagged = $taggedCount
    rules_with_data = $rulesData.Count
    top_rules = (@($rulesData | Sort-Object -Property invocations -Descending | Select-Object -First 5) |
                 ForEach-Object { @{ rule=$_.rule; invocations=$_.invocations; effectiveness=$_.effectiveness } })
}
try {
    Add-Content -Path $MetricsPath -Value ($summary | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8
} catch { }

# Console summary
Write-Host ""
Write-Host "==== Outcome scan (since $Since) ===="
Write-Host ("  Repos scanned : {0}" -f $repos.Count)
Write-Host ("  Commits seen  : {0}" -f $commitCount)
Write-Host ("  Tagged commits: {0}" -f $taggedCount)
Write-Host ("  Rules w/ data : {0}" -f $rulesData.Count)
if ($rulesData.Count -gt 0) {
    Write-Host ""
    Write-Host "  Top rules:"
    foreach ($r in ($rulesData | Sort-Object -Property invocations -Descending | Select-Object -First 10)) {
        Write-Host ("    {0,-30}  invocations={1,3}  effectiveness={2}" -f $r.rule, $r.invocations, $r.effectiveness)
    }
}

if (-not $WriteReport) {
    Write-Host ""
    Write-Host "(report not generated; pass -WriteReport to emit docs/factory-effectiveness.md)"
    exit 0
}

# ---- Generate report ----
$reportDir = Split-Path -Parent $ReportPath
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }

$now = Get-Date -Format "yyyy-MM-dd"
$report = @"
# Factory effectiveness report

> _Generated: $now from git log across $($repos.Count) repos, window: $Since._
> _Source: scripts/extract-rule-outcomes.ps1._

## Coverage

- Repos scanned: $($repos.Count)
- Commits in window: $commitCount
- Commits tagged with [rule: X]: $taggedCount
- Tag coverage: $(if ($commitCount -gt 0) { [Math]::Round(($taggedCount/$commitCount)*100,1) } else { 0 })%

## Per-rule outcomes

| Rule | Invocations | Catches | Misses | Effectiveness |
|---|---:|---:|---:|---:|
"@

foreach ($r in ($rulesData | Sort-Object -Property invocations -Descending)) {
    $report += "`n| ``$($r.rule)`` | $($r.invocations) | $($r.catches) | $($r.misses) | $($r.effectiveness) |"
}

if ($rulesData.Count -eq 0) {
    $report += "`n| _(no tagged commits in window)_ |  |  |  |  |"
}

$report += @"


## How to tag commits

Add to the commit body (not the subject):

``````
fix(api): handle null tenant on lookup

[rule: VIBE-35]
[outcome: PREVENTED]
``````

- ``[rule: VIBE-35]`` -- the rule that prevented worse / drove this fix
- ``[outcome: PREVENTED]`` -- the rule caught this class of bug at design time (default)
- ``[outcome: MISSED]`` -- the rule SHOULD have caught it but didn't -- candidate for strengthening
- Multiple rules allowed: ``[rule: VIBE-2] [rule: VIBE-44]``

## Caveats

- A low effectiveness score indicates the rule is being invoked but not catching the bug -- candidate for strengthening
- A high invocation count + high effectiveness = the rule is earning its token cost
- A rule with zero invocations may be untriggered (not necessarily ineffective) -- review at next quarterly rule-decay scan
- This report is descriptive, not prescriptive -- it doesn't propose rule changes (that's the synthesizer's job)
"@

Set-Content -Path $ReportPath -Value $report -Encoding UTF8
Write-Host ""
Write-Host "[OK] Wrote $ReportPath"
exit 0
