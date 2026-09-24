<#
.SYNOPSIS
    Verify cross-reference integrity across .claude/rules/*.md (and nested).

.DESCRIPTION
    Detects every cross-file section reference between rule files, resolves
    each against the actual file's section anchors, and fails on any broken
    reference.

    Patterns detected:
      - <name>.md SECTION N[.M]       (e.g., data-protection.md SS5 or SS 5.1)
      - SECTION N[.M] (in|of|from) <name>.md
      - frontmatter see-also: lists with rule-file paths
    Where SECTION = U+00A7 (section sign) OR ASCII "SS" workaround per
    factory CLAUDE.md SS10 (ASCII-only rule).

    Section header anchors detected:
      ^##+ SECTION N[.M] ...
      ^##+ N. ...   (legacy numeric header)

    Companion to scripts/verify-factory.ps1. Will be integrated as a new
    "rule-reference-integrity" check during the v4.4.5 token-burn fix sprint
    Commit 2.

.PARAMETER FactoryRoot
.PARAMETER Json
.PARAMETER Quiet

.EXAMPLE
    .\scripts\verify-rule-reference-integrity.ps1
    .\scripts\verify-rule-reference-integrity.ps1 -Json

.NOTES
    PowerShell 5.1 compatible. ASCII source. Reads files as UTF-8 so the
    U+00A7 section mark survives.
#>

[CmdletBinding()]
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json,
    [switch]$Quiet
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path $PSScriptRoot -Parent }

$ErrorActionPreference = "Stop"

try {
    $u = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $u
    [Console]::OutputEncoding = $u
} catch { }

# Files referenced from rules that exist outside the rule corpus -- skip.
$nonRule = @(
    "claude.md", "readme.md", "agents.md", "gemini.md", "version.md",
    "next_session.md", "current_sprint.md", "pending_approvals.md",
    "decisions.md", "status_report.md", "state.md", "changelog.md",
    "session_debrief.md", "daily_digest.md", "weekly_insights.md",
    "architecture.md", "data-flow.md",
    "design-capability-spec.md", "visual-qa-checklist.md",
    "enforcement-first-spec.md", "legal-ai-review.md", "rule-enforcement-coverage.md"
)

# Every legacy rule body lives in the relocated reference corpus (Context V2 Delivery 3b).
$rulesDir = Join-Path $FactoryRoot "docs\rules-reference\factory"
if (-not (Test-Path $rulesDir)) {
    Write-Error "Rules directory not found: $rulesDir"
    exit 2
}

$ruleFiles = @(Get-ChildItem -Path $rulesDir -Filter "*.md" -File -Recurse | Sort-Object FullName)
if ($ruleFiles.Count -eq 0) {
    Write-Error "No rule files found in $rulesDir"
    exit 2
}

# ----- Pass 1: build anchor map ----
# anchors[<file.md>] = @{ '1'=$true; '1.1'=$true; '2'=$true; ... }
$sec = [char]0x00A7
$anchors = @{}

foreach ($f in $ruleFiles) {
    $key = $f.Name.ToLower()
    if (-not $anchors.ContainsKey($key)) { $anchors[$key] = @{} }

    $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.UTF8Encoding]::new($false))

    # Header patterns -- multiline
    $headerRx1 = [regex]::new("^##+\s*$sec\s*(\d+(?:\.\d+)?)\b", "Multiline")
    $headerRx2 = [regex]::new("^##+\s*SS\s*(\d+(?:\.\d+)?)\b", "Multiline")
    $headerRx3 = [regex]::new("^##+\s+(\d+(?:\.\d+)?)\.\s+", "Multiline")

    foreach ($mh in $headerRx1.Matches($txt)) { $anchors[$key][$mh.Groups[1].Value] = $true }
    foreach ($mh in $headerRx2.Matches($txt)) { $anchors[$key][$mh.Groups[1].Value] = $true }
    foreach ($mh in $headerRx3.Matches($txt)) { $anchors[$key][$mh.Groups[1].Value] = $true }
}

# ----- Pass 2: collect references ----
$refs = New-Object System.Collections.ArrayList

foreach ($f in $ruleFiles) {
    $selfName = $f.Name.ToLower()
    $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.UTF8Encoding]::new($false))

    # Split frontmatter vs body
    $body = $txt
    $fmText = ""
    $fmLineOffset = 0
    if ($txt -match "^---\r?\n([\s\S]*?)\r?\n---\r?\n") {
        $fmText = $matches[1]
        $bodyStart = $matches[0].Length
        $body = $txt.Substring($bodyStart)
        $fmLineOffset = ([regex]::Matches($matches[0], "`n")).Count
    }

    # ----- frontmatter see-also parsing -----
    if ($fmText) {
        $fmLines = $fmText -split "`r?`n"
        $inSeeAlso = $false
        for ($i = 0; $i -lt $fmLines.Count; $i++) {
            $l = $fmLines[$i]
            if ($l -match '^see-also\s*:\s*$') { $inSeeAlso = $true; continue }
            if ($inSeeAlso -and $l -match '^[a-zA-Z_][a-zA-Z0-9_-]*\s*:') { $inSeeAlso = $false }
            if ($inSeeAlso) {
                $mfm = [regex]::Match($l, '^\s*-\s+(?:[\.\w/-]+/)?([a-z0-9][a-z0-9_-]*\.md)\s*$', "IgnoreCase")
                if ($mfm.Success) {
                    $tgt = $mfm.Groups[1].Value
                    if ($tgt) {
                        $tgt = $tgt.ToLower()
                        $null = $refs.Add([PSCustomObject]@{
                            source      = $f.Name
                            target      = $tgt
                            section     = $null
                            line_number = ($i + 2)  # +1 for ---, +1 for 1-indexed
                            raw         = $l.Trim()
                            kind        = "frontmatter-see-also"
                        })
                    }
                }
            }
        }
    }

    # ----- body reference patterns -----
    # 4 forms: unicode/ascii section mark, before/after filename
    $bodyPatterns = @(
        @("``?([a-z0-9][a-z0-9_-]*\.md)``?\s+$sec\s*(\d+(?:\.\d+)?)", 1, 2, "filename-then-section-unicode"),
        @("``?([a-z0-9][a-z0-9_-]*\.md)``?\s+SS\s*(\d+(?:\.\d+)?)",   1, 2, "filename-then-section-ascii"),
        @("$sec\s*(\d+(?:\.\d+)?)\s+(?:in|of|from)\s+``?([a-z0-9][a-z0-9_-]*\.md)``?", 2, 1, "section-then-filename-unicode"),
        @("SS\s*(\d+(?:\.\d+)?)\s+(?:in|of|from)\s+``?([a-z0-9][a-z0-9_-]*\.md)``?",   2, 1, "section-then-filename-ascii")
    )

    foreach ($bp in $bodyPatterns) {
        $rxStr   = $bp[0]
        $nameG   = $bp[1]
        $secG    = $bp[2]
        $kindStr = $bp[3]
        $rx = [regex]::new($rxStr, "IgnoreCase")

        foreach ($mm in $rx.Matches($body)) {
            $tgtRaw = $mm.Groups[$nameG].Value
            if (-not $tgtRaw) { continue }
            $tgt = $tgtRaw.ToLower()

            if ($tgt -eq $selfName) { continue }
            if ($nonRule -contains $tgt) { continue }

            $secNum = $mm.Groups[$secG].Value
            if (-not $secNum) { $secNum = $null }

            # Line number = lines before match.Index in body + frontmatter line offset
            $prefix = $body.Substring(0, [Math]::Min($mm.Index, $body.Length))
            $lineNum = ([regex]::Matches($prefix, "`n")).Count + 1 + $fmLineOffset

            # Raw line: extract line containing match in body
            $bodyLines = $body -split "`r?`n"
            $bodyLineIdx = $lineNum - $fmLineOffset - 1
            $rawLine = ""
            if ($bodyLineIdx -ge 0 -and $bodyLineIdx -lt $bodyLines.Count) {
                $rawLine = $bodyLines[$bodyLineIdx].Trim()
                if ($rawLine.Length -gt 120) { $rawLine = $rawLine.Substring(0, 120) }
            }

            $null = $refs.Add([PSCustomObject]@{
                source      = $f.Name
                target      = $tgt
                section     = $secNum
                line_number = $lineNum
                raw         = $rawLine
                kind        = $kindStr
            })
        }
    }
}

# ----- Pass 3: validate ----
$results = New-Object System.Collections.ArrayList
foreach ($r in $refs) {
    if (-not $r) { continue }
    if (-not $r.target) { continue }

    $verdict = "ok"
    $detail  = ""

    if (-not $anchors.ContainsKey($r.target)) {
        $verdict = "missing-file"
        $detail  = "target file not found: $($r.target)"
    }
    elseif ($r.section) {
        if (-not $anchors[$r.target].ContainsKey($r.section)) {
            $verdict = "missing-section"
            $parent = ($r.section -split '\.')[0]
            if ($parent -and $anchors[$r.target].ContainsKey($parent)) {
                $detail = "section $($r.section) missing in $($r.target); parent $parent present"
            } else {
                $detail = "section $($r.section) (and parent) missing in $($r.target)"
            }
        } else {
            $detail = "resolved"
        }
    } else {
        $detail = "see-also resolved"
    }

    $null = $results.Add([PSCustomObject]@{
        source      = $r.source
        line_number = $r.line_number
        target      = $r.target
        section     = $r.section
        verdict     = $verdict
        detail      = $detail
        kind        = $r.kind
        raw         = $r.raw
    })
}

# ----- Summarize + emit ----
$passCount      = (@($results | Where-Object { $_.verdict -eq "ok" })).Count
$missingFile    = (@($results | Where-Object { $_.verdict -eq "missing-file" })).Count
$missingSection = (@($results | Where-Object { $_.verdict -eq "missing-section" })).Count
$fails = $missingFile + $missingSection

$anchorTotal = 0
foreach ($a in $anchors.Values) { $anchorTotal += $a.Count }

if ($Json) {
    $obj = @{
        ts              = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        factory_root    = $FactoryRoot
        rule_files      = $ruleFiles.Count
        anchors_total   = $anchorTotal
        references      = $refs.Count
        pass            = $passCount
        missing_file    = $missingFile
        missing_section = $missingSection
        results         = @($results)
    }
    $obj | ConvertTo-Json -Depth 6
    if ($fails -gt 0) { exit 1 } else { exit 0 }
}

if (-not $Quiet) {
    Write-Host ""
    Write-Host "==== rule reference integrity ===="
    Write-Host ("  rules dir : {0}" -f $rulesDir)
    Write-Host ("  rule files: {0}" -f $ruleFiles.Count)
    Write-Host ("  anchors   : {0} sections across all rules" -f $anchorTotal)
    Write-Host ("  references: {0} cross-file refs found" -f $refs.Count)
    Write-Host ""
}

if ($fails -gt 0) {
    Write-Host "BROKEN REFERENCES:" -ForegroundColor Red
    foreach ($r in @($results | Where-Object { $_.verdict -ne "ok" })) {
        $secLabel = if ($r.section) { " SS$($r.section)" } else { "" }
        Write-Host ("  [{0}] {1}:{2}  -> {3}{4}  ({5})" -f $r.verdict, $r.source, $r.line_number, $r.target, $secLabel, $r.detail) -ForegroundColor Yellow
        if (-not $Quiet -and $r.raw) {
            Write-Host ("        line: {0}" -f $r.raw) -ForegroundColor DarkGray
        }
    }
    Write-Host ""
}

$color = if ($fails -gt 0) { "Red" } else { "Green" }
Write-Host ("  Pass: {0}  Missing file: {1}  Missing section: {2}" -f $passCount, $missingFile, $missingSection) -ForegroundColor $color

if ($fails -gt 0) { exit 1 } else { exit 0 }
