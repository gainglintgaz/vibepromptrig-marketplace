# Live state takes precedence; fallback never hides an invalid live file.
function Get-StateConfigPath {
    param([string]$Root, [string]$Name, [string]$ProjectRoot = $Root)
    if ($Name -notin @('routines', 'active-skills', 'cockpit', 'default-profile', 'rule-overrides', 'plan-translations')) { throw 'Unknown state config name' }
    $projectLive = Join-Path $ProjectRoot ('.forge\' + $Name + '.json')
    if (Test-Path -LiteralPath $projectLive) { return $projectLive }
    $live = Join-Path $Root ('.forge\' + $Name + '.json')
    if (Test-Path -LiteralPath $live) { return $live }
    foreach ($relative in @(('.forge\' + $Name + '.template.json'), ('scripts\templates\forge\' + $Name + '.template.json'))) {
        $template = Join-Path $Root $relative
        if (Test-Path -LiteralPath $template) { return $template }
    }
    return $live
}
