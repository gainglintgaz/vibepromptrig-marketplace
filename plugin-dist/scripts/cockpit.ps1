<#
.SYNOPSIS
    cockpit.ps1 -- regenerate PROJECT_COCKPIT.md: a single, plain-English view of where
    a project stands (goals, milestones + % complete, what's been spent, blockers).

.DESCRIPTION
    The MVP answer to "vibe-coding in the dark." Pulls what is REALLY measurable from
    git + factory_metrics.jsonl, reads the human-maintained goal/milestone block from
    .forge/cockpit.json, and renders one clean status page.

    HONESTY CONTRACT (this is the whole point -- never fake a number):
      - MEASURED  = pulled from git log / factory_metrics.jsonl (hard fact, cited).
      - ESTIMATED = derived (e.g. session wall-clock from message timestamps). Labeled.
      - DECLARED  = human-set in .forge/cockpit.json (goals, milestone %). Labeled.
      - UNKNOWN   = not captured yet. Shown as "not tracked" -- NEVER guessed.

    Token + dollar spend: the factory does NOT reliably capture per-session tokens or
    cost yet (only sporadic context_measurement events + an unwired vibepromptrig-cost
    MCP). So this MVP shows the Anthropic Console as the source of truth for $ and
    labels factory token figures ESTIMATED/PARTIAL. The wired version is a v5.x feature
    (architect-probe queued). Do not present estimates as measurements.

    PowerShell 5.1 compatible. ASCII only. Read-only except writing PROJECT_COCKPIT.md.

.PARAMETER FactoryRoot
    Defaults to $env:VIBE_ROOT, else derived from the script location.

.PARAMETER Json
    Emit machine-readable JSON instead of writing the markdown.

.EXAMPLE
    .\scripts\cockpit.ps1
    Regenerates PROJECT_COCKPIT.md at the factory root.
#>

[CmdletBinding()]
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path $PSScriptRoot -Parent }

$ErrorActionPreference = "Stop"
Set-Location $FactoryRoot

# ---- DECLARED layer: human-maintained goals + milestones ----
# Lives in .forge/cockpit.json. If absent, render a starter the user fills in.
$cockpitJsonPath = Join-Path $FactoryRoot ".forge\cockpit.json"
if (Test-Path $cockpitJsonPath) {
    $declared = Get-Content $cockpitJsonPath -Raw | ConvertFrom-Json
} else {
    $declared = $null
}

# ---- MEASURED layer: git facts ----
function Get-GitCount { param([string]$Range) (git log --oneline $Range 2>$null | Measure-Object).Count }

$totalCommits   = Get-GitCount "HEAD"
$last7Commits   = (git log --oneline --since="7 days ago" 2>$null | Measure-Object).Count
$lastCommitSha  = (git rev-parse --short HEAD 2>$null)
$lastCommitSubj = (git log -1 --format=%s 2>$null)
$lastCommitDate = (git log -1 --format=%cI 2>$null)
$branch         = (git rev-parse --abbrev-ref HEAD 2>$null)

# ---- MEASURED layer: factory_metrics facts (single STREAMING pass -- O(1) memory) ----
# One StreamReader pass does ALL counters (probe/gate/override/context) + the ai_call month-to-date
# aggregation, instead of loading the whole (append-only, unbounded) file into RAM and scanning it
# 5x. The ai_call cost arithmetic is GUARDED so the customer-facing status surface stays honest
# under hostile input (router writes cost_cents with no source validation):
#   * a bad/string/missing cost uses `-as [double]` (returns $null, never the Stop-fatal cast throw),
#     so one malformed row never crashes the whole dashboard;
#   * negative / NaN / Infinity costs are rejected (counted as anomalies), never summed;
#   * ai_measured requires at least one event with a REAL finite non-negative cost -- a cost-less
#     event renders [PARTIAL], NEVER a fabricated "$0.00 [MEASURED]";
#   * month-to-date uses a robust UTC datetime parse, not a lexical string compare.
$metricsPath = Join-Path $FactoryRoot "factory_metrics.jsonl"
$probeCount = 0; $gateCount = 0; $overrideCount = 0; $lastContextTokens = $null
$aiCalls = 0; $aiCostCents = 0.0; $aiTokens = 0; $aiMeasured = $false; $aiPartial = $false; $aiCostKnown = $false; $aiAnomalies = 0
if (Test-Path $metricsPath) {
    $nowUtc = (Get-Date).ToUniversalTime()
    $monthStartDt = [datetime]::SpecifyKind([datetime]::new($nowUtc.Year, $nowUtc.Month, 1, 0, 0, 0), 'Utc')
    $reader = $null
    try {
        $reader = New-Object System.IO.StreamReader($metricsPath)
        while ($null -ne ($ln = $reader.ReadLine())) {
            if ($ln.Length -eq 0) { continue }
            if     ($ln -match '"event":"architect_probe"')   { $probeCount++ }
            if     ($ln -match '"event":"arch_gate_override"') { $overrideCount++ }
            elseif ($ln -match '"event":"arch_gate"')          { $gateCount++ }
            if ($ln -match '"grand_tokens":(\d+)') { $lastContextTokens = [int]$matches[1] }
            if ($ln -notmatch '"event":"ai_call"') { continue }
            $ev = $null
            try { $ev = $ln | ConvertFrom-Json } catch { continue }
            if ($ev.event -ne 'ai_call') { continue }
            if ($ev.ts) {
                $tsDt = $null
                try { $tsDt = ([datetimeoffset]::Parse([string]$ev.ts)).UtcDateTime } catch { $tsDt = $null }
                if ($null -ne $tsDt -and $tsDt -lt $monthStartDt) { continue }
            }
            $aiCalls++
            if ($null -eq $ev.cost_cents) {
                # cost not present for this event -> unknown (PARTIAL), NOT an anomaly, NOT a real $0
            } else {
                $cc = $ev.cost_cents -as [double]   # -as returns $null on a bad value (no Stop-fatal throw)
                if ($null -eq $cc -or [double]::IsNaN($cc) -or [double]::IsInfinity($cc) -or $cc -lt 0) {
                    $aiAnomalies++   # present but invalid (string / negative / NaN / Infinity) -> excluded
                } else {
                    $aiCostCents += $cc
                    $aiCostKnown = $true
                }
            }
            $ti = $ev.tokens_in -as [int];  if ($null -eq $ti) { $ti = 0 }
            $to = $ev.tokens_out -as [int]; if ($null -eq $to) { $to = 0 }
            $aiTokens += ($ti + $to)
        }
    } catch { } finally { if ($reader) { $reader.Dispose() } }
    $aiMeasured = ($aiCalls -gt 0 -and $aiCostKnown)
    $aiPartial  = ($aiCalls -gt 0 -and -not $aiCostKnown)   # events logged but no real cost captured
}
$aiCostCents = [math]::Round($aiCostCents, 2)

# ---- MEASURED: forge doctor health ----
$doctorVerdict = "unknown"
$doctorScript = Join-Path $FactoryRoot "scripts\forge.ps1"
if (Test-Path $doctorScript) {
    try {
        $d = (& powershell -NoProfile -ExecutionPolicy Bypass -File $doctorScript doctor 2>&1 | Out-String)
        $dm = [regex]::Match($d, "Doctor verdict:\s*(.+)")
        if ($dm.Success) { $doctorVerdict = $dm.Groups[1].Value.Trim() }
    } catch { $doctorVerdict = "doctor run failed: $($_.Exception.Message)" }
}

if ($Json) {
    [pscustomobject]@{
        measured = @{ total_commits=$totalCommits; last7_commits=$last7Commits; head=$lastCommitSha;
                      head_subject=$lastCommitSubj; head_date=$lastCommitDate; branch=$branch;
                      architect_probes=$probeCount; arch_gates=$gateCount; gate_overrides=$overrideCount;
                      last_context_tokens=$lastContextTokens; doctor=$doctorVerdict;
                      ai_calls_mtd=$aiCalls; ai_cost_cents_mtd=$aiCostCents; ai_tokens_mtd=$aiTokens;
                      ai_measured=$aiMeasured; ai_partial=$aiPartial; ai_anomalies=$aiAnomalies }
        declared = $declared
        generated_at_note = "timestamp intentionally omitted -- pass via cron/caller to keep deterministic"
    } | ConvertTo-Json -Depth 8
    return
}

# ---- Render PROJECT_COCKPIT.md ----
$sb = New-Object System.Text.StringBuilder
function L { param([string]$s) [void]$sb.AppendLine($s) }

L "# PROJECT COCKPIT"
L ""
L "> Regenerate: ``powershell -File scripts/cockpit.ps1``. One plain-English view of where things stand."
L "> **Honesty contract:** [MEASURED] = hard fact from git/metrics. [ESTIMATED] = derived, approximate."
L "> [DECLARED] = human-set in .forge/cockpit.json. [NOT TRACKED] = not captured yet (never guessed)."
L ""
L "---"
L ""
L "## Where things stand (MEASURED)"
L ""
L "| Metric | Value | Source |"
L "|---|---|---|"
L "| Current branch | $branch | git |"
L "| Total commits | $totalCommits | git log |"
L "| Commits last 7 days | $last7Commits | git log |"
L "| Latest commit | ``$lastCommitSha`` $lastCommitSubj | git |"
L "| Factory health | $doctorVerdict | forge doctor |"
L "| Architect-probes run | $probeCount | factory_metrics |"
L "| Arch gates fired | $gateCount ($overrideCount overrides) | factory_metrics |"
if ($lastContextTokens) { L "| Last context-load measure | ~$lastContextTokens tokens/msg | factory_metrics (sporadic) |" }
L ""
L "## Goals + milestones (DECLARED)"
L ""
if ($declared -and $declared.goals) {
    foreach ($g in $declared.goals) {
        L "### $($g.title)  -- $($g.percent_complete)% [DECLARED]"
        if ($g.note) { L "$($g.note)" }
        if ($g.milestones) {
            L ""
            L "| Milestone | Status |"
            L "|---|---|"
            foreach ($m in $g.milestones) { L "| $($m.name) | $($m.status) |" }
        }
        L ""
    }
} else {
    L "_No .forge/cockpit.json yet._ Create it to declare goals + milestone %. Starter:"
    L ""
    L '```json'
    L '{'
    L '  "goals": [{'
    L '    "title": "v5.0 commercial launch",'
    L '    "percent_complete": 0,'
    L '    "note": "Customer-configurable factory plugin.",'
    L '    "milestones": ['
    L '      {"name": "v4.4.5 token-burn sprint", "status": "done"},'
    L '      {"name": "v5.0 Sprint 1 override layer", "status": "in progress"},'
    L '      {"name": "Phase D fan-out", "status": "not started"},'
    L '      {"name": "1 stranger journey cold", "status": "not started"},'
    L '      {"name": "landing + attorney review", "status": "not started"}'
    L '    ]'
    L '  }]'
    L '}'
    L '```'
}
L ""
L "## Spend (HONEST LIMITS)"
L ""
L "| What | Status |"
L "|---|---|"
if ($aiMeasured) {
    $anom = if ($aiAnomalies -gt 0) { " ($aiAnomalies event(s) had invalid cost and were excluded)" } else { "" }
    L ("| Dollar cost (AI, month-to-date) | [MEASURED] `$$('{0:N2}' -f ($aiCostCents/100)) -- $aiCalls ai_call events via the router's provenance (A8)$anom. Anthropic Console remains the billing source of truth. |")
} elseif ($aiPartial) {
    L "| Dollar cost | [PARTIAL] -- $aiCalls ai_call event(s) logged this month, but none carried a valid cost, so the dollar figure is not measurable yet. NOT shown as `$0.00 (that would be a fabricated number). Anthropic Console -> Usage is the billing source of truth. |"
} else {
    L "| Dollar cost | [NOT TRACKED] -- the vibepromptrig-cost MCP is now wired to the router's ai_call provenance (get_ai_call_cost), but no ai_call events have been logged yet. Lights up to [MEASURED] once agents dispatch through the router. Anthropic Console -> Usage is the billing source of truth. |"
}
L "| Tokens (per session) | [PARTIAL] -- only sporadic context-load measurements exist, not per-session totals. |"
L "| Your time (prompting/reviewing/reading) | [NOT TRACKED] -- never captured; can only be ESTIMATED forward from message timestamps, not measured backward. |"
L "| AI work time | [ESTIMATED] -- derivable from commit timestamps; not yet aggregated. |"
L ""
L "> The wired version (real token+cost+time capture into the 3 vibepromptrig MCPs) is a"
L "> queued v5.x feature (architect-probe pending). This MVP shows what is honestly"
L "> knowable today and refuses to fabricate the rest."
L ""
L "## Blockers + next (DECLARED)"
L ""
$approvals = $null
if (Get-Command node -ErrorAction SilentlyContinue) {
    $approvals = (& node (Join-Path $PSScriptRoot "lib\pending-summary.mjs") (Join-Path $FactoryRoot "PENDING_APPROVALS.md") 2>$null)
}
if ($approvals) { L "- $approvals -- see PENDING_APPROVALS.md"; L "" }
if ($declared -and $declared.blockers) {
    foreach ($b in $declared.blockers) { L "- $b" }
} else {
    L "_Add a ``blockers`` array to .forge/cockpit.json to track these._"
}
L ""
L "---"
L "_Generated by scripts/cockpit.ps1. Re-run after milestones change. Edit goals/milestones/blockers in .forge/cockpit.json._"

$outPath = Join-Path $FactoryRoot "PROJECT_COCKPIT.md"
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "[OK] Wrote PROJECT_COCKPIT.md ($totalCommits commits, doctor: $doctorVerdict)" -ForegroundColor Green
