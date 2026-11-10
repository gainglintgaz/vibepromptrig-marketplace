<#
.SYNOPSIS
    forge workflows -- list the saved dynamic-workflow library (.claude/workflows/).

.DESCRIPTION
    Read-only. Reads each .claude/workflows/*.mjs, extracts its meta.name + meta.description,
    and prints how to run it. A saved workflow is invoked from a Claude Code session via the
    Workflow tool -- by name once the harness re-indexes at session start, or by scriptPath
    immediately. This command is how a cold reader discovers what is runnable.

.PARAMETER FactoryRoot
    Defaults to $env:VIBE_ROOT, else the factory root derived from the script location.

.PARAMETER Json
    Machine-readable output.

.EXAMPLE
    forge workflows
    forge workflows --json
#>
param(
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json
)
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$ErrorActionPreference = "Stop"

$wfDir = Join-Path $FactoryRoot ".claude\workflows"
if (-not (Test-Path $wfDir)) {
    if ($Json) { '{"workflows":[]}' }
    else { Write-Host "  No .claude/workflows/ directory yet." -ForegroundColor DarkGray }
    exit 0
}

$files = @(Get-ChildItem -Path $wfDir -Filter "*.mjs" -File | Sort-Object Name)
$workflows = @()
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw
    $name = $null
    $desc = $null
    $mName = [regex]::Match($content, "name:\s*'([^']*)'")
    if ($mName.Success) { $name = $mName.Groups[1].Value }
    $mDesc = [regex]::Match($content, "description:\s*'([^']*)'")
    if ($mDesc.Success) { $desc = $mDesc.Groups[1].Value }
    if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name) }
    $workflows += [PSCustomObject]@{
        name        = $name
        description = $desc
        scriptPath  = ".claude/workflows/$($f.Name)"
    }
}

if ($Json) {
    @{ workflows = $workflows } | ConvertTo-Json -Depth 5
    exit 0
}

Write-Host ""
Write-Host "Saved dynamic workflows (.claude/workflows/)" -ForegroundColor Cyan
Write-Host ""
if ($workflows.Count -eq 0) {
    Write-Host "  (none yet -- add a .mjs Workflow script to .claude/workflows/)" -ForegroundColor DarkGray
} else {
    foreach ($w in $workflows) {
        Write-Host ("  {0}" -f $w.name) -ForegroundColor Green
        if ($w.description) {
            Write-Host ("      {0}" -f $w.description) -ForegroundColor Gray
        }
        Write-Host ("      run: Workflow(name: '{0}')  or  Workflow(scriptPath: '{1}')" -f $w.name, $w.scriptPath) -ForegroundColor DarkGray
        Write-Host ""
    }
    Write-Host ("  {0} workflow(s). Invoke from a Claude Code session with the Workflow tool." -f $workflows.Count) -ForegroundColor DarkGray
    Write-Host "  Name-invocation indexes at session start; scriptPath works immediately." -ForegroundColor DarkGray
}
Write-Host ""
exit 0
