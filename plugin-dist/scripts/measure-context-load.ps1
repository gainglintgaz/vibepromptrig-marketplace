<#
.SYNOPSIS
    Measure Claude Code per-session context load (estimated tokens).

.DESCRIPTION
    Walks every file Claude Code auto-includes at session start in the factory
    root and reports byte length + estimated tokens. Used to establish baseline
    before the v4.4.5 token-burn fix sprint and to validate reduction after.

    Token estimation: bytes / 3.5 (cl100k_base average for English markdown).
    This is a rough estimate; for exact counts use the Anthropic tokenizer.

    Output:
      - Console: per-file + per-directory + grand-total table
      - factory_metrics.jsonl: append event=context_measurement
      - Optional: JSON to stdout via -Json flag for downstream tooling

    Captures the A.3-worst-case: scans every .claude/rules/**/*.md file
    regardless of whether CLAUDE.md references it. Until A.3 research confirms
    Claude Code's actual glob behavior, this script assumes the worst case
    (everything is loaded).

.PARAMETER FactoryRoot
    Override factory root path. Defaults to script's repo root.

.PARAMETER Json
    Emit machine-readable JSON to stdout instead of human-readable table.

.PARAMETER NoLog
    Skip appending to factory_metrics.jsonl. Useful for dry-runs.

.PARAMETER Label
    Optional label for the measurement event (e.g., "pre-split", "post-commit-2").
    Stored in factory_metrics.jsonl entry for later comparison.

.NOTES
    PowerShell 5.1 compatible. ASCII only.
    First introduced as Commit 0 of v4.4.5 token-burn fix sprint per
    docs/architecture/v4.4.5-token-burn-fix.md §9.
#>

[CmdletBinding()]
param(
    [string]$FactoryRoot,
    [switch]$Json,
    [switch]$NoLog,
    [string]$Label = "ad-hoc"
)
$ErrorActionPreference = "Stop"

# Resolve factory root from script location if not provided
if (-not $FactoryRoot) {
    $FactoryRoot = Split-Path -Parent $PSScriptRoot
}
$FactoryRoot = (Resolve-Path $FactoryRoot).Path

# Token estimation: cl100k average for English markdown
$CharsPerToken = 3.5

function Measure-File {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return [PSCustomObject]@{
            file        = $Path
            exists      = $false
            bytes       = 0
            tokens_est  = 0
        }
    }
    $bytes = (Get-Item $Path).Length
    $tokens = [Math]::Round($bytes / $CharsPerToken, 0)
    return [PSCustomObject]@{
        file        = $Path
        exists      = $true
        bytes       = [int]$bytes
        tokens_est  = [int]$tokens
    }
}

function Measure-Glob {
    param([string]$Pattern, [string]$Label)
    $files = @(Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue)
    if (-not $files) { $files = @() }
    $rows = @()
    foreach ($f in $files) {
        $rows += Measure-File -Path $f.FullName
    }
    $totalBytes  = ($rows | Measure-Object -Property bytes -Sum).Sum
    $totalTokens = ($rows | Measure-Object -Property tokens_est -Sum).Sum
    if (-not $totalBytes)  { $totalBytes  = 0 }
    if (-not $totalTokens) { $totalTokens = 0 }
    return [PSCustomObject]@{
        label        = $Label
        file_count   = $rows.Count
        bytes_total  = [int]$totalBytes
        tokens_total = [int]$totalTokens
        files        = $rows
    }
}

# ---- Measurement passes ----
# Pass 1: factory root .claude/CLAUDE.md (single file Claude Code reads by name)
$pass1 = Measure-File -Path (Join-Path $FactoryRoot ".claude\CLAUDE.md")

# Pass 2: every .claude/rules/*.md (A.3 worst case: assume globbed)
$pass2 = Measure-Glob -Pattern (Join-Path $FactoryRoot ".claude\rules\*.md") -Label "claude-rules"

# Pass 3: nested rule dirs (domain-primers, reference if it exists)
$pass3 = Measure-Glob -Pattern (Join-Path $FactoryRoot ".claude\rules\**\*.md") -Label "claude-rules-nested"

# Pass 4: AGENTS.md, GEMINI.md, .windsurfrules, PERPLEXITY (other mirror formats)
$pass4_files = @(
    "AGENTS.md",
    "GEMINI.md",
    ".windsurfrules",
    "PERPLEXITY_SPACE_INSTRUCTIONS.md"
)
$pass4_rows = @()
foreach ($f in $pass4_files) {
    $pass4_rows += Measure-File -Path (Join-Path $FactoryRoot $f)
}
$pass4_totalBytes  = ($pass4_rows | Measure-Object -Property bytes -Sum).Sum
$pass4_totalTokens = ($pass4_rows | Measure-Object -Property tokens_est -Sum).Sum
if (-not $pass4_totalBytes)  { $pass4_totalBytes  = 0 }
if (-not $pass4_totalTokens) { $pass4_totalTokens = 0 }

# Grand total: CLAUDE.md + .claude/rules/*.md (the per-session base load for Claude Code specifically)
# Other mirrors (AGENTS.md/GEMINI.md/etc.) are for OTHER agents; reported separately.
$grandBytes  = $pass1.bytes + $pass2.bytes_total
$grandTokens = $pass1.tokens_est + $pass2.tokens_total

# ---- Output ----
$result = [PSCustomObject]@{
    ts                          = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    event                       = "context_measurement"
    label                       = $Label
    factory_root                = $FactoryRoot
    chars_per_token             = $CharsPerToken
    claude_md                   = $pass1
    claude_rules                = $pass2
    claude_rules_nested         = $pass3
    other_mirrors               = [PSCustomObject]@{
        files        = $pass4_rows
        bytes_total  = [int]$pass4_totalBytes
        tokens_total = [int]$pass4_totalTokens
    }
    grand_total = [PSCustomObject]@{
        bytes_total  = [int]$grandBytes
        tokens_total = [int]$grandTokens
        note         = "CLAUDE.md + .claude/rules/*.md combined; assumes A.3 worst case (all .claude/rules globbed)"
    }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
} else {
    Write-Host ""
    Write-Host "==== VibePromptRig context load measurement ====" -ForegroundColor Cyan
    Write-Host "  Factory root: $FactoryRoot"
    Write-Host "  Label:        $Label"
    Write-Host "  Timestamp:    $($result.ts)"
    Write-Host ""
    Write-Host "  Pass 1 -- .claude/CLAUDE.md (single file Claude Code loads by name)"
    Write-Host ("    bytes: {0,10:N0}   tokens (est): {1,8:N0}" -f $pass1.bytes, $pass1.tokens_est)
    Write-Host ""
    Write-Host "  Pass 2 -- .claude/rules/*.md (A.3 worst case: assume globbed)"
    Write-Host ("    files: {0,3}        bytes: {1,10:N0}   tokens (est): {2,8:N0}" -f $pass2.file_count, $pass2.bytes_total, $pass2.tokens_total)
    Write-Host ""
    Write-Host "  Pass 3 -- .claude/rules/**/*.md (includes subdirs like domain-primers/)"
    Write-Host ("    files: {0,3}        bytes: {1,10:N0}   tokens (est): {2,8:N0}" -f $pass3.file_count, $pass3.bytes_total, $pass3.tokens_total)
    Write-Host ""
    Write-Host "  Pass 4 -- other mirrors (NOT loaded by Claude Code; reported for ref)"
    Write-Host ("    AGENTS.md       {0,10:N0} bytes" -f $pass4_rows[0].bytes)
    Write-Host ("    GEMINI.md       {0,10:N0} bytes" -f $pass4_rows[1].bytes)
    Write-Host ("    .windsurfrules  {0,10:N0} bytes" -f $pass4_rows[2].bytes)
    Write-Host ("    PERPLEXITY...   {0,10:N0} bytes" -f $pass4_rows[3].bytes)
    Write-Host ("    total           {0,10:N0} bytes   {1,8:N0} tokens (est)" -f $pass4_totalBytes, $pass4_totalTokens)
    Write-Host ""
    Write-Host "  ==== GRAND TOTAL (Claude Code per-session base load) ====" -ForegroundColor Yellow
    Write-Host ("    bytes:        {0,10:N0}" -f $grandBytes) -ForegroundColor Yellow
    Write-Host ("    tokens (est): {0,10:N0}" -f $grandTokens) -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Spec baseline reference: 73,000 tokens (unmeasured estimate per A.1)"
    $deltaToSpec = $grandTokens - 73000
    $deltaSign   = if ($deltaToSpec -ge 0) { "+" } else { "" }
    Write-Host ("  Delta vs spec:           {0}{1:N0} tokens" -f $deltaSign, $deltaToSpec)
    Write-Host ""
}

# Append to factory_metrics.jsonl unless suppressed
if (-not $NoLog) {
    $metricsPath = Join-Path $FactoryRoot "factory_metrics.jsonl"
    $compactEntry = [PSCustomObject]@{
        ts            = $result.ts
        event         = "context_measurement"
        label         = $Label
        claude_md_bytes  = $pass1.bytes
        claude_md_tokens = $pass1.tokens_est
        rules_bytes      = $pass2.bytes_total
        rules_tokens     = $pass2.tokens_total
        rules_file_count = $pass2.file_count
        nested_bytes     = $pass3.bytes_total
        nested_tokens    = $pass3.tokens_total
        grand_bytes      = [int]$grandBytes
        grand_tokens     = [int]$grandTokens
        spec_baseline    = 73000
        delta_vs_spec    = ($grandTokens - 73000)
    }
    $line = $compactEntry | ConvertTo-Json -Compress -Depth 5
    Add-Content -Path $metricsPath -Value $line -Encoding UTF8
    if (-not $Json) {
        Write-Host "  Logged to: $metricsPath" -ForegroundColor DarkGray
    }
}
