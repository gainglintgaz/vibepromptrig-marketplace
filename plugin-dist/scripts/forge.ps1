<#
.SYNOPSIS
    forge CLI -- single command surface for the VibePromptRig factory.

.DESCRIPTION
    Dispatches subcommands to scripts/forge/<subcommand>.ps1. Each subcommand
    is its own .ps1 file. This keeps the entry point small and lets each command
    evolve independently.

    Subcommands (Day 1 — Week 1):
      init      Interactive profile wizard for current project.
      profile   show / set / get / list -- manage current project's profile.
      rule      list / add / remove -- manage which rules are active.
      doctor    Factory health check (verify-rules + verify-agents + verify-skills + smoke tests).
      cost      Cross-project token burn report.

    Subcommands (Week 2+):
      scaffold, onboard, sync, sanitize, audit, release, plan, ship, harvest, mcp

.PARAMETER Command
    Subcommand to run. If empty, prints help.

.PARAMETER Args
    Pass-through arguments to the subcommand.

.EXAMPLE
    forge init
    forge profile show
    forge profile set solo-pro
    forge rule list --available
    forge doctor

.NOTES
    PowerShell ASCII-only per CLAUDE.md SS10.
    Tab completion: register with Register-ArgumentCompleter (TODO Week 1 Day 2).
#>
param(
    [Parameter(Position = 0)]
    [string]$Command = "",

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args = @()
)

$ErrorActionPreference = "Stop"

# Locate factory root (the directory containing this script's parent)
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$FactoryRoot = Split-Path -Parent $ScriptRoot
$ForgeDir = Join-Path $ScriptRoot "forge"

# Known subcommands (Day 1)
$KnownCommands = @{
    "init"     = "init.ps1"
    "profile"  = "profile.ps1"
    "rule"     = "rule.ps1"
    "config"   = "config.ps1"
    "context"  = "context.ps1"
    "doctor"   = "doctor.ps1"
    "cost"     = "cost.ps1"
    "workflows" = "workflows.ps1"
    "scaffold" = "scaffold.ps1"
    "onboard"  = "onboard.ps1"
    "sync"     = "sync.ps1"
    "sanitize" = "sanitize.ps1"
    "audit"    = "audit.ps1"
    "release"  = "release.ps1"
    "plan"     = "plan.ps1"
    "ship"     = "ship.ps1"
    "harvest"  = "harvest.ps1"
    "mcp"      = "mcp.ps1"
    "legacy-rules" = "legacy-rules.ps1"
    "help"     = "help.ps1"
    "version"  = "version.ps1"
}

function Show-Help {
    Write-Host ""
    Write-Host "forge -- VibePromptRig factory CLI" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "USAGE:"
    Write-Host "  forge <command> [args...]"
    Write-Host ""
    Write-Host "COMMANDS (Day 1 -- Week 1):"
    Write-Host "  init                 Interactive profile wizard for current project."
    Write-Host "  profile show         Display effective profile + token budget."
    Write-Host "  profile set <name>   Set project profile to a preset (indie-free, solo-pro, senior-dev, agency, enterprise)."
    Write-Host "  profile get [field]  Get a single profile field value."
    Write-Host "  profile list         List available profile presets."
    Write-Host "  rule list            List rules active in current profile."
    Write-Host "  rule list --available All rules + tier per."
    Write-Host "  rule add <name>      Add a specific rule to user_overrides."
    Write-Host "  rule remove <name>   Remove a rule from user_overrides (cannot remove required rules)."
    Write-Host "  config list          List tunable config fields with current values."
    Write-Host "  config get <field>   Get a single config field value."
    Write-Host "  config set <field> <value>  Update a single config field (validates type/range)."
    Write-Host "  context resolve|explain     Resolve a bounded VF-CONTEXT-V2 packet."
    Write-Host "  legacy-rules plan|apply|rollback  Reviewed, backup-first removal of old factory rule copies in a project."
    Write-Host "  doctor               Factory health check."
    Write-Host "  cost                 [Planned v0.2] Cross-project token burn report."
    Write-Host "  workflows            List saved dynamic workflows (.claude/workflows/)."
    Write-Host ""
    Write-Host "COMMANDS (Week 2+):"
    Write-Host "  scaffold <name>      Windows wrapper for scaffold-new-project.ps1 (Node-native handler planned)."
    Write-Host "  onboard <path>       Windows wrapper for onboard-existing-project.ps1 (Node-native handler planned)."
    Write-Host "  sync                 Windows wrapper for sync-rules-to-platforms.ps1 (Node-native handler planned)."
    Write-Host "  sanitize             Build sanitized public mirror (wraps sanitize-for-public.ps1)."
    Write-Host "  audit                Security + drift sweep."
    Write-Host "  release              Tag + release notes + push."
    Write-Host "  plan                 Open Plan agent on CURRENT_SPRINT."
    Write-Host "  ship                 Invoke /ship skill."
    Write-Host "  harvest              Invoke /harvest skill on current project."
    Write-Host "  mcp install <name>   Wire an MCP server to current project."
    Write-Host "  version              Print factory version."
    Write-Host ""
    Write-Host "ENVIRONMENT:"
    Write-Host "  Factory root: $FactoryRoot" -ForegroundColor DarkGray
    Write-Host "  Profile presets: $ForgeDir\..\..\.forge\profiles\" -ForegroundColor DarkGray
    Write-Host ""
}

# Empty or help command -> show help
if (-not $Command -or $Command -in @("help", "-h", "--help", "/?")) {
    Show-Help
    exit 0
}

# Unknown command
if (-not $KnownCommands.ContainsKey($Command)) {
    Write-Host ""
    Write-Host "Unknown command: $Command" -ForegroundColor Red
    Write-Host "Run 'forge help' to see available commands." -ForegroundColor DarkGray
    Write-Host ""
    exit 1
}

# Dispatch
$subCommandPath = Join-Path $ForgeDir $KnownCommands[$Command]
if (-not (Test-Path $subCommandPath)) {
    # Subcommand file doesn't exist yet (Week 2+ commands during Week 1 build phase)
    Write-Host ""
    Write-Host "forge: '$Command' is not implemented yet." -ForegroundColor Yellow
    Write-Host "  Expected at: $subCommandPath" -ForegroundColor DarkGray
    Write-Host ""
    exit 2
}

# Execute subcommand with pass-through args. Forward $FactoryRoot env var so subcommands don't need to recompute.
$env:VIBE_ROOT = $FactoryRoot
& $subCommandPath @Args
exit $LASTEXITCODE
