<#
.SYNOPSIS
    dashboard.ps1 -- a tight, live "where things stand" status table in the TERMINAL.
    The engine behind the /dashboard slash command.

.DESCRIPTION
    REUSES scripts/cockpit.ps1 (-Json) as the single source of status truth (VIBE Rule 16 --
    reuse before build); this script only FORMATS that data into a compact terminal view and
    layers the customer's display preferences on top. It does NOT duplicate cockpit's logic.

    HONESTY CONTRACT (inherited from cockpit.ps1 -- never fake a number):
      [MEASURED]   hard fact from git / factory_metrics / forge doctor.
      [ESTIMATED]  derived, approximate -- labeled.
      [DECLARED]   human-set in .forge/cockpit.json -- labeled.
      [NOT-TRACKED] not captured yet -- shown honestly, never guessed.

    Customer-configurable via the `dashboard` block in .forge/cockpit.json (decision: EXTEND
    cockpit.json rather than add a second config file, per the dashboard directive SS2). Keys:
      sections             which sections to show (status|goals|blockers|spend). Default all.
      data_source          terminal | mcp | both. Default terminal. (Tier 2 lights up mcp cost.)
      refresh_cache_minutes how long a cached cockpit snapshot is reused before re-running
                            doctor live. Default 10. -Refresh forces a fresh run.

    Default reads a cached cockpit snapshot (fast/cheap); -Refresh re-runs cockpit + doctor live.

    PowerShell 5.1 compatible. ASCII only. Read-only except its own temp cache file.

.PARAMETER Refresh   Re-run cockpit.ps1 (incl. forge doctor) live, ignoring the cache.
.PARAMETER Json      Emit the assembled dashboard model as JSON (for tooling / tests).
.PARAMETER Help      Print usage + point at the tutorial.
.PARAMETER FactoryRoot  Defaults to $env:VIBE_ROOT, else derived from the script location.

.EXAMPLE
    powershell -File scripts/dashboard.ps1
    powershell -File scripts/dashboard.ps1 -Refresh
#>
[CmdletBinding()]
param(
    [switch]$Refresh,
    [switch]$Json,
    [switch]$Help,
    [string]$FactoryRoot = $env:VIBE_ROOT
)

$ErrorActionPreference = "Stop"
if (-not $FactoryRoot) { $FactoryRoot = Split-Path $PSScriptRoot -Parent }

if ($Help) {
    Write-Host ""
    Write-Host "/dashboard -- VibePromptRig live status" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  powershell -File scripts/dashboard.ps1 [-Refresh] [-Json]"
    Write-Host ""
    Write-Host "  (default)   compact status table from a cached cockpit snapshot (fast)."
    Write-Host "  -Refresh    re-run cockpit + forge doctor live (slower, fully current)."
    Write-Host "  -Json       machine-readable dashboard model."
    Write-Host ""
    Write-Host "  Configure what shows + the data source in the 'dashboard' block of"
    Write-Host "  .forge/cockpit.json (sections, data_source: terminal|mcp|both, refresh_cache_minutes)."
    Write-Host ""
    Write-Host "  Honesty labels: [MEASURED] hard fact | [ESTIMATED] derived | [DECLARED] human-set |"
    Write-Host "  [NOT-TRACKED] not captured yet (never guessed)."
    Write-Host ""
    Write-Host "  Full guide: docs/tutorials/dashboard.md" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# ---- Customer display config (the `dashboard` block in .forge/cockpit.json) ----
$cockpitJsonPath = Join-Path $FactoryRoot ".forge\cockpit.json"
$cfgSections = @("status", "goals", "blockers", "spend")
$cfgDataSource = "terminal"
$cfgCacheMin = 10
if (Test-Path $cockpitJsonPath) {
    try {
        $cj = Get-Content $cockpitJsonPath -Raw | ConvertFrom-Json
        if ($cj.dashboard) {
            if ($cj.dashboard.sections) { $cfgSections = @($cj.dashboard.sections) }
            if ($cj.dashboard.data_source) { $cfgDataSource = [string]$cj.dashboard.data_source }
            if ($null -ne $cj.dashboard.refresh_cache_minutes) { $cfgCacheMin = [int]$cj.dashboard.refresh_cache_minutes }
        }
    } catch { }   # malformed dashboard block -> fall back to defaults (the cockpit goals still load below)
}

# ---- Get cockpit status data (cached by default; -Refresh forces live) ----
$frHash = [Math]::Abs($FactoryRoot.ToLowerInvariant().GetHashCode()).ToString("x8")
$cachePath = Join-Path ([System.IO.Path]::GetTempPath()) "vibepromptrig-dashboard-cache-$frHash.json"
# cockpit.ps1 is a FACTORY script (sibling of this one), found relative to THIS script's
# location -- not relative to $FactoryRoot, which is the customer/data root (where cockpit.json
# + factory_metrics.jsonl live and which is passed to cockpit via -FactoryRoot).
$cockpitScript = Join-Path $PSScriptRoot "cockpit.ps1"
$cacheAgeMin = $null
$cockpit = $null
$usedCache = $false

function Get-CockpitFresh {
    $raw = (& powershell -NoProfile -ExecutionPolicy Bypass -File $cockpitScript -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String)
    $obj = $raw | ConvertFrom-Json   # throws if cockpit failed -> caller handles
    # cache it (best-effort)
    try { [System.IO.File]::WriteAllText($cachePath, ($obj | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding $false)) } catch { }
    return $obj
}

if (-not $Refresh -and (Test-Path $cachePath)) {
    try {
        $cacheItem = Get-Item $cachePath
        $cacheAgeMin = [math]::Round(((Get-Date) - $cacheItem.LastWriteTime).TotalMinutes, 1)
        if ($cacheAgeMin -le $cfgCacheMin) {
            $cockpit = Get-Content $cachePath -Raw | ConvertFrom-Json
            $usedCache = $true
        }
    } catch { $cockpit = $null }
}

if (-not $cockpit) {
    try {
        $cockpit = Get-CockpitFresh
        $cacheAgeMin = 0
    } catch {
        # Graceful degrade: cockpit could not run. Never crash; surface honestly.
        if ($Json) {
            [pscustomobject]@{ error = "cockpit.ps1 unavailable"; detail = $_.Exception.Message; data_source = $cfgDataSource } | ConvertTo-Json
        } else {
            Write-Host ""
            Write-Host "VIBEPROMPTRIG DASHBOARD" -ForegroundColor Cyan
            Write-Host "  [NOT-TRACKED] cockpit.ps1 could not run -- $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  Status data is unavailable right now. Try -Refresh, or run scripts/cockpit.ps1 directly." -ForegroundColor DarkGray
            Write-Host ""
        }
        exit 0
    }
}

$m = $cockpit.measured
$d = $cockpit.declared

# ---- Spend -- data_source-aware (Tier 2 MCP-backed live data + graceful degrade) ----
# data_source = terminal (default, zero-setup -- the Tier-1 estimated view, no MCP cost);
#               mcp | both -- read the router's REAL ai_call provenance (the same spine the
#               vibepromptrig-cost MCP aggregates via get_ai_call_cost), surfaced by cockpit.ps1
#               as measured.ai_* fields. When ai_call events exist -> [MEASURED]; when the MCP
#               data spine is absent / has no events -> gracefully fall back to [NOT-TRACKED]
#               (never crash, never fabricate a number).
$useMcpCost = ($cfgDataSource -eq "mcp" -or $cfgDataSource -eq "both")
$aiMeasured = ($useMcpCost -and $m.ai_measured -eq $true)
$aiPartial  = ($useMcpCost -and $m.ai_partial -eq $true)
$spend = [ordered]@{
    data_source  = $cfgDataSource
    mcp_backed   = $useMcpCost
}
if ($aiMeasured) {
    $dollars = "{0:N2}" -f ([double]$m.ai_cost_cents_mtd / 100)
    $anom = if ([int]$m.ai_anomalies -gt 0) { " ($($m.ai_anomalies) event(s) with invalid cost excluded)" } else { "" }
    $spend.cost_label   = "[MEASURED]"
    $spend.cost_note    = "`$$dollars month-to-date ($($m.ai_calls_mtd) ai_call events via the router's provenance, A8)$anom. Anthropic Console = billing source of truth."
    $spend.tokens_label = "[MEASURED]"
    $spend.tokens_note  = "$($m.ai_tokens_mtd) AI tokens month-to-date (ai_call provenance)."
} elseif ($aiPartial) {
    # events were logged this month but none carried a valid cost -> honest PARTIAL, never a fake $0
    $spend.cost_label   = "[PARTIAL]"
    $spend.cost_note    = "$($m.ai_calls_mtd) ai_call event(s) logged this month but none carried a valid cost -- not shown as `$0.00 (that would be a fabricated number). Anthropic Console = source of truth."
    $spend.tokens_label = "[MEASURED]"
    $spend.tokens_note  = "$($m.ai_tokens_mtd) AI tokens month-to-date (cost unavailable for these events)."
} elseif ($useMcpCost) {
    # MCP-backed mode requested, but the router has logged no ai_call events yet -> graceful degrade
    $spend.cost_label   = "[NOT-TRACKED]"
    $spend.cost_note    = "data_source=$cfgDataSource, but the router has logged no ai_call events yet -- cost flips to [MEASURED] once agents dispatch through the router. Anthropic Console = source of truth."
    $spend.tokens_label = if ($m.last_context_tokens) { "[ESTIMATED]" } else { "[PARTIAL]" }
    $spend.tokens_note  = if ($m.last_context_tokens) { "~$($m.last_context_tokens) tokens/msg (sporadic context-load measure); no ai_call totals yet" } else { "no per-session totals yet" }
} else {
    # terminal mode (default, zero-setup) -- the honest Tier-1 estimated view
    $spend.cost_label   = "[NOT-TRACKED]"
    $spend.cost_note    = "terminal mode -- Anthropic Console -> Usage is the source of truth. Set data_source=mcp in .forge/cockpit.json's dashboard block to surface real ai_call cost."
    $spend.tokens_label = if ($m.last_context_tokens) { "[ESTIMATED]" } else { "[PARTIAL]" }
    $spend.tokens_note  = if ($m.last_context_tokens) { "~$($m.last_context_tokens) tokens/msg (sporadic context-load measure)" } else { "only sporadic context-load measures exist, not per-session totals" }
}

# ---- JSON mode ----
if ($Json) {
    [pscustomobject]@{
        used_cache       = $usedCache
        cache_age_min    = $cacheAgeMin
        data_source      = $cfgDataSource
        sections         = $cfgSections
        measured         = $m
        declared         = $d
        spend            = $spend
    } | ConvertTo-Json -Depth 12
    exit 0
}

# ---- Terminal render ----
function Show($s, $color = "White") { Write-Host $s -ForegroundColor $color }

$freshness = if ($usedCache) { "cached ${cacheAgeMin}m ago -- -Refresh for live" } else { "live" }
Write-Host ""
Show "VIBEPROMPTRIG DASHBOARD" "Cyan"
Show "  ($freshness | data_source: $cfgDataSource)" "DarkGray"
Write-Host ""

if ($cfgSections -contains "status") {
    $doctorColor = if ("$($m.doctor)" -match "0 fail") { "Green" } else { "Yellow" }
    Show "WHERE THINGS STAND [MEASURED]" "White"
    Show ("  Branch:  {0} @ {1}  ""{2}""" -f $m.branch, $m.head, $m.head_subject)
    Show ("  Commits: {0} total | {1} last 7d" -f $m.total_commits, $m.last7_commits)
    $doctorAge = if ($usedCache) { " (as of ${cacheAgeMin}m ago -- -Refresh to recheck)" } else { "" }
    Show ("  Health:  forge doctor {0}{1}" -f $m.doctor, $doctorAge) $doctorColor
    Show ("  Gates:   {0} architect-probes | {1} arch-gates ({2} overrides)" -f $m.architect_probes, $m.arch_gates, $m.gate_overrides) "DarkGray"
    Write-Host ""
}

if ($cfgSections -contains "goals" -and $d -and $d.goals) {
    Show "GOALS + MILESTONES [DECLARED]" "White"
    foreach ($g in $d.goals) {
        Show ("  {0} -- {1}%" -f $g.title, $g.percent_complete) "Cyan"
        if ($g.milestones) {
            $open = @($g.milestones | Where-Object { "$($_.status)" -notmatch "^done" })
            $doneCount = @($g.milestones).Count - $open.Count
            Show ("    {0}/{1} milestones done; open:" -f $doneCount, @($g.milestones).Count) "DarkGray"
            foreach ($ms in ($open | Select-Object -First 6)) {
                $st = "$($ms.status)"; if ($st.Length -gt 64) { $st = $st.Substring(0, 61) + "..." }
                Show ("      - {0}  ({1})" -f $ms.name, $st)
            }
            if ($open.Count -gt 6) { Show ("      ... +{0} more open" -f ($open.Count - 6)) "DarkGray" }
        }
    }
    Write-Host ""
}

if ($cfgSections -contains "blockers" -and $d -and $d.blockers) {
    Show "BLOCKERS [DECLARED]" "White"
    foreach ($b in $d.blockers) { Show ("  - {0}" -f $b) "Yellow" }
    Write-Host ""
}

if ($cfgSections -contains "spend") {
    Show "SPEND (HONEST LIMITS)" "White"
    Show ("  Dollar cost: {0} {1}" -f $spend.cost_label, $spend.cost_note) "DarkGray"
    Show ("  Tokens:      {0} {1}" -f $spend.tokens_label, $spend.tokens_note) "DarkGray"
    Write-Host ""
}

Show "  /dashboard --refresh for live | edit .forge/cockpit.json 'dashboard' block to customize | docs/tutorials/dashboard.md" "DarkGray"
Write-Host ""
exit 0
