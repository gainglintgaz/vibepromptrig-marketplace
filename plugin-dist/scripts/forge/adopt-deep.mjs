// adopt-deep.mjs -- Phase 3 qualitative pass for `forge adopt --review --deep`.
// Headless-safe: heuristic IMPROVE signals + consent-gated queue for user-original content.
// No LLM in CLI -- queue is for Cursor/agent follow-up. forge-adopt.md §9.3.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { forgeDir } from './safe-write.mjs';

export const DEFAULT_BUDGET_TOKENS = 50_000;
const CHARS_PER_TOKEN = 4;
const USER_ORIGINAL = new Set(['AGENTS.md', '.forge/cockpit.json']);

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

export function readProjectFile(projectRoot, relPath) {
  const p = join(projectRoot, ...relPath.split('/'));
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export function runDeepPass({ projectRoot, mechanicalItems, budgetTokens = DEFAULT_BUDGET_TOKENS, consent = false }) {
  const qualitative = [];
  let estimated = 0;
  let counter = mechanicalItems.length;

  function add(item) {
    estimated += item.estimated_tokens || 0;
    qualitative.push({ ...item, id: ++counter, kind: 'QUALITATIVE(opinion)' });
  }

  const agents = readProjectFile(projectRoot, 'AGENTS.md');
  if (agents != null) {
    const body = agents.replace(/^---[\s\S]*?---\n/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const tok = estimateTokens(agents);
    if (!consent && USER_ORIGINAL.has('AGENTS.md')) {
      add({ relPath: 'AGENTS.md', verdict: 'IMPROVE', consent_required: true, estimated_tokens: tok,
        note: 'User-original -- set ADOPT_DEEP_CONSENT=1 or pass --consent for full qualitative review.' });
    } else if (body.length < 120 || /<!--\s*Stack/.test(agents)) {
      add({ relPath: 'AGENTS.md', verdict: 'IMPROVE', estimated_tokens: tok,
        note: 'AGENTS.md looks like a stub -- add stack, deploy target, and conventions.' });
    } else {
      add({ relPath: 'AGENTS.md', verdict: 'KEEP', estimated_tokens: tok, note: 'AGENTS.md has substantive context.' });
    }
  } else {
    add({ relPath: 'AGENTS.md', verdict: 'IMPROVE', estimated_tokens: 200, note: 'No AGENTS.md -- add lean doctrine stub.' });
  }

  const cockpit = readProjectFile(projectRoot, '.forge/cockpit.json');
  if (cockpit != null) {
    let parsed;
    try { parsed = JSON.parse(cockpit); } catch { parsed = null; }
    const vision = parsed?.vision || parsed?.goals?.vision || '';
    const mission = parsed?.mission || '';
    const tok = estimateTokens(cockpit);
    if (!consent) {
      add({ relPath: '.forge/cockpit.json', verdict: 'IMPROVE', consent_required: true, estimated_tokens: tok,
        note: 'User-original cockpit -- consent required for qualitative review.' });
    } else if (!vision || String(vision).length < 20) {
      add({ relPath: '.forge/cockpit.json', verdict: 'IMPROVE', estimated_tokens: tok, note: 'Vision missing or vague.' });
    } else if (!mission || String(mission).length < 15) {
      add({ relPath: '.forge/cockpit.json', verdict: 'IMPROVE', estimated_tokens: tok, note: 'Mission missing or stub.' });
    } else {
      add({ relPath: '.forge/cockpit.json', verdict: 'KEEP', estimated_tokens: tok, note: 'Cockpit has vision + mission.' });
    }
  }

  const errs = readProjectFile(projectRoot, 'errors-fixed.json');
  if (errs != null) {
    let empty = true;
    try {
      const p = JSON.parse(errs);
      empty = Array.isArray(p) ? p.length === 0 : Object.keys(p).length === 0;
    } catch { empty = true; }
    if (empty) {
      add({ relPath: 'errors-fixed.json', verdict: 'IMPROVE', estimated_tokens: estimateTokens(errs),
        note: 'errors-fixed.json is empty -- learning flywheel has nothing to compound.' });
    }
  }

  const rulesDir = join(projectRoot, '.cursor', 'rules');
  if (existsSync(rulesDir)) {
    for (const name of readdirSync(rulesDir).filter((f) => f.endsWith('.mdc'))) {
      const content = readProjectFile(projectRoot, `.cursor/rules/${name}`);
      if (!content) continue;
      const always = /^---[\s\S]*?alwaysApply:\s*true/im.test(content);
      const bodyLen = content.replace(/^---[\s\S]*?---\n/, '').length;
      if (always && bodyLen > 2000) {
        add({ relPath: `.cursor/rules/${name}`, verdict: 'IMPROVE', estimated_tokens: 400,
          note: `alwaysApply rule ~${bodyLen} chars -- consider Agent-Requested mode (token tax).` });
      }
    }
  }

  for (const m of mechanicalItems.filter((i) => i.verdict === 'DIVERGED')) {
    add({ relPath: m.relPath, verdict: 'IMPROVE', estimated_tokens: 500,
      note: 'Customized vs factory -- review .factory-new sidecar and merge manually.' });
  }

  return { qualitative, estimated_tokens: estimated, budget_tokens: budgetTokens, over_budget: estimated > budgetTokens, consent };
}

export function mergeDeepIntoPlan(plan, deepResult) {
  if (deepResult.over_budget) return { ...plan, deep: deepResult, deep_refused: true };
  const items = [...plan.items, ...deepResult.qualitative];
  const summary = { ...plan.summary };
  for (const q of deepResult.qualitative) summary[q.verdict] = (summary[q.verdict] || 0) + 1;
  return { ...plan, items, summary, deep: deepResult, deep_refused: false };
}

export function renderDeepSection(deepResult) {
  const L = [];
  L.push('## QUALITATIVE pass (--deep)');
  L.push('');
  if (deepResult.over_budget) {
    L.push(`**REFUSED:** estimated ${deepResult.estimated_tokens} tokens exceeds cap ${deepResult.budget_tokens}.`);
    L.push('Reduce scope or raise ADOPT_DEEP_BUDGET_TOKENS.');
    return L.join('\n') + '\n';
  }
  L.push(`Estimated review cost: ~${deepResult.estimated_tokens} tokens (cap: ${deepResult.budget_tokens})`);
  L.push(`Consent for user-original content: ${deepResult.consent ? 'yes' : 'no (heuristic gate only)'}`);
  L.push('');
  const byVerdict = {};
  for (const q of deepResult.qualitative) {
    if (!byVerdict[q.verdict]) byVerdict[q.verdict] = [];
    byVerdict[q.verdict].push(q);
  }
  for (const [v, rows] of Object.entries(byVerdict)) {
    L.push(`### ${v} (${rows.length}) -- QUALITATIVE(opinion)`);
    for (const r of rows) {
      L.push(`- \`[${r.id}]\` \`${r.relPath}\`${r.consent_required ? ' [consent required]' : ''} -- ${r.note}`);
    }
    L.push('');
  }
  return L.join('\n');
}

export function writeDeepQueue(projectRoot, deepResult, ts) {
  const dir = forgeDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `adopt-deep-queue-${ts}.json`);
  writeFileSync(path, JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    estimated_tokens: deepResult.estimated_tokens,
    consent: deepResult.consent,
    items: deepResult.qualitative.filter((q) => q.consent_required || q.verdict === 'IMPROVE'),
  }, null, 2) + '\n', 'utf8');
  return path;
}
