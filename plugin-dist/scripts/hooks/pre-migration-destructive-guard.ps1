<#
.SYNOPSIS
    PreToolUse hook -- screens Supabase apply_migration calls for selected destructive SQL patterns.
    Matcher: ^mcp__.+__apply_migration$ (any MCP server's apply_migration tool, for example
    mcp__supabase__apply_migration and mcp__plugin_supabase_supabase__apply_migration)
    Exit 2 = block with stderr message.

.NOTES
    FAIL CLOSED for the listed patterns and tokenization failures (owner policy, PR #37).
    This selective scanner prints review steps when it blocks. It does not prove other SQL safe. Blocked:
      - destructive statements: DROP TABLE, TRUNCATE, ALTER TABLE ... DROP, DROP POLICY/INDEX/SCHEMA/DATABASE;
      - DELETE FROM and UPDATE without a WHERE in the statement's own top-level scope. A WHERE inside a
        USING/FROM/SET subquery, in RETURNING, or in a surrounding CTE does not count;
      - dynamic SQL, whose text no scanner can see: PL/pgSQL EXECUTE of a string, variable or
        string-built statement, format(), dblink()/dblink_exec(). EXECUTE FUNCTION|PROCEDURE (trigger
        actions) and EXECUTE ON / "EXECUTE," (privileges) are not dynamic SQL;
      - unparseable SQL: a literal, quoted identifier, block comment or dollar-quoted body the payload
        never closes, or an internal error while judging the SQL.
    Other SQL shapes may pass; database authorization, restorable backups and human review remain necessary.
    Twin of pre-migration-destructive-guard.mjs; migration-guard-matcher.test.mjs checks their parity.
    PowerShell 5.1 compatible. ASCII only.
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

# PostgreSQL block comments nest. A dollar-body closing tag ends scanning inside that body.
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

# The SQL with comments and '...', E'...', "..." contents blanked (same length, newlines kept), so their
# keywords and semicolons are neither matched nor treated as statement ends. Plain '...' treats a
# backslash literally (PostgreSQL standard_conforming_strings), so it never swallows following SQL.
# $tag$...$tag$ bodies stay visible and are scanned as SQL (DO blocks and function bodies run); a quote
# or comment opened inside one ends at its closing tag. Nested /* */ stays masked. Twin of sqlCode().
# Sets $script:unterminated when the payload ends inside a literal, identifier, comment or dollar body.
$script:unterminated = $false
function Get-SqlCode([string]$sql) {
    $sb = New-Object System.Text.StringBuilder
    $closers = New-Object System.Collections.Generic.List[string]
    $len = $sql.Length
    $i = 0
    while ($i -lt $len) {
        $top = $null
        if ($closers.Count -gt 0) { $top = $closers[$closers.Count - 1] }
        if ($top -and ($i + $top.Length -le $len) -and [string]::CompareOrdinal($sql, $i, $top, 0, $top.Length) -eq 0) {
            $closers.RemoveAt($closers.Count - 1); [void]$sb.Append(' ' * $top.Length); $i += $top.Length; continue
        }
        $c = [string]$sql[$i]
        $n = ''; if ($i + 1 -lt $len) { $n = [string]$sql[$i + 1] }
        $prev = ''; if ($i -gt 0) { $prev = [string]$sql[$i - 1] }
        $j = -1
        $open = $false
        if ($c -ceq '-' -and $n -ceq '-') { $j = $sql.IndexOf("`n", $i); if ($j -lt 0) { $j = $len } }
        elseif ($c -ceq '/' -and $n -ceq '*') {
            $comment = Get-BlockCommentEnd $sql $i $top
            if ($comment.Open) { $script:unterminated = $true }
            [void]$sb.Append([regex]::Replace($sql.Substring($i, $comment.End - $i), '[^\n]', ' '))
            $i = $comment.End
            continue
        }
        elseif ($c -ceq "'" -or $c -ceq '"' -or ($c -match '^[Ee]$' -and $n -ceq "'" -and $prev -notmatch '^\w$')) {
            $esc = ($c -cne "'" -and $c -cne '"')
            $q = $c; $k = $i + 1
            if ($esc) { $q = "'"; $k = $i + 2 }
            while ($k -lt $len) {
                $ch = [string]$sql[$k]
                if ($esc -and $ch -ceq '\') { $k += 2; continue }
                if ($ch -ceq $q) {
                    if ($k + 1 -lt $len -and [string]$sql[$k + 1] -ceq $q) { $k += 2; continue }
                    break
                }
                $k++
            }
            $open = ($k -ge $len)
            $j = [Math]::Min($k + 1, $len)
        }
        elseif ($c -ceq '$' -and $prev -notmatch '^[\w$]$') {
            $m = [regex]::Match($sql.Substring($i, [Math]::Min(64, $len - $i)), '^\$(?:[A-Za-z_]\w*)?\$')
            if ($m.Success) { $closers.Add($m.Value); [void]$sb.Append(' ' * $m.Length); $i += $m.Length; continue }
        }
        if ($j -lt 0) { [void]$sb.Append($c); $i++; continue }
        $stop = $j
        $k2 = -1
        if ($top) { $k2 = $sql.IndexOf($top, $i, [StringComparison]::Ordinal) }
        if ($open -and $k2 -lt 0) { $script:unterminated = $true }
        if ($k2 -ge 0 -and $k2 -lt $stop) { $stop = $k2 }
        [void]$sb.Append([regex]::Replace($sql.Substring($i, $stop - $i), '[^\n]', ' '))
        $i = $stop
    }
    if ($closers.Count -gt 0) { $script:unterminated = $true }
    $sb.ToString()
}

# True when $stmt (masked SQL starting at DELETE/UPDATE) has a WHERE at its own parenthesis depth
# before the statement closes (a ')' below its starting depth ends a DELETE/UPDATE nested in a CTE).
function Test-TopLevelWhere([string]$stmt) {
    $depth = 0
    foreach ($m in [regex]::Matches($stmt, '(?i)[()]|\bWHERE\b')) {
        if ($m.Value -eq '(') { $depth++ }
        elseif ($m.Value -eq ')') { $depth--; if ($depth -lt 0) { return $false } }
        elseif ($depth -eq 0) { return $true }
    }
    return $false
}

# WHERE is judged per statement on its masked text: a WHERE in a comment, literal, quoted identifier or
# $$ text is not a clause, and neither is one in a subquery or in another statement.
function Test-Unscoped([string]$code, [string]$raw, [string]$re) {
    foreach ($m in [regex]::Matches($code, $re)) {
        if (-not (Test-TopLevelWhere (Mask-Sql $raw.Substring($m.Index, $m.Length)))) { return $true }
    }
    return $false
}

# UPDATE as a statement: not a trigger event, privilege, row lock, FK action or ON CONFLICT DO UPDATE.
$updateStatement = '(?i)(?<!\b(?:DO|FOR|KEY|BEFORE|AFTER|OR|OF|ON|GRANT|REVOKE)\s*)(?<!,\s*)\bUPDATE\b(?!\s+(?:ON|OF)\b)[^;]*'
$dynamicSql = '(?i)\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)(?!\s*,)|\bformat\s*\(|\bdblink(?:_exec)?\s*\('

$pattern = ""
try {
    $code = Get-SqlCode $sqlText
    if ($script:unterminated)                                   { $pattern = "unparseable SQL (a literal, quoted identifier, comment or dollar-quoted body is never closed)" }
    elseif ($code -match '(?i)\bDROP\s+TABLE\b')                { $pattern = "DROP TABLE" }
    elseif ($code -match '(?i)\bTRUNCATE\b')                    { $pattern = "TRUNCATE" }
    elseif ($code -match '(?i)\bALTER\s+TABLE\b[^;]*\bDROP\b')  { $pattern = "ALTER TABLE...DROP" }
    elseif (Test-Unscoped $code $sqlText '(?i)\bDELETE\s+FROM\b[^;]*') { $pattern = "DELETE without a top-level WHERE" }
    elseif (Test-Unscoped $code $sqlText $updateStatement)     { $pattern = "UPDATE without a top-level WHERE" }
    elseif ($code -match '(?i)\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b') { $pattern = "DROP POLICY/INDEX/SCHEMA/DATABASE" }
    elseif ($code -match $dynamicSql)                           { $pattern = "dynamic SQL (EXECUTE, format() or dblink): the statement text cannot be checked" }
} catch {
    $pattern = "unparseable SQL (the guard could not judge it)"
}

if ($pattern) {
    [Console]::Error.WriteLine("[BLOCKED] Destructive migration detected: $pattern")
    [Console]::Error.WriteLine("          This guard screens selected patterns and blocks unparseable SQL; exit 0 is not a safety verdict.")
    [Console]::Error.WriteLine("          1. Confirm a restorable backup exists from the last 24h (platform PITR or an off-platform pg_dump)")
    [Console]::Error.WriteLine("          2. Diff against current schema and surface each destructive op to the project owner")
    [Console]::Error.WriteLine("          3. Confirm dev project (not prod) and get explicit confirmation before any separate retry; this hook has no confirmation input")
    [Console]::Error.WriteLine("          See docs/rules-reference/factory/data-protection.md SS4 (destructive operation gate) and SS8 (self-check).")
    exit 2
}

exit 0
