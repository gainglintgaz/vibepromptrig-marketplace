# VibePromptRig — workflows for AI-assisted development

An open-source toolkit that gives AI coding assistants reusable workflows for planning, project setup, implementation, review, and verification.

VibePromptRig ships as the `vibepromptrig` Claude Code plugin. The 5.1.6 package has 14 agents, 9 skills, 3 commands, 4 workflows, the `forge` tools, and a compact Context V2 rule resolver. The installable boundary is the generated `plugin-dist/` directory.

**The source repository is private.** Customer releases are distributed through the separate sanitized marketplace at [gainglintgaz/vibepromptrig-marketplace](https://github.com/gainglintgaz/vibepromptrig-marketplace). Publication is a separate release step; see that repository for the currently available release. See [INSTALL.md](INSTALL.md) for marketplace and local-checkout commands, first use, update, and uninstall.

## What ships

| Path in `plugin-dist/` | Purpose |
| --- | --- |
| `agents/`, `skills/`, `commands/`, `workflows/` | Claude Code plugin entry points. |
| `hooks/hooks.json`, `scripts/` | Portable Node hooks, the `forge` CLI, and supporting tools. |
| `.forge/context/`, `.claude/rules-manifest.json` | Compact Context V2 kernel, cards, and rule manifest. |
| `docs/rules-reference/` | Context V2 safeguards and exactly five selected legacy references used by packaged tools. |
| `catalog.json`, `.claude-plugin/` | Setup catalog and plugin metadata. |
| `INSTALL.md`, `README.md`, `LICENSE` | Customer instructions and license notice. |

Portfolio examples in the shipped rules and templates use anonymized project labels. They are teaching examples, not public customer case studies.

The old full `.claude/rules/` autoload tree and generated Cursor rule mirrors are absent from the package after Delivery 3b. Other editors are outside this distribution milestone.

## Use and maintenance

Install through a Claude Code marketplace, then run `/vibepromptrig:setup` inside your project. It scans the local stack and proposes relevant tooling and rule packs for your approval. Automated equip writes are currently Windows-only; macOS and Ubuntu receive a manual checklist. The plugin may run Claude Code hooks in your project, so review the package before installing it.

The publisher rebuilds `plugin-dist/`, runs its no-ship and regression checks, bumps the plugin release version, and publishes only the sanitized package to the public marketplace after approval. Customer project settings are outside the package and should be preserved through updates and uninstall. The factory's `VERSION.md` is an independent internal version counter, not the plugin release version.

## License

VibePromptRig's original code and documentation are MIT licensed. Copyright (c) 2026 gainglintgaz. See [LICENSE](LICENSE).

The [code-of-conduct template](scripts/templates/public/CODE_OF_CONDUCT.md) includes an adaptation of Contributor Covenant 2.1 by Coraline Ada Ehmke under CC BY 4.0; its attribution and license link are retained in that file. This material keeps its separate terms. Dependency manifests identify external packages; their implementations are not bundled, and separately installed dependencies retain their own licenses.
