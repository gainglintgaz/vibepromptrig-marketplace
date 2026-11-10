<#
.SYNOPSIS
    VibePromptRig v4.3.5 — Tier-1 passive-listening signal classifier.
    Fires on every UserPromptSubmit hook. Never blocks execution (always exits 0).
    Matches prompt against 12 signal categories in signal-taxonomy.json.
    Logs matched signals to <project>/.claude/signal-log.jsonl (90-day TTL).
    Prints real-time alerts to stdout for CRITICAL signals (Claude sees them).
.NOTES
    PowerShell 5.1 compatible. ASCII-only. No emoji. No box-drawing chars.
    Hook input: JSON via stdin {"session_id":"...","transcript_path":"...","prompt":"..."}
    PII scrubber runs inline before any storage.
#>

param()
$ErrorActionPreference = "SilentlyContinue"

# ---- Force UTF-8 encoding for stdin/stdout (PowerShell 5.1 defaults to CP1252) ----
# Without this, UTF-8 bytes for chars like -> are decoded as Windows-1252 and stored as mojibake.
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

# --- Double-fire guard (Desktop audit 2026-06-13) -----------------------------
# In a FACTORY session the repo's .claude/settings.json wires this hook AND the
# globally-enabled vibepromptrig plugin wires the same hook -- so it fires twice,
# double-logging every prompt's signals. When THIS copy is the plugin
# DISTRIBUTION copy (under plugin-dist/ or the plugins cache) and the session is
# running in the factory itself, defer to the repo-local copy. Customer sessions
# are unaffected (their cwd is not the factory).
if (($PSScriptRoot -match '[\\/]plugin-dist([\\/]|$)') -or ($PSScriptRoot -match '[\\/]plugins[\\/]cache[\\/]')) {
    $vfCwd = (Get-Location).Path
    if ((Test-Path (Join-Path $vfCwd '.claude-plugin\plugin.json')) -and (Test-Path (Join-Path $vfCwd 'plugin-dist'))) {
        exit 0
    }
}

# ---- Config ----
# Prefer script-adjacent taxonomy (so each worktree has its own copy), fall back to factory root.
$FactoryRoot    = if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path $PSScriptRoot -Parent }
$ScriptDir      = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$LocalTaxonomy  = Join-Path (Split-Path -Parent $ScriptDir) ".claude\signal-taxonomy.json"
$GlobalTaxonomy = Join-Path $FactoryRoot ".claude\signal-taxonomy.json"
$TaxonomyPath   = if (Test-Path $LocalTaxonomy) { $LocalTaxonomy } else { $GlobalTaxonomy }
$MaxExcerptLen  = 200
$TtlDays        = 90
$TtlCleanupRate = 50  # prune on 1/50 runs to avoid overhead

# ---- Read stdin (UTF-8 per encoding override above) ----
$stdinRaw = $null
try { $stdinRaw = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $stdinRaw -or $stdinRaw.Trim().Length -eq 0) { exit 0 }

$hookInput = $null
try { $hookInput = $stdinRaw | ConvertFrom-Json } catch { exit 0 }

$prompt    = $hookInput.prompt
$sessionId = if ($hookInput.session_id) { $hookInput.session_id } else {
    "sess-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
}

if (-not $prompt -or $prompt.Trim().Length -eq 0) { exit 0 }

# ---- Load taxonomy ----
if (-not (Test-Path $TaxonomyPath)) { exit 0 }
$taxonomy = $null
try { $taxonomy = Get-Content $TaxonomyPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { exit 0 }
if (-not $taxonomy -or -not $taxonomy.signals) { exit 0 }

# ---- Project ID ----
$cwd       = (Get-Location).Path
$projectId = Split-Path $cwd -Leaf
if ($cwd -ieq $FactoryRoot) { $projectId = "factory" }

# ---- PII scrubber ----
function Invoke-PIIScrub {
    param([string]$Text)

    # API key patterns (highest priority -- discard entire entry if raw key found)
    $secretPatterns = @(
        'sbp_[a-zA-Z0-9]{10,}',
        'sk-ant-[a-zA-Z0-9\-_]{20,}',
        'sk-proj-[a-zA-Z0-9\-_]{20,}',
        'AKIA[A-Z0-9]{16}',
        'eyJhbGci[a-zA-Z0-9\-_.]{20,}',
        'gh[pousr]_[a-zA-Z0-9]{36,}',
        'xoxb-[a-zA-Z0-9\-]{20,}',
        'xoxp-[a-zA-Z0-9\-]{20,}'
    )
    foreach ($sp in $secretPatterns) {
        if ($Text -match $sp) { return $null }   # signal caller to discard
    }

    # Redact PII patterns
    $Text = $Text -replace '\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b', '[EMAIL]'
    $Text = $Text -replace '\b(\+1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b', '[PHONE]'
    $Text = $Text -replace '\b\d{3}-\d{2}-\d{4}\b', '[SSN]'
    $Text = $Text -replace '\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b', '[CC]'
    $Text = $Text -replace '(?i)(password|passwd|secret|token)\s*[:=]\s*\S+', '$1=[REDACTED]'

    return $Text
}

# ---- Meta-context exclusion: prompts that ask about / explain concepts shouldn't fire incident signals ----
# Applies to CRITICAL signals only (SECURITY, RULE_VIOLATION, REPEAT) to avoid false positives.
# Example: "explain the secret-rotation rule" should not fire SECURITY.
$metaContextPattern = $null
if ($taxonomy.meta_context_exclusions) {
    $metaContextPattern = $taxonomy.meta_context_exclusions
}
$isMetaContext = $false
if ($metaContextPattern) {
    try { if ($prompt -match $metaContextPattern) { $isMetaContext = $true } } catch { }
}

# ---- Tier-1 classification ----
$matchedSignals  = [System.Collections.Generic.List[object]]::new()
$criticalFired   = [System.Collections.Generic.List[string]]::new()

foreach ($signal in $taxonomy.signals) {
    $tier1Hit = $false

    foreach ($pattern in $signal.tier1_patterns) {
        try {
            if ($prompt -match $pattern) { $tier1Hit = $true; break }
        } catch { continue }
    }

    if (-not $tier1Hit) { continue }

    # ---- Negative-pattern exclusion: if any negative pattern matches, suppress this signal ----
    # Lets the taxonomy say "fire BUG except when surrounded by 'no bug', 'fixed the bug', 'past tense'".
    $negHit = $false
    if ($signal.negative_patterns) {
        foreach ($neg in $signal.negative_patterns) {
            try {
                if ($prompt -match $neg) { $negHit = $true; break }
            } catch { continue }
        }
    }
    if ($negHit) { continue }

    # ---- Meta-context suppression for CRITICAL signals ----
    # Prose discussion of security/rule concepts should not be flagged as an incident.
    # Skip suppression if the signal explicitly opts in via require_incident_context=false.
    if ($isMetaContext -and $signal.priority -eq "CRITICAL") {
        $requiresIncident = $true
        if ($signal.PSObject.Properties['require_incident_context']) {
            $requiresIncident = [bool]$signal.require_incident_context
        }
        if ($requiresIncident) { continue }
    }

    # ---- SECURITY hardening: require actual token-shaped string OR incident phrasing ----
    # Avoids firing on every prose mention of 'token', 'secret', 'credential'.
    if ($signal.type -eq "SECURITY") {
        $hasRealTokenShape = ($prompt -match 'sbp_[a-zA-Z0-9]{10,}') `
            -or ($prompt -match 'sk-ant-[a-zA-Z0-9\-_]{20,}') `
            -or ($prompt -match 'sk-proj-[a-zA-Z0-9\-_]{20,}') `
            -or ($prompt -match 'AKIA[A-Z0-9]{16}') `
            -or ($prompt -match 'eyJhbGci[a-zA-Z0-9\-_.]{20,}') `
            -or ($prompt -match 'gh[pousr]_[a-zA-Z0-9]{36,}')
        $hasIncidentPhrase = $prompt -match '(?i)\b(exposed|leaked|leaking|breach|compromised|in the (transcript|log|output|repo|commit)|just (committed|pushed|pasted)|accidentally (committed|pushed|pasted))\b'
        if (-not ($hasRealTokenShape -or $hasIncidentPhrase)) { continue }
    }

    # Strength scoring
    $strength = 1
    foreach ($marker in $signal.strength_markers) {
        try {
            if ($prompt -match $marker) { $strength = 3; break }
        } catch { continue }
    }

    $matchedSignals.Add(@{
        type     = $signal.type
        priority = $signal.priority
        strength = $strength
    })

    if ($signal.priority -eq "CRITICAL") {
        $criticalFired.Add($signal.type)
    }
}

# ---- Nothing matched: exit silently (no log entry) ----
if ($matchedSignals.Count -eq 0) { exit 0 }

# ---- Print real-time alerts for CRITICAL signals ----
# These appear in Claude's context for this prompt turn
foreach ($critType in $criticalFired) {
    switch ($critType) {
        "SECURITY" {
            Write-Output ""
            Write-Output "[SIGNAL:SECURITY] Possible secret or credential exposure detected in this prompt."
            Write-Output "  Action: Review prompt before proceeding. Check secrets-handling.md SS9 incident response."
            Write-Output "  If a token value appeared: rotate immediately per SS3.1."
        }
        "REPEAT" {
            Write-Output ""
            Write-Output "[SIGNAL:REPEAT] This pattern has been flagged before. Check signal-log.jsonl for prior occurrences."
            Write-Output "  High-priority: if a prior lesson covers this, promote it to a factory rule."
        }
        "RULE_VIOLATION" {
            Write-Output ""
            Write-Output "[SIGNAL:RULE_VIOLATION] Possible VibePromptRig rule violation detected."
            Write-Output "  Action: identify which rule, log to PENDING_APPROVALS.md for rule-strengthening review."
        }
    }
}

# ---- Build log entry ----
$signalTypes  = $matchedSignals | ForEach-Object { $_.type }
$totalStrength = ($matchedSignals | Measure-Object -Property strength -Sum).Sum
$needsTier2    = ($matchedSignals.Count -ge [int]$taxonomy.tier2_trigger.Replace(">=","").Trim())

# Scrub excerpt -- if scrubber returns $null, a raw secret was in the prompt
$rawExcerpt     = $prompt.Substring(0, [Math]::Min($prompt.Length, $MaxExcerptLen))
$scrubbedExcerpt = Invoke-PIIScrub -Text $rawExcerpt

$secretInPrompt = ($null -eq $scrubbedExcerpt)

$logEntry = [ordered]@{
    # Real UTC -- Get-Date -Format "...Z" stamped LOCAL time with a fake Z, which the
    # batch analyzer (RoundtripKind parse) shifted 4h older, shrinking its session
    # window (self-improvement wiring audit R1, 2026-06-04).
    ts             = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss") + "Z")
    session_id     = $sessionId
    project        = $projectId
    signals        = @($signalTypes)
    strength       = $totalStrength
    needs_tier2    = $needsTier2
    secret_in_prompt = $secretInPrompt
    prompt_excerpt = if ($secretInPrompt) { "[DISCARDED: secret detected -- not stored]" } else { $scrubbedExcerpt }
}

# ---- Write to signal-log.jsonl ----
$logDir  = Join-Path $cwd ".claude"
$logPath = Join-Path $logDir "signal-log.jsonl"

if (-not (Test-Path $logDir)) {
    try { New-Item -ItemType Directory -Path $logDir -Force | Out-Null } catch { exit 0 }
}

try {
    $line = $logEntry | ConvertTo-Json -Compress -Depth 5
    Add-Content -Path $logPath -Value $line -Encoding UTF8
} catch { exit 0 }

# ---- TTL cleanup (probabilistic -- 1/50 runs) ----
if ((Get-Random -Maximum $TtlCleanupRate) -eq 0) {
    try {
        if (Test-Path $logPath) {
            $cutoff = (Get-Date).AddDays(-$TtlDays).ToString("yyyy-MM-dd")
            $lines  = Get-Content $logPath -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($lines) {
                $kept = $lines | Where-Object {
                    $_ -match '"ts"\s*:\s*"(\d{4}-\d{2}-\d{2})' -and $Matches[1] -ge $cutoff
                }
                if ($kept) {
                    $kept | Set-Content $logPath -Encoding UTF8
                }
            }
        }
    } catch {
        # TTL failure is non-fatal
    }
}

exit 0
