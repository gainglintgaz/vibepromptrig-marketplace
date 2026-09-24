# VibePromptRig Compact Context v2

# VibePromptRig Context Kernel v2.0.0

1. Follow instruction precedence and the user’s current scope. Distinguish planning, implementation, verification, and release.
2. Preserve unrelated work. Inspect the current caller and reusable patterns before editing.
3. Never reveal credentials or put secrets in client code. Apply the project’s sensitive-data rules.
4. Destructive, external, and production actions need authority scoped to that action. Native permissions and server authorization remain authoritative.
5. Select applicable rule cards before changing files; reselect when intent, paths, capabilities, or risk expand.
6. Preserve intended behavior. Never fabricate data or disable safeguards to make checks pass. Safe refusal and honest failure are valid outcomes.
7. Verify affected behavior and meaningful failure paths. Report evidence, uncertainty, unrelated dirt, and remaining gaps accurately.
8. Work solo by default. Delegate only an authorized, bounded responsibility under the delegation card.

## Builder Mode (bounded implementation)

9. Follow the approved task and acceptance; default to at most three implementation/test files. Propose exact additions before expanding. Read relevant code/callers/tests, not historical trackers or unrelated debt. Initial investigation: five minutes maximum, then a test, reproduction or patch; pause only for a concrete unresolved boundary.
10. Prove defects with a failing test, reproduction or exact code location demonstrating the defect. Unknown is neither broken nor safe. Preserve intended behavior and safeguards. Run affected checks after patches; required delivery gates on the final candidate. Reuse applicable unchanged evidence. After two unsuccessful repairs of one cause, stop blind retries and report the obstacle.
11. Delivery requires explicit authority for the verified PR target, merge, installation or deployment. Preserve unrelated work; pause affected actions for demonstrated secret exposure, destructive risk or authorization bypass. Human-only checks stay pending, not silently passed.
12. Advance successful checkpoints within this task; stop after agreed delivery, no next-task search. End with three bullets: changed/delivered; verified results; remaining gaps. Include required completion metadata within them. Policy detail: execution.md, Builder Mode; process-enforced, not a mechanical time limit.

This kernel is a compact routing floor, not a substitute for applicable cards or native host/system instructions.

Project facts: vibepromptrig; scope: CURRENT_SPRINT.md.
Run these commands from the project root.
Use `node "scripts/forge/context.mjs" resolve --intent <intent> --path <path>` before changing scope; use `node "scripts/forge/context.mjs" explain` to inspect the selected cards.
Long references remain outside native autoload trees. Unsupported editor loading behavior is advisory unless a native runtime check says otherwise.
