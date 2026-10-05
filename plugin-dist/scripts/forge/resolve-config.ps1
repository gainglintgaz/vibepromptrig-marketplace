<#
.SYNOPSIS
    resolve-config.ps1 -- the v5.0 override-layer config resolver. CODE, zero LLM tokens (A1).
.DESCRIPTION
    Single entry point. Resolves the EFFECTIVE config for one artifact by merging the
    customer's .forge/ override (FIRST) onto the factory default (SECOND), per the
    artifact-type merge semantics in config-lib.ps1 (A2). NEVER mutates shared core.

    v5.0 Sprint 1, Commit 2. Arch artifact 9d7294c.

    Assumptions honored:
      A1  resolver is deterministic PowerShell. Runs with NO API key. Zero tokens.
      A2  per-artifact-type merge (deep-merge | replace | boolean-replace | enable-disable
          | merge-by-task). Centralized table: Get-MergeSemantics.
      A3  customer paths jailed to ProjectRoot (Find-PathJailViolations).
      A4  malformed config -> throw naming file+field. NO silent fallback.
      A5  schema_version const skew -> throw with migration message.
      A7  tier entitlement: agent not in the profile-tier's allow-list -> reject.
      A10 token-shaped strings in .forge/*.json -> reject.

    For agent-config: factory default = the agent .md frontmatter `configurable.defaults`
    (flow-style JSON). Customer override = .forge/agent-configs/<name>.json `config`.
    Result = deep-merge(default, customer.config).

.PARAMETER ArtifactType
    agent-config | routine | skill | rule-override | model-router | workflow
.PARAMETER Name
    The artifact name (e.g., agent name 'synthesizer').
.PARAMETER ProjectRoot
    Customer factory clone root (holds .forge/). Defaults to cwd.
.PARAMETER FactoryRoot
    Shared core root. Defaults to env or the standard path.
.PARAMETER Json
    Emit the resolved config as JSON to stdout (default behavior).
.PARAMETER SkipTierCheck
    Internal/testing: skip A7 tier entitlement (used by golden capture).
.EXAMPLE
    .\scripts\forge\resolve-config.ps1 -ArtifactType agent-config -Name synthesizer -Json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('agent-config', 'routine', 'skill', 'rule-override', 'model-router', 'workflow')]
    [string]$ArtifactType,

    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string]$ProjectRoot = (Get-Location).Path,
    [string]$FactoryRoot = $env:VIBE_ROOT,
    [switch]$Json,
    [switch]$SkipTierCheck
)

$ErrorActionPreference = 'Stop'
if (-not $FactoryRoot) { $FactoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

. (Join-Path $PSScriptRoot 'config-lib.ps1')

$schemaDir = Join-Path $FactoryRoot 'agent-schemas'

function Read-JsonFileOrThrow {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path $Path)) { return $null }
    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw "RESOLVER ERROR: $Label at $Path is not valid JSON: $($_.Exception.Message) (A4)"
    }
}

function Assert-CustomerConfigValid {
    <#
    .SYNOPSIS  Validate a customer .forge config object against its schema + A3/A5/A10.
               Throws (A4 fail-loud) on any violation, naming file + field.
    #>
    param($Data, [string]$SchemaName, [string]$SourcePath)
    $schemaPath = Join-Path $schemaDir ("{0}.schema.json" -f $SchemaName)
    if (-not (Test-Path $schemaPath)) {
        throw "RESOLVER ERROR: schema '$SchemaName' not found at $schemaPath"
    }
    $schema = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json
    $errs = @(Test-ConfigArtifact -Data $Data -Schema $schema -Base $ProjectRoot)
    if ($errs.Count -gt 0) {
        throw ("RESOLVER ERROR: invalid config in {0}: {1}" -f $SourcePath, ($errs -join ' | '))
    }
}

# -------------------------------------------------------------------
# Dispatch per artifact type (A2)
# -------------------------------------------------------------------
$semantics = Get-MergeSemantics -ArtifactType $ArtifactType
$resolved = $null
$meta = [ordered]@{
    artifact_type = $ArtifactType
    name          = $Name
    merge         = $semantics
    project_root  = $ProjectRoot
    factory_root  = $FactoryRoot
    customer_layer_present = $false
}

switch ($ArtifactType) {

    'agent-config' {
        # A7 tier entitlement
        if (-not $SkipTierCheck) {
            $tierAgents = Get-TierAgents -ProjectRoot $ProjectRoot -FactoryRoot $FactoryRoot
            if ($null -ne $tierAgents -and ($tierAgents -notcontains $Name)) {
                $tierName = '(unknown)'
                $pp = Join-Path $ProjectRoot ".forge\profile.json"
                if (Test-Path $pp) { try { $tierName = (Get-Content $pp -Raw | ConvertFrom-Json).profile } catch {} }
                else {
                    $dp = Join-Path $FactoryRoot ".forge\default-profile.json"
                    if (Test-Path $dp) { try { $tierName = (Get-Content $dp -Raw | ConvertFrom-Json).profile } catch {} }
                }
                throw "RESOLVER ERROR: agent '$Name' is not included in your tier '$tierName'. Upgrade your tier or enable it in your profile's agents_enabled. (A7)"
            }
        }

        # Factory default = agent .md frontmatter configurable.defaults
        $agentMd = Join-Path $FactoryRoot ".claude\agents\$Name.md"
        $factoryDefault = Get-AgentFactoryDefault -AgentMdPath $agentMd

        # Customer override = .forge/agent-configs/<name>.json
        $custPath = Join-Path $ProjectRoot ".forge\agent-configs\$Name.json"
        $custConfig = $null
        if (Test-Path $custPath) {
            $custObj = Read-JsonFileOrThrow -Path $custPath -Label 'customer agent-config'
            Assert-CustomerConfigValid -Data $custObj -SchemaName 'customer-config' -SourcePath $custPath
            $custConfig = $custObj.config
            $meta.customer_layer_present = $true
        }

        $resolved = Invoke-DeepMerge -Base $factoryDefault -Override $custConfig
    }

    'model-router' {
        # Base = factory model-router.json task_categories; override merge-by-task
        $routerPath = Join-Path $FactoryRoot ".claude\model-router.json"
        $router = Read-JsonFileOrThrow -Path $routerPath -Label 'factory model-router'
        $base = $router.task_categories
        $prefsPath = Join-Path $ProjectRoot ".forge\provider-prefs.json"
        $merged = [ordered]@{}
        foreach ($p in $base.PSObject.Properties) { $merged[$p.Name] = $p.Value }
        if (Test-Path $prefsPath) {
            $prefs = Read-JsonFileOrThrow -Path $prefsPath -Label 'customer provider-prefs'
            Assert-CustomerConfigValid -Data $prefs -SchemaName 'provider-prefs' -SourcePath $prefsPath
            foreach ($p in $prefs.task_categories.PSObject.Properties) {
                $merged[$p.Name] = $p.Value   # merge-by-task: per-category replace
            }
            $meta.customer_layer_present = $true
        }
        $resolved = $merged
    }

    default {
        # routine | skill | rule-override | workflow -> replace / boolean-replace / enable-disable.
        # Sprint 1 builds schema + resolver dispatch; behavioral proof is synthesizer-first (N6).
        $fileMap = @{
            'routine'       = '.forge\routines.json'
            'skill'         = '.forge\active-skills.json'
            'rule-override' = '.forge\rule-overrides.json'
            'workflow'      = ".forge\workflows\$Name.json"
        }
        $schemaMap = @{
            'routine'       = 'routines'
            'skill'         = 'active-skills'
            'rule-override' = 'rule-overrides'
            'workflow'      = $null
        }
        $custPath = Join-Path $ProjectRoot $fileMap[$ArtifactType]
        if (Test-Path $custPath) {
            $custObj = Read-JsonFileOrThrow -Path $custPath -Label "customer $ArtifactType"
            if ($schemaMap[$ArtifactType]) {
                Assert-CustomerConfigValid -Data $custObj -SchemaName $schemaMap[$ArtifactType] -SourcePath $custPath
            }
            $meta.customer_layer_present = $true
            $resolved = $custObj
        } else {
            $resolved = $null   # no customer layer -> factory behaves as default (valid, not error)
        }
    }
}

# -------------------------------------------------------------------
# Output
# -------------------------------------------------------------------
$out = [ordered]@{
    resolved = $resolved
    _meta    = $meta
}
$out | ConvertTo-Json -Depth 12
exit 0
