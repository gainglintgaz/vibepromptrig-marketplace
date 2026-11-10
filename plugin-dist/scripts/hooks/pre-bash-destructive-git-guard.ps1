<#
.SYNOPSIS
    PreToolUse hook -- blocks Bash commands containing destructive git operations.
    Exit 2 = block with stderr message.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Reads stdin (not $env:TOOL_INPUT).
#>

param()
$ErrorActionPreference = "SilentlyContinue"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

$stdin = $null
try { $stdin = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $stdin -or $stdin.Trim().Length -eq 0) { exit 0 }

$hook = $null
try { $hook = $stdin | ConvertFrom-Json } catch { exit 0 }
if (-not $hook -or $hook.tool_name -ne "Bash") { exit 0 }

$cmd = $null
if ($hook.tool_input -and $hook.tool_input.command) {
    $cmd = [string]$hook.tool_input.command
}
if (-not $cmd) { exit 0 }

# Destructive git operations
$blocked = $false
$reason  = ""

if ($cmd -match '(?i)\bgit\s+push\s+(-{1,2}f(orce)?|--force-with-lease)\b' -and $cmd -match '(?i)\b(main|master)\b') {
    $blocked = $true
    $reason  = "git push --force on main/master"
}
elseif ($cmd -match '(?i)\bgit\s+reset\s+--hard\b') {
    $blocked = $true
    $reason  = "git reset --hard (use git stash or git revert instead)"
}
elseif ($cmd -match '(?i)\bgit\s+clean\s+-f') {
    $blocked = $true
    $reason  = "git clean -f (destructive)"
}
elseif ($cmd -match '\bgit\s+branch\b' -and ($cmd -match '(^|\s)-D(\s|$)' -or $cmd -match '--force\b')) {
    # Case-sensitive -D check (was (?i), which false-matched safe lowercase -d --
    # git's own merge-verified delete). --force also catches --delete --force.
    $blocked = $true
    $reason  = "git branch -D / --delete --force (force-delete)"
}

if ($blocked) {
    [Console]::Error.WriteLine("[BLOCKED] Destructive git operation: $reason")
    [Console]::Error.WriteLine("          Get explicit approval from the project owner before retrying.")
    exit 2
}

exit 0
