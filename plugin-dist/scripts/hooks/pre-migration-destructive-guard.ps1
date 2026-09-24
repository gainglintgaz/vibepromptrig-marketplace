<#
.SYNOPSIS
    PreToolUse hook -- blocks Supabase apply_migration calls containing destructive SQL.
    Matcher: mcp__31fc416e*apply_migration
    Exit 2 = block with stderr message.
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
if (-not $hook) { exit 0 }

# Gather all string fields from tool_input -- migrations may pass SQL via 'query' or 'sql' field
$sqlText = ""
if ($hook.tool_input) {
    foreach ($prop in $hook.tool_input.PSObject.Properties) {
        if ($prop.Value -is [string]) {
            $sqlText += "`n" + $prop.Value
        }
    }
}

if (-not $sqlText) { exit 0 }

$destructive = $false
$pattern     = ""

if ($sqlText -match '(?i)\bDROP\s+TABLE\b')                   { $destructive = $true; $pattern = "DROP TABLE" }
elseif ($sqlText -match '(?i)\bTRUNCATE\b')                   { $destructive = $true; $pattern = "TRUNCATE" }
elseif ($sqlText -match '(?i)\bALTER\s+TABLE\b.*\bDROP\b')    { $destructive = $true; $pattern = "ALTER TABLE...DROP" }
elseif ($sqlText -match '(?i)\bDELETE\s+FROM\b' -and $sqlText -notmatch '(?i)\bWHERE\b') {
    $destructive = $true; $pattern = "DELETE FROM (no WHERE)"
}
elseif ($sqlText -match '(?i)\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b') {
    $destructive = $true; $pattern = "DROP POLICY/INDEX/SCHEMA/DATABASE"
}

if ($destructive) {
    [Console]::Error.WriteLine("[BLOCKED] Destructive migration detected: $pattern")
    [Console]::Error.WriteLine("          1. Run backup-check skill first")
    [Console]::Error.WriteLine("          2. Diff against current schema and surface to the project owner")
    [Console]::Error.WriteLine("          3. Confirm dev project (not prod) before re-trying")
    [Console]::Error.WriteLine("          See data-protection.md SS3 destructive-op gate.")
    exit 2
}

exit 0
