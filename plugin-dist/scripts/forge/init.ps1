<#
.SYNOPSIS
    forge init -- interactive profile wizard for current project.

.DESCRIPTION
    Asks plain-English questions to recommend + set a profile.

    Interactive flow:
      1. "What's your AI plan?"  (Claude Free/Pro/Max, Cursor Free/Pro/Business,
                                  Codex Free/Paid, API direct, BYOK)
      2. "What's the project like?"  (simple side-project / multi-feature app /
                                      production with users / multi-client / regulated)
      3. Recommends a profile from the combo (free + simple -> indie-free,
         pro + production -> solo-pro, pro + multi-feature -> senior-dev, etc.)
      4. Asks for confirmation, then writes .forge/profile.json via
         `forge profile set <name>`.

    Non-interactive (CI/scripting):
      forge init --profile solo-pro --plan claude-pro --no-prompt

.PARAMETER Profile
    Skip the wizard. Set profile to this preset directly. Requires --no-prompt.

.PARAMETER Plan
    Skip the AI-plan question. Records this AI plan in profile.json's `ai_plan`.

.PARAMETER NoPrompt
    Non-interactive mode. Requires --profile.

.PARAMETER Force
    Overwrite an existing .forge/profile.json without confirmation.

.EXAMPLE
    forge init

.EXAMPLE
    forge init --profile solo-pro --plan claude-pro --no-prompt

.NOTES
    PowerShell ASCII-only. Output mirrors `forge profile show` plain-English convention.
#>
param(
    [string]$Profile = "",
    [string]$Plan = "",
    [switch]$NoPrompt,
    [switch]$Force
)

# Tolerate caller passing --flag style. PowerShell positional binding may
# capture `--profile` as the literal value of $Profile (since `--` is not
# a recognized param prefix). Reparse: collect $Profile, $Plan, and $args
# into one stream, scan for --flag tokens, rebuild values.
$allTokens = @()
if ($Profile) { $allTokens += $Profile }
if ($Plan)    { $allTokens += $Plan }
$allTokens += @($args)

$Profile = ""
$Plan = ""

$i = 0
while ($i -lt $allTokens.Count) {
    $a = "$($allTokens[$i])"
    switch -Regex ($a) {
        '^--no-prompt$'    { $NoPrompt = $true }
        '^--force$'        { $Force = $true }
        '^--profile=(.+)$' { $Profile = $matches[1] }
        '^--plan=(.+)$'    { $Plan = $matches[1] }
        '^--profile$'      {
            if ($i + 1 -lt $allTokens.Count) { $Profile = "$($allTokens[$i + 1])"; $i++ }
        }
        '^--plan$'         {
            if ($i + 1 -lt $allTokens.Count) { $Plan = "$($allTokens[$i + 1])"; $i++ }
        }
        default {
            # Bare positional value (no leading --) lands in $Profile then $Plan.
            if (-not $Profile -and $a -notmatch '^--') { $Profile = $a }
            elseif (-not $Plan -and $a -notmatch '^--') { $Plan = $a }
        }
    }
    $i++
}

$ErrorActionPreference = "Stop"

$FactoryRoot = $env:VIBE_ROOT
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ProjectRoot = (Get-Location).Path
$PresetsDir = Join-Path $FactoryRoot ".forge\profiles"
$ProjectProfile = Join-Path $ProjectRoot ".forge\profile.json"
$TranslationsPath = Join-Path $FactoryRoot ".forge\plan-translations.json"
$ProfileScript = Join-Path $FactoryRoot "scripts\forge\profile.ps1"

# ----------------------------------------------------------------
# Recommendation matrix: (plan, project_kind) -> preset
# ----------------------------------------------------------------
# Plan budget tiers (rough):
#   free    -> claude-free, cursor-free, codex-free
#   pro     -> claude-pro, cursor-pro, codex-paid
#   heavy   -> claude-max, cursor-business
#   api     -> api-direct, byok
#
# Project kinds:
#   simple      -> indie-free / solo-pro
#   multi       -> solo-pro / senior-dev
#   production  -> senior-dev
#   agency      -> agency
#   regulated   -> enterprise

function Get-PlanTier {
    param([string]$PlanKey)
    switch ($PlanKey) {
        "claude-free"     { "free" }
        "cursor-free"     { "free" }
        "codex-free"      { "free" }
        "claude-pro"      { "pro" }
        "cursor-pro"      { "pro" }
        "codex-paid"      { "pro" }
        "claude-max"      { "heavy" }
        "cursor-business" { "heavy" }
        "api-direct"      { "api" }
        "byok"            { "api" }
        default           { "pro" }
    }
}

function Get-RecommendedPreset {
    param([string]$PlanKey, [string]$Kind)
    $tier = Get-PlanTier $PlanKey
    switch ("$tier|$Kind") {
        "free|simple"      { "indie-free" }
        "free|multi"       { "indie-free" }
        "free|production"  { "solo-pro" }
        "free|agency"      { "solo-pro" }
        "free|regulated"   { "senior-dev" }
        "pro|simple"       { "solo-pro" }
        "pro|multi"        { "solo-pro" }
        "pro|production"   { "senior-dev" }
        "pro|agency"       { "agency" }
        "pro|regulated"    { "enterprise" }
        "heavy|simple"     { "solo-pro" }
        "heavy|multi"      { "senior-dev" }
        "heavy|production" { "senior-dev" }
        "heavy|agency"     { "agency" }
        "heavy|regulated"  { "enterprise" }
        "api|simple"       { "solo-pro" }
        "api|multi"        { "senior-dev" }
        "api|production"   { "senior-dev" }
        "api|agency"       { "agency" }
        "api|regulated"    { "enterprise" }
        default            { "solo-pro" }
    }
}

# ----------------------------------------------------------------
# Validation helpers
# ----------------------------------------------------------------
function Test-PresetExists {
    param([string]$Name)
    Test-Path (Join-Path $PresetsDir "$Name.json")
}

function Test-PlanKnown {
    param([string]$Key)
    if (-not (Test-Path $TranslationsPath)) { return $true }   # tolerate missing file
    $t = Get-Content $TranslationsPath -Raw | ConvertFrom-Json
    $null -ne $t.plans.$Key
}

# ----------------------------------------------------------------
# Apply: write profile + stamp ai_plan
# ----------------------------------------------------------------
function Apply-Profile {
    param([string]$PresetName, [string]$PlanKey)

    & $ProfileScript "set" $PresetName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # Stamp ai_plan into the freshly-written profile.json
    if ($PlanKey -and (Test-Path $ProjectProfile)) {
        $p = Get-Content $ProjectProfile -Raw | ConvertFrom-Json
        $p | Add-Member -NotePropertyName "ai_plan" -NotePropertyValue $PlanKey -Force
        $p | ConvertTo-Json -Depth 6 | Set-Content -Path $ProjectProfile -Encoding UTF8
    }
}

# ----------------------------------------------------------------
# Non-interactive path
# ----------------------------------------------------------------
if ($NoPrompt) {
    if (-not $Profile) {
        Write-Error "forge init --no-prompt requires --profile <name>"
        exit 1
    }
    if (-not (Test-PresetExists $Profile)) {
        Write-Host ""
        Write-Host "Unknown preset: $Profile" -ForegroundColor Red
        Write-Host "Available: indie-free, solo-pro, senior-dev, agency, enterprise" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
    if ($Plan -and -not (Test-PlanKnown $Plan)) {
        Write-Host "Warning: '$Plan' is not in plan-translations.json. Recording anyway." -ForegroundColor Yellow
    }
    if ((Test-Path $ProjectProfile) -and -not $Force) {
        Write-Error "Profile already exists at $ProjectProfile. Re-run with --force to overwrite."
        exit 1
    }
    Apply-Profile -PresetName $Profile -PlanKey $Plan
    exit 0
}

# ----------------------------------------------------------------
# Interactive path
# ----------------------------------------------------------------
Write-Host ""
Write-Host "forge init -- profile wizard" -ForegroundColor Cyan
Write-Host "  Project: $ProjectRoot" -ForegroundColor DarkGray
Write-Host ""

if ((Test-Path $ProjectProfile) -and -not $Force) {
    Write-Host "A profile already exists at:" -ForegroundColor Yellow
    Write-Host "  $ProjectProfile" -ForegroundColor DarkGray
    Write-Host ""
    $resp = Read-Host "Overwrite? (y/N)"
    if ($resp -notmatch '^[yY]') {
        Write-Host "Cancelled. Run 'forge profile show' to see current config." -ForegroundColor DarkGray
        Write-Host ""
        exit 0
    }
}

# ---- Question 1: AI plan ----
Write-Host "1) What's your AI plan?" -ForegroundColor White
Write-Host ""
$planChoices = @(
    @{ Key = "claude-free";     Label = "Claude Free ($0/mo)" }
    @{ Key = "claude-pro";      Label = "Claude Pro ($20/mo)" }
    @{ Key = "claude-max";      Label = "Claude Max ($100-200/mo)" }
    @{ Key = "cursor-free";     Label = "Cursor Free ($0/mo)" }
    @{ Key = "cursor-pro";      Label = "Cursor Pro ($20/mo)" }
    @{ Key = "cursor-business"; Label = "Cursor Business ($40/user/mo)" }
    @{ Key = "codex-free";      Label = "Codex CLI Free ($0/mo)" }
    @{ Key = "codex-paid";      Label = "Codex CLI Paid (pay-per-use)" }
    @{ Key = "api-direct";      Label = "Direct API billing (Anthropic/OpenAI/Gemini)" }
    @{ Key = "byok";            Label = "Bring Your Own Key (managed for clients)" }
)
for ($i = 0; $i -lt $planChoices.Count; $i++) {
    Write-Host ("  {0,2})  {1}" -f ($i + 1), $planChoices[$i].Label) -ForegroundColor DarkGray
}
Write-Host ""
$planIdx = 0
while ($true) {
    $resp = Read-Host "Pick 1-$($planChoices.Count)"
    if ($resp -match '^\d+$' -and [int]$resp -ge 1 -and [int]$resp -le $planChoices.Count) {
        $planIdx = [int]$resp - 1
        break
    }
    Write-Host "  Please enter a number from 1 to $($planChoices.Count)." -ForegroundColor Yellow
}
$planKey = $planChoices[$planIdx].Key
$planLabel = $planChoices[$planIdx].Label

# ---- Question 2: project kind ----
Write-Host ""
Write-Host "2) What's the project like?" -ForegroundColor White
Write-Host ""
$kindChoices = @(
    @{ Key = "simple";     Label = "Simple side-project or prototype" }
    @{ Key = "multi";      Label = "Multi-feature app, still small" }
    @{ Key = "production"; Label = "Production app with real users" }
    @{ Key = "agency";     Label = "Agency / multi-client work" }
    @{ Key = "regulated";  Label = "Regulated (fintech, healthcare, legal, compliance-heavy)" }
)
for ($i = 0; $i -lt $kindChoices.Count; $i++) {
    Write-Host ("  {0})  {1}" -f ($i + 1), $kindChoices[$i].Label) -ForegroundColor DarkGray
}
Write-Host ""
$kindIdx = 0
while ($true) {
    $resp = Read-Host "Pick 1-$($kindChoices.Count)"
    if ($resp -match '^\d+$' -and [int]$resp -ge 1 -and [int]$resp -le $kindChoices.Count) {
        $kindIdx = [int]$resp - 1
        break
    }
    Write-Host "  Please enter a number from 1 to $($kindChoices.Count)." -ForegroundColor Yellow
}
$kindKey = $kindChoices[$kindIdx].Key
$kindLabel = $kindChoices[$kindIdx].Label

# ---- Recommendation ----
$recommended = Get-RecommendedPreset -PlanKey $planKey -Kind $kindKey

Write-Host ""
Write-Host "Recommendation" -ForegroundColor Cyan
Write-Host "  AI plan:       $planLabel" -ForegroundColor DarkGray
Write-Host "  Project kind:  $kindLabel" -ForegroundColor DarkGray
Write-Host "  Profile:       $recommended" -ForegroundColor Green
Write-Host ""

# ---- Confirm ----
$resp = Read-Host "Apply this profile? (Y/n, or type a different preset name)"
$chosen = $recommended
if ($resp -match '^[nN]') {
    Write-Host "Cancelled. No profile written." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
} elseif ($resp -and $resp -notmatch '^[yY]') {
    if (-not (Test-PresetExists $resp)) {
        Write-Host "Unknown preset: $resp" -ForegroundColor Red
        Write-Host "Available: indie-free, solo-pro, senior-dev, agency, enterprise" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
    $chosen = $resp
}

Apply-Profile -PresetName $chosen -PlanKey $planKey

Write-Host ""
Write-Host "Next:" -ForegroundColor DarkGray
Write-Host "  forge profile show     # see effective config" -ForegroundColor DarkGray
Write-Host "  forge rule list        # see active rules" -ForegroundColor DarkGray
Write-Host "  forge doctor           # verify factory health" -ForegroundColor DarkGray
Write-Host ""
