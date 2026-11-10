// Neutral install defaults. Live state always wins, including malformed live state.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePathInside } from './safe-write.mjs';
export const stateNames = ["routines","active-skills","cockpit","default-profile","rule-overrides","plan-translations"];
export function stateConfigPath(root, name, projectRoot = root) {
  const projectLive = join(projectRoot, '.forge', name + '.json');
  if (stateNames.includes(name) && existsSync(projectLive)) return projectLive;
  if (!stateNames.includes(name)) throw new Error('Unknown state config name');
  const live = join(root, '.forge', name + '.json');
  if (existsSync(live)) return live;
  const template = stateTemplatePath(root, name);
  return template || live;
}
export function stateTemplatePath(root, name) {
  if (!stateNames.includes(name)) throw new Error('Unknown state config name');
  return [join(root, '.forge', name + '.template.json'), join(root, 'scripts', 'templates', 'forge', name + '.template.json')].find(existsSync) || null;
}
export function initializeState(factoryRoot, projectRoot) {
  const added = [];
  for (const name of stateNames) {
    // Never copy the factory's live state, even when it exists. Never replace a customer file.
    const source = stateTemplatePath(factoryRoot, name);
    if (!source) continue;
    const target = resolvePathInside(projectRoot, '.forge/' + name + '.json');
    if (existsSync(target)) continue;
    const bytes = readFileSync(source);
    JSON.parse(bytes.toString('utf8')); // validate before writing
    mkdirSync(dirname(target), { recursive: true });
    try { writeFileSync(target, bytes, { flag: 'wx' }); added.push(name); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return added;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--init' || !process.argv[3] || !process.argv[4]) process.exit(2);
  initializeState(process.argv[3], process.argv[4]);
}
