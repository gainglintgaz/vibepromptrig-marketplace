<#
.SYNOPSIS
    Resolve the effective VibePromptRig profile for the current project.

.DESCRIPTION
    Resolution order (first match wins):
      1. Project-level: <project>/.forge/profile.json
      2. Factory default: <factory>/.forge/default-profile.json
      3. Built-in fallback: indie-free preset (safest, smallest)

    If the resolved profile references a preset by name (e.g., "solo-pro"), the
    preset values from .forge/profiles/<name>.json are merged underneath, with
    project-level keys overriding preset keys (deep merge for user_overrides).

    Outputs JSON to stdout (machine-readable) or formatted summary (-Pretty).

.PARAMETER ProjectRoot
    Project directory to resolve profile for. Defaults to current working dir.

.PARAMETER FactoryRoot
    Factory root. Defaults to $env:VIBE_ROOT, else derived from the script location.

.PARAMETER Pretty
    Print human-readable summary instead of JSON. For CLI display.

.PARAMETER Field
    Output a single field's value (e.g., -Field session_budget_tokens). Useful for hook scripts.

.EXAMPLE
    .\scripts\forge\profile-resolver.ps1
    Resolve profile for current dir, output JSON.

.EXAMPLE
    .\scripts\forge\profile-resolver.ps1 -ProjectRoot C:\path\to\project -Pretty
    Human-readable summary.

.EXAMPLE
    .\scripts\forge\profile-resolver.ps1 -Field session_budget_tokens
    Output just the budget number for hook consumption.

.NOTES
    PowerShell ASCII-only per CLAUDE.md SS10. No em-dashes, no emoji.
#>
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Pretty,
    [switch]$Verbose_Output,   # technical detail (old default Pretty view)
    [switch]$Json,             # machine-readable JSON
    [switch]$Terse,            # single-line summary
    [string]$Field = ""
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------
# Step 1: Locate profile sources
# ---------------------------------------------------------------
$ProjectProfilePath = Join-Path $ProjectRoot ".forge\profile.json"
$FactoryDefaultPath = Join-Path $FactoryRoot ".forge\default-profile.json"
$PresetsDir = Join-Path $FactoryRoot ".forge\profiles"

# ---------------------------------------------------------------
# Step 2: Load the active profile (project > factory default > fallback)
# ---------------------------------------------------------------
$activeSource = "fallback"
$active = $null

if (Test-Path $ProjectProfilePath) {
    $active = Get-Content $ProjectProfilePath -Raw | ConvertFrom-Json
    $activeSource = "project ($ProjectProfilePath)"
} elseif (Test-Path $FactoryDefaultPath) {
    $active = Get-Content $FactoryDefaultPath -Raw | ConvertFrom-Json
    $activeSource = "factory ($FactoryDefaultPath)"
} else {
    # Built-in fallback - hardcoded indie-free preset to guarantee resolver never fails
    $active = [PSCustomObject]@{
        profile = "indie-free"
        ai_plan = "claude-free"
        byok = $false
        monthly_budget_tokens = 500000
        session_budget_tokens = 50000
        verbosity = "terse"
        rule_tier = "essential"
        agents_enabled = @()
        skills_enabled = @("catchup", "today", "ship-status")
        hooks_enabled = @("destructive-sql-blocker")
        subagent_dispatch_threshold_tokens = 0
        compaction_trigger_percent = 50
        tool_result_truncation_kb = 10
        llm_cache_ttl_hours = 168
        vertical_pack = $null
        compliance_overlay = @()
        user_overrides = [PSCustomObject]@{
            rules_added = @(); rules_removed = @()
            agents_added = @(); agents_removed = @()
            skills_added = @(); skills_removed = @()
            hooks_added = @(); hooks_removed = @()
        }
        factory_version_at_init = "v4.4"
    }
    $activeSource = "built-in fallback (no profile files found)"
}

# ---------------------------------------------------------------
# Step 3: If profile references a preset by name, merge preset values underneath
# ---------------------------------------------------------------
if ($active.profile -and $active.profile -ne "custom") {
    $presetPath = Join-Path $PresetsDir "$($active.profile).json"
    if (Test-Path $presetPath) {
        $preset = Get-Content $presetPath -Raw | ConvertFrom-Json
        # Merge: preset values for anything missing from $active
        foreach ($prop in $preset.PSObject.Properties) {
            if (-not $active.PSObject.Properties[$prop.Name] -or
                ($null -eq $active.$($prop.Name) -and $prop.Name -ne "vertical_pack")) {
                $active | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value -Force
            }
        }
    }
}

# ---------------------------------------------------------------
# Step 4: Apply user_overrides to resolve final lists
# ---------------------------------------------------------------
function Apply-Overrides {
    param($BaseList, $Added, $Removed)
    if (-not $BaseList) { $BaseList = @() }
    if (-not $Added) { $Added = @() }
    if (-not $Removed) { $Removed = @() }
    $result = @($BaseList) + @($Added) | Select-Object -Unique
    $result = $result | Where-Object { $Removed -notcontains $_ }
    return @($result)
}

$overrides = $active.user_overrides
$effectiveAgents = Apply-Overrides $active.agents_enabled $overrides.agents_added $overrides.agents_removed
$effectiveSkills = Apply-Overrides $active.skills_enabled $overrides.skills_added $overrides.skills_removed
$effectiveHooks = Apply-Overrides $active.hooks_enabled $overrides.hooks_added $overrides.hooks_removed

# ---------------------------------------------------------------
# Step 5: Construct effective config (read-only result)
# ---------------------------------------------------------------
$effective = [ordered]@{
    profile = $active.profile
    ai_plan = $active.ai_plan
    byok = $active.byok
    monthly_budget_tokens = $active.monthly_budget_tokens
    session_budget_tokens = $active.session_budget_tokens
    verbosity = $active.verbosity
    rule_tier = $active.rule_tier
    agents_effective = $effectiveAgents
    skills_effective = $effectiveSkills
    hooks_effective = $effectiveHooks
    subagent_dispatch_threshold_tokens = $active.subagent_dispatch_threshold_tokens
    compaction_trigger_percent = $active.compaction_trigger_percent
    tool_result_truncation_kb = $active.tool_result_truncation_kb
    llm_cache_ttl_hours = $active.llm_cache_ttl_hours
    vertical_pack = $active.vertical_pack
    compliance_overlay = $active.compliance_overlay
    factory_version_at_init = $active.factory_version_at_init
    _meta = [ordered]@{
        project_root = $ProjectRoot
        factory_root = $FactoryRoot
        source = $activeSource
        resolved_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    }
}

# ---------------------------------------------------------------
# Step 6: Output
# ---------------------------------------------------------------
if ($Field) {
    if ($effective.Contains($Field)) {
        Write-Output $effective[$Field]
    } else {
        Write-Error "Field not found: $Field"
        exit 1
    }
    exit 0
}

# ---------------------------------------------------------------
# Step 7: Plain-English translation (load plan info)
# ---------------------------------------------------------------
$translationsPath = Join-Path $FactoryRoot ".forge\plan-translations.json"
$planInfo = $null
if (Test-Path $translationsPath) {
    $translations = Get-Content $translationsPath -Raw | ConvertFrom-Json
    $planInfo = $translations.plans.($effective.ai_plan)
}

function Format-TokenInPlainEnglish {
    param([int]$Tokens)
    if ($Tokens -ge 1000000) {
        return "{0:N1}M" -f ($Tokens / 1000000)
    } elseif ($Tokens -ge 1000) {
        return "{0:N0}K" -f ($Tokens / 1000)
    } else {
        return "$Tokens"
    }
}

function Get-TokenMeaning {
    param([int]$Tokens)
    if ($Tokens -lt 30000)       { return "roughly 15-30 messages OR one quick task" }
    elseif ($Tokens -lt 80000)   { return "roughly 30-50 messages OR a short coding task" }
    elseif ($Tokens -lt 200000)  { return "roughly 60-150 messages OR a full afternoon of coding" }
    elseif ($Tokens -lt 400000)  { return "roughly 100-300 messages OR multiple sessions per day" }
    else                         { return "roughly 200-500 messages OR all-day coding capacity" }
}

# ---------------------------------------------------------------
# Step 8: Usage stats (read factory_metrics.jsonl if it exists)
# ---------------------------------------------------------------
$metricsPath = Join-Path $FactoryRoot "factory_metrics.jsonl"
$usage = [PSCustomObject]@{
    today = 0
    week = 0
    month = 0
    has_data = $false
}
if (Test-Path $metricsPath) {
    $now = Get-Date
    $todayStart = $now.Date
    $weekStart = $now.Date.AddDays(-7)
    $monthStart = $now.Date.AddDays(-30)
    Get-Content $metricsPath | ForEach-Object {
        try {
            $entry = $_ | ConvertFrom-Json
            $ts = [datetime]$entry.ts
            $tokensUsed = ($entry.tokens_in -as [int]) + ($entry.tokens_out -as [int])
            if ($ts -ge $todayStart) { $usage.today += $tokensUsed }
            if ($ts -ge $weekStart)  { $usage.week += $tokensUsed }
            if ($ts -ge $monthStart) { $usage.month += $tokensUsed }
            $usage.has_data = $true
        } catch {}
    }
}

# ---------------------------------------------------------------
# Step 9: Output (4 modes)
# ---------------------------------------------------------------
if ($Field) {
    if ($effective.Contains($Field)) {
        Write-Output $effective[$Field]
    } else {
        Write-Error "Field not found: $Field"
        exit 1
    }
    exit 0
}

if ($Json) {
    # Machine-readable mode (also used by hooks to consume effective config)
    $output = [ordered]@{
        effective = $effective
        plan_info = $planInfo
        usage = $usage
    }
    $output | ConvertTo-Json -Depth 8
    exit 0
}

if ($Terse) {
    # Single-line summary (fits in narrow terminal, low token consumption when Claude reads it)
    $planName = if ($planInfo) { $planInfo.display_name } else { $effective.ai_plan }
    $sessBudget = Format-TokenInPlainEnglish $effective.session_budget_tokens
    Write-Host ("forge: {0} | plan {1} | session {2} ({3} agents, {4} skills, {5} hooks)" -f `
        $effective.profile, $planName, $sessBudget, `
        $effective.agents_effective.Count, $effective.skills_effective.Count, $effective.hooks_effective.Count)
    exit 0
}

if ($Verbose_Output) {
    # Technical detail (old default Pretty view) - for power users / debugging
    Write-Host ""
    Write-Host "VibePromptRig profile (effective, verbose)" -ForegroundColor Cyan
    Write-Host "  Source            : $($effective._meta.source)" -ForegroundColor DarkGray
    Write-Host "  Project root      : $($effective._meta.project_root)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host ("  Profile           : {0}" -f $effective.profile) -ForegroundColor White
    Write-Host ("  AI plan           : {0}" -f $effective.ai_plan) -ForegroundColor White
    Write-Host ("  BYOK              : {0}" -f $effective.byok) -ForegroundColor White
    Write-Host ("  Verbosity         : {0}" -f $effective.verbosity) -ForegroundColor White
    Write-Host ("  Rule tier         : {0}" -f $effective.rule_tier) -ForegroundColor White
    Write-Host ""
    Write-Host ("  Session budget    : {0:N0} tokens" -f $effective.session_budget_tokens) -ForegroundColor White
    Write-Host ("  Monthly budget    : {0:N0} tokens" -f $effective.monthly_budget_tokens) -ForegroundColor White
    Write-Host ""
    Write-Host ("  Active agents     : {0}" -f $effective.agents_effective.Count) -ForegroundColor White
    Write-Host ("  Active skills     : {0}" -f $effective.skills_effective.Count) -ForegroundColor White
    Write-Host ("  Active hooks      : {0}" -f $effective.hooks_effective.Count) -ForegroundColor White
    if ($effective.vertical_pack) {
        Write-Host ("  Vertical pack     : {0}" -f $effective.vertical_pack) -ForegroundColor Yellow
    }
    if ($effective.compliance_overlay -and $effective.compliance_overlay.Count -gt 0) {
        Write-Host ("  Compliance        : {0}" -f ($effective.compliance_overlay -join ", ")) -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Behavior tuning:" -ForegroundColor DarkCyan
    Write-Host ("    Subagent dispatch threshold : {0:N0} tokens" -f $effective.subagent_dispatch_threshold_tokens) -ForegroundColor DarkGray
    Write-Host ("    Compaction trigger          : {0}%" -f $effective.compaction_trigger_percent) -ForegroundColor DarkGray
    Write-Host ("    Tool result truncation      : {0} KB" -f $effective.tool_result_truncation_kb) -ForegroundColor DarkGray
    Write-Host ("    LLM cache TTL               : {0} hr" -f $effective.llm_cache_ttl_hours) -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

if ($Pretty) {
    # Default human-readable view -- plain English, what customer cares about
    Write-Host ""
    Write-Host "Your VibePromptRig setup" -ForegroundColor Cyan
    Write-Host ""

    # Plan
    if ($planInfo) {
        Write-Host ("  You are on        : {0} ({1})" -f $planInfo.display_name, $planInfo.cost) -ForegroundColor White
        Write-Host ("  What this gives   : {0}" -f $planInfo.what_you_get) -ForegroundColor DarkGray
        Write-Host ("  Good for          : {0}" -f $planInfo.good_for) -ForegroundColor DarkGray
        Write-Host ("  Not for           : {0}" -f $planInfo.not_for) -ForegroundColor DarkGray
        Write-Host ""
    } else {
        Write-Host ("  AI plan (unknown) : {0}" -f $effective.ai_plan) -ForegroundColor Yellow
    }

    # Budget in lay terms
    $sessionInPlain = Format-TokenInPlainEnglish $effective.session_budget_tokens
    $sessionMeaning = Get-TokenMeaning $effective.session_budget_tokens
    $monthlyInPlain = Format-TokenInPlainEnglish $effective.monthly_budget_tokens

    Write-Host "  Budget per session: $sessionInPlain tokens" -ForegroundColor White
    Write-Host "    (That is        : $sessionMeaning)" -ForegroundColor DarkGray
    Write-Host "  Monthly budget    : $monthlyInPlain tokens" -ForegroundColor White
    if ($planInfo -and $planInfo.limit_resets) {
        Write-Host "    Limit resets    : $($planInfo.limit_resets)" -ForegroundColor DarkGray
    }
    Write-Host ""

    # Usage (if metrics exist)
    if ($usage.has_data) {
        $todayPct = if ($effective.monthly_budget_tokens -gt 0) { [math]::Round(100 * $usage.today / ($effective.monthly_budget_tokens / 30), 0) } else { 0 }
        $weekPct  = if ($effective.monthly_budget_tokens -gt 0) { [math]::Round(100 * $usage.week / ($effective.monthly_budget_tokens / 4), 0) } else { 0 }
        $monthPct = if ($effective.monthly_budget_tokens -gt 0) { [math]::Round(100 * $usage.month / $effective.monthly_budget_tokens, 0) } else { 0 }
        Write-Host "  Your usage:" -ForegroundColor Cyan
        Write-Host ("    Today           : {0} tokens  ({1}% of daily average)" -f (Format-TokenInPlainEnglish $usage.today), $todayPct) -ForegroundColor White
        Write-Host ("    Last 7 days     : {0} tokens  ({1}% of weekly average)" -f (Format-TokenInPlainEnglish $usage.week), $weekPct) -ForegroundColor White
        Write-Host ("    Last 30 days    : {0} tokens  ({1}% of monthly budget)" -f (Format-TokenInPlainEnglish $usage.month), $monthPct) -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host "  Your usage        : (no data yet -- tracker ships in v4.4 Week 4)" -ForegroundColor DarkGray
        Write-Host ""
    }

    # Count active rules based on tier (frontmatter of the relocated rule corpus, Context V2 Delivery 3b)
    $rulesDir = Join-Path $FactoryRoot "docs\rules-reference\factory"
    $activeRuleCount = 0
    if (Test-Path $rulesDir) {
        $tierOrder = @{ "essential" = 1; "standard" = 2; "full" = 3 }
        $userTierLevel = $tierOrder[$effective.rule_tier]
        if (-not $userTierLevel) { $userTierLevel = 1 }
        Get-ChildItem $rulesDir -Filter "*.md" | ForEach-Object {
            $first6 = (Get-Content $_.FullName -TotalCount 6) -join "`n"
            if ($first6 -match "tier:\s*(\w+)") {
                $ruleTierLevel = $tierOrder[$matches[1]]
                if ($ruleTierLevel -and $ruleTierLevel -le $userTierLevel) {
                    $activeRuleCount++
                }
            }
        }
    }

    # Helper to format list with truncation
    function Format-FeatureList {
        param([array]$Items, [int]$ShowFirst = 4)
        if (-not $Items -or $Items.Count -eq 0) { return "none" }
        $shown = @($Items) | Select-Object -First $ShowFirst
        $joined = $shown -join ', '
        if ($Items.Count -gt $ShowFirst) {
            $joined += ", + $($Items.Count - $ShowFirst) more"
        }
        return $joined
    }

    # What is active in plain English
    Write-Host "  Active features:" -ForegroundColor Cyan
    Write-Host ("    Coding rules     : {0} loaded ({1} tier)" -f $activeRuleCount, $effective.rule_tier) -ForegroundColor White
    Write-Host ("                       (run 'forge rule list' to see them)") -ForegroundColor DarkGray
    Write-Host ("    Helper agents    : {0} ({1})" -f $effective.agents_effective.Count, (Format-FeatureList $effective.agents_effective 4)) -ForegroundColor White
    Write-Host ("    Quick commands   : {0} ({1})" -f $effective.skills_effective.Count, (Format-FeatureList $effective.skills_effective 5)) -ForegroundColor White
    Write-Host ("    Safety guards    : {0} ({1})" -f $effective.hooks_effective.Count, (Format-FeatureList $effective.hooks_effective 3)) -ForegroundColor White
    if ($effective.vertical_pack) {
        Write-Host ("    Vertical pack    : {0}" -f $effective.vertical_pack) -ForegroundColor Yellow
    }
    if ($effective.compliance_overlay -and $effective.compliance_overlay.Count -gt 0) {
        Write-Host ("    Compliance       : {0}" -f ($effective.compliance_overlay -join ', ')) -ForegroundColor Yellow
    }
    Write-Host ""

    # Warnings
    Write-Host "  When factory will warn you:" -ForegroundColor Cyan
    $warn70 = Format-TokenInPlainEnglish ([int]($effective.session_budget_tokens * 0.7))
    $warn90 = Format-TokenInPlainEnglish ([int]($effective.session_budget_tokens * 0.9))
    Write-Host ("    Yellow warning   : at $warn70 tokens used in a session (70%)") -ForegroundColor DarkGray
    Write-Host ("    Red warning      : at $warn90 tokens used in a session (90%)") -ForegroundColor DarkGray
    Write-Host ""

    # Help
    Write-Host "  Want more detail?" -ForegroundColor DarkGray
    Write-Host "    forge profile show --verbose    show technical detail" -ForegroundColor DarkGray
    Write-Host "    forge profile show --terse      one-line summary" -ForegroundColor DarkGray
    Write-Host "    forge profile show --json       machine-readable" -ForegroundColor DarkGray
    Write-Host "    forge profile list              show all available presets" -ForegroundColor DarkGray
    Write-Host "    forge profile set <name>        switch to a different preset" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# No flags -- default to JSON (machine-readable)
$effective | ConvertTo-Json -Depth 6
