<#
.SYNOPSIS
    forge profile -- show / set / get / list current project profile.

.DESCRIPTION
    Manages .forge/profile.json at the current project root.

    Subcommands:
      show         Print effective config (resolver output, pretty-formatted)
      set <name>   Set project profile to preset (copies preset to .forge/profile.json)
      get <field>  Output a single field value (machine-readable)
      list         List available preset names

.EXAMPLE
    forge profile show
    forge profile set solo-pro
    forge profile get session_budget_tokens
    forge profile list

.NOTES
    PowerShell ASCII-only.
#>
param(
    [Parameter(Position = 0)]
    [string]$SubCommand = "show",

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args = @()
)

# Extract flags from $Args
$Arg = ""
$VerboseFlag = $false
$JsonFlag = $false
$TerseFlag = $false
foreach ($a in $Args) {
    switch ($a) {
        "--verbose" { $VerboseFlag = $true }
        "--json"    { $JsonFlag = $true }
        "--terse"   { $TerseFlag = $true }
        default     { if (-not $Arg) { $Arg = $a } }
    }
}

$ErrorActionPreference = "Stop"

$FactoryRoot = $env:VIBE_ROOT
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ProjectRoot = (Get-Location).Path
$PresetsDir = Join-Path $FactoryRoot ".forge\profiles"
$ProjectProfile = Join-Path $ProjectRoot ".forge\profile.json"
$ResolverScript = Join-Path $FactoryRoot "scripts\forge\profile-resolver.ps1"

switch ($SubCommand) {
    "show" {
        if (-not (Test-Path $ResolverScript)) {
            Write-Error "Profile resolver missing: $ResolverScript"
            exit 1
        }
        $resolverArgs = @{
            ProjectRoot = $ProjectRoot
            FactoryRoot = $FactoryRoot
        }
        if ($VerboseFlag) {
            & $ResolverScript @resolverArgs -Verbose_Output
        } elseif ($JsonFlag) {
            & $ResolverScript @resolverArgs -Json
        } elseif ($TerseFlag) {
            & $ResolverScript @resolverArgs -Terse
        } else {
            # Default: plain-English human-friendly view
            & $ResolverScript @resolverArgs -Pretty
        }
    }

    "set" {
        # Keep the mutation on the canonical compact installer. Read commands retain the
        # PowerShell resolver, including support for BOM-prefixed profiles written by init.
        $nodeScript = Join-Path $PSScriptRoot "profile.mjs"
        if (-not (Test-Path -LiteralPath $nodeScript)) { Write-Error "Profile command missing: $nodeScript"; exit 1 }
        & node $nodeScript set @Args
        exit $LASTEXITCODE
    }

    "get" {
        if (-not $Arg) {
            Write-Error "Usage: forge profile get <field>"
            exit 1
        }
        if (-not (Test-Path $ResolverScript)) {
            Write-Error "Profile resolver missing: $ResolverScript"
            exit 1
        }
        & $ResolverScript -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot -Field $Arg
    }

    "list" {
        Write-Host ""
        Write-Host "Available profile presets:" -ForegroundColor Cyan
        Write-Host ""
        Get-ChildItem $PresetsDir -Filter "*.json" | ForEach-Object {
            $preset = Get-Content $_.FullName -Raw | ConvertFrom-Json
            Write-Host ("  {0,-14}  session_budget={1,9:N0}  agents={2,2}  skills={3,2}  hooks={4,2}" -f `
                $_.BaseName, `
                $preset.session_budget_tokens, `
                ($preset.agents_enabled | Measure-Object).Count, `
                ($preset.skills_enabled | Measure-Object).Count, `
                ($preset.hooks_enabled | Measure-Object).Count) -ForegroundColor White
        }
        Write-Host ""
        Write-Host "To set: forge profile set <name>" -ForegroundColor DarkGray
        Write-Host ""
    }

    default {
        Write-Host ""
        Write-Host "Unknown subcommand: $SubCommand" -ForegroundColor Red
        Write-Host "Usage:" -ForegroundColor DarkGray
        Write-Host "  forge profile show" -ForegroundColor DarkGray
        Write-Host "  forge profile set <name>" -ForegroundColor DarkGray
        Write-Host "  forge profile get <field>" -ForegroundColor DarkGray
        Write-Host "  forge profile list" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
}
