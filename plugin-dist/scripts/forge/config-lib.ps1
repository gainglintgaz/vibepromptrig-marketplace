<#
.SYNOPSIS
    config-lib.ps1 -- reusable library for the v5.0 override layer.
.DESCRIPTION
    Dot-sourced by validate-agent-schemas.ps1 (Commit 1) and resolve-config.ps1
    (Commit 2). Houses the A3 path-jail, A10 secrets-scan, and (Commit 2) the A2
    merge-rule table.

    Arch artifact: 9d7294c (docs/architecture/v5.0-sprint-1-override-layer.md).
    PowerShell 5.1 compatible. ASCII only. No native JSON Schema in 5.1 --
    validation is hand-rolled (property existence + type + enum + const).

    Constraints honored:
      A3  -- path jail: resolve(base, path).StartsWith(base); reject '..' escape.
      A4  -- fail loud: callers throw on violation; never silent-fallback.
      A10 -- no secrets in .forge/*.json: reject token-shaped strings.
.NOTES
    Functions are pure (no global state) so the resolver stays code-not-LLM (A1).
#>

# Token-shaped string patterns rejected at load time (A10). VALUES come from env.
$script:SecretPatterns = @(
    'sk-ant-',          # Anthropic
    'sk-proj-',         # OpenAI project keys
    'sbp_',             # Supabase access token
    'AKIA',             # AWS access key id
    'eyJ'               # JWT header (base64 '{"')
)

# Schema contract version this build validates against (A5).
$script:SchemaVersion = '1.0.0'

function Test-PathJail {
    <#
    .SYNOPSIS  A3 path jail. Returns $true if Candidate stays inside Base.
    .PARAMETER Base       Absolute base directory (the jail root, normally cwd).
    .PARAMETER Candidate  Customer-supplied (possibly relative) path.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Base,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    # Normalize the base to a full path with a trailing separator.
    $baseFull = [System.IO.Path]::GetFullPath($Base)
    if (-not $baseFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $baseFull += [System.IO.Path]::DirectorySeparatorChar
    }
    # Resolve the candidate relative to the base (GetFullPath collapses '..').
    $combined = [System.IO.Path]::Combine($baseFull, $Candidate)
    try {
        $candFull = [System.IO.Path]::GetFullPath($combined)
    } catch {
        return $false
    }
    # Inside the jail if the resolved path starts with the base (case-insensitive on Windows).
    return $candFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-StringLeaves {
    <#
    .SYNOPSIS  Recursively collect every string leaf as @{ Path; Value }.
               Used by both the secrets scan and the path-jail field sweep.
    #>
    param(
        [Parameter(Mandatory = $true)]$Node,
        [string]$Path = '$'
    )
    $out = @()
    if ($null -eq $Node) { return $out }
    if ($Node -is [string]) {
        $out += [pscustomobject]@{ Path = $Path; Value = $Node }
        return $out
    }
    if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
        $i = 0
        foreach ($item in $Node) {
            $out += Get-StringLeaves -Node $item -Path ("{0}[{1}]" -f $Path, $i)
            $i++
        }
        return $out
    }
    if ($Node -is [psobject] -and $Node.PSObject.Properties.Count -gt 0) {
        foreach ($p in $Node.PSObject.Properties) {
            $out += Get-StringLeaves -Node $p.Value -Path ("{0}.{1}" -f $Path, $p.Name)
        }
    }
    return $out
}

function Find-SecretViolations {
    <#
    .SYNOPSIS  A10 secrets scan. Returns a list of violation strings (empty = clean).
    #>
    param([Parameter(Mandatory = $true)]$Data)
    $violations = @()
    foreach ($leaf in (Get-StringLeaves -Node $Data)) {
        foreach ($pat in $script:SecretPatterns) {
            if ($leaf.Value -like "*$pat*") {
                $violations += ("{0} : token-shaped string matched '{1}' -- secrets must come from env, never .forge/*.json (A10)" -f $leaf.Path, $pat)
                break
            }
        }
    }
    return $violations
}

function Find-PathJailViolations {
    <#
    .SYNOPSIS  A3 sweep. Path-jails every path-like string leaf against Base.
               Path-like = property name 'path', 'output_path', or ending '_path'.
    #>
    param(
        [Parameter(Mandatory = $true)]$Data,
        [Parameter(Mandatory = $true)][string]$Base
    )
    $violations = @()
    foreach ($leaf in (Get-StringLeaves -Node $Data)) {
        $leafName = ($leaf.Path -split '\.')[-1]
        $leafName = ($leafName -split '\[')[0]
        if ($leafName -eq 'path' -or $leafName -eq 'output_path' -or $leafName -like '*_path') {
            if (-not (Test-PathJail -Base $Base -Candidate $leaf.Value)) {
                $violations += ("{0} : path '{1}' escapes the .forge jail (A3)" -f $leaf.Path, $leaf.Value)
            }
        }
    }
    return $violations
}

function Test-JsonAgainstSchema {
    <#
    .SYNOPSIS  Hand-rolled JSON-Schema-subset validator (PS 5.1 has none native).
               Supports: type, required, properties, items, enum, const, minimum,
               minItems. Returns a list of error strings (empty = valid).
    #>
    param(
        [Parameter(Mandatory = $true)]$Data,
        [Parameter(Mandatory = $true)]$Schema,
        [string]$Path = '$'
    )
    $errs = @()
    $has = { param($o, $n) ($null -ne $o) -and ($o.PSObject.Properties.Name -contains $n) }

    # type
    if (& $has $Schema 'type') {
        $t = $Schema.type
        $ok = $true
        switch ($t) {
            'object'  { $ok = ($Data -is [psobject]) -and -not ($Data -is [array]) -and -not ($Data -is [string]) }
            'array'   { $ok = $Data -is [array] }
            'string'  { $ok = $Data -is [string] }
            'integer' { $ok = (($Data -is [int]) -or ($Data -is [long])) -and -not ($Data -is [bool]) }
            'number'  { $ok = ($Data -is [double]) -or ($Data -is [int]) -or ($Data -is [long]) }
            'boolean' { $ok = $Data -is [bool] }
            default   { $ok = $true }
        }
        if (-not $ok) { $errs += ("{0} : expected type '{1}'" -f $Path, $t) }
    }

    # const
    if (& $has $Schema 'const') {
        if ("$Data" -ne "$($Schema.const)") {
            $errs += ("{0} : expected const '{1}' but got '{2}'" -f $Path, $Schema.const, $Data)
        }
    }

    # enum
    if (& $has $Schema 'enum') {
        if ($Schema.enum -notcontains $Data) {
            $errs += ("{0} : value '{1}' not in enum [{2}]" -f $Path, $Data, ($Schema.enum -join ', '))
        }
    }

    # minimum
    if ((& $has $Schema 'minimum') -and ($Data -is [int] -or $Data -is [long] -or $Data -is [double])) {
        if ($Data -lt $Schema.minimum) {
            $errs += ("{0} : value {1} below minimum {2}" -f $Path, $Data, $Schema.minimum)
        }
    }

    # maximum (added 2026-06-05 for the ai-employee removed_ai_pct band gate)
    if ((& $has $Schema 'maximum') -and ($Data -is [int] -or $Data -is [long] -or $Data -is [double])) {
        if ($Data -gt $Schema.maximum) {
            $errs += ("{0} : value {1} above maximum {2}" -f $Path, $Data, $Schema.maximum)
        }
    }

    # object: required + properties recursion
    if (((& $has $Schema 'type') -and $Schema.type -eq 'object') -or (& $has $Schema 'properties')) {
        if ($Data -is [psobject] -and -not ($Data -is [array]) -and -not ($Data -is [string])) {
            if (& $has $Schema 'required') {
                foreach ($req in $Schema.required) {
                    if ($Data.PSObject.Properties.Name -notcontains $req) {
                        $errs += ("{0}.{1} : required field missing" -f $Path, $req)
                    }
                }
            }
            if (& $has $Schema 'properties') {
                foreach ($pn in $Schema.properties.PSObject.Properties.Name) {
                    if ($Data.PSObject.Properties.Name -contains $pn) {
                        $errs += Test-JsonAgainstSchema -Data $Data.$pn -Schema $Schema.properties.$pn -Path ("{0}.{1}" -f $Path, $pn)
                    }
                }
            }
        }
    }

    # array: minItems + items recursion
    if ((& $has $Schema 'type') -and $Schema.type -eq 'array' -and $Data -is [array]) {
        if (& $has $Schema 'minItems') {
            if ($Data.Count -lt $Schema.minItems) {
                $errs += ("{0} : array has {1} items, minItems {2}" -f $Path, $Data.Count, $Schema.minItems)
            }
        }
        if (& $has $Schema 'items') {
            for ($i = 0; $i -lt $Data.Count; $i++) {
                $errs += Test-JsonAgainstSchema -Data $Data[$i] -Schema $Schema.items -Path ("{0}[{1}]" -f $Path, $i)
            }
        }
    }

    return $errs
}

function Test-ConfigArtifact {
    <#
    .SYNOPSIS  Full A3+A4+A5+A10 gate for one parsed config object against its schema.
               Returns a list of error strings (empty = valid). Callers FAIL LOUD on any.
    .PARAMETER Data    Parsed config (from ConvertFrom-Json).
    .PARAMETER Schema  Parsed schema.
    .PARAMETER Base    Path-jail base (normally factory root / cwd).
    #>
    param(
        [Parameter(Mandatory = $true)]$Data,
        [Parameter(Mandatory = $true)]$Schema,
        [Parameter(Mandatory = $true)][string]$Base
    )
    $errs = @()
    $errs += Test-JsonAgainstSchema -Data $Data -Schema $Schema
    $errs += Find-PathJailViolations -Data $Data -Base $Base
    $errs += Find-SecretViolations -Data $Data
    return $errs
}

# ===================================================================
# Commit 2 -- resolver primitives (A1 code-not-LLM, A2 per-type merge)
# ===================================================================

# A2 centralized merge-rule table. ONE place; the resolver dispatches on it.
$script:MergeSemantics = @{
    'agent-config'  = 'deep-merge'      # customer fields override; unspecified inherit factory
    'routine'       = 'replace'         # customer routines wholesale replace factory
    'skill'         = 'boolean-replace' # customer enable/disable wins
    'rule-override' = 'enable-disable'  # enable/disable only; NEVER disable a required:true rule
    'model-router'  = 'merge-by-task'   # merge per task-category
    'workflow'      = 'replace'         # customer workflow wholesale replace
}

function Get-MergeSemantics {
    param([Parameter(Mandatory = $true)][string]$ArtifactType)
    if (-not $script:MergeSemantics.ContainsKey($ArtifactType)) {
        throw "RESOLVER ERROR: unknown artifact type '$ArtifactType'. Known: $($script:MergeSemantics.Keys -join ', ')"
    }
    return $script:MergeSemantics[$ArtifactType]
}

function Invoke-DeepMerge {
    <#
    .SYNOPSIS  Deep-merge $Override onto $Base. Object keys recurse; scalars + arrays
               are replaced by $Override when present. Unspecified keys inherit $Base.
               Returns a NEW ordered hashtable (never mutates inputs -- A2 "never mutate
               shared core").
    #>
    param($Base, $Override)
    $out = [ordered]@{}
    # Seed with base
    if ($null -ne $Base) {
        foreach ($p in $Base.PSObject.Properties) { $out[$p.Name] = $p.Value }
    }
    if ($null -eq $Override) { return $out }
    foreach ($p in $Override.PSObject.Properties) {
        $k = $p.Name
        $ov = $p.Value
        $bv = if ($out.Contains($k)) { $out[$k] } else { $null }
        $bothObjects = (
            $bv -is [psobject] -and -not ($bv -is [array]) -and -not ($bv -is [string]) -and
            $ov -is [psobject] -and -not ($ov -is [array]) -and -not ($ov -is [string])
        )
        if ($bothObjects) {
            $out[$k] = Invoke-DeepMerge -Base $bv -Override $ov
        } else {
            $out[$k] = $ov   # scalar or array -> override wins wholesale
        }
    }
    return $out
}

function Get-AgentFrontmatter {
    <#
    .SYNOPSIS  Extract the YAML frontmatter (first ---...--- block) of an agent .md as text.
    #>
    param([Parameter(Mandatory = $true)][string]$AgentMdPath)
    if (-not (Test-Path $AgentMdPath)) {
        throw "RESOLVER ERROR: agent file not found: $AgentMdPath"
    }
    $raw = [System.IO.File]::ReadAllText($AgentMdPath, (New-Object System.Text.UTF8Encoding $false))
    $m = [regex]::Match($raw, "^---\r?\n([\s\S]*?)\r?\n---", "Multiline")
    if (-not $m.Success) {
        throw "RESOLVER ERROR: no frontmatter found in $AgentMdPath"
    }
    return $m.Groups[1].Value
}

function Get-AgentFactoryDefault {
    <#
    .SYNOPSIS  Read an agent's factory-default config from its frontmatter `configurable:`
               block. The block uses YAML flow style (valid JSON) for the `defaults:` value
               so PS 5.1 can parse it deterministically (no YAML lib). FAILS LOUD (A4) if the
               block or its defaults are missing/unparseable.
    #>
    param([Parameter(Mandatory = $true)][string]$AgentMdPath)
    $fm = Get-AgentFrontmatter -AgentMdPath $AgentMdPath
    # Find the `defaults:` line inside the configurable block; value is flow-style JSON.
    $dm = [regex]::Match($fm, "(?m)^\s{2,}defaults:\s*(\{.*\})\s*$")
    if (-not $dm.Success) {
        throw "RESOLVER ERROR: no 'configurable.defaults' flow-style JSON found in $AgentMdPath frontmatter (A4)"
    }
    try {
        return $dm.Groups[1].Value | ConvertFrom-Json
    } catch {
        throw "RESOLVER ERROR: 'configurable.defaults' in $AgentMdPath is not valid JSON: $($_.Exception.Message) (A4)"
    }
}

function Get-TierAgents {
    <#
    .SYNOPSIS  A7 -- the agents a profile's tier entitles. Reads .forge/profile.json tier,
               then the matching preset's agents_enabled. Returns @() if no profile (open).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$FactoryRoot
    )
    $profilePath = Join-Path $ProjectRoot ".forge\profile.json"
    $tier = $null
    if (Test-Path $profilePath) {
        try { $tier = (Get-Content $profilePath -Raw | ConvertFrom-Json).profile } catch { $tier = $null }
    }
    if (-not $tier) {
        # No project profile -> fall back to factory default-profile tier.
        $dp = Join-Path $FactoryRoot ".forge\default-profile.json"
        if (Test-Path $dp) {
            try { $tier = (Get-Content $dp -Raw | ConvertFrom-Json).profile } catch { $tier = $null }
        }
    }
    if (-not $tier) { return $null }   # null = "no tier gate available" (open)
    $presetPath = Join-Path $FactoryRoot ".forge\profiles\$tier.json"
    if (-not (Test-Path $presetPath)) { return $null }
    $preset = Get-Content $presetPath -Raw | ConvertFrom-Json
    return ,@($preset.agents_enabled)
}
