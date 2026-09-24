<#
.SYNOPSIS
    forge rule -- list / show / add / remove / explain rule activation.

.DESCRIPTION
    Reads tier frontmatter from docs/rules-reference/factory/*.md and reconciles against
    the current project's profile + user_overrides.

    Subcommands:
      list                 Rules active in current profile.
      list --available     All rules + tier + which profiles load them.
      show <name>          Display rule title + tier + first paragraph (truncated).
      add <name>           Append to user_overrides.rules_added in .forge/profile.json.
      remove <name>        Append to user_overrides.rules_removed. Refuses if required: true.
      explain              Explain the tier system in plain English.

.EXAMPLE
    forge rule list
    forge rule list --available
    forge rule show vibe-standard
    forge rule add ai-first-principles
    forge rule remove consulting
    forge rule explain

.NOTES
    PowerShell ASCII-only. Rule name accepts trailing .md or not.
#>
param(
    [Parameter(Position = 0)]
    [string]$SubCommand = "list",

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$RestArgs = @()
)

$ErrorActionPreference = "Stop"

$FactoryRoot = $env:VIBE_ROOT
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ProjectRoot = (Get-Location).Path
# Every legacy rule body lives outside native autoload since Context V2 Delivery 3b.
$RulesDir = Join-Path $FactoryRoot "docs\rules-reference\factory"
$RuleDirs = @($RulesDir)
function Get-RulePath([string]$Name) {
    foreach ($dir in $RuleDirs) { $p = Join-Path $dir "$Name.md"; if (Test-Path $p) { return $p } }
    return (Join-Path $RulesDir "$Name.md")
}
$ProjectProfile = Join-Path $ProjectRoot ".forge\profile.json"
$ResolverScript = Join-Path $FactoryRoot "scripts\forge\profile-resolver.ps1"

# Extract flags from RestArgs
$Available = $false
$NameArg = ""
foreach ($a in $RestArgs) {
    switch -Regex ($a) {
        '^--available$' { $Available = $true }
        '^--all$'       { $Available = $true }
        default         { if (-not $NameArg) { $NameArg = $a } }
    }
}

# ----------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------

function Normalize-RuleName {
    param([string]$Name)
    $n = $Name -replace '\.md$', ''
    $n.Trim()
}

function Get-RuleMeta {
    param([string]$RulePath)
    $content = Get-Content $RulePath -Raw -Encoding UTF8
    $meta = @{
        name     = [System.IO.Path]::GetFileNameWithoutExtension($RulePath)
        tier     = "standard"
        required = $false
        profiles = @()
        title    = ""
        summary  = ""
    }
    # Strip optional BOM
    if ($content.Length -gt 0 -and [int]$content[0] -eq 0xFEFF) {
        $content = $content.Substring(1)
    }
    $front = ""
    $body = $content
    if ($content -match '(?s)^---\s*\r?\n(.+?)\r?\n---\s*\r?\n(.*)') {
        $front = $matches[1]
        $body = $matches[2]
    }
    if ($front) {
        foreach ($line in ($front -split "\r?\n")) {
            if ($line -match '^\s*tier:\s*(\S+)') { $meta.tier = $matches[1] }
            elseif ($line -match '^\s*required:\s*(true|false)') { $meta.required = ($matches[1] -eq 'true') }
            elseif ($line -match '^\s*profiles:\s*\[(.+)\]') {
                $meta.profiles = ($matches[1] -split ',') | ForEach-Object { $_.Trim() }
            }
        }
        # First H1 = title
        if ($body -match '(?m)^#\s+(.+?)\s*$') { $meta.title = $matches[1] }
        # First non-blank paragraph after frontmatter that isn't the H1 or a quote
        $paragraphs = $body -split "(\r?\n){2,}"
        foreach ($p in $paragraphs) {
            $p = $p.Trim()
            if (-not $p) { continue }
            if ($p -match '^#') { continue }
            if ($p -match '^>') { continue }
            $meta.summary = ($p -split "\r?\n")[0]
            break
        }
    }
    [PSCustomObject]$meta
}

function Get-AllRules {
    Get-ChildItem ($RuleDirs | Where-Object { Test-Path $_ }) -Filter "*.md" -File | ForEach-Object {
        Get-RuleMeta -RulePath $_.FullName
    }
}

function Get-EffectiveProfile {
    if (Test-Path $ResolverScript) {
        $json = & $ResolverScript -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String
        try {
            return ($json | ConvertFrom-Json).effective
        } catch {
            return $null
        }
    }
    return $null
}

function Get-ProjectProfileRaw {
    if (Test-Path $ProjectProfile) {
        return Get-Content $ProjectProfile -Raw | ConvertFrom-Json
    }
    return $null
}

function Save-ProjectProfile {
    param($Profile)
    $Profile | Add-Member -NotePropertyName "updated_at" -NotePropertyValue (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ") -Force
    $Profile | ConvertTo-Json -Depth 6 | Set-Content -Path $ProjectProfile -Encoding UTF8
}

function Test-RuleActive {
    param($RuleMeta, $EffectiveProfile)
    if (-not $EffectiveProfile) { return $RuleMeta.required }

    $profName = $EffectiveProfile.profile
    $tierAllowed = @{
        "essential" = @("essential", "standard", "full")
        "standard"  = @("standard", "full")
        "full"      = @("full")
    }
    # rule_tier is what the profile accepts as MIN tier
    $profileTier = $EffectiveProfile.rule_tier
    if (-not $profileTier) { $profileTier = "standard" }

    # required rules always active
    if ($RuleMeta.required) { $active = $true }
    elseif ($RuleMeta.profiles -and ($RuleMeta.profiles -contains $profName)) { $active = $true }
    else { $active = $false }

    # user_overrides
    $rp = Get-ProjectProfileRaw
    if ($rp -and $rp.user_overrides) {
        $added = @($rp.user_overrides.rules_added)
        $removed = @($rp.user_overrides.rules_removed)
        if ($added -contains $RuleMeta.name) { $active = $true }
        if ($removed -contains $RuleMeta.name -and -not $RuleMeta.required) { $active = $false }
    }
    return $active
}

# ----------------------------------------------------------------
# Subcommands
# ----------------------------------------------------------------
switch ($SubCommand) {

    "list" {
        $effective = Get-EffectiveProfile
        $rules = Get-AllRules | Sort-Object name
        Write-Host ""
        if ($Available) {
            Write-Host "All rules ($($rules.Count) total)" -ForegroundColor Cyan
            $profName = if ($effective) { $effective.profile } else { "(no profile)" }
            Write-Host "  Current profile: $profName" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host ("  {0,-32} {1,-10} {2,-7} {3}" -f "RULE", "TIER", "ACTIVE", "PROFILES") -ForegroundColor DarkGray
            foreach ($r in $rules) {
                $active = Test-RuleActive -RuleMeta $r -EffectiveProfile $effective
                $glyph = if ($active) { "yes" } else { "no" }
                $color = if ($active) { "White" } else { "DarkGray" }
                $profs = if ($r.profiles) { $r.profiles -join "," } else { "-" }
                Write-Host ("  {0,-32} {1,-10} {2,-7} {3}" -f $r.name, $r.tier, $glyph, $profs) -ForegroundColor $color
            }
        } else {
            $active = $rules | Where-Object { Test-RuleActive -RuleMeta $_ -EffectiveProfile $effective }
            $profName = if ($effective) { $effective.profile } else { "(no profile)" }
            Write-Host "Active rules for profile: $profName" -ForegroundColor Cyan
            Write-Host "  $($active.Count) of $($rules.Count) rule files loaded" -ForegroundColor DarkGray
            Write-Host ""
            foreach ($r in $active) {
                $tierLabel = if ($r.required) { "$($r.tier) (required)" } else { $r.tier }
                Write-Host ("  {0,-32} {1}" -f $r.name, $tierLabel) -ForegroundColor White
            }
            Write-Host ""
            Write-Host "Run 'forge rule list --available' for all rules + which profiles load them." -ForegroundColor DarkGray
        }
        Write-Host ""
    }

    "show" {
        if (-not $NameArg) {
            Write-Error "Usage: forge rule show <name>"
            exit 1
        }
        $name = Normalize-RuleName $NameArg
        $path = Get-RulePath $name
        if (-not (Test-Path $path)) {
            Write-Host "No rule named '$name'. Run 'forge rule list --available' to see options." -ForegroundColor Red
            exit 1
        }
        $r = Get-RuleMeta -RulePath $path
        $effective = Get-EffectiveProfile
        $active = Test-RuleActive -RuleMeta $r -EffectiveProfile $effective

        Write-Host ""
        Write-Host $r.name -ForegroundColor Cyan
        if ($r.title) { Write-Host "  $($r.title)" -ForegroundColor White }
        Write-Host ""
        Write-Host ("  Tier:      {0}" -f $r.tier) -ForegroundColor DarkGray
        Write-Host ("  Required:  {0}" -f $(if ($r.required) { "yes" } else { "no" })) -ForegroundColor DarkGray
        Write-Host ("  Profiles:  {0}" -f $(if ($r.profiles) { $r.profiles -join ", " } else { "-" })) -ForegroundColor DarkGray
        Write-Host ("  Active:    {0}" -f $(if ($active) { "yes (in current profile)" } else { "no (not loaded for current profile)" })) -ForegroundColor DarkGray
        if ($r.summary) {
            Write-Host ""
            $summary = $r.summary
            if ($summary.Length -gt 300) { $summary = $summary.Substring(0, 300) + "..." }
            Write-Host "  $summary" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "  Full text: $path" -ForegroundColor DarkGray
        Write-Host ""
    }

    "add" {
        if (-not $NameArg) {
            Write-Error "Usage: forge rule add <name>"
            exit 1
        }
        $name = Normalize-RuleName $NameArg
        $path = Get-RulePath $name
        if (-not (Test-Path $path)) {
            Write-Host "No rule named '$name'. Run 'forge rule list --available' to see options." -ForegroundColor Red
            exit 1
        }
        $rp = Get-ProjectProfileRaw
        if (-not $rp) {
            Write-Host "No project profile yet. Run 'forge init' first." -ForegroundColor Red
            exit 1
        }
        if (-not $rp.user_overrides) {
            $rp | Add-Member -NotePropertyName "user_overrides" -NotePropertyValue ([PSCustomObject]@{
                rules_added = @(); rules_removed = @()
                agents_added = @(); agents_removed = @()
                skills_added = @(); skills_removed = @()
                hooks_added = @(); hooks_removed = @()
            }) -Force
        }
        $added = @($rp.user_overrides.rules_added)
        $removed = @($rp.user_overrides.rules_removed)
        if ($added -contains $name) {
            Write-Host "Rule '$name' already in user_overrides.rules_added." -ForegroundColor Yellow
            exit 0
        }
        $added += $name
        $removed = $removed | Where-Object { $_ -ne $name }
        $rp.user_overrides.rules_added = $added
        $rp.user_overrides.rules_removed = @($removed)
        Save-ProjectProfile -Profile $rp
        Write-Host "Added '$name' to user_overrides.rules_added." -ForegroundColor Green
        Write-Host "  Run 'forge rule list' to confirm." -ForegroundColor DarkGray
    }

    "remove" {
        if (-not $NameArg) {
            Write-Error "Usage: forge rule remove <name>"
            exit 1
        }
        $name = Normalize-RuleName $NameArg
        $path = Get-RulePath $name
        if (-not (Test-Path $path)) {
            Write-Host "No rule named '$name'." -ForegroundColor Red
            exit 1
        }
        $r = Get-RuleMeta -RulePath $path
        if ($r.required) {
            Write-Host "Cannot remove '$name': it is marked 'required: true' in frontmatter." -ForegroundColor Red
            Write-Host "  Required rules ship with every profile and cannot be opted out of." -ForegroundColor DarkGray
            exit 1
        }
        $rp = Get-ProjectProfileRaw
        if (-not $rp) {
            Write-Host "No project profile yet. Run 'forge init' first." -ForegroundColor Red
            exit 1
        }
        if (-not $rp.user_overrides) {
            $rp | Add-Member -NotePropertyName "user_overrides" -NotePropertyValue ([PSCustomObject]@{
                rules_added = @(); rules_removed = @()
                agents_added = @(); agents_removed = @()
                skills_added = @(); skills_removed = @()
                hooks_added = @(); hooks_removed = @()
            }) -Force
        }
        $added = @($rp.user_overrides.rules_added)
        $removed = @($rp.user_overrides.rules_removed)
        if ($removed -contains $name) {
            Write-Host "Rule '$name' already in user_overrides.rules_removed." -ForegroundColor Yellow
            exit 0
        }
        $removed += $name
        $added = $added | Where-Object { $_ -ne $name }
        $rp.user_overrides.rules_added = @($added)
        $rp.user_overrides.rules_removed = $removed
        Save-ProjectProfile -Profile $rp
        Write-Host "Added '$name' to user_overrides.rules_removed." -ForegroundColor Green
        Write-Host "  Run 'forge rule list' to confirm." -ForegroundColor DarkGray
    }

    "explain" {
        Write-Host ""
        Write-Host "Rule tier system" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Every rule file in docs/rules-reference/factory/ declares a tier in its frontmatter:" -ForegroundColor White
        Write-Host ""
        Write-Host "    essential  Safety + correctness. Loads in EVERY profile, every time." -ForegroundColor DarkGray
        Write-Host "               Examples: privacy, data-protection, execution, vibe-standard." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "    standard   Useful for most production work. Loads in solo-pro and up." -ForegroundColor DarkGray
        Write-Host "               Examples: hostile-architect, data-integrity, secrets-handling." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "    full       Specialist guidance (agency, consulting, AI architecture)." -ForegroundColor DarkGray
        Write-Host "               Loads in senior-dev, agency, enterprise." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  How activation actually works:" -ForegroundColor White
        Write-Host "    1. If a rule is 'required: true', it loads regardless of profile." -ForegroundColor DarkGray
        Write-Host "    2. Otherwise, it loads if the profile is listed in its 'profiles:' field." -ForegroundColor DarkGray
        Write-Host "    3. Then user_overrides.rules_added / rules_removed apply on top." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Tweak rules per project:" -ForegroundColor White
        Write-Host "    forge rule add <name>     Force a rule on (e.g., add consulting to a solo project)." -ForegroundColor DarkGray
        Write-Host "    forge rule remove <name>  Opt out of a non-required rule." -ForegroundColor DarkGray
        Write-Host ""
    }

    default {
        Write-Host ""
        Write-Host "Unknown subcommand: $SubCommand" -ForegroundColor Red
        Write-Host "Usage:" -ForegroundColor DarkGray
        Write-Host "  forge rule list              # active rules in current profile" -ForegroundColor DarkGray
        Write-Host "  forge rule list --available  # all rules + tier + profiles" -ForegroundColor DarkGray
        Write-Host "  forge rule show <name>       # display one rule's frontmatter" -ForegroundColor DarkGray
        Write-Host "  forge rule add <name>        # force-add to user_overrides" -ForegroundColor DarkGray
        Write-Host "  forge rule remove <name>     # opt out (if not required)" -ForegroundColor DarkGray
        Write-Host "  forge rule explain           # plain-English tier explainer" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
}
