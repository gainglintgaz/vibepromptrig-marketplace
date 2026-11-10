---
name: second-look
description: After a review FAIL/HOLD, or after one repair of the same cause already failed, writes read-only outside-diagnosis prompts for 2+ different tools (grok, antigravity, claude, codex) plus a COMPARE.md to reconcile their answers. Rotates tools so one model's blind spot is not repeated. Writes prompts only; dispatches nothing.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Bash(git rev-parse *)
  - Bash(git log *)
  - Bash(git show *)
  - Bash(git ls-tree *)
  - Bash(git grep *)
arguments:
  - name: review_path
    description: "Repo-relative path to the review artifact that FAILed/HOLDed: a REVIEW.md, a ROOT-CAUSE.md, a PR review comment saved to a file, or the /ship blocked result saved as docs/diagnosis/<head12>/REVIEW.json (its reviewArtifactPath)."
    required: true
  - name: tools
    description: "Comma-separated outside tools to write prompts for. Default: grok,claude. Use at least two different vendors."
    required: false
---

> **Needs Claude Code.** It reads the review file and git history from your project folder and writes prompt files into it. In chat, paste the review text and ask Claude for an outside-diagnosis prompt in the shape below instead.

# /second-look -- outside root-cause diagnosis, rotated across tools

Use it when the in-pipeline `diagnostician` was refused or its repair still HOLDed, when two repairs
of the same cause failed, or when a stalled item is classified DEFECT by a stall census. Evidence
(owner record, 2026-10-02): two defects that survived two owner repairs each were solved first-pass by
read-only outside diagnosis that asked "trace the path and explain why the tests passed".

## Steps

1. **Freeze the reviewed head.** Read `review_path` first. Extract its recorded `head_sha`:
   use `review.head_sha` for a /ship blocked-result JSON, or the artifact's own `head_sha` for
   a standalone review (including an explicitly recorded `head_sha` field in Markdown).
   If the artifact has no recorded `head_sha`, refuse without writing prompts; ask for a review
   artifact that records the reviewed revision. Never substitute the current HEAD. Refuse
   conflicting recorded review SHAs, malformed SHAs (require a full 40-character hexadecimal
   commit SHA), or a SHA that `git rev-parse <review sha>^{commit}` cannot resolve locally.
   Run `git rev-parse HEAD` only to compare: when it differs, print both SHAs, labelled
   `review head_sha` and `current HEAD`, and keep the review SHA as the frozen head.
   Every historical read, including preparation and reconciliation, must use the review SHA:
   `git show <review sha>:<path>`, `git ls-tree -r <review sha>`,
   `git grep <pattern> <review sha>`, and `git log <review sha>`. Never read current working-tree
   source with Read/Glob/Grep as evidence for that review. Extract the blockers and every probe
   (command, input or test that demonstrates the failure). If the review has no probe, say so
   in each prompt: the outside tool must reproduce the failure first at the reviewed revision.
2. **Pick tools.** Parse `tools` (default `grok,claude`). Refuse with a one-line message if fewer than
   two distinct tools are named, or if the only tools named are the ones that authored the code.
3. **Write one prompt per tool** to `docs/diagnosis/<review-id>/<tool>/PROMPT.md`, where `<review-id>`
   is the review file's basename without extension plus the first 12 characters of the review SHA. Use
   exactly this shape, filling the brackets:

   ```text
   You are an independent, read-only diagnostician. You did not write this code.
   Repository: <repo name>, frozen review head <review sha>. Read code only at that revision: `git show <review sha>:<path>`,
   `git ls-tree -r <review sha>` to list files, `git grep <pattern> <review sha>` to search, and `git log <review sha>`. Do not edit files, install packages, use MCP tools, use the network, or read credentials or .env
   files. Write only to docs/diagnosis/<review-id>/<tool>/ROOT-CAUSE.md.
   The failing review (the probe is the specification):
   <blockers and probes, verbatim>
   Deliverables, in order: (1) line-level failure path with file:line at the frozen head; (2) why the
   author's tests passed, naming those test lines; (3) class audit of every analogous site (each await,
   settle point, multi-leg operation, retry path, clock read, cleanup before resolve) with same-defect
   yes/no/unknown; (4) minimal design and the files it touches; (5) ranked alternatives including defer;
   (6) red-first tests derived from the probe; (7) VERIFIED or HYPOTHESIS on every claim; (8) evidence
   limits. Recommend defer when nothing calls the code or two repairs of this cause already failed.
   ```

   For tools that cannot read the repository (consumer chats), add one line telling the owner to paste
   the files named in the review after the prompt, extracted with `git show <review sha>:<path>`.
4. **Write `docs/diagnosis/<review-id>/COMPARE.md`** with this template:

   | Question | <tool A> | <tool B> | Agree? | Verified by me (command or file:line) |
   |---|---|---|---|---|
   | Failure path | | | | |
   | Why tests passed | | | | |
   | Affected sites | | | | |
   | Minimal design | | | | |
   | Repair or defer | | | | |

   Under it: "Decision: repair / defer, by <owner> on <date>", and "Red-first tests to import" as a list.
5. **Report** the paths written, the frozen review head (and both SHAs when current HEAD differs),
   and which tools to paste each prompt into. Dispatch
   nothing and change no source. After the answers arrive, fill the "Verified by me" column by
   re-reading each cited line with `git show <review sha>:<path>` before any repair starts.
