<#
.SYNOPSIS
    PreToolUse hook -- screens Bash commands for selected destructive SQL patterns.
    Reads Claude Code hook JSON from stdin (per Claude Code hook spec).
    Exit 0 = allow; exit 2 = block with stderr message.

.NOTES
    FAIL CLOSED for the listed patterns (owner policy, PR #37). This selective scanner prints
    review steps when it blocks; it does not prove other SQL safe. Blocked anywhere in the command: DROP TABLE, TRUNCATE,
    ALTER TABLE ... DROP, DROP POLICY/INDEX/SCHEMA/DATABASE, and DELETE FROM / UPDATE ... SET without a
    WHERE in the statement's own top-level scope (a WHERE inside a USING/FROM/SET subquery or a CTE does
    not count). Blocked when the command carries SQL (psql, pgcli, supabase db, a DO block or plpgsql):
    dynamic SQL -- EXECUTE of a string, variable or string-built statement, format(),
    dblink()/dblink_exec(), psql \gexec -- whose text cannot be checked. EXECUTE FUNCTION|PROCEDURE and
    EXECUTE ON (privileges) are not dynamic SQL. The SQL sits inside shell quoting here, so it is not
    tokenized: the checks read the raw command and can miss other shapes. SQL in a file (psql -f) is
    out of this guard's sight. Database authorization, restorable backups and human review remain necessary.
    Twin of pre-bash-destructive-sql-guard.mjs; migration-guard-matcher.test.mjs checks their parity.
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

# PostgreSQL block comments nest; WHERE judgement must hide the whole comment.
function Get-BlockCommentEnd([string]$sql, [int]$start, [string]$boundary) {
    $depth = 1
    $i = $start + 2
    while ($i -lt $sql.Length) {
        if ($boundary -and $i + $boundary.Length -le $sql.Length -and [string]::CompareOrdinal($sql, $i, $boundary, 0, $boundary.Length) -eq 0) {
            return @{ End = $i; Open = $false }
        }
        if ($i + 1 -lt $sql.Length -and $sql.Substring($i, 2) -ceq '/*') { $depth++; $i += 2; continue }
        if ($i + 1 -lt $sql.Length -and $sql.Substring($i, 2) -ceq '*/') {
            $depth--; $i += 2
            if ($depth -eq 0) { return @{ End = $i; Open = $false } }
            continue
        }
        $i++
    }
    return @{ End = $sql.Length; Open = $true }
}

# WHERE judgement masks comments, quoted text and dollar bodies without exposing nested contents.
# Ordinary strings assume standard_conforming_strings=on; only E/e strings escape backslashes.
$maskToken = '--[^\n]*|(?<![\w$])[Ee]''(?:[^''\\]|\\[\s\S]|'''')*(?:''|$)|''(?:[^'']|'''')*(?:''|$)|"(?:[^"]|"")*(?:"|$)|\$([A-Za-z_]\w*|)\$[\s\S]*?(?:\$\1\$|$)'
$script:maskTokenRegex = New-Object System.Text.RegularExpressions.Regex $maskToken
function Mask-Sql([string]$sql) {
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    while ($i -lt $sql.Length) {
        if ($i + 1 -lt $sql.Length -and $sql.Substring($i, 2) -ceq '/*') {
            $comment = Get-BlockCommentEnd $sql $i ''
            [void]$sb.Append([regex]::Replace($sql.Substring($i, $comment.End - $i), '[^\n]', ' '))
            $i = $comment.End
            continue
        }
        $token = $script:maskTokenRegex.Match($sql, $i)
        if ($token.Success -and $token.Index -eq $i) {
            [void]$sb.Append([regex]::Replace($token.Value, '[^\n]', ' '))
            $i += $token.Length
        } else {
            [void]$sb.Append($sql[$i])
            $i++
        }
    }
    return $sb.ToString()
}

# True when $stmt (masked, starting at DELETE/UPDATE) has a WHERE at its own parenthesis depth before
# the statement closes (a ')' below its starting depth ends a DELETE/UPDATE nested in a CTE).
function Test-TopLevelWhere([string]$stmt) {
    $depth = 0
    foreach ($m in [regex]::Matches($stmt, '(?i)[()]|\bWHERE\b')) {
        if ($m.Value -eq '(') { $depth++ }
        elseif ($m.Value -eq ')') { $depth--; if ($depth -lt 0) { return $false } }
        elseif ($depth -eq 0) { return $true }
    }
    return $false
}
# WHERE is judged per statement: a WHERE elsewhere in the command must not qualify an unscoped one.
function Test-Unscoped([string]$re) {
    foreach ($m in [regex]::Matches($cmd, $re)) {
        if (-not (Test-TopLevelWhere (Mask-Sql $m.Value))) { return $true }
    }
    return $false
}

# UPDATE ... SET as a statement (shell words like `apt-get update` have no SET); not ON CONFLICT DO UPDATE.
$updateStatement = '(?i)(?<!\b(?:DO|FOR|KEY|BEFORE|AFTER|OR|OF|ON|GRANT|REVOKE)\s*)(?<!,\s*)\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\S+)?\s+SET\b[^;]*'
$sqlContext = '(?i)\b(?:psql|pgcli|plpgsql)\b|\bsupabase\s+db\b|\bDO\s+(?:\$|E?'')'
$dynamicSql = '(?i)\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)(?!\s*,)|\bformat\s*\(|\bdblink(?:_exec)?\s*\(|\\gexec\b'

$destructive = $false
try {
    if ($cmd -match '(?i)\bDROP\s+TABLE\b')                   { $destructive = $true }
    if ($cmd -match '(?i)\bTRUNCATE\b')                       { $destructive = $true }
    # Statement-agnostic on purpose: in a shell command the SQL sits inside shell quoting, so a ';' inside a
    # SQL literal or comment cannot be told from a statement end. Any DROP after ALTER TABLE blocks.
    if ($cmd -match '(?i)\bALTER\s+TABLE\b[\s\S]*\bDROP\b')   { $destructive = $true }
    if (Test-Unscoped '(?i)\bDELETE\s+FROM\b[^;]*')           { $destructive = $true }
    if (Test-Unscoped $updateStatement)                       { $destructive = $true }
    if ($cmd -match '(?i)\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b') { $destructive = $true }
    if (($cmd -match $sqlContext) -and ($cmd -match $dynamicSql)) { $destructive = $true }
} catch {
    $destructive = $true
}

if ($destructive) {
    [Console]::Error.WriteLine("[BLOCKED] Destructive SQL detected in bash command.")
    [Console]::Error.WriteLine("          This guard screens selected patterns; exit 0 is not a safety verdict.")
    [Console]::Error.WriteLine("          Surface to the project owner and get explicit confirmation before a separate retry; this hook has no confirmation input.")
    [Console]::Error.WriteLine("          See data-protection.md SS4 destructive-op gate.")
    exit 2
}

exit 0
