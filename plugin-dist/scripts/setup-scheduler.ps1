<#
.SYNOPSIS
    One-time setup of Windows Task Scheduler tasks for VibePromptRig maintenance routines.
    Reads .forge/routines.json (the source of truth) and registers ONE task per ENABLED routine
    that has a runnable local body (scripts/<name>.mjs) AND a cron schedule -- matching the Node
    twin setup-scheduler.mjs. Each task runs `node scripts/<name>.mjs` (uniform OS-native per
    docs/architecture/cross-platform-port-t3-schedulers.md). Must be run as Administrator.

    NOT scheduled (skipped with a note): agent routines with no local runner (synthesizer,
    tech-radar, outcome-tracker, schema-auditor -- they belong on cloud Routines), event routines
    (schedule "stop-hook", e.g. debrief), and disabled routines. restore-drill stays manual.
.EXAMPLE
    # Run PowerShell as Admin, then:
    .\scripts\setup-scheduler.ps1
    .\scripts\setup-scheduler.ps1 -DryRun
#>
param([switch]$DryRun)

$ErrorActionPreference = "Stop"

$ScriptsDir  = $PSScriptRoot
$FactoryRoot = Split-Path $PSScriptRoot -Parent
$RoutinesFile = Join-Path $FactoryRoot ".forge\routines.json"
$Dow3 = @{ "0" = "SUN"; "7" = "SUN"; "1" = "MON"; "2" = "TUE"; "3" = "WED"; "4" = "THU"; "5" = "FRI"; "6" = "SAT" }

# cron -> schtasks. Returns @{ sc = @(...); st = "HH:MM"; label = "..." } or $null if untranslatable.
function ConvertFrom-CronToSchtasks {
    param([string]$Cron)
    if ([string]::IsNullOrWhiteSpace($Cron)) { return $null }
    $f = $Cron.Trim() -split "\s+"
    if ($f.Count -ne 5) { return $null }
    $min = $f[0]; $hour = $f[1]; $dom = $f[2]; $mon = $f[3]; $dow = $f[4]
    if ($min -notmatch "^\d{1,2}$" -or $hour -notmatch "^\d{1,2}$") { return $null }
    if ($mon -ne "*") { return $null }
    $st = "{0:D2}:{1:D2}" -f [int]$hour, [int]$min
    if ($dom -eq "*" -and $dow -eq "*") { return @{ sc = @("DAILY"); st = $st; label = "daily at $st" } }
    if ($dom -eq "*" -and $dow -match "^[0-7]$") { $d = $Dow3[$dow]; return @{ sc = @("WEEKLY", "/d", $d); st = $st; label = "$d at $st" } }
    if ($dow -eq "*" -and $dom -match "^\d{1,2}$" -and [int]$dom -ge 1 -and [int]$dom -le 31) { return @{ sc = @("MONTHLY", "/d", $dom); st = $st; label = "monthly day $dom at $st" } }
    return $null
}

Write-Host "`n  VibePromptRig Scheduler Setup" -ForegroundColor Cyan
Write-Host ""

if (-not $DryRun) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "This script must be run as Administrator. Right-click PowerShell -> Run as Administrator."
        exit 1
    }
}

if (-not (Test-Path $RoutinesFile)) {
    Write-Error "routines.json not found at $RoutinesFile -- nothing to register."
    exit 1
}
$routines = (Get-Content -Raw -Path $RoutinesFile | ConvertFrom-Json).routines

$schedulable = @()
foreach ($r in $routines) {
    if ($r.PSObject.Properties.Name -contains "enabled" -and $r.enabled -eq $false) {
        Write-Host "  [skip] $($r.name) -- disabled in routines.json" -ForegroundColor DarkGray; continue
    }
    if ($r.schedule -eq "stop-hook") {
        Write-Host "  [skip] $($r.name) -- event routine (stop-hook), fires via the Claude Stop hook, not the OS scheduler" -ForegroundColor DarkGray; continue
    }
    $script = Join-Path $ScriptsDir "$($r.name).mjs"
    if (-not (Test-Path $script)) {
        Write-Host "  [skip] $($r.name) -- agent routine, no local runner (belongs on cloud Routines; see docs/architecture/agent-routines-cloud-routines.md)" -ForegroundColor Yellow; continue
    }
    $schedulable += [PSCustomObject]@{ Name = $r.name; TaskName = "VibePromptRig-$($r.name)"; Script = $script; Cron = $r.schedule; St = (ConvertFrom-CronToSchtasks $r.schedule) }
}

if ($schedulable.Count -eq 0) {
    Write-Host "`n  No OS-schedulable routines found (need an enabled routine with a scripts/<name>.mjs body).`n" -ForegroundColor Yellow
    exit 0
}

foreach ($j in $schedulable) {
    if ($null -eq $j.St) {
        Write-Host "  [warn] $($j.Name): cron '$($j.Cron)' can't map to a single Task Scheduler trigger -- register manually or simplify the schedule. Skipped." -ForegroundColor Yellow
        continue
    }
    $tr = "node `"$($j.Script)`""
    $createArgs = @("/create", "/tn", $j.TaskName, "/tr", $tr, "/sc") + $j.St.sc + @("/st", $j.St.st, "/rl", "HIGHEST", "/f")
    if ($DryRun) {
        Write-Host "  [dry-run] schtasks /delete /tn $($j.TaskName) /f" -ForegroundColor DarkGray
        Write-Host "  [dry-run] schtasks $($createArgs -join ' ')" -ForegroundColor DarkGray
        continue
    }
    $ErrorActionPreference = "SilentlyContinue"
    schtasks /delete /tn $j.TaskName /f 2>$null | Out-Null
    $ErrorActionPreference = "Stop"
    schtasks @createArgs | Out-Null
    Write-Host "  Created: $($j.TaskName) ($($j.St.label))" -ForegroundColor Green
}

Write-Host ""
Write-Host ("  Setup complete!" + $(if ($DryRun) { " (dry-run -- nothing was registered)" } else { "" })) -ForegroundColor Green
Write-Host ""
Write-Host "  Verify with:" -ForegroundColor White
Write-Host "    schtasks /query /tn $($schedulable[0].TaskName)" -ForegroundColor DarkGray
Write-Host "  Note: restore-drill is MANUAL (quarterly) -- run 'node scripts/restore-drill.mjs' by hand." -ForegroundColor DarkGray
if ($schedulable.Name -contains "pg-dump-offsite") {
    Write-Host "  Note: pg-dump-offsite is REGISTERED, but only actually runs once its off-site backup is" -ForegroundColor DarkGray
    Write-Host "        ACTIVATED separately -- B2 + DB creds present in the operator env AND the task runs" -ForegroundColor DarkGray
    Write-Host "        elevated. Registration != active backup. See docs/architecture/cross-platform-port-t3-schedulers.md." -ForegroundColor DarkGray
}
Write-Host ""
