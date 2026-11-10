# Proven prompt: "what is next" (shipped inside the /next skill folder; paste it into Codex, Grok, ChatGPT or any chat)

Use `/next` in Claude Code. In any other tool, paste the block below and attach the project's current DIGEST.md, STATE.json (or sprint file) and the list of open PRs. Replace `<project>`.

```text
You are answering my standing end-of-milestone question for <project>, from evidence only. Tag every status claim VERIFIED (with the command or file you read) or UNVERIFIED; a tracker row is a claim, not a fact. Do not merge, deploy, change settings or spend; recommend, and print the exact commands for me to run.

Answer in exactly these five sections:
1. Queue state: what merged since the last report; every open PR with its checks, whether it is behind or blocked and why, and unresolved review threads; tasks by stage; anything blocked more than 3 days; expired leases or claims.
2. Run now: the exact merge command list for PRs that are green and clean; the exact prompt to paste per tool (Codex chat title, new Claude Code session with worktree and branch, Grok, Antigravity, ChatGPT), marked parallel-safe or not; any overnight loop, ship or scheduled run worth starting, each with a stop condition. Write any prompt that does not exist yet, self-contained: tool, worktree, branch, base, acceptance, tests, three-bullet report rule.
3. Decisions waiting on me: for each, the options, the industry norm with a named reference, your recommendation, and one approve-all line at the end.
4. Gaps I have not planned: features, searches, analytics, trends, APIs, third-party or MCP capabilities, competitor moves, risks. Only rows with evidence (a source, a user signal, a repo failure pattern); rank by effect on launch; say "none with evidence" if that is true.
5. Tracker updates: which files you updated (queue, digest, roadmap, sprint, approvals) and which prompts you wrote for the next sessions.
End with three bullets: changed / verified (commands and counts) / gaps.
```

Origin: the owner's recurring end-of-milestone request, recorded 2026-10-02; the Claude Code version is `SKILL.md` in this folder.
