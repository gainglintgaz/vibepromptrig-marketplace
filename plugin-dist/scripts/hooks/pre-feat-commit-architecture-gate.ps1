<#
.SYNOPSIS
    Pre-commit hook enforcing architect-first.md SS9.

    Blocks commits whose first line starts with feat( or feature( UNLESS:
    1. The commit body contains [no-arch: <reason>] with a non-trivial reason, OR
    2. An ARCHITECTURE.md (or any file under docs/architecture/) was committed
       within the last 14 days affecting any directory this commit touches.

    Soft gate by design: override is allowed but logged to factory_metrics.jsonl
    so abuse can be audited. Per architect-first.md SS9 -- a hard gate would
    block legitimate small-scope work; soft-with-logging surfaces abuse without
    stopping productive work.

.NOTES
    PowerShell 5.1 compatible. ASCII only.
    Invoked as a git pre-commit hook via .git/hooks/pre-commit, OR as a Claude
    Code PreToolUse hook on Bash matching "git commit*".

    Override marker: include this line in the commit body
        [no-arch: <reason explaining why>]
    Logging: each invocation appends one event to factory_metrics.jsonl.
#>

[CmdletBinding()]
param(
    [string]$CommitMsgPath,
    [string]$RepoRoot
)
$ErrorActionPreference = "SilentlyContinue"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

# Resolve repo root if not given
if (-not $RepoRoot) {
    $RepoRoot = (& git rev-parse --show-toplevel 2>$null)
    if (-not $RepoRoot) {
        # Not in a repo -- nothing to enforce
        exit 0
    }
    $RepoRoot = $RepoRoot.Trim()
}

# Resolve commit-msg path (git pre-commit hook gets it as arg, or .git/COMMIT_EDITMSG)
if (-not $CommitMsgPath) {
    $candidate = Join-Path $RepoRoot ".git\COMMIT_EDITMSG"
    if (Test-Path $candidate) { $CommitMsgPath = $candidate } else { exit 0 }
}

if (-not (Test-Path $CommitMsgPath)) { exit 0 }
$msg = Get-Content -Path $CommitMsgPath -Raw -Encoding UTF8
if (-not $msg -or -not $msg.Trim()) { exit 0 }

$lines = $msg -split "`r?`n"
$subject = if ($lines.Count -gt 0) { $lines[0] } else { "" }

# Only fires on feat(... or feature(...
$firesPattern = '^(feat|feature)\s*\('
if ($subject -notmatch $firesPattern) { exit 0 }

# Check override marker -- UNION of three accepted patterns per
# 2026-05-18 reconciliation: Senior Council doctrine + architect-probe
# implementation + Bridge Brief artifact. All three forms log identically
# to factory_metrics.jsonl with event=arch_gate_override.
$override = $false
$overrideReason = $null
$overrideMarker = $null
foreach ($line in $lines) {
    if ($line -match '^\s*\[(no-arch|discovery-skipped|bridge-skipped):\s*(.+?)\s*\]\s*$') {
        $override = $true
        $overrideMarker = $matches[1]
        $overrideReason = $matches[2]
        break
    }
}

# Get list of files this commit touches
$stagedFiles = & git diff --cached --name-only 2>$null
if (-not $stagedFiles) { $stagedFiles = @() }

# Affected top-level dirs
$affectedDirs = @{}
foreach ($f in $stagedFiles) {
    if (-not $f) { continue }
    # Skip files in docs/architecture/ (the artifact itself doesn't gate itself)
    if ($f -match '(^|/)docs/architecture/') { continue }
    $top = ($f -split '/')[0]
    if ($top) { $affectedDirs[$top] = $true }
}

# Find ARCHITECTURE.md or docs/architecture/*.md committed in last 14 days
$archMissing = $false
$archEvidence = @()
if (-not $override) {
    $since = (Get-Date).AddDays(-14).ToString("yyyy-MM-dd")
    $archLog = & git log --since="$since" --pretty=format:"%H|%ad" --date=short --name-only --diff-filter=AM -- 'docs/architecture/' 'ARCHITECTURE.md' '**/ARCHITECTURE.md' '**/docs/architecture/' 2>$null

    $foundArtifact = $false
    if ($archLog) {
        foreach ($line in $archLog) {
            if (-not $line) { continue }
            # Lines without | are file paths from previous commit
            if ($line -notmatch '\|') {
                if ($line -match '(?i)(^|/)(docs/architecture/.+\.md|ARCHITECTURE\.md)$') {
                    $foundArtifact = $true
                    $archEvidence += $line
                }
            }
        }
    }

    if (-not $foundArtifact) {
        $archMissing = $true
    }
}

# Log the event
$metricsPath = Join-Path $RepoRoot "factory_metrics.jsonl"
if (-not (Test-Path $metricsPath)) {
    # Try factory root if not in current repo
    $factoryMetrics = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "factory_metrics.jsonl"
    if (Test-Path (Split-Path -Parent $factoryMetrics)) {
        $metricsPath = $factoryMetrics
    }
}

$eventName = if ($override) { "arch_gate_override" } else { "arch_gate" }
$logEntry = [ordered]@{
    ts              = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    event           = $eventName
    repo            = (Split-Path -Leaf $RepoRoot)
    subject         = ($subject -replace '"', "'").Substring(0, [Math]::Min(120, $subject.Length))
    override_used   = $override
    override_marker = $overrideMarker
    override_reason = $overrideReason
    arch_missing    = $archMissing
    affected_dirs   = ($affectedDirs.Keys -join ",")
    artifact_evidence_count = $archEvidence.Count
    blocked         = ($archMissing -and -not $override)
}
try {
    $line = $logEntry | ConvertTo-Json -Compress -Depth 5
    Add-Content -Path $metricsPath -Value $line -Encoding UTF8
} catch { }

# Decide
if ($archMissing -and -not $override) {
    [Console]::Error.WriteLine("[BLOCKED] feat() commit without an ARCHITECTURE.md artifact within the last 14 days.")
    [Console]::Error.WriteLine("          Per architect-first.md SS9 -- every feat( commit must follow a probing pass.")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("  Commit subject: $subject")
    [Console]::Error.WriteLine("  Affected dirs:  $($affectedDirs.Keys -join ', ')")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("  To proceed, either:")
    [Console]::Error.WriteLine("    1. Run /architect-probe and produce docs/architecture/<feature>.md, OR")
    [Console]::Error.WriteLine("    2. Add this line to your commit body:")
    [Console]::Error.WriteLine("       [no-arch: <reason>]   OR   [discovery-skipped: <reason>]   OR   [bridge-skipped: <reason>]")
    [Console]::Error.WriteLine("       example: [no-arch: small extension of existing feature X with same architecture]")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("  See: docs/rules-reference/factory/architect-first.md (factory) + .claude/skills/architect-probe/SKILL.md")
    exit 1
}

if ($override) {
    Write-Host "[arch-gate] feat() commit overridden via [${overrideMarker}: $overrideReason] -- logged to factory_metrics.jsonl"
}

exit 0
