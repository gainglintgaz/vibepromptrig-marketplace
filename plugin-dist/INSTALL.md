# VibePromptRig installation

VibePromptRig's Claude Code plugin is named `vibepromptrig`. Its marketplace is also named `vibepromptrig`, so the install identifier is `vibepromptrig@vibepromptrig`. This guide describes source version 5.2.0 (`.claude-plugin/plugin.json`), which contains 15 agents, 19 skills, 3 commands, 4 workflows, compact Context V2 cards, and 5 selected reference rules. It does not install the former full `.claude/rules/` tree or generated editor mirrors.

**Which version this describes.** This guide describes VibePromptRig 5.2.0. Check the version you have with `claude plugin list`. To upgrade from an earlier version, run `claude plugin marketplace update vibepromptrig`, then `claude plugin update vibepromptrig@vibepromptrig`. 5.2.0 has not been submitted to Anthropic's plugin directory. When you test a specific build, record that version and, for a local marketplace, the checkout's commit (`git rev-parse HEAD`); the plugin name alone does not identify the artifact.

## Requirements

- Claude Code CLI with plugin marketplace support, installed and authenticated. Check with `claude --version`.
- Git for a GitHub marketplace. Node.js for the standard `forge` commands, the setup helpers and the hooks: Node.js 24 LTS is recommended, and Node.js 18 is the oldest version they support. Node.js 18 is past its upstream end of life, and the package's automated checks run on Node.js 20 and 24.
- The optional workforce coordination route needs Windows and Node.js 24 or newer (including `node:sqlite`). It refuses older Node.js versions before opening a loop; Node.js 18 does not cover it. It also requires a signed-in Codex CLI, an existing Claude cloud session, Git for Windows and the .NET Framework `csc` compiler; see the [quickstart prerequisites](docs/tutorials/workforce-quickstart.md#1-check-the-host). Run `scripts/forge/workforce-entry.mjs` by following the [workforce quickstart](docs/tutorials/workforce-quickstart.md); the [workforce guide](docs/tutorials/workforce.md) covers result states, recovery and provider boundaries.
- Windows, macOS, or Ubuntu for the Claude Code plugin and Node-based gates. The optional source-checkout bootstrap script is Windows PowerShell only. `/vibepromptrig:setup` can inspect and propose on all three; its automated equip write step currently runs only on Windows. On macOS and Ubuntu it gives a manual checklist.
- Shell: on Windows, use Windows PowerShell 5.1 (`powershell`) or PowerShell 7 (`pwsh`); the PowerShell blocks below work in both. `/vibepromptrig:mode` itself runs `powershell`. On macOS and Linux, use bash or zsh. Bash syntax such as `${NAME}` or `unset` does not work in PowerShell.
- On Windows, keep the Claude configuration path reasonably short. Git may reject very deep marketplace checkouts with `Filename too long`; retry from a shorter `CLAUDE_CONFIG_DIR` or enable Git long-path support. For private branch refs where GitHub shorthand chooses unavailable SSH, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` for that command.

## Settings you may inherit

`VIBE_ROOT` is a contributor setting for working on a VibePromptRig source checkout. If it is set, the `forge` initializer and profile tools read presets and rule cards from that folder instead of the installed plugin, and if it names a VibePromptRig source checkout, the capture hooks write an operator ledger there. Customers should leave it unset. Check your user and machine settings in PowerShell (on macOS and Linux, `printenv VIBE_ROOT` shows what your shell inherited):

```powershell
[Environment]::GetEnvironmentVariable('VIBE_ROOT', 'User')
[Environment]::GetEnvironmentVariable('VIBE_ROOT', 'Machine')
```

The initialization commands below clear it for their own shell session only; they do not change your saved settings.

A fresh Windows user account removes your per-user settings and sign-ins. It does not remove machine-wide configuration, policies, services, scheduled tasks, machine-level managed settings or machine-wide environment variables, and it is not a security sandbox. If you use one for a first-use trial, inspect and record those inherited controls before you start.

## Marketplace installation

The public customer destination is [gainglintgaz/vibepromptrig-marketplace](https://github.com/gainglintgaz/vibepromptrig-marketplace). It contains the sanitized package, with its own release history. Install the published release with these lines, which are the same in PowerShell and bash:

```text
claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace
claude plugin install vibepromptrig@vibepromptrig
claude plugin marketplace list
claude plugin list
```

With the default user scope, installing writes only inside your Claude configuration folder (the marketplace copy, the plugin cache and Claude Code's plugin settings), not in your project. Then, in this order:

1. Restart Claude Code and open your own project folder.
2. Run `/vibepromptrig:setup`. Its questions and suggestions write nothing. Review its proposed tooling and approve individual writes; it writes an undo record (`.claude/setup-rollback-<run-id>.md`) before the first change, and its `.claude/setup-manifest.json` and `.claude/setup-audit.jsonl` records need an approved save. On macOS and Ubuntu, follow the manual checklist it prints.
3. Optionally, initialize `forge` project state (next section).

Installing or updating the plugin does not require replacing your Claude Code user settings or project files.

## Initialize forge project state (optional)

Setup does not need this step, and it does not need setup. The hooks, goal, checkup and handoff flows work without it. Run it when you want a per-project `forge` profile, editable routine, cockpit and budget settings, or the compact instruction entry files that other AI tools read. Run it yourself, from your project folder.

`${CLAUDE_PLUGIN_ROOT}` is substituted only inside the plugin's own skills, commands and hooks. It is not set in your terminal or in ordinary commands Claude Code runs for you, so look up the installed root first: `claude plugin list --json` reports it as `installPath`.

Windows PowerShell 5.1 or PowerShell 7:

```powershell
Remove-Item Env:VIBE_ROOT -ErrorAction SilentlyContinue
$vpr = (claude plugin list --json | ConvertFrom-Json) | Where-Object { $_.id -eq 'vibepromptrig@vibepromptrig' } | Select-Object -First 1 -ExpandProperty installPath
$vpr
if (-not $vpr -or -not (Test-Path -LiteralPath "$vpr\scripts\forge\init.mjs")) {
  Write-Host "STOP: init was not run. The VibePromptRig path is empty or has no scripts\forge\init.mjs."
} else {
  node "$vpr\scripts\forge\init.mjs" --profile solo-pro --no-prompt
}
```

macOS or Linux (bash or zsh):

```bash
unset VIBE_ROOT
vpr=$(claude plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.id==="vibepromptrig@vibepromptrig");if(!p)process.exit(1);console.log(p.installPath)})')
echo "$vpr"
if [ -z "$vpr" ] || [ ! -f "$vpr/scripts/forge/init.mjs" ]; then
  echo "STOP: init was not run. The VibePromptRig path is empty or has no scripts/forge/init.mjs." >&2
else
  node "$vpr/scripts/forge/init.mjs" --profile solo-pro --no-prompt
fi
```

Both blocks check the path before they run init. If one prints `STOP: init was not run`, nothing was written. An empty path means the plugin is not installed for this account; a path without `scripts/forge/init.mjs` is an incomplete or removed plugin copy. Install or update the plugin (see Marketplace installation above), then run the block again. If you have more than one version installed, check that the path ends in the version you mean to use.

**Choosing a profile and plan.** `--profile` must be one of the five presets shipped in the plugin: `indie-free`, `solo-pro`, `senior-dev`, `agency` or `enterprise`. `node "$vpr/scripts/forge/profile.mjs" list` prints their budgets and sizes. `--plan` is optional. It is stored only as a label (`ai_plan`) in your profile; the shipped plan catalog is empty, so the value is not checked against any subscription. Without `--no-prompt`, the initializer asks about your AI plan and project and recommends a preset, but only in an interactive terminal. Where it cannot ask (for example inside Claude Code's command runner) it writes nothing and tells you to use `--no-prompt`.

**What it writes.** In a new folder, one run writes:

- `.forge/profile.json`, and if they are absent, neutral `.forge/routines.json`, `active-skills.json`, `cockpit.json`, `default-profile.json`, `rule-overrides.json` and `plan-translations.json`. Existing state files are kept.
- Compact instruction entry files: `AGENTS.md`, `GEMINI.md`, `.windsurfrules`, `.claude/CLAUDE.md`, `.cursor/rules/vf-context-core.mdc` and `.agents/rules/vf-context-core.md`.
- Supporting context files: `.forge/context/` (kernel and rule cards), `.forge/factory-manifest.json`, `.claude/rules-manifest.json`, `docs/rules-reference/context-v2-safeguards.md`, and six helper scripts under `scripts/forge/` (`context.mjs`, `context.ps1`, `context-contract.mjs`, `context-install.mjs`, `project-json.mjs`, `safe-write.mjs`).
- An undo record in `.forge/backups/<id>/`.

If any of those instruction or context files already exists with different content, that whole part is refused and none of it is written; the `.forge/` state is still written and the command prints `Advisory: compact entrypoint needs review` (see below). Running it again with `--no-prompt` stops with `Profile already exists`. Add `--force` only to replace `.forge/profile.json`; the other state files are kept. Review and enable routines in `.forge/routines.json` before running the scheduler; the package continues to supply their executable runners.

**`Advisory: compact entrypoint needs review` means a partial setup.** The `.forge/` profile and state files were written, but none of the instruction or context files were, and no undo record was made for them. Init still exits successfully. The text in brackets after the advisory names the first file that blocked the install, usually one of your own files such as `AGENTS.md` or `.claude/CLAUDE.md`. `--force` is not the fix: it only rewrites `.forge/profile.json` and tries the same install again, which is refused for the same files.

To finish the setup, in the same terminal as the init block (these commands use `$vpr`), list the blocking files (this writes nothing), move each one aside, then install the instruction and context files. PowerShell:

```powershell
((node "$vpr\scripts\forge\context.mjs" install-plan --project-root .) | ConvertFrom-Json).inventory | Where-Object { $_.action -eq 'diverged' } | ForEach-Object { $_.path }
Move-Item AGENTS.md AGENTS.md.mine
node "$vpr\scripts\forge\context.mjs" install --project-root .
```

bash or zsh:

```bash
node "$vpr/scripts/forge/context.mjs" install-plan --project-root . | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s).inventory)if(f.action==="diverged")console.log(f.path)})'
mv AGENTS.md AGENTS.md.mine
node "$vpr/scripts/forge/context.mjs" install --project-root .
```

`AGENTS.md` is only an example: move every path the first command lists. If it lists nothing, the text in brackets after the advisory is the start of the error the install reported. A successful install prints `"applied": true` and a `"backup"` id, which is its undo record. Your moved files are not merged into the new compact files, so AI tools no longer read your own instructions from those paths. To go back, use the Undo steps below, then move your files back. If you would rather keep your own files in place, you can leave the setup partial: the profile and state files are written and only the instruction and context files are missing.

To remove a partial setup instead, delete `.forge/profile.json` and the `.forge/` state files that run added. If the project had no `.forge` folder before, delete the whole `.forge` folder.

**Undo.** List the undo records, then roll back the instruction and context files that run changed. Replace `<id>` with the folder name you want to undo. PowerShell:

```powershell
Get-ChildItem .forge\backups
node "$vpr\scripts\forge\context.mjs" rollback --project-root . --backup <id>
```

bash or zsh:

```bash
ls .forge/backups
node "$vpr/scripts/forge/context.mjs" rollback --project-root . --backup <id>
```

Rollback removes the files that run added and restores any it updated. It does not delete the `.forge/` state or the undo record; remove those yourself if you no longer want them. Uninstalling the plugin does not undo initialization.

## Local marketplace from a checkout

For a local trial, clone the public distribution repository or obtain an authorized source checkout containing both `.claude-plugin/marketplace.json` and `plugin-dist/`. This is also how to try an unpublished version. From a **different project directory**:

```text
claude plugin marketplace add /absolute/path/to/checkout
claude plugin install vibepromptrig@vibepromptrig
claude plugin list
```

Replace the path with the actual checkout path (quote it if it contains spaces). Keep the checkout available as the marketplace source. Claude Code may cache an installed copy; rebuild `plugin-dist/`, then run `claude plugin update vibepromptrig@vibepromptrig` to test a newer local package. This path is for local evaluation. The published GitHub marketplace provides the normal update path.

## Update, disable and removal

For a published GitHub marketplace:

```text
claude plugin marketplace update vibepromptrig
claude plugin update vibepromptrig@vibepromptrig
claude plugin list
```

The publisher must bump `.claude-plugin/plugin.json` for each release. To turn the plugin off without removing it, run `claude plugin disable vibepromptrig@vibepromptrig` (and `claude plugin enable vibepromptrig@vibepromptrig` to turn it back on). To remove the plugin:

```text
claude plugin uninstall vibepromptrig@vibepromptrig
claude plugin list
```

These commands affect the plugin installation. Review any project files created by `/vibepromptrig:setup` or by initialization separately; uninstall does not reverse approved project changes. Use setup's undo record and the initialization rollback above. Keep your own Claude Code settings and credentials in your normal user profile. The plugin does not need provider API keys for a standard authenticated Claude Code session.

To stop the blocking guards and the session lock for one session, start Claude Code from a shell where `VIBE_HOOKS_DISABLE=1` is set (PowerShell: `$env:VIBE_HOOKS_DISABLE = '1'`; bash: `VIBE_HOOKS_DISABLE=1 claude`). For stopping workforce runs, provider sessions and billing, see "Stop, undo and recovery" in [README.md](README.md#stop-undo-and-recovery): ending a local process is not remote termination or settled billing.

## Contents and license

The installable boundary is `plugin-dist/`, built by `scripts/build-plugin-dist.ps1` from the private source checkout. It includes the MIT `LICENSE`, compact context assets, skills, commands, agents, hooks, and the `forge` tools. The private source repository is not a public distribution. See [README.md](README.md) for the package inventory and third-party attribution, and [LICENSE](LICENSE) for the VibePromptRig copyright notice.
