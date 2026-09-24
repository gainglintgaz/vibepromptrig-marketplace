# VibePromptRig installation

VibePromptRig's Claude Code plugin is named `vibepromptrig`. Its marketplace is also named `vibepromptrig`, so the install identifier is `vibepromptrig@vibepromptrig`. Release 5.1.4 contains 14 agents, 9 skills, 3 commands, 4 workflows, compact Context V2 cards, and 5 selected reference rules. It does not install the former full `.claude/rules/` tree or generated editor mirrors.

## Requirements

- Claude Code CLI with plugin marketplace support, installed and authenticated. Check with `claude --version`.
- Git for a GitHub marketplace. Node.js 18 or newer for the shipped `forge` commands and hooks.
- Windows, macOS, or Ubuntu for the Claude Code plugin and Node-based gates. The optional source-checkout bootstrap script is Windows PowerShell only. `/vibepromptrig:setup` can inspect and propose on all three; its automated equip write step currently runs only on Windows. On macOS and Ubuntu it gives a manual checklist.
- On Windows, keep the Claude configuration path reasonably short. Git may reject very deep marketplace checkouts with `Filename too long`; retry from a shorter `CLAUDE_CONFIG_DIR` or enable Git long-path support. For private branch refs where GitHub shorthand chooses unavailable SSH, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` for that command.

## Marketplace installation

The public customer destination is [gainglintgaz/vibepromptrig-marketplace](https://github.com/gainglintgaz/vibepromptrig-marketplace). It contains the sanitized package, with its own release history. After a release is published there, install it with:

```bash
claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace
claude plugin install vibepromptrig@vibepromptrig
claude plugin marketplace list
claude plugin list
```

Start Claude Code in your own project and run `/vibepromptrig:setup`. Review its proposed tooling and approve individual writes. On macOS and Ubuntu, follow the manual checklist it prints. Setup stores its project state in the project's `.claude/`; installing or updating the plugin does not require replacing your Claude Code user settings or project files.

## Local marketplace from a checkout

For a local trial, clone the public distribution repository or obtain an authorized source checkout containing both `.claude-plugin/marketplace.json` and `plugin-dist/`. From a **different project directory**:

```bash
claude plugin marketplace add /absolute/path/to/checkout
claude plugin install vibepromptrig@vibepromptrig
claude plugin list
```

Replace the path with the actual checkout path (quote it if it contains spaces). Keep the checkout available as the marketplace source. Claude Code may cache an installed copy; rebuild `plugin-dist/`, then run `claude plugin update vibepromptrig@vibepromptrig` to test a newer local package. This path is for local evaluation. The published GitHub marketplace provides the normal update path.

## Update and removal

For a published GitHub marketplace:

```bash
claude plugin marketplace update vibepromptrig
claude plugin update vibepromptrig@vibepromptrig
claude plugin list
```

The publisher must bump `.claude-plugin/plugin.json` for each release. To remove the plugin:

```bash
claude plugin uninstall vibepromptrig@vibepromptrig
claude plugin list
```

These commands affect the plugin installation. Review any project files created by `/vibepromptrig:setup` separately; uninstall does not reverse approved project changes. Keep your own Claude Code settings and credentials in your normal user profile. The plugin does not need provider API keys for a standard authenticated Claude Code session.

## Contents and license

The installable boundary is `plugin-dist/`, built by `scripts/build-plugin-dist.ps1` from the private source checkout. It includes the MIT `LICENSE`, compact context assets, skills, commands, agents, hooks, and the `forge` tools. The private source repository is not a public distribution. See [README.md](README.md) for the package inventory and third-party attribution, and [LICENSE](LICENSE) for the VibePromptRig copyright notice.
