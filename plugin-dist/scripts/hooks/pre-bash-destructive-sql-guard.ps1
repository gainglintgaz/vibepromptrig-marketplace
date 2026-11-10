<#
.SYNOPSIS
    PreToolUse(Bash) SQL guard compatibility entrypoint (PowerShell 5.1).
.NOTES
    FAIL CLOSED for listed SQL patterns and unknown SQL client inputs. One canonical
    parser lives in the adjacent .mjs: quote removal, wrappers, pipes, substitutions,
    heredocs, explicit .sql files and the PR #44 nested-comment WHERE masking.
    Requires Node >=18, as do the registered plugin hooks. Never executes the inspected
    command; forwards the original stdin envelope and the Node exit code/stderr.
    Empty/malformed/non-Bash envelopes allow; missing Node/guard fails closed.
    migration-guard-matcher.test.mjs exercises this entrypoint against the Node twin.
#>
param()
$ErrorActionPreference = 'Stop'
if ($env:VIBE_HOOKS_DISABLE) { exit 0 }
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $envelope = [Console]::In.ReadToEnd()
    if (-not $envelope -or -not $envelope.Trim()) { exit 0 }
    # Do not print the command or any SQL/file contents, including on errors.
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $guard = Join-Path $PSScriptRoot 'pre-bash-destructive-sql-guard.mjs'
    if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) { throw 'Missing guard' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.Arguments = '"' + $guard + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $child = [System.Diagnostics.Process]::Start($start)
    # .NET Framework (PS 5.1) has no StandardInputEncoding property. Write UTF-8 bytes.
    $bytes = $utf8NoBom.GetBytes($envelope)
    $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $child.StandardInput.BaseStream.Flush()
    $child.StandardInput.Close()
    $child.WaitForExit()
    $code = $child.ExitCode
    $child.Dispose()
    exit $code
} catch {
    [Console]::Error.WriteLine('[BLOCKED] SQL guard could not inspect the hook input.')
    exit 2
}
