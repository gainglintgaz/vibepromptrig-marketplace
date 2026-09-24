<#
.SYNOPSIS
    Split .claude/rules/lessons.md into 4 domain files when it exceeds the threshold.

.DESCRIPTION
    Reads .claude/rules/lessons.md, classifies each numbered lesson into one of 4 domain
    buckets (execution / data / architecture / ai-systems), and writes 4 child files +
    an index lessons.md. Unblocks PENDING_APPROVALS #3.

    Default mode: DRY RUN. Reports which buckets each lesson would go into. Pass -Apply
    to actually write the new files (renames lessons.md to lessons-archive-YYYY-MM-DD.md
    and writes the new split + index).

.PARAMETER FactoryRoot
    Path to the factory root. Defaults to $env:VIBE_ROOT, else derived from the script location.

.PARAMETER MinEntriesToSplit
    Minimum lesson count to trigger the split. Default 100 (per PENDING_APPROVALS #3 threshold).

.PARAMETER Apply
    Actually write files. Without this flag, the script reports only.

.EXAMPLE
    .\scripts\split-lessons-md.ps1
    Dry run ??? shows distribution of lessons across 4 buckets.

.EXAMPLE
    .\scripts\split-lessons-md.ps1 -Apply
    Performs the split. Renames original to lessons-archive-YYYY-MM-DD.md.

.NOTES
    The classifier uses keyword heuristics. Lessons that don't match any keyword default to
    "execution" ??? review the dry-run output before applying.

    Reclassify manually after the split if a lesson lands in the wrong bucket; the classifier
    is a starting point, not gospel.
#>
param(
    [string]$FactoryRoot = $(if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }),
    [int]$MinEntriesToSplit = 100,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

$LessonsPath = Join-Path $FactoryRoot ".claude\rules\lessons.md"
if (-not (Test-Path $LessonsPath)) {
    Write-Error "lessons.md not found at $LessonsPath"
    exit 1
}

$content = Get-Content $LessonsPath -Raw

# Parse numbered lessons: "## NN. Title" or "NN. **Title.**"
# Most common pattern in this codebase: "NN. **Title.** body"
$lessonPattern = '(?ms)^(\d+)\.\s+\*\*([^*]+)\*\*\s*(.*?)(?=^\d+\.\s+\*\*|^##\s|\z)'
$lessons = [regex]::Matches($content, $lessonPattern)

Write-Host "Found $($lessons.Count) numbered lessons in $LessonsPath" -ForegroundColor Cyan

if ($lessons.Count -lt $MinEntriesToSplit) {
    Write-Host "Below split threshold ($MinEntriesToSplit). Nothing to do." -ForegroundColor Yellow
    Write-Host "Run again when lesson count >= $MinEntriesToSplit." -ForegroundColor Gray
    exit 0
}

# Classifier keywords (lowercase match against title + body)
$buckets = @{
    "execution" = @(
        'commit', 'build', 'ship', 'session', 'sprint', 'plan', 'audit', 'rollback', 'revert',
        'workflow', 'process', 'discipline', 'context drift', 'verification', 'qa', 'definition of done',
        'pre-launch', 'launch', 'deploy', 'cron', 'function shipped', 'undeployed'
    )
    "data" = @(
        'database', 'schema', 'migration', 'rls', 'select', 'insert', 'update', 'column', 'table',
        'persistence', 'tax year', 'documentdate', 'data completeness', 'data maturity', 'dmg',
        'dedup', 'unique constraint', 'foreign key', 'index', 'aggregate', 'cohort', 'benchmark',
        'export', 'sparse-data', 'data integrity'
    )
    "architecture" = @(
        'architecture', 'design', 'pattern', 'decision', 'boundary', 'cascade', 'system boundary',
        'multi-tenant', 'tenant', 'dispatcher', 'monolith', 'service', 'edge function',
        'two-environment', 'sandbox', 'mcp', 'rule', 'rule gap', 'enforcement', 'self-reflection',
        'review', 'plan stale'
    )
    "ai-systems" = @(
        'ai', 'llm', 'prompt', 'model', 'claude', 'gemini', 'openai', 'gpt', 'anthropic',
        'agent', 'subagent', 'classifier', 'fabrication', 'hallucination', 'voice', 'rag',
        'embedding', 'context', 'token budget', 'prompt_version', 'data flywheel', 'maturity gate',
        'discovery', 'recommendation', 'silent-no-op', 'rule violation'
    )
}

# Classify each lesson
$classification = @{
    "execution" = @()
    "data" = @()
    "architecture" = @()
    "ai-systems" = @()
}

foreach ($match in $lessons) {
    $num = $match.Groups[1].Value
    $title = $match.Groups[2].Value.Trim()
    $body = $match.Groups[3].Value
    $fullText = "$title $body".ToLower()

    $scores = @{}
    foreach ($bucket in $buckets.Keys) {
        $score = 0
        foreach ($kw in $buckets[$bucket]) {
            if ($fullText.Contains($kw)) { $score++ }
        }
        $scores[$bucket] = $score
    }

    # Winner: highest score; ties broken by bucket priority (execution ??? data ??? architecture ??? ai-systems)
    $maxScore = ($scores.Values | Measure-Object -Maximum).Maximum
    if ($maxScore -eq 0) {
        # No keywords matched ??? default to execution
        $winner = "execution"
    } else {
        $winners = $scores.GetEnumerator() | Where-Object { $_.Value -eq $maxScore } | ForEach-Object { $_.Key }
        $priorityOrder = @("execution", "data", "architecture", "ai-systems")
        $winner = ($priorityOrder | Where-Object { $winners -contains $_ } | Select-Object -First 1)
    }

    $classification[$winner] += @{
        Number = $num
        Title = $title
        Body = $body
        FullText = "$num. **$title** $body"
    }
}

# Report distribution
Write-Host ""
Write-Host "Distribution by bucket:" -ForegroundColor Cyan
foreach ($bucket in @("execution", "data", "architecture", "ai-systems")) {
    Write-Host ("  {0,-15} {1,3} lessons" -f $bucket, $classification[$bucket].Count) -ForegroundColor White
}
Write-Host ""

if (-not $Apply) {
    Write-Host "DRY RUN MODE. No files written." -ForegroundColor Yellow
    Write-Host "Pass -Apply to perform the split." -ForegroundColor Gray
    Write-Host ""
    Write-Host "Sample classifications (first 3 per bucket):" -ForegroundColor Cyan
    foreach ($bucket in @("execution", "data", "architecture", "ai-systems")) {
        Write-Host "  $bucket :" -ForegroundColor White
        foreach ($lesson in ($classification[$bucket] | Select-Object -First 3)) {
            Write-Host ("    #{0,-4} {1}" -f $lesson.Number, ($lesson.Title.Substring(0, [Math]::Min(70, $lesson.Title.Length)))) -ForegroundColor Gray
        }
    }
    exit 0
}

# APPLY MODE ??? actually write files
$RulesDir = Join-Path $FactoryRoot ".claude\rules"
$today = Get-Date -Format "yyyy-MM-dd"
$archivePath = Join-Path $RulesDir "lessons-archive-$today.md"

Write-Host "APPLY MODE ??? writing 4 split files + updated lessons.md index" -ForegroundColor Yellow
Write-Host "Archiving original to $archivePath" -ForegroundColor Gray

Copy-Item -Path $LessonsPath -Destination $archivePath -Force

foreach ($bucket in @("execution", "data", "architecture", "ai-systems")) {
    $outPath = Join-Path $RulesDir "lessons-$bucket.md"
    $header = @"
# lessons-$bucket.md ??? Battle-tested lessons (${bucket} domain)

> Split from lessons.md on $today (PENDING_APPROVALS #3, scripts/split-lessons-md.ps1).
> Original archived to lessons-archive-$today.md.
> $($classification[$bucket].Count) lessons in this domain.

---

"@
    $body = ($classification[$bucket] | ForEach-Object { $_.FullText }) -join "`n`n---`n`n"
    Set-Content -Path $outPath -Value ($header + $body) -Encoding UTF8
    Write-Host "  wrote $outPath ($($classification[$bucket].Count) lessons)" -ForegroundColor Green
}

# Write index lessons.md (replaces the old monolithic file)
$indexContent = @"
# lessons.md ??? Battle-tested lessons (index)

> Split into 4 domain files on $today (PENDING_APPROVALS #3).
> Total lessons: $($lessons.Count). Add new lessons to the correct domain file directly.

## Files

- [lessons-execution.md](lessons-execution.md) ??? $($classification['execution'].Count) lessons. Session/sprint/build/ship discipline, plan-stale, context-drift, verification gates.
- [lessons-data.md](lessons-data.md) ??? $($classification['data'].Count) lessons. Schema, migrations, RLS, persistence, sparse-data, aggregates, exports.
- [lessons-architecture.md](lessons-architecture.md) ??? $($classification['architecture'].Count) lessons. Multi-tenant, dispatcher, MCP, boundaries, environment isolation, self-reflection.
- [lessons-ai-systems.md](lessons-ai-systems.md) ??? $($classification['ai-systems'].Count) lessons. AI agent management, prompt versioning, fabrication defense, classification, RAG, model selection.

## Original archive

[lessons-archive-$today.md](lessons-archive-$today.md) ??? the pre-split monolithic file, for historical reference.

## Adding new lessons

Pick the domain. Append a numbered entry: '## NN. **Short title.** Body...'
When this index drifts or any domain file exceeds ~70 entries, re-run scripts/split-lessons-md.ps1 to rebalance.
"@

Set-Content -Path $LessonsPath -Value $indexContent -Encoding UTF8
Write-Host "  wrote $LessonsPath (index)" -ForegroundColor Green

Write-Host ""
Write-Host "DONE. Update .claude/CLAUDE.md SS15 auto-loaded rules list:" -ForegroundColor Cyan
Write-Host "  Replace: 'lessons.md - N battle-tested lessons from real projects'" -ForegroundColor Gray
Write-Host "  With:    4 entries pointing to lessons-execution / lessons-data / lessons-architecture / lessons-ai-systems" -ForegroundColor Gray
Write-Host ""
Write-Host "Review the split. Manually move any misclassified lesson by editing the appropriate file." -ForegroundColor Yellow

