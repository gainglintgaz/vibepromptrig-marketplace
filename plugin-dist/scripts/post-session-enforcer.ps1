<#
.SYNOPSIS
    Post-session learning loop enforcer. Fired by Claude Code Stop hook.
    Generates SESSION_DEBRIEF.md and outputs learning prompts to stdout.
#>

$ErrorActionPreference = "SilentlyContinue"

# UTF-8 end-to-end (VRA friction #7/#8: '#' section signs in commit subjects
# rendered as mojibake because git's UTF-8 stdout was decoded with the ANSI
# codepage and files were written back with the ANSI codepage).
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8NoBom } catch { }

# --- Double-fire guard (Desktop audit 2026-06-13) -----------------------------
# In a FACTORY session the repo's .claude/settings.json wires this hook AND the
# globally-enabled vibepromptrig plugin wires the same hook -- so it fires twice.
# When THIS copy is the plugin DISTRIBUTION copy (under plugin-dist/ or the
# plugins cache) and the session is running in the factory itself, defer to the
# repo-local copy so the work happens exactly once. Customer sessions are
# unaffected: their cwd is not the factory, so the plugin copy proceeds normally.
if (($PSScriptRoot -match '[\\/]plugin-dist([\\/]|$)') -or ($PSScriptRoot -match '[\\/]plugins[\\/]cache[\\/]')) {
    $vfCwd = (Get-Location).Path
    if ((Test-Path (Join-Path $vfCwd '.claude-plugin\plugin.json')) -and (Test-Path (Join-Path $vfCwd 'plugin-dist'))) {
        exit 0
    }
}

$cwd = Get-Location
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"

# Check if we're in a git repo
$isGit = git rev-parse --is-inside-work-tree 2>$null
if ($isGit -ne "true") {
    Write-Output "SESSION DEBRIEF: Not a git repository. No debrief generated."
    exit 0
}

# Get recent commits (last 2 hours)
$since = (Get-Date).AddHours(-2).ToString("yyyy-MM-ddTHH:mm:ss")
$recentCommits = git log --oneline --since="$since" 2>$null
$commitCount = if ($recentCommits) { ($recentCommits | Measure-Object).Count } else { 0 }

# Get changed files
$diffStat = git diff --stat HEAD~$([Math]::Max($commitCount, 1))..HEAD 2>$null
if (-not $diffStat) {
    $diffStat = "No changes detected"
}

# Check tracking file staleness
$trackingFiles = @("CURRENT_SPRINT.md", "V1_FEATURE_BACKLOG.md", "errors-fixed.json", "golden-paths.md")
$staleFiles = @()
foreach ($file in $trackingFiles) {
    $filePath = Join-Path $cwd $file
    if (Test-Path $filePath) {
        $lastWrite = (Get-Item $filePath).LastWriteTime
        $daysSince = ((Get-Date) - $lastWrite).Days
        if ($daysSince -gt 3) {
            $staleFiles += "  - $file (last updated $daysSince days ago)"
        }
    }
}

# Generate SESSION_DEBRIEF.md
$commitList = if ($recentCommits) { $recentCommits -join "`n" } else { "No commits this session" }
$diffList = if ($diffStat -is [array]) { $diffStat -join "`n" } else { $diffStat }
$staleSection = if ($staleFiles.Count -gt 0) {
    "STALE files (not updated in 3+ days):`n$($staleFiles -join "`n")"
} else {
    "All tracking files are current."
}

$debrief = @"
# Session Debrief — $timestamp

## Commits This Session ($commitCount)
$commitList

## Files Changed
$diffList

## Tracking File Status
$staleSection

## Action Items
- [ ] Review commits above — any bugs fixed? Add to errors-fixed.json
- [ ] Any new patterns? Add to golden-paths.md
- [ ] Update CURRENT_SPRINT.md with task statuses
- [ ] Any lessons learned? Suggest additions to lessons.md
"@

$debriefPath = Join-Path $cwd "SESSION_DEBRIEF.md"
[System.IO.File]::WriteAllText($debriefPath, $debrief, $utf8NoBom)

# Auto-changelog: append session commits to CHANGELOG.md.
# Fixed 2026-06-12 (VRA friction #7 + #8):
#   - dedup by SHORT SHA: every line carries "(<sha>)" and a commit already
#     present is never re-appended -> running this hook N times is a no-op
#     after the first run (the old code re-appended the whole window on
#     every Stop event: scaffold line appeared 3x)
#   - housekeeping commits (changelog/version/debrief-only) are never logged,
#     so committing the changelog itself does not re-dirty the tree on the
#     next Stop -- "clean committed changelog + clean tree" now converges,
#     and pre-including the commit's own subject (the old PS workaround) is
#     unnecessary
#   - UTF-8 no-BOM read/write (mojibake fix; see console encoding above)
$changelogPath = Join-Path $cwd "CHANGELOG.md"
$newEntries = @()
if ($commitCount -gt 0) {
    $autoArtifacts = @('CHANGELOG.md', 'VERSION.md', 'SESSION_DEBRIEF.md')
    $rawLog = git log --since="$since" --pretty=format:"%h%x09%s" 2>$null
    foreach ($line in @($rawLog)) {
        if (-not $line) { continue }
        $parts = ([string]$line) -split "`t", 2
        if ($parts.Count -lt 2) { continue }
        $sha = $parts[0].Trim()
        $subject = $parts[1].Trim()
        if (-not $sha -or -not $subject) { continue }
        # Housekeeping by subject (Desktop audit #4: + dist|metrics -- the dist
        # rebuild + metrics-persist commits are auto-artifact churn; logging them
        # re-dirtied the tree on the next Stop, so "commit + clean tree" never converged).
        if ($subject -match '^chore\((changelog|version|session|debrief|dist|metrics)\)') { continue }
        # Housekeeping by content: touches ONLY auto-generated artifacts
        $touched = @(git show --name-only --pretty=format: $sha 2>$null | Where-Object { $_ })
        if ($touched.Count -gt 0) {
            $nonAuto = @($touched | Where-Object { $autoArtifacts -notcontains $_ })
            if ($nonAuto.Count -eq 0) { continue }
        }
        $newEntries += [PSCustomObject]@{ sha = $sha; subject = $subject }
    }

    $existing = ""
    if (Test-Path $changelogPath) {
        $existing = [System.IO.File]::ReadAllText($changelogPath, [System.Text.Encoding]::UTF8)
    }

    # Dedup by SHA -- the "(<sha>)" suffix is the idempotency key
    $newEntries = @($newEntries | Where-Object { $existing.IndexOf("($($_.sha))") -lt 0 })

    if ($newEntries.Count -gt 0) {
        $dateHeader = Get-Date -Format "yyyy-MM-dd"
        $newLines = (($newEntries | ForEach-Object { "- $($_.subject) ($($_.sha))" }) -join "`n") + "`n"

        $headerMatch = [regex]::Match($existing, "(?m)^## " + [regex]::Escape($dateHeader) + "[ \t]*\r?$")
        if ($headerMatch.Success) {
            # Insert directly under today's existing header (string surgery --
            # no regex replacement, so '$' in commit subjects is safe)
            $insertAt = $existing.IndexOf("`n", $headerMatch.Index)
            $insertAt = if ($insertAt -lt 0) { $existing.Length } else { $insertAt + 1 }
            $existing = $existing.Substring(0, $insertAt) + $newLines + $existing.Substring($insertAt)
        } else {
            $block = "## $dateHeader`n$newLines`n"
            if (-not $existing) {
                $existing = "# Changelog`n`n$block"
            } else {
                # Insert the new date block right AFTER the file's H1 title (any
                # "# ..." at the very start of the file, + its trailing blank).
                # Desktop audit #4: the old '^# Changelog' (no (?m)) only matched at
                # position 0, so once the title was buried the branch went dead and
                # every block was prepended ABOVE the title -- burying it further.
                # \A anchors to start-of-string and matches the title regardless of
                # its exact text; falls back to prepending a title if none exists.
                $titleMatch = [regex]::Match($existing, '\A# [^\r\n]+\r?\n(\r?\n)?')
                if ($titleMatch.Success) {
                    $existing = $existing.Substring(0, $titleMatch.Length) + $block + $existing.Substring($titleMatch.Length)
                } else {
                    $existing = "# Changelog`n`n" + $block + $existing
                }
            }
        }
        [System.IO.File]::WriteAllText($changelogPath, $existing, $utf8NoBom)
    }
}

# Version bump: bump ONLY the canonical "**Current version:** X.Y.Z" line.
# Fixed 2026-06-13 (Desktop audit #3): target the dedicated canonical line, never
# "the first semver anywhere" -- the old enforcer's '-replace \d+\.\d+\.\d+'
# rewrote EVERY x.y.z in the file (renumbering the changelog history 5.0.71 ->
# 5.0.118), and even the first-occurrence variant clobbered prose. If the canonical
# line is absent, do nothing (no prose fallback). Patch-only, in place.
$versionPath = Join-Path $cwd "VERSION.md"
if ((Test-Path $versionPath) -and $newEntries.Count -gt 0) {
    $vContent = [System.IO.File]::ReadAllText($versionPath, [System.Text.Encoding]::UTF8)
    $cv = [regex]::Match($vContent, '(?m)^(\*\*Current version:\*\*\s+)(\d+)\.(\d+)\.(\d+)')
    if ($cv.Success) {
        $minor = $cv.Groups[3].Value
        $patch = [int]$cv.Groups[4].Value + 1
        $newVersion = "$($cv.Groups[2].Value).$minor.$patch"
        $semStart = $cv.Index + $cv.Groups[1].Length
        $semLen   = $cv.Length - $cv.Groups[1].Length
        $vContent = $vContent.Substring(0, $semStart) + $newVersion + $vContent.Substring($semStart + $semLen)
        [System.IO.File]::WriteAllText($versionPath, $vContent, $utf8NoBom)
    }
}

# Output to stdout (Claude sees this as hook context)
Write-Output ""
Write-Output "=== SESSION DEBRIEF ==="
Write-Output "Generated: $debriefPath"
Write-Output "Commits this session: $commitCount"
if ($staleFiles.Count -gt 0) {
    Write-Output ""
    Write-Output "WARNING: Stale tracking files detected:"
    $staleFiles | ForEach-Object { Write-Output $_ }
}
Write-Output ""
Write-Output "LEARNING LOOP: Review SESSION_DEBRIEF.md and suggest updates to:"
Write-Output "  - errors-fixed.json (if bugs were found/fixed this session)"
Write-Output "  - golden-paths.md (if new patterns emerged)"
Write-Output "  - lessons.md (if lessons were learned)"
Write-Output "  - CURRENT_SPRINT.md (update feature statuses)"
Write-Output ""
Write-Output "SELF-REFLECTION (MANDATORY -- see docs/rules-reference/factory/self-reflection.md):"
Write-Output "  Run the 7-question Self-Audit Checklist NOW:"
Write-Output "  1. Did I follow a rule that produced a bad outcome?"
Write-Output "  2. Did I skip a rule that would have caught a problem?"
Write-Output "  3. Did I ask a question but not enforce the answer?"
Write-Output "  4. Did another session miss something my rules should have caught?"
Write-Output "  5. Did I build something a future session will struggle to understand?"
Write-Output "  6. Did I use a reusable pattern not yet in golden-paths.md?"
Write-Output "  7. Did any rule feel outdated or contradicted by this session?"
Write-Output ""
Write-Output "  If ANY answer is YES -> draft rule update for the project owner to approve."
Write-Output "  If ALL answers are NO -> state that explicitly so the project owner knows the audit ran."
Write-Output ""
Write-Output "Do NOT auto-commit changes. Present suggestions for the project owner to approve."
Write-Output "=== END DEBRIEF ==="
