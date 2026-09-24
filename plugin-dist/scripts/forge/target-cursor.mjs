// target-cursor.mjs -- forge adopt artifact registry for Cursor (.cursor/* + AGENTS.md).
// cursor-forge-adopt.md §3. Implements hash manifest + .mdc writer via safe-write.mjs.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyDrift, readManifest } from './safe-write.mjs';
import {
  DRIFT_TO_VERDICT, listArtifactsUnder, checkGitHooksWiring, summarize,
} from './adopt-shared.mjs';

export const TARGET = 'cursor';

// Essential rules for `forge adopt --apply --essential` (the lean seed; also the whole lean set today).
export const ESSENTIAL_RULES = new Set([
  'architect-first.mdc',
  'enforcement-first.mdc',
  'secrets-handling.mdc',
  'data-protection.mdc',
  'wired-not-orphaned.mdc',
]);

// Context V2 Delivery 3b retired the 42 generated full-rule .cursor/rules mirrors. The Cursor
// distribution ships only the hand-written lean templates (each well under 1 KB, never a full rule
// body); the compact routing entry .cursor/rules/vf-context-core.mdc stays owned by the compact
// installer (forge context install / onboard), which is the one renderer of native entries.
export const LEAN_RULE_TEMPLATES = 'scripts/templates/cursor/rules';

export function listFactoryArtifacts(factoryRoot) {
  const out = [];
  for (const { relPath, content } of listArtifactsUnder(factoryRoot, LEAN_RULE_TEMPLATES, { extFilter: '.mdc' })) {
    out.push({ relPath: `.cursor/rules/${relPath.split('/').pop()}`, content });
  }
  out.push(...listArtifactsUnder(factoryRoot, '.cursor/hooks', { extFilter: '.mjs' }));
  const hooksJson = join(factoryRoot, '.cursor', 'hooks.json');
  if (existsSync(hooksJson)) out.push({ relPath: '.cursor/hooks.json', content: readFileSync(hooksJson, 'utf8') });
  const agentsStub = join(factoryRoot, 'scripts', 'templates', 'cursor', 'AGENTS.md');
  if (existsSync(agentsStub)) out.push({ relPath: 'AGENTS.md', content: readFileSync(agentsStub, 'utf8') });
  return out;
}

export function isPresent(projectRoot) {
  return existsSync(join(projectRoot, '.cursor'));
}

export function checkCursorWiring(projectRoot, nextId) {
  const items = [];
  const rulesDir = join(projectRoot, '.cursor', 'rules');
  if (!existsSync(rulesDir)) return items;
  for (const name of readdirSync(rulesDir)) {
    if (name.toLowerCase().endsWith('.md') && !name.toLowerCase().endsWith('.mdc')) {
      items.push({ id: nextId(), relPath: `.cursor/rules/${name}`, verdict: 'MISWIRED', kind: 'MECHANICAL',
        target: TARGET, note: 'Plain .md in .cursor/rules/ is ignored by Cursor -- rename to .mdc with frontmatter.' });
    }
  }
  return items;
}

export function reviewTarget({ projectRoot, factoryRoot, idStart = 0 }) {
  readManifest(projectRoot); // ensure readable; drift uses fresh read inside classifyDrift
  const items = [];
  let counter = idStart;
  const nextId = () => ++counter;
  const manifest = readManifest(projectRoot);
  for (const { relPath, content } of listFactoryArtifacts(factoryRoot)) {
    const drift = classifyDrift({ projectRoot, relPath, factoryContent: content, manifest });
    items.push({ id: nextId(), relPath, verdict: DRIFT_TO_VERDICT[drift.state], kind: 'MECHANICAL', drift: drift.state, target: TARGET });
  }
  items.push(...checkCursorWiring(projectRoot, nextId));
  items.push(...checkGitHooksWiring(projectRoot, factoryRoot, nextId).map((i) => ({ ...i, target: TARGET })));
  return { items, nextId: counter, manifest };
}

export function artifactMap(factoryRoot) {
  const m = new Map();
  for (const a of listFactoryArtifacts(factoryRoot)) m.set(a.relPath, a.content);
  return m;
}

export function summarizeItems(items) { return summarize(items.filter((i) => i.target === TARGET)); }

export function filterEssentialItems(items) {
  return items.filter((i) => {
    if (i.verdict !== 'ADD' && i.verdict !== 'UPGRADE') return false;
    if (i.relPath === 'AGENTS.md') return true;
    if (i.relPath.startsWith('.cursor/rules/') && ESSENTIAL_RULES.has(i.relPath.split('/').pop())) return true;
    return false;
  });
}
