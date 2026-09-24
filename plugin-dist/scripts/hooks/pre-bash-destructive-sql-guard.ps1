<#
.SYNOPSIS
    PreToolUse hook -- blocks Bash commands containing destructive SQL.
    Reads Claude Code hook JSON from stdin (per Claude Code hook spec).
    Exit 0 = allow; exit 2 = block with stderr message.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Never uses $input (PS automatic variable).
    Hook stdin: {"session_id":"...","tool_name":"Bash","tool_input":{"command":"..."}}
#>

param()
$ErrorActionPreference = "SilentlyContinue"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

# Read stdin (use $stdin, NOT $input)
$stdin = $null
try { $stdin = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $stdin -or $stdin.Trim().Length -eq 0) { exit 0 }

$hook = $null
try { $hook = $stdin | ConvertFrom-Json } catch { exit 0 }
if (-not $hook) { exit 0 }

# Only fire for Bash tool
if ($hook.tool_name -ne "Bash") { exit 0 }

$cmd = $null
if ($hook.tool_input -and $hook.tool_input.command) {
    $cmd = [string]$hook.tool_input.command
}
if (-not $cmd) { exit 0 }

# Destructive SQL patterns -- block unless commit body has [approved-destructive] flag.
# Note: DELETE FROM <table> WITHOUT a WHERE clause is destructive; with WHERE it's OK.
$destructive = $false

if ($cmd -match '(?i)\bDROP\s+TABLE\b')                   { $destructive = $true }
if ($cmd -match '(?i)\bTRUNCATE\b')                       { $destructive = $true }
if ($cmd -match '(?i)\bALTER\s+TABLE\b.*\bDROP\b')        { $destructive = $true }
if ($cmd -match '(?i)\bDELETE\s+FROM\b' -and $cmd -notmatch '(?i)\bWHERE\b') { $destructive = $true }
if ($cmd -match '(?i)\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b') { $destructive = $true }

if ($destructive) {
    [Console]::Error.WriteLine("[BLOCKED] Destructive SQL detected in bash command.")
    [Console]::Error.WriteLine("          Surface to the project owner for explicit approval before executing.")
    [Console]::Error.WriteLine("          See data-protection.md SS3 destructive-op gate.")
    exit 2
}

exit 0
