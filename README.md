# VibePromptRig marketplace

Reusable project setup, planning, review, and verification workflows for AI-assisted development. This is a Claude Code plugin distribution preview, version 5.1.6.

The package contains 14 agents, 9 skills, 3 commands, 4 workflows, compact rule cards, hooks, and forge tools. Project labels in examples are anonymized teaching placeholders. Native support in other AI products has not been verified.

## Install

Requires an authenticated Claude Code CLI with marketplace support, Git, and Node.js 18 or newer.

```sh
claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace
claude plugin install vibepromptrig@vibepromptrig
claude plugin marketplace list
claude plugin list
```

Restart Claude Code in your project and run `/vibepromptrig:setup`. Review each proposed project change. Setup can apply approved writes on Windows. On macOS and Ubuntu it proposes a manual checklist; an authenticated first-use run remains pending. See the [full installation guide](plugin-dist/INSTALL.md).

## Update

```sh
claude plugin marketplace update vibepromptrig
claude plugin update vibepromptrig@vibepromptrig
```

Restart Claude Code after updating.

## Uninstall

```sh
claude plugin uninstall vibepromptrig@vibepromptrig
```

Uninstall removes the plugin. It does not undo project changes that you previously approved through setup, and it should not replace unrelated customer settings.

## Status

The curated package and lifecycle checks passed on the source revision used to build this repository. Live authenticated first use of `/vibepromptrig:setup` remains pending. This repository is a direct GitHub marketplace source, not a listing or endorsement in another platform's catalog. See [platform status](PLATFORMS.md).

## License and maintenance

The VibePromptRig package is [MIT licensed](LICENSE), copyright (c) 2026 gainglintgaz. The packaged [Contributor Covenant adaptation](plugin-dist/scripts/templates/public/CODE_OF_CONDUCT.md) retains its separate CC BY 4.0 notice. Each update should rebuild the curated package, pass the package and release checks, and verify installation from a disposable customer profile.
