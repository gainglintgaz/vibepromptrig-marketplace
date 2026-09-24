<#
.SYNOPSIS
    VibePromptRig session token-budget tracker.
    Reads the transcript JSONL, sums NEW tokens (uncached input + cache-creation +
    output) from assistant turns -- EXCLUDING cache-read re-reads, which repeat the
    same cached context (system prompt + rules + history) every turn and would
    otherwise balloon a normal session's total to millions -- compares against the
    active profile's session_budget_tokens, and warns the user (via stdout) when
    budget thresholds are crossed.

    Fires on UserPromptSubmit (incremental warning) AND Stop (session summary).

.NOTES
    PowerShell 5.1 compatible. ASCII only. Read-only on transcript.
    Hook stdin: {"session_id":"...","transcript_path":"...","hook_event_name":"..."}

    Profile resolution:
      1. <cwd>/.forge/profile.json
      2. <factory_root>/.forge/default-profile.json
      3. built-in fallback (200K session budget)

    Metric output: appends to <factory_root>/factory_metrics.jsonl
#>

param()
$ErrorActionPreference = "SilentlyContinue"

# UTF-8 stdin
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

# --- Double-fire guard (Desktop audit 2026-06-13) -----------------------------
# In a FACTORY session the repo's .claude/settings.json wires this hook AND the
# globally-enabled vibepromptrig plugin wires the same hook -- so it fires twice
# (writing two session_summary rows per Stop, double-counting the meter). When
# THIS copy is the plugin DISTRIBUTION copy (under plugin-dist/ or the plugins
# cache) and the session is running in the factory itself, defer to the
# repo-local copy. Customer sessions are unaffected (cwd is not the factory).
if (($PSScriptRoot -match '[\\/]plugin-dist([\\/]|$)') -or ($PSScriptRoot -match '[\\/]plugins[\\/]cache[\\/]')) {
    $vfCwd = (Get-Location).Path
    if ((Test-Path (Join-Path $vfCwd '.claude-plugin\plugin.json')) -and (Test-Path (Join-Path $vfCwd 'plugin-dist'))) {
        exit 0
    }
}

$FactoryRoot   = $env:VIBE_ROOT   # env-overridable for testability + factory-convention parity
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
# Telemetry root must be the OPERATOR's factory -- never a plugin distribution copy. When this hook
# runs from the in-repo plugin source (plugin-dist), $FactoryRoot resolves to ...\plugin-dist; the
# real factory is its PARENT, so redirect there (this is the 2026-06-12 leak that dropped
# session_summary rows into plugin-dist/factory_metrics.jsonl). When it runs from an installed
# plugins cache there is no adjacent factory, so fall back to $env:VIBE_ROOT, and if that is unset
# skip the telemetry write entirely (a plugin consumer has no factory ledger to append to).
if ((Split-Path -Leaf $FactoryRoot) -eq 'plugin-dist') {
    $FactoryRoot = Split-Path $FactoryRoot -Parent
} elseif ($FactoryRoot -match '[\\/]plugins[\\/]cache[\\/]') {
    $FactoryRoot = $env:VIBE_ROOT   # $null when unset -> $MetricsPath stays null -> write is skipped
}
$MetricsPath   = if ($FactoryRoot) { Join-Path $FactoryRoot "factory_metrics.jsonl" } else { $null }
# Fallback budgets when NO profile file exists -- aligned with profile-resolver.ps1's built-in
# indie-free fallback (50K session / 500K monthly) so the hook and `forge profile show` never
# disagree about the budget. (Was 200K, which matched no preset and diverged from the resolver.)
$FallbackSessionBudget = 50000
$FallbackMonthlyBudget = 500000

# ---- Read hook input ----
$stdin = $null
try { $stdin = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $stdin -or $stdin.Trim().Length -eq 0) { exit 0 }
$hook = $null
try { $hook = $stdin | ConvertFrom-Json } catch { exit 0 }
if (-not $hook) { exit 0 }

$sessionId  = [string]$hook.session_id
$transcript = [string]$hook.transcript_path
$event      = [string]$hook.hook_event_name
if (-not $sessionId) { $sessionId = "unknown" }
if (-not $event)     { $event     = "unknown" }

# ---- Resolve active profile ----
# Resolution MUST mirror scripts/forge/profile-resolver.ps1 (the canonical resolver, which
# `forge profile show` + `/mode` read back through): project <cwd>/.forge/profile.json >
# factory <root>/.forge/default-profile.json > built-in indie-free fallback, with preset-merge
# for any budget field a partial profile.json omits. This hook INLINES that budget-only
# resolution (no child-process spawn) so it stays ~16ms on every UserPromptSubmit -- shelling to
# the resolver -Field would cost a powershell.exe spawn per field on every prompt. CONTRACT: any
# change to the resolution ORDER here must also change profile-resolver.ps1 (single source of truth).
$PresetsDir = Join-Path $FactoryRoot ".forge\profiles"

function Get-ActiveProfile {
    $cwd = (Get-Location).Path
    $candidates = @(
        (Join-Path $cwd ".forge\profile.json"),
        (Join-Path $FactoryRoot ".forge\default-profile.json")
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) {
            try {
                $cfg = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
                return $cfg
            } catch { continue }
        }
    }
    return $null
}

# Resolve a budget field: inline value wins; else the named preset's value (preset-merge, matching
# the resolver); else the indie-free fallback. Uses `$null -ne` (NOT PowerShell truthiness) so a
# DELIBERATE 0 is honored as "guard disabled for this scope" -- never silently replaced by the
# fallback and never printed as a budget the profile file does not actually declare.
function Resolve-BudgetField {
    param($Cfg, [string]$Field, [int]$Fallback)
    if ($Cfg -and ($null -ne $Cfg.$Field)) { return [int]$Cfg.$Field }
    if ($Cfg -and $Cfg.profile -and ($Cfg.profile -ne "custom")) {
        $presetPath = Join-Path $PresetsDir ("{0}.json" -f $Cfg.profile)
        if (Test-Path $presetPath) {
            try {
                $preset = Get-Content $presetPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($null -ne $preset.$Field) { return [int]$preset.$Field }
            } catch { }
        }
    }
    return $Fallback
}

$activeProfile = Get-ActiveProfile
$profileName   = if ($activeProfile -and $activeProfile.profile) { [string]$activeProfile.profile } else { "indie-free" }
$budgetTokens  = Resolve-BudgetField $activeProfile "session_budget_tokens" $FallbackSessionBudget
$monthlyBudget = Resolve-BudgetField $activeProfile "monthly_budget_tokens" $FallbackMonthlyBudget

# ---- Sum tokens from transcript ----
$tokensIn        = 0
$tokensOut       = 0
$tokensCacheRead = 0    # cache re-reads -- tracked for the cost line, EXCLUDED from the budget total
$toolCalls       = 0
$model           = $null
$turnCount       = 0

if ($transcript -and (Test-Path $transcript)) {
    $reader = $null
    try {
        $reader = [System.IO.StreamReader]::new($transcript, [System.Text.Encoding]::UTF8)
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if (-not $line) { continue }
            $msg = $null
            try { $msg = $line | ConvertFrom-Json } catch { continue }
            if (-not $msg) { continue }

            $turnCount++

            # Anthropic transcript format: usage on assistant messages
            $usage = $null
            if ($msg.message -and $msg.message.usage) { $usage = $msg.message.usage }
            elseif ($msg.usage)                       { $usage = $msg.usage }

            if ($usage) {
                if ($usage.input_tokens)  { $tokensIn  += [int]$usage.input_tokens }
                if ($usage.output_tokens) { $tokensOut += [int]$usage.output_tokens }
                if ($usage.cache_creation_input_tokens) { $tokensIn += [int]$usage.cache_creation_input_tokens }
                # cache_read = the SAME cached context (system prompt + rules + history) re-read every
                # turn. Summing it across turns counts one ~300K context N times, exploding the total to
                # millions on a normal session. It is NOT new consumption, so it does NOT count toward the
                # session/monthly token budget. Tracked separately for the (cheap, ~0.1x) cost line only.
                if ($usage.cache_read_input_tokens)     { $tokensCacheRead += [int]$usage.cache_read_input_tokens }
            }

            if ($msg.message -and $msg.message.model -and -not $model) {
                $model = [string]$msg.message.model
            } elseif ($msg.model -and -not $model) {
                $model = [string]$msg.model
            }

            # Count tool_use blocks
            $content = $null
            if ($msg.message -and $msg.message.content) { $content = $msg.message.content }
            elseif ($msg.content)                       { $content = $msg.content }
            if ($content -is [array]) {
                foreach ($block in $content) {
                    if ($block.type -eq "tool_use") { $toolCalls++ }
                }
            }
        }
    } catch {
        # Silently skip parse failures
    } finally {
        if ($reader) { $reader.Dispose() }
    }
}

$total = $tokensIn + $tokensOut
$pctUsed = if ($budgetTokens -gt 0) { [Math]::Round(($total / $budgetTokens) * 100, 1) } else { 0 }

# ---- Monthly token spend month-to-date (G1 -- monthly_budget_tokens guard) ----
# The profile budgets are in TOKENS, so the monthly measure is the sum of per-session token totals
# (session_summary.tokens_total) for the current UTC month -- ONE contribution per session_id (see
# the B-4 note below; these rows are cumulative snapshots, so summing them raw double-counts).
# THIS hook itself writes those rows on Stop. We ALSO read the router's ai_call rows in the same
# single pass (per the directive -- reuse the ai_call format, no second format invented) to surface
# the router's A9 AI cost/tokens in the ceiling notice. The token-budget comparison uses the
# session_summary total; the ai_call cents are the router's SEPARATE A9 cents-cap (already hard-stopped).
$mtdTokens = 0; $mtdAiTokens = 0; $mtdAiCostCents = 0.0
if ($MetricsPath -and (Test-Path $MetricsPath)) {
    $nowU = (Get-Date).ToUniversalTime()
    $monStart = [datetime]::SpecifyKind([datetime]::new($nowU.Year, $nowU.Month, 1, 0, 0, 0), 'Utc')
    # BOUNDED read (directive SS2: "budget math on a JSONL tail -- cap the read; never let it slow
    # every prompt"). Only the last $MetricsTail lines are scanned, so this stays fast on EVERY
    # prompt no matter how large factory_metrics.jsonl grows (an append-only file). The monthly
    # token budget is gated on session_summary rows (~1 per session), so 8000 tail lines covers
    # many months of them; at extreme ai_call volume this can slightly UNDERCOUNT month-to-date --
    # acceptable for a non-blocking ADVISORY (it can only under-warn, never falsely block or lock).
    $MetricsTail = 8000
    $lines = $null
    try { $lines = Get-Content -LiteralPath $MetricsPath -Tail $MetricsTail -Encoding UTF8 } catch { $lines = $null }
    if ($lines) {
        # B-4 FIX (2026-07-24, ported to the .ps1 twin 2026-08-15): session_summary rows are
        # CUMULATIVE per-session snapshots -- this hook rewrites one on EVERY Stop, so a session that
        # stops 10 times leaves 10 rows each carrying the full running total. Summing every row
        # multiplied each session by its stop count: July 2026 had 706 rows across 65 distinct
        # sessions -> a measured 10.0x inflation. The .mjs twin got this fix; this twin did not, and
        # the PLUGIN ships only the .ps1 -- so every plugin-consumer session read an inflated month
        # (2026-08-15: reported 4,024,642,998 / 201.2% vs the true 412,175,662 / 20.6%, a 9.78x
        # over-report). Keep the MAX per session_id, then sum once per session.
        # ai_call rows are per-call (NOT cumulative) and are still summed directly -- do not dedupe those.
        $mtdBySession = @{}
        $anonSeq = 0
        foreach ($l in $lines) {
            if (-not $l) { continue }
            if ($l -notmatch '"event":"(session_summary|ai_call)"') { continue }
            $e = $null; try { $e = $l | ConvertFrom-Json } catch { continue }
            if (-not $e -or -not $e.ts) { continue }
            $td = $null; try { $td = ([datetimeoffset]::Parse([string]$e.ts)).UtcDateTime } catch { continue }
            if ($td -lt $monStart) { continue }
            if ($e.event -eq 'session_summary') {
                $tt = $e.tokens_total -as [int]
                if ($tt) {
                    # A row with no session_id cannot be deduped -- give it a unique key so it still
                    # counts once (under-counting is acceptable per the bounded-read contract;
                    # double-counting is not).
                    if ($null -ne $e.session_id -and ([string]$e.session_id) -ne '') {
                        $sid = [string]$e.session_id
                    } else {
                        $sid = "(anon-$anonSeq)"; $anonSeq++
                    }
                    if (-not $mtdBySession.ContainsKey($sid) -or $tt -gt $mtdBySession[$sid]) { $mtdBySession[$sid] = $tt }
                }
            } elseif ($e.event -eq 'ai_call') {
                $ti = $e.tokens_in -as [int];  if ($null -eq $ti) { $ti = 0 }
                $to = $e.tokens_out -as [int]; if ($null -eq $to) { $to = 0 }
                $mtdAiTokens += ($ti + $to)
                if ($null -ne $e.cost_cents) {
                    $cc = $e.cost_cents -as [double]
                    if ($null -ne $cc -and -not [double]::IsNaN($cc) -and -not [double]::IsInfinity($cc) -and $cc -ge 0) { $mtdAiCostCents += $cc }
                }
            }
        }
        # One contribution per session (see B-4 note above), not one per Stop-written snapshot.
        foreach ($v in $mtdBySession.Values) { $mtdTokens += $v }
    }
}
$mtdAiCostCents = [math]::Round($mtdAiCostCents, 2)
$monthlyPct = if ($monthlyBudget -gt 0) { [Math]::Round(($mtdTokens / $monthlyBudget) * 100, 1) } else { 0 }

# ---- Cost estimate (rough, in cents -- aligns with Claude API pricing) ----
# Use $3/M input and $15/M output for sonnet/opus rough avg; for haiku $0.8/M, $4/M.
# We don't always know exact model; default to sonnet rates.
$costPerMIn  = 300       # cents per million input tokens
$costPerMOut = 1500      # cents per million output tokens
if ($model -match '(?i)haiku') { $costPerMIn = 80;  $costPerMOut = 400 }
if ($model -match '(?i)opus')  { $costPerMIn = 1500; $costPerMOut = 7500 }
# cache reads bill at ~0.1x the input rate; include them here so the cost line stays honest even
# though they are (correctly) EXCLUDED from the token-budget total above.
$costCents = [Math]::Round((($tokensIn / 1000000.0) * $costPerMIn) + (($tokensOut / 1000000.0) * $costPerMOut) + (($tokensCacheRead / 1000000.0) * ($costPerMIn * 0.1)), 2)

# ---- Budget guard (G1): warn at 80%, LOUD at 100%+, for SESSION and MONTHLY. UserPromptSubmit only.
# NEVER hard-blocks: a UserPromptSubmit hook that blocked would stop the user mid-thought with no
# recourse (hostile). The decision to continue stays with the human; this just makes the cost
# impossible to miss (VIBE Rule 21 -- surface the breach, don't lock the user out of their own tool).
# The router's assertWithinBudget hard-stop is the right place for a true STOP (automated dispatch).
if ($event -eq "UserPromptSubmit") {
    $notes = @()
    if ($pctUsed -ge 100) {
        $notes += "[BUDGET CEILING] This SESSION has used $total tokens -- $pctUsed% of the '$profileName' session budget ($budgetTokens). You're past the ceiling. Options: /clear to start fresh, 'forge config set session_budget_tokens <n>' to raise it, or /mode max for a bigger budget. Nothing is blocked -- your call."
    } elseif ($pctUsed -ge 80) {
        $notes += "[BUDGET 80%] This session is at $pctUsed% of the '$profileName' session budget ($budgetTokens tokens). Consider /clear, or /mode lean to burn less, if you want to keep going without hitting limits."
    }
    if ($monthlyBudget -gt 0) {
        if ($monthlyPct -ge 100) {
            $notes += "[MONTHLY CEILING] Month-to-date $mtdTokens tokens -- $monthlyPct% of '$profileName' monthly_budget_tokens ($monthlyBudget). Raise with 'forge config set monthly_budget_tokens <n>', switch /mode max, or stop here. Your call -- not blocked."
        } elseif ($monthlyPct -ge 80) {
            $notes += "[MONTHLY 80%] Month-to-date at $monthlyPct% of the '$profileName' monthly budget ($monthlyBudget tokens)."
        }
    }
    if ($notes.Count -gt 0) {
        Write-Output ""
        foreach ($n in $notes) { Write-Output $n }
        if ($mtdAiCostCents -gt 0) {
            Write-Output ("              (router AI spend month-to-date: `$$('{0:N2}' -f ($mtdAiCostCents / 100)) over $mtdAiTokens ai_call tokens -- A9 provenance.)")
        }
    }
}

# ---- Write factory_metrics.jsonl entry on Stop event ----
# $MetricsPath is null when this hook runs from an installed plugins cache with no $env:VIBE_ROOT
# (a plugin consumer with no factory ledger) -- skip the write rather than pollute the cache.
if ($event -eq "Stop" -and $MetricsPath) {
    $entry = [ordered]@{
        ts            = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        event         = "session_summary"
        session_id    = $sessionId
        project       = (Split-Path -Leaf (Get-Location).Path)
        profile       = $profileName
        model         = $model
        msg_count     = $turnCount
        tool_calls    = $toolCalls
        tokens_in     = $tokensIn
        tokens_out    = $tokensOut
        tokens_cache_read = $tokensCacheRead
        tokens_total  = $total
        budget_tokens = $budgetTokens
        pct_used      = $pctUsed
        cost_cents    = $costCents
    }
    try {
        $line = $entry | ConvertTo-Json -Compress -Depth 5
        Add-Content -Path $MetricsPath -Value $line -Encoding UTF8
    } catch { }
}

exit 0
