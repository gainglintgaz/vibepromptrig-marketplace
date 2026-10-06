# Thin launcher: pass the same --root, --dry-run and --apply arguments as the Node CLI.
& node (Join-Path $PSScriptRoot 'worktree-retire.mjs') @args
if ($null -eq $LASTEXITCODE) { exit 1 }
exit $LASTEXITCODE
