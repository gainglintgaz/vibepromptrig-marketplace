// VF-CONTEXT-V2 dependency-free contract loader, resolver, and packet renderer.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { resolvePathInside } from './safe-write.mjs';

const AUTOLOAD = ['.claude/rules/', '.cursor/rules/', '.agents/rules/', '.agent/rules/'];
const RISKS = new Set(['W0', 'W1', 'W2', 'W3']);
export const CONTEXT_MANIFEST_SCHEMA_VERSION = 2;
export const DEFAULT_PACKET_BUDGETS = Object.freeze({ normal: 16 * 1024, high_risk: 24 * 1024 });
const posix = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
const stableId = (file) => `VF-RULE-${posix(file).replace(/\.md$/i, '').replaceAll('/', '-').replace(/[^a-z0-9-]+/gi, '-').toUpperCase()}`;

export function migrateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('context manifest must be a JSON object');
  if (input.schema_version === 2) return { manifest: input, migrated: false, warnings: [] };
  if (input.schema_version !== undefined && input.schema_version !== 1) throw new Error(`unsupported context manifest schema_version ${input.schema_version}`);
  if (!input.buckets || typeof input.buckets !== 'object') throw new Error('legacy manifest is missing buckets');
  const files = [];
  for (const bucket of Object.values(input.buckets)) for (const file of bucket?.files || []) if (!files.includes(file)) files.push(file);
  const rules = files.map((file) => ({
    id: stableId(file), legacy_file: file, source: `.claude/rules/${file}`,
    summary: `Legacy rule ${file}; compact metadata not yet authored.`,
    card: '.forge/context/rules/scope-and-preservation.md',
    card_version: '1.0.0',
    reference: `docs/rules-reference/context-v2-safeguards.md#${file.replace(/\.md$/i, '').replaceAll('/', '-')}`,
    reference_version: '1.0.0',
    applicability: { intents: ['unknown'], paths: [], capabilities: [], risks: ['W0', 'W1', 'W2', 'W3'] },
    dependencies: [],
    enforcement: { tier: 3, kind: 'advisory', reference: 'legacy manifest migration only', coverage_limit: 'Legacy v1 has no machine-readable enforcement metadata.' },
    replacement: { outcome: 'retained', card_ids: ['scope-and-preservation'], rationale: 'Compatibility projection only; author v2 metadata before activation.' },
    lifecycle: 'active'
  }));
  return { manifest: { ...input, schema_version: 2, rules, selection_requirements: { baseline: rules.filter((rule) => /vibe-standard|secrets-handling/.test(rule.legacy_file)).map((rule) => rule.id) }, packet_budgets: { normal_bytes: DEFAULT_PACKET_BUDGETS.normal, high_risk_bytes: DEFAULT_PACKET_BUDGETS.high_risk, policy: 'Compatibility defaults; advisory until v2 metadata is authored.' } }, migrated: true, warnings: ['Legacy rules-manifest v1 loaded through an advisory compatibility projection.'] };
}

function walkNative(root, relativeDir, out = []) {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walkNative(root, rel, out);
    else if (/\.(md|mdc)$/i.test(entry.name)) out.push(rel);
  }
  return out;
}
const stem = (file) => posix(file).split('/').pop().replace(/\.(md|mdc)$/i, '').toLowerCase();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Fails when a legacy rule body sits in a native autoload directory (.claude/.cursor/.agents/.agent
// rules), whether as a manifest source, a same-named copy/mirror, or a byte-identical renamed copy.
// Delivery 3b relocated every legacy body, so there is no exemption: a native directory may hold only
// compact entries (for example vf-context-core.mdc), never a legacy rule name or relocated bytes.
export function findLegacyBodiesInNativeAutoload(factoryRoot, manifest) {
  const violations = [];
  const rules = manifest?.rules || [];
  const legacyByStem = new Map(rules.map((rule) => [stem(rule.legacy_file), rule]));
  const movedHashes = new Map();
  for (const rule of rules) {
    const source = posix(rule.source).split('#')[0];
    if (AUTOLOAD.some((prefix) => source.startsWith(prefix))) violations.push(`${rule.id}: source ${source} is in a native autoload directory`);
    else if (existsInside(factoryRoot, source)) movedHashes.set(sha256(readFileSync(join(factoryRoot, source))), source);
  }
  for (const prefix of AUTOLOAD) for (const file of walkNative(factoryRoot, prefix.replace(/\/$/, ''))) {
    const copyOf = movedHashes.get(sha256(readFileSync(join(factoryRoot, file))));
    if (copyOf) { violations.push(`${file}: byte-identical copy of relocated legacy rule ${copyOf}`); continue; }
    const rule = legacyByStem.get(stem(file));
    if (rule) violations.push(`${file}: legacy rule body ${rule.legacy_file} in a native autoload directory`);
  }
  return violations;
}

// Source-versus-package detection (Context V2 Delivery 3b). The source factory no longer has a
// `.claude/rules/` tree, so its absence cannot mean "packaged". A tree is a packaged runtime only when
// build-plugin-dist wrote the distribution marker AND the relocated corpus holds exactly the marker's
// packaged references. A stray or copied marker in a source checkout (which carries all 47 bodies)
// therefore cannot disable source checks; a missing marker only makes doctor stricter.
export const DISTRIBUTION_MARKER = '.forge/distribution.json';
export const RELOCATED_RULE_CORPUS = 'docs/rules-reference/factory';
export function packagedRuntimeStatus(root) {
  if (existsSync(join(root, '.claude', 'rules'))) return { packaged: false, reason: 'legacy .claude/rules tree present' };
  const markerPath = join(root, ...DISTRIBUTION_MARKER.split('/'));
  if (!existsSync(markerPath)) return { packaged: false, reason: 'no distribution marker' };
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { return { packaged: false, reason: 'unreadable distribution marker' }; }
  if (marker?.kind !== 'packaged-runtime' || !Array.isArray(marker.packaged_factory_refs)) return { packaged: false, reason: 'invalid distribution marker' };
  const corpus = walkFiles(root, RELOCATED_RULE_CORPUS).map((file) => file.slice(RELOCATED_RULE_CORPUS.length + 1)).sort();
  const declared = marker.packaged_factory_refs.map(posix).sort();
  if (JSON.stringify(corpus) !== JSON.stringify(declared)) return { packaged: false, reason: `relocated corpus has ${corpus.length} file(s), marker declares ${declared.length}` };
  return { packaged: true, reason: 'distribution marker matches the packaged reference set' };
}
export const isPackagedRuntime = (root) => packagedRuntimeStatus(root).packaged;
function walkFiles(root, relativeDir, out = []) {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(root, rel, out); else out.push(rel);
  }
  return out;
}

function existsInside(root, relativePath) {
  // Reuse the physical existing-ancestor jail before any context content is read.
  try { return existsSync(resolvePathInside(root, relativePath)); }
  catch { return false; }
}

export function validateManifest(manifest, { factoryRoot, requireFiles = true } = {}) {
  const fileMode = requireFiles === 'runtime' ? 'runtime' : requireFiles ? 'all' : 'none';
  const errors = [], ids = new Set(), legacy = new Set();
  if (manifest?.schema_version !== 2) errors.push('schema_version must be 2');
  if (!Array.isArray(manifest?.rules) || manifest.rules.length === 0) errors.push('rules[] must be non-empty');
  if (!manifest?.selection_requirements || typeof manifest.selection_requirements !== 'object') errors.push('selection_requirements must be an object');
  for (const key of ['normal_bytes', 'high_risk_bytes']) if (!Number.isSafeInteger(manifest?.packet_budgets?.[key]) || manifest.packet_budgets[key] <= 0) errors.push(`packet_budgets.${key} must be a positive integer`);
  if (Number.isSafeInteger(manifest?.packet_budgets?.normal_bytes) && Number.isSafeInteger(manifest?.packet_budgets?.high_risk_bytes) && manifest.packet_budgets.high_risk_bytes < manifest.packet_budgets.normal_bytes) errors.push('packet_budgets.high_risk_bytes must be >= normal_bytes');
  for (const [index, rule] of (manifest?.rules || []).entries()) {
    const at = `rules[${index}]`;
    for (const key of ['id', 'legacy_file', 'source', 'summary', 'card', 'card_version', 'reference', 'reference_version', 'applicability', 'dependencies', 'enforcement', 'replacement', 'lifecycle']) if (rule?.[key] === undefined) errors.push(`${at}.${key} is required`);
    for (const key of ['card_version', 'reference_version']) if (rule?.[key] !== undefined && !/^\d+\.\d+\.\d+$/.test(rule[key])) errors.push(`${at}.${key} must be semantic version text`);
    if (ids.has(rule.id)) errors.push(`${at}.id duplicates ${rule.id}`); else ids.add(rule.id);
    if (legacy.has(rule.legacy_file)) errors.push(`${at}.legacy_file duplicates ${rule.legacy_file}`); else legacy.add(rule.legacy_file);
    const card = posix(rule.card), reference = posix(rule.reference).split('#')[0], source = posix(rule.source).split('#')[0];
    if (AUTOLOAD.some((prefix) => card.startsWith(prefix))) errors.push(`${at}.card must be outside native autoload paths`);
    if (AUTOLOAD.some((prefix) => reference.startsWith(prefix))) errors.push(`${at}.reference must be outside native autoload paths`);
    if (fileMode !== 'none' && factoryRoot) {
      if (fileMode === 'all' && !existsInside(factoryRoot, source)) errors.push(`${at}.source does not exist: ${source}`);
      if (!existsInside(factoryRoot, card)) errors.push(`${at}.card does not exist: ${card}`);
      if (fileMode === 'all' && !existsInside(factoryRoot, reference)) errors.push(`${at}.reference does not exist: ${reference}`);
    }
    for (const key of ['intents', 'paths', 'capabilities', 'risks']) if (!Array.isArray(rule.applicability?.[key])) errors.push(`${at}.applicability.${key} must be an array`);
    for (const risk of rule.applicability?.risks || []) if (!RISKS.has(risk)) errors.push(`${at}.applicability.risks has unknown value ${risk}`);
    if (!Array.isArray(rule.dependencies)) errors.push(`${at}.dependencies must be an array`);
    const expectedKind = { 1: 'mechanical', 2: 'process', 3: 'advisory' }[rule.enforcement?.tier];
    if (!expectedKind) errors.push(`${at}.enforcement.tier must be 1, 2, or 3`);
    else if (rule.enforcement.kind !== expectedKind) errors.push(`${at}.enforcement tier ${rule.enforcement.tier} must be ${expectedKind}`);
    if (!['retained', 'mechanically_enforced', 'merged', 'retired'].includes(rule.replacement?.outcome)) errors.push(`${at}.replacement.outcome is invalid`);
    if (!Array.isArray(rule.replacement?.card_ids) || rule.replacement.card_ids.length === 0) errors.push(`${at}.replacement.card_ids must be non-empty`);
    else if (fileMode !== 'none' && factoryRoot) for (const cardId of rule.replacement.card_ids) {
      const replacementCard = `.forge/context/rules/${cardId}.md`;
      if (!existsInside(factoryRoot, replacementCard)) errors.push(`${at}.replacement.card_ids references missing card ${cardId}`);
    }
    if (!['active', 'reference', 'superseded'].includes(rule.lifecycle)) errors.push(`${at}.lifecycle is invalid`);
  }
  for (const rule of manifest?.rules || []) for (const dependency of rule.dependencies || []) if (!ids.has(dependency)) errors.push(`${rule.id} depends on unknown rule ${dependency}`);
  for (const [name, values] of Object.entries(manifest?.selection_requirements || {})) {
    if (!Array.isArray(values)) errors.push(`selection_requirements.${name} must be an array`);
    for (const id of values || []) if (!ids.has(id)) errors.push(`selection_requirements.${name} references unknown rule ${id}`);
  }
  return errors;
}

export function loadContextManifest(path, options = {}) {
  const factoryRoot = options.factoryRoot || dirname(dirname(path));
  if (!existsInside(factoryRoot, relative(factoryRoot, path))) throw new Error('context manifest is missing or outside the factory root');
  const result = migrateManifest(JSON.parse(readFileSync(path, 'utf8')));
  const errors = validateManifest(result.manifest, { factoryRoot: options.factoryRoot || dirname(dirname(path)), requireFiles: options.requireFiles ?? false });
  if (errors.length) throw new Error(`invalid context manifest:\n- ${errors.join('\n- ')}`);
  return result;
}

// Intent, path and capability are alternative selectors; risk narrows metadata matches.
// Mandatory safeguard groups below remain floors regardless of metadata or lifecycle.
function matchesPath(pattern, path) {
  const glob = posix(pattern).toLowerCase();
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
      else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$').test(posix(path).toLowerCase());
}
function applicableRuleIds(manifest, scenario) {
  const intent = String(scenario.intent || 'unknown').toLowerCase();
  const risk = String(scenario.risk || 'W1').toUpperCase();
  const capabilities = new Set((scenario.capabilities || []).map((value) => String(value).toLowerCase()));
  return (manifest.rules || []).filter((rule) => {
    if (rule.lifecycle === 'superseded') return false;
    const applicability = rule.applicability || {};
    // Unknown risk retains matching safeguards instead of becoming a permissive filter.
    if (RISKS.has(risk) && applicability.risks?.length && !applicability.risks.includes(risk)) return false;
    return (applicability.intents || []).some((value) => ['all', intent].includes(String(value).toLowerCase()))
      || (applicability.capabilities || []).some((value) => capabilities.has(String(value).toLowerCase()))
      || (applicability.paths || []).some((pattern) => (scenario.paths || []).some((path) => matchesPath(pattern, path)));
  }).map((rule) => rule.id);
}

export function requiredRuleIds(manifest, scenario) {
  const req = manifest.selection_requirements || {}, keys = ['baseline'];
  const intent = String(scenario.intent || 'unknown').toLowerCase();
  const caps = new Set((scenario.capabilities || []).map((value) => String(value).toLowerCase()));
  const paths = (scenario.paths || []).map((value) => posix(value).toLowerCase());
  const risk = String(scenario.risk || 'W1').toUpperCase();
  if (intent === 'ui' || caps.has('ui') || paths.some((path) => /(^|\/)(src|app|components)\/.*\.(tsx|jsx|vue|svelte)$/.test(path))) keys.push('ui');
  if (intent === 'auth' || caps.has('auth') || paths.some((path) => /auth|login|signup|session/.test(path))) keys.push('auth');
  if (intent === 'finance' || caps.has('finance') || paths.some((path) => /finance|tax|money|payment|invoice/.test(path))) keys.push('finance');
  if (intent === 'unknown' || scenario.unknown === true || !RISKS.has(risk)) keys.push('unknown');
  if (risk === 'W2' || risk === 'W3') keys.push('high_risk');
  return [...new Set([...keys.flatMap((key) => req[key] || []), ...applicableRuleIds(manifest, scenario)])];
}

export function validateSelection(manifest, scenario) {
  const selected = new Set(scenario.selected_rule_ids || []);
  const required = requiredRuleIds(manifest, scenario);
  const missing = required.filter((id) => !selected.has(id));
  return { valid: missing.length === 0, required_rule_ids: required, missing_rule_ids: missing };
}

export class ContextResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContextResolutionError';
    this.code = code;
    this.details = details;
  }
}

function normalizeScenario(scenario = {}) {
  const uniqueSorted = (values) => [...new Set((values || []).map((value) => posix(value).trim()).filter(Boolean))].sort();
  const risk = String(scenario.risk || 'W1').toUpperCase();
  return {
    intent: String(scenario.intent || 'unknown').toLowerCase(),
    paths: uniqueSorted(scenario.paths),
    capabilities: uniqueSorted((scenario.capabilities || []).map((value) => String(value).toLowerCase())),
    risk: RISKS.has(risk) ? risk : 'unknown',
    unknown: scenario.unknown === true || !RISKS.has(risk) || String(scenario.intent || 'unknown').toLowerCase() === 'unknown',
  };
}

function selectionKey(scenario, selectedRuleIds) {
  return createHash('sha256').update(JSON.stringify({ scenario, selected_rule_ids: selectedRuleIds })).digest('hex');
}

export function resolveContext(manifest, scenario = {}) {
  const normalized = normalizeScenario(scenario);
  const seedIds = requiredRuleIds(manifest, normalized);
  const byId = new Map((manifest.rules || []).map((rule) => [rule.id, rule]));
  for (const id of seedIds) if (!byId.has(id)) {
    throw new ContextResolutionError('MISSING_REQUIRED_RULE', `required context rule is missing: ${id}`, { rule_id: id });
  }

  const selected = [...seedIds];
  const selectedSet = new Set(selected);
  for (let index = 0; index < selected.length; index += 1) {
    const rule = byId.get(selected[index]);
    for (const dependency of rule.dependencies || []) {
      if (!byId.has(dependency)) {
        throw new ContextResolutionError('UNKNOWN_DEPENDENCY', `${rule.id} depends on unknown rule ${dependency}`, { rule_id: rule.id, dependency });
      }
      if (!selectedSet.has(dependency)) {
        selectedSet.add(dependency);
        selected.push(dependency);
      }
    }
  }

  const visiting = new Set(), visited = new Set(), stack = [];
  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      throw new ContextResolutionError('DEPENDENCY_CYCLE', `context rule dependency cycle: ${cycle.join(' -> ')}`, { cycle });
    }
    if (visited.has(id)) return;
    visiting.add(id); stack.push(id);
    for (const dependency of byId.get(id).dependencies || []) visit(dependency);
    stack.pop(); visiting.delete(id); visited.add(id);
  };
  for (const id of selected) visit(id);

  const selectedCards = [], seenCards = new Set();
  for (const id of selected) {
    const rule = byId.get(id);
    const paths = [rule.card, ...(rule.replacement?.card_ids || []).map((cardId) => `.forge/context/rules/${cardId}.md`)];
    for (const path of paths.map(posix)) if (!seenCards.has(path)) {
      seenCards.add(path);
      selectedCards.push(path);
    }
  }

  const selectedCardSet = new Set(selectedCards);
  return {
    contract: 'VF-CONTEXT-V2',
    manifest_version: manifest.version || 'unknown',
    scenario: normalized,
    selected_rule_ids: selected,
    selected_card_paths: selectedCards,
    excluded_rule_ids: (manifest.rules || []).map((rule) => rule.id).filter((id) => !selectedSet.has(id)),
    excluded_card_paths: [...new Set((manifest.rules || []).map((rule) => posix(rule.card)))].filter((path) => !selectedCardSet.has(path)),
    selection_key: selectionKey(normalized, selected),
  };
}

export function reselectContext(manifest, previousResolution, expandedScenario) {
  if (!previousResolution?.selection_key) throw new ContextResolutionError('INVALID_PREVIOUS_SELECTION', 'scope expansion requires a previous resolved selection');
  const next = resolveContext(manifest, expandedScenario);
  const before = new Set(previousResolution.selected_rule_ids || []), after = new Set(next.selected_rule_ids);
  return {
    ...next,
    scope_expanded: true,
    previous_selection_key: previousResolution.selection_key,
    added_rule_ids: next.selected_rule_ids.filter((id) => !before.has(id)),
    removed_rule_ids: (previousResolution.selected_rule_ids || []).filter((id) => !after.has(id)),
  };
}

function readRequired(factoryRoot, relativePath, code) {
  if (!existsInside(factoryRoot, relativePath)) {
    throw new ContextResolutionError(code, `required context file is missing or outside the factory root: ${relativePath}`, { path: relativePath });
  }
  return readFileSync(join(factoryRoot, relativePath), 'utf8').trimEnd();
}

export function renderContextPacket({ factoryRoot, manifest, resolution, budgetBytes } = {}) {
  if (!factoryRoot || !manifest || !resolution) throw new ContextResolutionError('INVALID_RENDER_INPUT', 'factoryRoot, manifest, and resolution are required');
  const kernelPath = '.forge/context/kernel.md', factsPath = '.forge/context/project-facts.json';
  const sections = [
    readRequired(factoryRoot, kernelPath, 'MISSING_KERNEL'),
    `## Project facts\n\n\`\`\`json\n${readRequired(factoryRoot, factsPath, 'MISSING_PROJECT_FACTS')}\n\`\`\``,
  ];
  const cardPaths = [];
  for (const path of resolution.selected_card_paths || []) {
    const content = readRequired(factoryRoot, path, 'MISSING_REQUIRED_CARD');
    cardPaths.push(posix(path));
    sections.push(`## Context card: ${posix(path)}\n\n${content}`);
  }
  const content = `${sections.join('\n\n---\n\n')}\n`;
  const bytes = Buffer.byteLength(content, 'utf8');
  const configuredBudgets = manifest.packet_budgets || {};
  const defaultBudget = ['W2', 'W3'].includes(resolution.scenario?.risk)
    ? (configuredBudgets.high_risk_bytes || DEFAULT_PACKET_BUDGETS.high_risk)
    : (configuredBudgets.normal_bytes || DEFAULT_PACKET_BUDGETS.normal);
  const budget = budgetBytes ?? defaultBudget;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new ContextResolutionError('INVALID_PACKET_BUDGET', 'packet budget must be a positive integer byte count', { budget_bytes: budget });
  if (bytes > budget) {
    throw new ContextResolutionError('PACKET_BUDGET_EXCEEDED', `required context packet is ${bytes} bytes and exceeds the ${budget}-byte budget; no safety card was dropped`, { actual_bytes: bytes, budget_bytes: budget, selected_rule_ids: resolution.selected_rule_ids, card_paths: cardPaths });
  }
  return { content, bytes, budget_bytes: budget, card_paths: cardPaths, selection_key: resolution.selection_key };
}

export function explainContextSelection(manifest, resolution, packet = null) {
  const byId = new Map((manifest.rules || []).map((rule) => [rule.id, rule]));
  const lines = [
    'VF-CONTEXT-V2 selection',
    `Intent: ${resolution.scenario.intent}`,
    `Risk: ${resolution.scenario.risk}`,
    `Paths: ${resolution.scenario.paths.length ? resolution.scenario.paths.join(', ') : '(none)'}`,
    `Capabilities: ${resolution.scenario.capabilities.length ? resolution.scenario.capabilities.join(', ') : '(none)'}`,
    '',
    'Selected rules:',
    ...resolution.selected_rule_ids.map((id) => `- ${id}: ${byId.get(id)?.summary || 'required dependency'}`),
    '',
    'Deduplicated cards:',
    ...resolution.selected_card_paths.map((path) => `- ${path}`),
    '',
    `Packet: ${packet ? `${packet.bytes} bytes of ${packet.budget_bytes}` : 'not rendered'}`,
    `Selection key: ${resolution.selection_key}`,
    '',
    `Excluded: ${resolution.excluded_rule_ids.length} rules did not match this scenario's safeguard floors or applicability metadata.`,
  ];
  if (resolution.scope_expanded) lines.push(`Reselected after scope expansion: +${resolution.added_rule_ids.length} / -${resolution.removed_rule_ids.length} rules.`);
  return `${lines.join('\n')}\n`;
}
