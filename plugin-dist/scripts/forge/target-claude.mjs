// target-claude.mjs -- forge adopt artifact registry for Claude Code (.claude/*).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyDrift, readManifest } from './safe-write.mjs';
import {
  DRIFT_TO_VERDICT, listArtifactsUnder, checkGitHooksWiring, summarize,
} from './adopt-shared.mjs';

export const TARGET = 'claude';
const ARTIFACT_DIRS = ['.claude/rules', '.claude/agents', '.claude/skills'];

export function listFactoryArtifacts(factoryRoot) {
  const out = [];
  for (const d of ARTIFACT_DIRS) out.push(...listArtifactsUnder(factoryRoot, d));
  return out;
}

export function isPresent(projectRoot) {
  return existsSync(join(projectRoot, '.claude'));
}

export function reviewTarget({ projectRoot, factoryRoot, idStart = 0 }) {
  const manifest = readManifest(projectRoot);
  const items = [];
  let counter = idStart;
  const nextId = () => ++counter;
  for (const { relPath, content } of listFactoryArtifacts(factoryRoot)) {
    const drift = classifyDrift({ projectRoot, relPath, factoryContent: content, manifest });
    items.push({ id: nextId(), relPath, verdict: DRIFT_TO_VERDICT[drift.state], kind: 'MECHANICAL', drift: drift.state, target: TARGET });
  }
  items.push(...checkGitHooksWiring(projectRoot, factoryRoot, nextId).map((i) => ({ ...i, target: TARGET })));
  return { items, nextId: counter, manifest };
}

export function artifactMap(factoryRoot) {
  const m = new Map();
  for (const a of listFactoryArtifacts(factoryRoot)) m.set(a.relPath, a.content);
  return m;
}

export function summarizeItems(items) { return summarize(items.filter((i) => i.target === TARGET)); }
