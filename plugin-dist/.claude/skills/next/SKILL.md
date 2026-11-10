---
name: next
description: The owner's standing end-of-milestone question, answered from live evidence in one fixed shape -- queue state, exact commands and paste prompts per tool, decisions with options/norm/recommendation, evidence-backed gaps (features, trends, APIs, competitors), and tracker updates. Run after any merge, lane report, or approval; also when the owner asks "what's next" or "anything else" in any wording.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Bash(git *)
  - Bash(gh *)
  - Bash(node *)
  - WebSearch
  - WebFetch
arguments:
  - name: focus
    description: "Optional narrowing: 'merge' (only the queue and commands), 'decide' (only owner decisions), 'gaps' (only research/feature gaps), or a free-text area such as 'launch' or 'billing'. Default: all five sections."
    required: false
---

> **Needs Claude Code with the project folder open.** It reads the queue, trackers and git/GitHub state and writes prompt files. In chat, paste the contents of `chat-prompt.md` from this skill's folder instead and attach your current DIGEST or status file.

# /next -- what is next, answered without being asked

The owner types some version of this at every milestone: *"Is there anything useful, popular or trending I haven't planned (features, searches, analytics, APIs, third-party or competitor angles)? What is still in the queue, roadmap or tracker to build, fix, merge, commit or deploy? Let's work in parallel across Codex, Claude Code, Antigravity, Grok and ChatGPT, overnight if useful, with the right slash commands, modes and effort. Update every tracker and write the full prompts for the next sessions."* This skill is that question, made repeatable and evidence-bound.

## Rules

- **Evidence first.** Every status claim comes from `git`, `gh`, a file read, or a test run made in this session, tagged VERIFIED (with the command) or UNVERIFIED. A tracker row is a claim, not a fact.
- **No padding.** A "gap" is listed only with the evidence that makes it a gap: a user signal, a market or trend fact with a source, a competitor feature, an API capability the project could use, or a recurring failure in the repo's own history. If a section is genuinely empty, say so in one line.
- **Decisions come with options, the industry norm and a recommendation, plus a one-line approve-all.** Never hand the owner a bare question.
- **Prompts are paste-ready and self-contained:** tool, chat or worktree, branch, base, acceptance, tests, and the three-bullet report, with the VERIFIED/UNVERIFIED rule. Mark which can run in parallel.
- **Never merge, deploy, change settings or spend.** Recommend; the owner acts. The merge train and settings commands are printed for the owner to run.

## Steps

1. **Read the live state.** `STATE.json`, `DIGEST.md`, `PENDING_APPROVALS.md`, `DECISIONS.md` (DEFER/REJECT/REVISIT rows), `CURRENT_SPRINT.md`, the newest `docs/status/*.md` (stall census, inventories), open PRs (`gh pr list --state open --json number,title,mergeStateStatus,headRefOid`), their checks (`gh pr checks`), and unresolved review threads (GraphQL `reviewThreads(isResolved:false)`). Note `git rev-parse HEAD` and whether `VIBE_ROOT` points elsewhere.
2. **Section 1, queue state.** Table: merged since last run; open PRs with checks, behind/blocked reason, open threads; tasks by stage; dead letters (blocked > 3 days); expired leases.
3. **Section 2, run now.** The exact merge-train command for every PR that is green and clean; the exact paste section per tool (Codex chat title, new Claude Code session + worktree + branch, Grok, Antigravity, ChatGPT/Dot) with a parallel-safe flag; any `/ship`, `/loop`, `/goal` or scheduled-task command worth running overnight, with its stop condition. Write any prompt that does not yet exist into `docs/operations/PROMPTS-PARALLEL-<date>.md` and refresh the owner's desktop copy if one is named in DIGEST.
4. **Section 3, decisions.** Every owner action and every DECISION-class stalled item: options, norm, recommendation, approve-all line.
5. **Section 4, gaps** (the section that uses WebSearch and WebFetch: cite the URL or source for every market, trend, competitor or API claim, and mark anything you could not fetch UNVERIFIED). Compare the roadmap and queue against: the repo's own signal log and errors file (recurring pain), the latest insights or census, competitor and platform capabilities relevant to the project (name the source), analytics or trend data the project already collects or could, and APIs/MCP servers in the catalog the project is not using. Rank by expected effect on launch; cite evidence per row; tag UNVERIFIED where it is a hypothesis.
6. **Section 5, trackers.** Rewrite `DIGEST.md` in its fixed 8-line shape, update roadmap and sprint trackers, and list every file you wrote. For `STATE.json`: if the project has the `forge state` command, use it for every correction and never hand-edit the file; if the file says its writer is `manual-bootstrap` (the hand-written bootstrap used before `forge state` exists), change only the fields you verified, keep it valid JSON, and say so in the report; otherwise write the proposed corrections into your report and leave `STATE.json` untouched. Commit docs-only on the queue branch when one exists; never on master.
7. **Report** in the five sections, then the three bullets: changed / verified (commands and counts) / gaps.

With `focus`, run only the matching section(s) but still do step 1.
