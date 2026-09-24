#!/usr/bin/env node
// pending-summary.mjs -- parse PENDING_APPROVALS.md into a triage summary + classify entries
// open vs resolved. Shared source of truth for the /dashboard + daily-status queue-summary line
// and the archive-resolved-approvals tool (audit 2026-07-08 item 3.4).
//
// Entry model: each top-level "## <YYYY-MM-DD> -- [TAG] <desc> (<PRIORITY> ...)" heading starts a
// block that runs until the next "## " heading. Meta sections (Triage log / Synthesizer Proposals /
// Recently Resolved / Archive) and any non-dated "## " heading are NOT approval entries.
//
// Open vs resolved is a HEURISTIC over the block's **Status:** line (or an inline "> RESOLVED/CLOSED"):
// resolved ONLY when a closed word is present and no open word is -- otherwise OPEN. Bias is toward
// over-surfacing (an approval wrongly hidden is worse than one wrongly shown), per the file's own
// "surface, do not decide" ethos.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const CLOSED_WORD = /\b(RESOLVED|CLOSED|APPROVED|DROPPED|DONE|SHIPPED|REJECTED|WON'?T\s*FIX)\b/i;
const OPEN_WORD = /\b(PENDING|NEEDS?\s+(?:[A-Z][A-Za-z]+\s+)?DECISION|AWAITING|OPEN|IN\s+PROGRESS|TODO)\b/i;
const PRIORITY = /\b(URGENT|HIGH|MEDIUM|LOW)\b/;
const PRIORITY_RANK = { URGENT: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
const META_HEADING = /^(Triage log|Synthesizer Proposals|Recently Resolved|Archive|Legend|How to use)/i;

/** Split the file into top-level "## " blocks, keeping each block's raw text verbatim. */
export function parseBlocks(text) {
  const lines = text.split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let cur = null;
  for (const ln of lines) {
    if (/^##\s+/.test(ln) && !/^###/.test(ln)) {
      if (cur) blocks.push(cur);
      cur = { heading: ln.replace(/^##\s+/, ''), raw: [ln] };
    } else if (cur) {
      cur.raw.push(ln);
    } else {
      preamble.push(ln);
    }
  }
  if (cur) blocks.push(cur);
  return { preamble, blocks };
}

/** Classify one block. Returns null for non-approval (meta / undated) headings. */
export function classifyBlock(block, nowMs) {
  const heading = block.heading;
  if (META_HEADING.test(heading)) return null;
  const dateM = /(\d{4})-(\d{2})-(\d{2})/.exec(heading);
  if (!dateM) return null; // approval entries are dated; undated "## " sections are not the queue

  // First status signal in DOCUMENT ORDER wins: resolved entries carry their resolution note
  // (**Status:** RESOLVED, or an inline "> RESOLVED/CLOSED/APPROVED") at the TOP of the block; a
  // stale "**Status:** PENDING" further down (a sub-note) must not override an earlier resolution.
  let signal = null;
  for (const ln of block.raw) {
    const st = /\*\*Status:\*\*\s*(.+)/i.exec(ln);
    if (st) { signal = st[1]; break; }
    if (/^>\s*(?:RESOLVED|CLOSED|APPROVED)\b/i.test(ln)) { signal = ln; break; }
  }
  let open;
  if (signal) {
    const closed = CLOSED_WORD.test(signal);
    const stillOpen = OPEN_WORD.test(signal);
    open = stillOpen || !closed; // resolved only when closed AND no open marker
  } else {
    open = true; // dated entry, no explicit status -> surface it
  }

  const pri = (PRIORITY.exec(heading) || PRIORITY.exec(block.raw.join('\n')) || [, 'LOW'])[1].toUpperCase();
  const tagM = /\[([A-Z0-9][A-Z0-9._-]*)\]/.exec(heading);
  const tag = tagM ? tagM[1] : heading.slice(0, 32).trim();
  const dateMs = Date.UTC(+dateM[1], +dateM[2] - 1, +dateM[3]);
  const ageDays = Math.max(0, Math.floor(((nowMs ?? Date.now()) - dateMs) / 86400000));
  return { open, pri, priRank: PRIORITY_RANK[pri] ?? 0, tag, ageDays, dateMs, heading };
}

/** Full summary object for PENDING_APPROVALS.md at `path`. */
export function summarizePending(path, nowMs) {
  const empty = { exists: false, open: 0, oldestDays: null, high: 0, urgent: 0, top: null, openItems: [] };
  if (!existsSync(path)) return empty;
  const now = nowMs ?? Date.now();
  const { blocks } = parseBlocks(readFileSync(path, 'utf8'));
  const openItems = [];
  for (const b of blocks) {
    const c = classifyBlock(b, now);
    if (c && c.open) openItems.push(c);
  }
  const high = openItems.filter((i) => i.pri === 'HIGH').length;
  const urgent = openItems.filter((i) => i.pri === 'URGENT').length;
  const oldestDays = openItems.reduce((m, i) => (i.ageDays > m ? i.ageDays : m), 0);
  // top = highest priority, oldest as tiebreak
  const top = openItems.slice().sort((a, b) => b.priRank - a.priRank || b.ageDays - a.ageDays)[0] || null;
  return { exists: true, open: openItems.length, oldestDays: openItems.length ? oldestDays : null, high, urgent, top, openItems };
}

/** One-line summary string for a status surface. */
export function summaryLine(path, nowMs) {
  const s = summarizePending(path, nowMs);
  if (!s.exists) return 'Approvals: (PENDING_APPROVALS.md not found)';
  if (s.open === 0) return 'Approvals: 0 open';
  const bits = [`${s.open} open`, `oldest ${s.oldestDays}d`];
  if (s.urgent) bits.push(`${s.urgent} URGENT`);
  if (s.high) bits.push(`${s.high} HIGH`);
  if (s.top) bits.push(`top: ${s.top.tag} (${s.top.ageDays}d, ${s.top.pri})`);
  return `Approvals: ${bits.join(' | ')}`;
}

// ---- CLI: `node scripts/lib/pending-summary.mjs [path]` prints the one-line summary ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] || new URL('../../PENDING_APPROVALS.md', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  process.stdout.write(summaryLine(path) + '\n');
}
