<#
.SYNOPSIS
    One-shot script to add tier: frontmatter to all factory rule files (v4.4 Day 1).
.DESCRIPTION
    Idempotent. Skips files that already have frontmatter.
#>
param(
    [string]$FactoryRoot = $(if ($env:VIBE_ROOT) { $env:VIBE_ROOT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent })
)
$ErrorActionPreference = "Stop"

$essential = @("vibe-standard", "privacy", "secrets-handling", "data-protection", "execution")
$standard  = @("hostile-architect", "data-integrity", "lessons", "compliance")
$full      = @("mcp-servers", "tech-defaults", "stack-optimizer", "consulting", "self-reflection", "aggregate-design", "ai-first-principles", "data-flywheel")

$tiers = @{}
foreach ($n in $essential) { $tiers[$n] = "essential" }
foreach ($n in $standard)  { $tiers[$n] = "standard" }
foreach ($n in $full)      { $tiers[$n] = "full" }

$rulesDir = Join-Path $FactoryRoot "docs\rules-reference\factory"   # relocated corpus (Context V2 Delivery 3b)
$rules = Get-ChildItem -Path $rulesDir -Filter "*.md"

foreach ($r in $rules) {
    $name = $r.BaseName
    $tier = $tiers[$name]
    if (-not $tier) {
        Write-Host "  SKIP $name (no tier mapping)" -ForegroundColor Yellow
        continue
    }

    $content = Get-Content $r.FullName -Raw
    if ($content.StartsWith("---")) {
        Write-Host "  HAS-FRONTMATTER $name (skip)" -ForegroundColor DarkGray
        continue
    }

    $required = if ($tier -eq "essential") { "true" } else { "false" }
    $profiles = switch ($tier) {
        "essential" { "[indie-free, solo-pro, senior-dev, agency, enterprise]" }
        "standard"  { "[solo-pro, senior-dev, agency, enterprise]" }
        "full"      { "[senior-dev, agency, enterprise]" }
    }

    $frontmatter = "---`ntier: $tier`nrequired: $required`nprofiles: $profiles`n---`n`n"
    $new = $frontmatter + $content
    Set-Content -Path $r.FullName -Value $new -Encoding UTF8 -NoNewline
    Write-Host "  $name : $tier" -ForegroundColor Green
}

Write-Host ""
Write-Host "Verification: count by tier..." -ForegroundColor Cyan
$counts = @{ essential = 0; standard = 0; full = 0 }
foreach ($r in Get-ChildItem $rulesDir -Filter "*.md") {
    $first5 = (Get-Content $r.FullName -TotalCount 5) -join "`n"
    if ($first5 -match "tier:\s*(\w+)") { $counts[$matches[1]]++ }
}
foreach ($k in @("essential", "standard", "full")) {
    Write-Host ("  {0,-12} {1}" -f $k, $counts[$k])
}
