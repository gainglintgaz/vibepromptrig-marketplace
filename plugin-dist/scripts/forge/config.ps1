<#
.SYNOPSIS
    forge config -- tune individual profile fields without re-running init.

.DESCRIPTION
    Reads/writes scalar fields on the project's .forge/profile.json. Validates
    against a known field whitelist with type + range checks.

    Subcommands:
      list                List all tunable fields with current values.
      get <field>         Print one field's value (delegates to profile-resolver).
      set <field> <value> Update one field in .forge/profile.json. Validates type.

    v5.0 override-layer subcommands (Commit 2, arch 9d7294c):
      show <type> <name>  Print the RESOLVED config for an override-layer artifact
                          (agent-config | routine | skill | rule-override | model-router
                          | workflow). Delegates to scripts/forge/resolve-config.ps1.
      reset <type> <name> Revert an artifact to factory default: backs up the customer's
                          .forge file (.bak-<ts>) then removes it. Fails loud if none.
      reload              A6 escape hatch: clear the session config lock so the next
                          resolution re-reads .forge/ fresh.

    Tunable fields (whitelist):
      verbosity                            (terse | standard | verbose)
      rule_tier                            (essential | standard | full)
      compaction_trigger_percent           (int 50-95)
      session_budget_tokens                (int >= 10000)
      monthly_budget_tokens                (int >= 100000)
      subagent_dispatch_threshold_tokens   (int >= 1000)
      tool_result_truncation_kb            (int 5-200)
      llm_cache_ttl_hours                  (int 1-720)
      ai_plan                              (string from plan-translations.json)
      byok                                 (bool)
      vertical_pack                        (string or null)

.EXAMPLE
    forge config list
    forge config get session_budget_tokens
    forge config set verbosity terse
    forge config set session_budget_tokens 100000

.NOTES
    PowerShell ASCII-only.
#>
param(
    [Parameter(Position = 0)]
    [string]$SubCommand = "list",

    [Parameter(Position = 1)]
    [string]$Field = "",

    [Parameter(Position = 2, ValueFromRemainingArguments = $true)]
    [string[]]$ValueArgs = @()
)

$ErrorActionPreference = "Stop"

$FactoryRoot = $env:VIBE_ROOT
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

$ProjectRoot = (Get-Location).Path
$ProjectProfile = Join-Path $ProjectRoot ".forge\profile.json"
$ResolverScript = Join-Path $FactoryRoot "scripts\forge\profile-resolver.ps1"
$TranslationsPath = Join-Path $FactoryRoot ".forge\plan-translations.json"

# ----------------------------------------------------------------
# Field schema: name -> { type, validate, hint }
# ----------------------------------------------------------------
$Schema = @{
    "verbosity" = @{
        type     = "enum"
        values   = @("terse", "standard", "verbose")
        hint     = "Output verbosity for forge commands."
    }
    "rule_tier" = @{
        type     = "enum"
        values   = @("essential", "standard", "full")
        hint     = "Minimum tier of rules to load."
    }
    "compaction_trigger_percent" = @{
        type     = "int"
        min      = 50
        max      = 95
        hint     = "% of context window before triggering compaction."
    }
    "session_budget_tokens" = @{
        type     = "int"
        min      = 10000
        max      = 100000000
        hint     = "Tokens allowed in a single session before warning. (Max raised 1M -> 100M 2026-06-09: measured heavy factory sessions run 8-11M new tokens; the old max made honest calibration impossible.)"
    }
    "monthly_budget_tokens" = @{
        type     = "int"
        min      = 100000
        max      = 2147000000
        hint     = "Tokens allowed per month before warning. (Max raised 100M -> ~2.147B (int32-safe) 2026-06-09: measured June month-to-date was 518M deduped new tokens in 9 days.)"
    }
    "subagent_dispatch_threshold_tokens" = @{
        type     = "int"
        min      = 1000
        max      = 100000
        hint     = "Token threshold above which to dispatch subagents."
    }
    "tool_result_truncation_kb" = @{
        type     = "int"
        min      = 5
        max      = 200
        hint     = "Max KB of tool result before truncation."
    }
    "llm_cache_ttl_hours" = @{
        type     = "int"
        min      = 1
        max      = 720
        hint     = "TTL (hours) for cached LLM responses."
    }
    "ai_plan" = @{
        type     = "string"
        hint     = "AI subscription plan key (see plan-translations.json)."
    }
    "byok" = @{
        type     = "bool"
        hint     = "Bring your own API key (true/false)."
    }
    "vertical_pack" = @{
        type     = "string-or-null"
        hint     = "Vertical specialization pack (e.g., fintech, healthcare). null for none."
    }
}

# ----------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------
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

function Parse-Value {
    param([string]$FieldName, [string]$RawValue)
    $s = $Schema[$FieldName]
    switch ($s.type) {
        "int" {
            if ($RawValue -notmatch '^-?\d+$') {
                throw "Field '$FieldName' expects integer, got '$RawValue'."
            }
            $n = [int]$RawValue
            if ($s.min -ne $null -and $n -lt $s.min) { throw "Field '$FieldName' min is $($s.min), got $n." }
            if ($s.max -ne $null -and $n -gt $s.max) { throw "Field '$FieldName' max is $($s.max), got $n." }
            return $n
        }
        "enum" {
            if ($s.values -notcontains $RawValue) {
                throw "Field '$FieldName' must be one of: $($s.values -join ', '). Got '$RawValue'."
            }
            return $RawValue
        }
        "bool" {
            switch -Regex ($RawValue) {
                '^(true|yes|1|on)$'  { return $true }
                '^(false|no|0|off)$' { return $false }
                default              { throw "Field '$FieldName' expects bool (true/false), got '$RawValue'." }
            }
        }
        "string-or-null" {
            if ($RawValue -in @("null", "none", "")) { return $null }
            return $RawValue
        }
        "string" {
            return $RawValue
        }
        default { return $RawValue }
    }
}

# ----------------------------------------------------------------
# Subcommands
# ----------------------------------------------------------------
switch ($SubCommand) {

    "list" {
        # Use resolver so we display effective (project OR factory-default) values
        $effective = $null
        try {
            $json = & $ResolverScript -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot -Json 2>&1 | Out-String
            $effective = ($json | ConvertFrom-Json).effective
        } catch { }

        $rp = Get-ProjectProfileRaw
        Write-Host ""
        Write-Host "Tunable config fields" -ForegroundColor Cyan
        Write-Host "  Project: $ProjectRoot" -ForegroundColor DarkGray
        if (-not $rp) {
            Write-Host "  (No .forge/profile.json yet -- showing effective values from factory default.)" -ForegroundColor DarkGray
            Write-Host "  Run 'forge init' to write a project-level profile." -ForegroundColor DarkGray
        }
        Write-Host ""
        $maxLen = ($Schema.Keys | Measure-Object -Maximum -Property Length).Maximum
        if (-not $maxLen) { $maxLen = 32 }
        foreach ($k in ($Schema.Keys | Sort-Object)) {
            $current = if ($effective) { $effective.$k } else { $null }
            if ($rp -and $null -ne $rp.$k) { $current = $rp.$k }
            $display = if ($null -eq $current) { "(null)" } else { $current.ToString() }
            Write-Host ("  {0,-$maxLen}  {1}" -f $k, $display) -ForegroundColor White
            Write-Host ("  {0,-$maxLen}    {1}" -f "", $Schema[$k].hint) -ForegroundColor DarkGray
        }
        Write-Host ""
        Write-Host "Set:  forge config set <field> <value>" -ForegroundColor DarkGray
        Write-Host "Get:  forge config get <field>" -ForegroundColor DarkGray
        Write-Host ""
    }

    "get" {
        if (-not $Field) {
            Write-Error "Usage: forge config get <field>"
            exit 1
        }
        if (-not $Schema.ContainsKey($Field)) {
            Write-Host "Unknown field: $Field" -ForegroundColor Red
            Write-Host "Run 'forge config list' to see tunable fields." -ForegroundColor DarkGray
            exit 1
        }
        & $ResolverScript -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot -Field $Field
    }

    "set" {
        if (-not $Field) {
            Write-Error "Usage: forge config set <field> <value>"
            exit 1
        }
        if (-not $Schema.ContainsKey($Field)) {
            Write-Host "Unknown field: $Field" -ForegroundColor Red
            Write-Host "Run 'forge config list' to see tunable fields." -ForegroundColor DarkGray
            exit 1
        }
        if (-not $ValueArgs -or $ValueArgs.Count -eq 0) {
            Write-Error "Usage: forge config set $Field <value>"
            exit 1
        }
        $raw = $ValueArgs[0]
        try {
            $parsed = Parse-Value -FieldName $Field -RawValue $raw
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Red
            Write-Host "Hint: $($Schema[$Field].hint)" -ForegroundColor DarkGray
            exit 1
        }

        $rp = Get-ProjectProfileRaw
        if (-not $rp) {
            Write-Host "No project profile yet. Run 'forge init' first." -ForegroundColor Red
            exit 1
        }

        # Special-case ai_plan: warn if not in translations
        if ($Field -eq "ai_plan" -and (Test-Path $TranslationsPath)) {
            $t = Get-Content $TranslationsPath -Raw | ConvertFrom-Json
            if ($null -eq $t.plans.$parsed) {
                Write-Host "Warning: '$parsed' is not in plan-translations.json." -ForegroundColor Yellow
                Write-Host "  Recording anyway. Run 'forge config list' afterwards to confirm." -ForegroundColor DarkGray
            }
        }

        $oldValue = $rp.$Field
        $rp | Add-Member -NotePropertyName $Field -NotePropertyValue $parsed -Force
        Save-ProjectProfile -Profile $rp

        $oldDisplay = if ($null -eq $oldValue) { "(null)" } else { $oldValue.ToString() }
        $newDisplay = if ($null -eq $parsed)   { "(null)" } else { $parsed.ToString() }
        Write-Host ""
        Write-Host "Set $Field" -ForegroundColor Green
        Write-Host ("  Was:  {0}" -f $oldDisplay) -ForegroundColor DarkGray
        Write-Host ("  Now:  {0}" -f $newDisplay) -ForegroundColor White
        Write-Host ""
    }

    "show" {
        # v5.0: print resolved override-layer config. $Field = artifact-type, $ValueArgs[0] = name.
        $artifactType = $Field
        $name = if ($ValueArgs -and $ValueArgs.Count -gt 0) { $ValueArgs[0] } else { "" }
        $valid = @("agent-config","routine","skill","rule-override","model-router","workflow")
        if (-not $artifactType -or $valid -notcontains $artifactType) {
            Write-Host "Usage: forge config show <type> <name>" -ForegroundColor Red
            Write-Host ("  <type> one of: {0}" -f ($valid -join ', ')) -ForegroundColor DarkGray
            exit 1
        }
        if (-not $name) {
            Write-Host "Usage: forge config show $artifactType <name>" -ForegroundColor Red
            exit 1
        }
        $resolver = Join-Path $FactoryRoot "scripts\forge\resolve-config.ps1"
        & $resolver -ArtifactType $artifactType -Name $name -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot -Json
        exit $LASTEXITCODE
    }

    "reset" {
        # v5.0: revert an artifact to factory default. Back up the customer file first.
        $artifactType = $Field
        $name = if ($ValueArgs -and $ValueArgs.Count -gt 0) { $ValueArgs[0] } else { "" }
        $fileMap = @{
            "agent-config"  = ".forge\agent-configs\$name.json"
            "routine"       = ".forge\routines.json"
            "skill"         = ".forge\active-skills.json"
            "rule-override" = ".forge\rule-overrides.json"
            "model-router"  = ".forge\provider-prefs.json"
            "workflow"      = ".forge\workflows\$name.json"
        }
        if (-not $fileMap.ContainsKey($artifactType)) {
            Write-Host "Usage: forge config reset <type> <name>" -ForegroundColor Red
            Write-Host ("  <type> one of: {0}" -f ($fileMap.Keys -join ', ')) -ForegroundColor DarkGray
            exit 1
        }
        $target = Join-Path $ProjectRoot $fileMap[$artifactType]
        if (-not (Test-Path $target)) {
            Write-Host "No customer override at $target -- already at factory default." -ForegroundColor Yellow
            exit 1
        }
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = "$target.bak-$stamp"
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Remove-Item -LiteralPath $target -Force
        Write-Host ""
        Write-Host "Reset $artifactType '$name' to factory default." -ForegroundColor Green
        Write-Host ("  Backed up customer override to: {0}" -f $backup) -ForegroundColor DarkGray
        Write-Host ""
        exit 0
    }

    "reload" {
        # v5.0 A6: clear the session config lock so the next resolution re-reads .forge/ fresh.
        $lock = Join-Path $ProjectRoot ".forge\.config-lock.json"
        if (Test-Path $lock) {
            Remove-Item -LiteralPath $lock -Force
            Write-Host "Config lock cleared. Next resolution will re-read .forge/ fresh." -ForegroundColor Green
        } else {
            Write-Host "No session config lock present. Resolution already re-reads .forge/ on next access." -ForegroundColor DarkGray
        }
        exit 0
    }

    default {
        Write-Host ""
        Write-Host "Unknown subcommand: $SubCommand" -ForegroundColor Red
        Write-Host "Usage:" -ForegroundColor DarkGray
        Write-Host "  forge config list                # show all tunable fields + current values" -ForegroundColor DarkGray
        Write-Host "  forge config get <field>         # print one field's value" -ForegroundColor DarkGray
        Write-Host "  forge config set <field> <value> # update one field (validates type/range)" -ForegroundColor DarkGray
        Write-Host "  forge config show <type> <name>  # print resolved override-layer config (v5.0)" -ForegroundColor DarkGray
        Write-Host "  forge config reset <type> <name> # revert artifact to factory default (v5.0)" -ForegroundColor DarkGray
        Write-Host "  forge config reload              # clear session config lock (v5.0)" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
}
