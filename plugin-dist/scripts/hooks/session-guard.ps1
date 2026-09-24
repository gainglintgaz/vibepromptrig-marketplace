<#
.SYNOPSIS
    One-writer-per-repo guard -- heartbeat lockfile + advisory + commit/push gate.
    Spec: docs/v5.0/one-writer-guard-spec.md (3 layers, warn-not-block).
    Build deltas: docs/architecture/one-writer-guard.md (founder-approved 2026-06-04).

    Events (wired in .claude/settings.json):
      -Event start      SessionStart      claim lock or print LOUD advisory (exit 0 always)
      -Event prewrite   PreToolUse(Bash)  owner: refresh; foreign fresh lock + git commit/push
                                          + INTERACTIVE session: exit 2 (the only hard stop);
                                          headless/unsure: warn only (exit 0)
      -Event heartbeat  UserPromptSubmit  refresh heartbeat_at (silent -- stdout becomes context)
      -Event stop       Stop              release lock if owned

    Lockfile: <CLAUDE_PROJECT_DIR>\.claude\.session-lock.json (gitignored, NO secrets).
    Staleness: heartbeat_at older than SESSION_GUARD_STALE_MINUTES (default 15) = DEAD,
    auto-reclaimed. Corrupt/unreadable lock = absent. Unknown own session id = degraded
    mode: never claim, never block.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Reads hook JSON from stdin.
    MUST never crash the tool loop: every path exits 0 except the deliberate
    interactive commit/push block (exit 2).
#>

[CmdletBinding()]
param(
    [ValidateSet("start", "prewrite", "heartbeat", "stop")]
    [string]$Event = "start"
)
$ErrorActionPreference = "SilentlyContinue"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

# ---------- helpers ----------

function Read-HookInput {
    $stdin = $null
    try { $stdin = [Console]::In.ReadToEnd() } catch { return $null }
    if (-not $stdin) { return $null }
    $stdin = $stdin.TrimStart([char]0xFEFF).Trim()   # tolerate UTF-8 BOM on stdin
    if ($stdin.Length -eq 0) { return $null }
    try { return ($stdin | ConvertFrom-Json) } catch { return $null }
}

function Get-ProjectDir {
    param($Hook)
    if ($env:CLAUDE_PROJECT_DIR -and (Test-Path $env:CLAUDE_PROJECT_DIR)) {
        return $env:CLAUDE_PROJECT_DIR
    }
    if ($Hook -and $Hook.cwd -and (Test-Path ([string]$Hook.cwd))) {
        return [string]$Hook.cwd
    }
    return (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
}

function Get-LockPath {
    param([string]$ProjectDir)
    return (Join-Path (Join-Path $ProjectDir ".claude") ".session-lock.json")
}

function Read-Lock {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        $raw = Get-Content -Path $Path -Raw -Encoding UTF8
        if (-not $raw -or -not $raw.Trim()) { return $null }
        $lock = $raw | ConvertFrom-Json
        if (-not $lock -or -not $lock.session_id) { return $null }   # corrupt/foreign shape = absent
        return $lock
    } catch { return $null }
}

function Get-StaleMinutes {
    $m = 15
    if ($env:SESSION_GUARD_STALE_MINUTES -and $env:SESSION_GUARD_STALE_MINUTES -match '^\d+$') {
        $m = [int]$env:SESSION_GUARD_STALE_MINUTES
        if ($m -lt 1) { $m = 1 }
    }
    return $m
}

function Test-LockFresh {
    param($Lock, [int]$StaleMinutes)
    if (-not $Lock -or -not $Lock.heartbeat_at) { return $false }
    try {
        $hb = [DateTimeOffset]::Parse([string]$Lock.heartbeat_at,
              [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $age = ([DateTime]::UtcNow - $hb).TotalMinutes
        # Far-future heartbeat (more than one stale-window ahead) = corrupt/tampered
        # -> STALE, reclaimable. Without this upper bound a future-dated lock is
        # immortal (SS5 gate hostile finding F1, 2026-06-04).
        if ($age -lt (-1 * $StaleMinutes)) { return $false }
        # Small negative skew (NTP resync after sleep) tolerated as fresh-now:
        if ($age -lt 0) { $age = 0 }
        return ($age -le $StaleMinutes)
    } catch { return $false }   # unparseable heartbeat = stale
}

function Get-LastSeenSeconds {
    param($Lock)
    try {
        $hb = [DateTimeOffset]::Parse([string]$Lock.heartbeat_at,
              [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $s = [int]([DateTime]::UtcNow - $hb).TotalSeconds
        if ($s -lt 0) { $s = 0 }
        return $s
    } catch { return -1 }
}

function Get-MySessionIds {
    # CLAUDE_CODE_SESSION_ID (env, process-lifetime) goes FIRST -- Write-Lock uses
    # $myIds[0] as the durable identity stamped into the lock. Some entrypoints
    # (observed: claude-desktop) mint a NEW Hook.session_id on every SessionStart:resume
    # within one continuous human conversation, while the env var stays fixed for the
    # life of that conversation. Storing the volatile Hook.session_id as canonical meant
    # Write-Lock stamped a throwaway id every time, so no later event -- including the
    # UserPromptSubmit heartbeat refresh -- could ever match ownership again: heartbeat_at
    # froze at whatever `start` last wrote, and every subsequent resume saw a "foreign"
    # lock that was actually the same session. Root-caused 2026-08-01 on example-wellness-app.
    # Kept in sync with session-guard.mjs's Get-MySessionIds -- see its comment for detail.
    param($Hook)
    $ids = @()
    if ($env:CLAUDE_CODE_SESSION_ID)  { $ids += [string]$env:CLAUDE_CODE_SESSION_ID }
    if ($Hook -and $Hook.session_id) { $ids += [string]$Hook.session_id }
    return @($ids | Where-Object { $_ -and $_.Trim() } | Select-Object -Unique)
}

function Test-IsOwner {
    param($Lock, [string[]]$MyIds)
    if (-not $Lock -or -not $Lock.session_id) { return $false }
    if (-not $MyIds -or $MyIds.Count -eq 0)   { return $false }
    # Dual signal: stdin session_id OR env CLAUDE_CODE_SESSION_ID -- EITHER match = owner.
    # (De-risks the owner-brick scenario; see docs/architecture/one-writer-guard.md SS5.)
    foreach ($id in $MyIds) {
        if ([string]$Lock.session_id -eq $id) { return $true }
    }
    return $false
}

function Get-AgentLabel {
    $ep = $env:CLAUDE_CODE_ENTRYPOINT
    if (-not $ep) { return "unknown" }
    switch -Regex ($ep) {
        '^cli$'   { return "interactive-cli" }
        '^print$' { return "headless-print" }
        '^sdk'    { return "headless-sdk" }
        default   { return [string]$ep }
    }
}

function Test-Interactive {
    # Founder delta 2 (2026-06-04): the hard stop fires ONLY when this session is
    # CONFIRMED interactive. 'print' / 'sdk-*' / missing entrypoint = headless or
    # unsure = warn, never block. Silently blocking the 8am cron's commit is worse
    # than the collision.
    return ($env:CLAUDE_CODE_ENTRYPOINT -eq "cli")
}

function Write-Lock {
    param([string]$Path, [string]$SessionId, [string]$StartedAt)
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $now = [DateTime]::UtcNow.ToString("o")
        if (-not $StartedAt) { $StartedAt = $now }
        $lock = [ordered]@{
            session_id   = $SessionId
            agent        = (Get-AgentLabel)
            pid          = $PID
            host         = [string]$env:COMPUTERNAME
            started_at   = $StartedAt
            heartbeat_at = $now
            intent       = "building"
        }
        $json = $lock | ConvertTo-Json -Compress
        $tmp = "$Path.tmp"
        Set-Content -Path $tmp -Value $json -Encoding UTF8
        Move-Item -Path $tmp -Destination $Path -Force
    } catch { }
}

function Remove-Lock {
    param([string]$Path)
    try { Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue } catch { }
}

# git invocation with optional global flags, then commit|push|add as the subcommand.
# Unanchored: catches compound commands (foo && git commit) and multiline Bash.
# Does NOT match 'git log | grep commit' (commit must follow git + flags directly).
# (?![\w-]) excludes hyphenated plumbing subcommands (commit-graph, commit-tree,
# push-options) -- SS5 gate findings, 2026-06-04.
$script:GitPrefix = '\bgit(\.exe)?\b(\s+(-C\s+("[^"]*"|' + "'[^']*'" + '|\S+)|--no-pager|-c\s+\S+|--git-dir=\S+|--work-tree=\S+))*\s+'

function Test-GitCommitPush { param([string]$Cmd)
    return ($Cmd -match ('(?i)' + $script:GitPrefix + '(commit|push)(?![\w-])')) }
function Test-GitStageOrSync { param([string]$Cmd)
    if ($Cmd -match ('(?i)' + $script:GitPrefix + 'add(?![\w-])')) { return $true }
    return ($Cmd -match '(?i)sync-rules') }

# ---------- main ----------

try {
    $hook       = Read-HookInput
    $projectDir = Get-ProjectDir -Hook $hook
    $lockPath   = Get-LockPath -ProjectDir $projectDir
    $staleMin   = Get-StaleMinutes
    $myIds      = @(Get-MySessionIds -Hook $hook)   # @() guards PS array-unwrap on return
    $lock       = Read-Lock -Path $lockPath
    $fresh      = Test-LockFresh -Lock $lock -StaleMinutes $staleMin
    $owner      = Test-IsOwner -Lock $lock -MyIds $myIds

    # Degraded mode: cannot establish own identity -> never claim, never block.
    $haveIdentity = ($myIds.Count -gt 0)

    switch ($Event) {

        "start" {
            if (-not $haveIdentity) { exit 0 }
            if (-not $lock -or -not $fresh -or $owner) {
                # absent / corrupt / stale / our own -> (re)claim silently
                $startedAt = $null
                if ($owner -and $lock.started_at) { $startedAt = [string]$lock.started_at }
                Write-Lock -Path $lockPath -SessionId $myIds[0] -StartedAt $startedAt
                exit 0
            }
            # foreign fresh lock -> LOUD advisory (stdout lands in session context). No steal.
            $seen = Get-LastSeenSeconds -Lock $lock
            Write-Output "[SESSION GUARD] Another active session appears to be building in this repo:"
            Write-Output "  agent=$($lock.agent)  started=$($lock.started_at)  last-seen=${seen}s ago  pid=$($lock.pid)  host=$($lock.host)"
            Write-Output "Two writers in one working tree corrupt commits (2026-06-01 incident -- docs/v5.0/one-writer-guard-spec.md SS1)."
            Write-Output "Options:"
            Write-Output "  (a) let that session finish before writing here"
            Write-Output "  (b) use a separate git worktree: git worktree add ../vf-<name> <branch>  (VIBE Rule 28)"
            Write-Output "  (c) if that session is dead, the lock auto-releases after $staleMin minutes"
            Write-Output "Recommendation: treat this session as READ-ONLY until the lock clears."
            Write-Output "git commit / git push here will be BLOCKED while the other session is live (interactive sessions only; headless sessions warn instead)."
            exit 0
        }

        "prewrite" {
            # Matcher is Bash-only (founder delta 4), but stay defensive:
            if (-not $hook -or $hook.tool_name -ne "Bash") { exit 0 }
            $cmd = $null
            if ($hook.tool_input -and $hook.tool_input.command) { $cmd = [string]$hook.tool_input.command }
            if (-not $cmd) { exit 0 }

            if (-not $haveIdentity) { exit 0 }   # degraded: never claim, never block

            if (-not $lock -or -not $fresh) {
                # absent / corrupt / stale -> claim (self-heal; prevents mid-session brick)
                Write-Lock -Path $lockPath -SessionId $myIds[0] -StartedAt $null
                exit 0
            }
            if ($owner) {
                # refresh heartbeat, preserve started_at
                Write-Lock -Path $lockPath -SessionId $myIds[0] -StartedAt ([string]$lock.started_at)
                exit 0
            }

            # foreign FRESH lock
            $seen = Get-LastSeenSeconds -Lock $lock
            if (Test-GitCommitPush -Cmd $cmd) {
                if (Test-Interactive) {
                    [Console]::Error.WriteLine("[SESSION GUARD] BLOCKED: git commit/push while another session holds the build lock.")
                    [Console]::Error.WriteLine("  owner agent=$($lock.agent)  last-seen=${seen}s ago  (lock: .claude\.session-lock.json)")
                    [Console]::Error.WriteLine("  Resolve: wait for the other session, use a git worktree (VIBE Rule 28),")
                    [Console]::Error.WriteLine("  or if that session is dead the lock auto-releases after $staleMin min.")
                    exit 2
                } else {
                    [Console]::Error.WriteLine("[SESSION GUARD] WARNING: another builder session is active (last-seen ${seen}s ago); commit/push may collide. Headless session -- warn only, not blocked.")
                    exit 0
                }
            }
            if (Test-GitStageOrSync -Cmd $cmd) {
                [Console]::Error.WriteLine("[SESSION GUARD] WARNING: another builder session is active (last-seen ${seen}s ago); your staged changes may be swept into its commit. See SessionStart notice.")
                exit 0
            }
            exit 0
        }

        "heartbeat" {
            # UserPromptSubmit: stdout becomes session context -- stay SILENT.
            if (-not $haveIdentity) { exit 0 }
            if (-not $lock -or -not $fresh) {
                Write-Lock -Path $lockPath -SessionId $myIds[0] -StartedAt $null
                exit 0
            }
            if ($owner) {
                Write-Lock -Path $lockPath -SessionId $myIds[0] -StartedAt ([string]$lock.started_at)
            }
            exit 0
        }

        "stop" {
            if ($owner) { Remove-Lock -Path $lockPath }
            exit 0
        }
    }
    exit 0
} catch {
    exit 0
}
