#!/usr/bin/env pwsh
# install-discovery-precommit.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Installs the Discovery Protocol pre-commit hook (Interlock 1 per
# `docs/rules-reference/factory/discovery-protocol.md §7`) into a target git repo.
#
# Run from the target project root:
#   pwsh <factory-root>\scripts\install-discovery-precommit.ps1
#
# What it does:
#   1. Appends a discovery-check block to .git/hooks/pre-commit (creates
#      the file if missing, preserving any existing hook content)
#   2. The hook scans staged commits for new files in src/(pages|features)/
#      and blocks merge unless docs/discovery/<slug>.md exists OR commit
#      message carries [discovery-skipped] reason: <why>
#
# Idempotent — safe to re-run. Detects existing install via marker comment.

param(
    [string]$ProjectRoot = $(Get-Location).Path
)

$ErrorActionPreference = "Stop"

$hooksDir = Join-Path $ProjectRoot ".git\hooks"
$hookFile = Join-Path $hooksDir "pre-commit"
$marker = "# === DISCOVERY-PROTOCOL-INTERLOCK-1 ==="

if (-not (Test-Path $hooksDir)) {
    Write-Error "No .git/hooks directory at $hooksDir — is this a git repo?"
    exit 1
}

# Idempotency check
if (Test-Path $hookFile) {
    $existing = Get-Content $hookFile -Raw
    if ($existing -match [regex]::Escape($marker)) {
        Write-Host "[discovery] Pre-commit hook already installed at $hookFile"
        Write-Host "[discovery] Marker found. No changes. Re-run with -Force to overwrite."
        exit 0
    }
}

$hookBlock = @'

# === DISCOVERY-PROTOCOL-INTERLOCK-1 ===
# See: docs/rules-reference/factory/discovery-protocol.md §7 (VibePromptRig factory)
# Blocks commits adding new feature/page files without a matching
# Discovery Doc in docs/discovery/. Skip with [discovery-skipped]
# annotation in commit message for trivial / refactor / revert commits.

discovery_check() {
    local new_features
    new_features=$(git diff --cached --name-only --diff-filter=A 2>/dev/null | \
        grep -E "^src/(pages|features)/.*\.(tsx|ts)$" 2>/dev/null | \
        grep -v "__tests__" 2>/dev/null | \
        grep -v "\.test\." 2>/dev/null || true)

    if [ -z "$new_features" ]; then
        return 0
    fi

    local commit_msg
    commit_msg=$(cat .git/COMMIT_EDITMSG 2>/dev/null || git log -1 --format=%B 2>/dev/null || echo "")

    if echo "$commit_msg" | grep -qE "\[discovery-skipped\]"; then
        echo "[discovery] Commit annotated with [discovery-skipped] — bypass allowed"
        return 0
    fi

    local missing=""
    for f in $new_features; do
        # Strip prefix + extension, lowercase, hyphenate
        local slug
        slug=$(echo "$f" | sed -E 's|src/(pages\|features)/||; s|\.(tsx\|ts)$||; s|/|-|g' | tr "[:upper:]" "[:lower:]")
        if [ ! -d "docs/discovery" ] || ! ls docs/discovery/ 2>/dev/null | grep -qi "$slug"; then
            missing="$missing\n    $f"
        fi
    done

    if [ -n "$missing" ]; then
        echo ""
        echo "[discovery] BLOCKED — new feature files lack a Discovery Doc:"
        echo -e "$missing"
        echo ""
        echo "Per the VibePromptRig factory docs/rules-reference/factory/discovery-protocol.md — to proceed:"
        echo "  (a) Create docs/discovery/YYYY-MM-DD-<slug>.md from template"
        echo "      .claude/templates/DISCOVERY_DOC_TEMPLATE.md, fill out, get"
        echo "      founder sign-off via the keyword in §6 of the rule"
        echo "  (b) Annotate commit message with: [discovery-skipped] reason: <why>"
        echo "      (only for trivial / refactor / revert per §3)"
        echo ""
        return 1
    fi

    return 0
}

if ! discovery_check; then
    exit 1
fi
'@

# Build the new hook content
$newContent = ""
if (Test-Path $hookFile) {
    $existing = Get-Content $hookFile -Raw
    # Ensure shebang present
    if (-not ($existing -match "^#!")) {
        $newContent = "#!/usr/bin/env bash`n" + $existing
    } else {
        $newContent = $existing
    }
} else {
    $newContent = "#!/usr/bin/env bash`n"
}

$newContent = $newContent.TrimEnd() + "`n" + $hookBlock + "`n"

Set-Content -Path $hookFile -Value $newContent -NoNewline -Encoding utf8

# Make executable (best effort on Windows — works on Git Bash)
if ($IsLinux -or $IsMacOS) {
    chmod +x $hookFile 2>$null
}

Write-Host "[discovery] Installed Discovery Protocol pre-commit hook at $hookFile"
Write-Host "[discovery] Test with: touch src/features/test/Foo.tsx; git add -A; git commit -m 'test'"
Write-Host "[discovery] Should block until you delete the file OR add the docs/discovery/ spec OR annotate [discovery-skipped]"
