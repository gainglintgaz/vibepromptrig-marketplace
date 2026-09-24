#!/usr/bin/env node
// Reversible VF-CONTEXT-V2 delivery.  This is deliberately an adapter over the
// existing context renderer and safe-write transaction primitive, not another
// rule registry or a second renderer.
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { loadContextManifest, renderContextPacket, resolveContext } from './context-contract.mjs';
import { beginTransaction, classifyDrift, commitTransaction, exactSha256, readManifest, recordOwnershipPostimage, resolvePathInside, restore, safeWrite, sha256, writeManifest } from './safe-write.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = realpathSync.native(dirname(dirname(here)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (value) => Buffer.byteLength(value, 'utf8');

function read(root, path) { return readFileSync(resolvePathInside(root, path), 'utf8'); }
const GLOBAL_PLATFORMS = Object.freeze({
  codex: { directory: '.codex', entry: 'AGENTS.md' },
  claude: { directory: '.claude', entry: 'CLAUDE.md' },
  gemini: { directory: '.gemini', entry: 'GEMINI.md' },
});
const GLOBAL_SUPPORT = '.vibepromptrig/context';
const CUSTOM_START = '<!-- VF-CUSTOM-START -->';
const CUSTOM_END = '<!-- VF-CUSTOM-END -->';

function nativeEntry(kernel, facts, platform, { resolverPath = null, projectNeutral = false } = {}) {
  const title = platform === 'cursor' ? 'VF-CONTEXT-V2' : 'VibePromptRig Compact Context v2';
  const identity = projectNeutral ? 'This global entry is project-neutral; pass the current task intent and project-relative paths to the resolver.'
    : `Project facts: ${facts.repository?.name || 'unknown'}; scope: ${facts.scope || 'unknown'}.`;
  const command = resolverPath ? `node \"${resolverPath.replaceAll('\\', '/')}\"` : 'forge context';
  const workingDirectory = resolverPath && !projectNeutral ? 'Run these commands from the project root.\n' : '';
  return `# ${title}\n\n${kernel.trim()}\n\n${identity}\n${workingDirectory}Use \`${command} resolve --intent <intent> --path <path>\` before changing scope; use \`${command} explain\` to inspect the selected cards.\nLong references remain outside native autoload trees. Unsupported editor loading behavior is advisory unless a native runtime check says otherwise.\n`;
}

function destinationFacts(destination, sourceFacts, tracked) {
  const relPath = '.forge/context/project-facts.json';
  const disk = resolvePathInside(destination, relPath);
  if (existsSync(disk)) {
    const content = readFileSync(disk, 'utf8');
    const recorded = tracked.files?.[relPath]?.sha256;
    // An unowned or edited facts file belongs to the project. Preserve its bytes and use whatever
    // valid fields it provides for native-entry labeling without claiming factory ownership.
    if (!recorded || sha256(content) !== recorded) {
      try { return { content, facts: JSON.parse(content), custom: true }; }
      catch { return { content, facts: { repository: { name: basename(destination) }, scope: 'unknown' }, custom: true }; }
    }
  }
  const hasRemote = spawnSync('git', ['-C', destination, 'remote'], { encoding: 'utf8' }).status === 0
    && Boolean(spawnSync('git', ['-C', destination, 'remote'], { encoding: 'utf8' }).stdout.trim());
  const facts = {
    schema_version: 2,
    bundle_version: sourceFacts.bundle_version,
    repository: { name: basename(destination), identity_basis: hasRemote ? 'resolved_root_and_remote' : 'resolved_root' },
    scope: existsSync(resolvePathInside(destination, 'CURRENT_SPRINT.md')) ? 'CURRENT_SPRINT.md' : 'unknown',
    stack: ['unknown'], commands: {}, environments: ['unknown'], capabilities: [],
    invariants: ['unknown'], context_entrypoint: 'forge context resolve|explain|check',
    host_context_observation: 'unknown',
    evidence: { audit_commit: null, clean_baseline_revision: null, report: null,
      runtime_unknowns: ['effective_instruction_loading', 'provider_token_cache_counters', 'child_agent_overhead'] },
  };
  return { content: `${JSON.stringify(facts, null, 2)}\n`, facts, custom: false };
}

function sourceInputPaths(manifest) {
  const paths = new Set([
    '.claude/rules-manifest.json', '.forge/context/kernel.md', '.forge/context/project-facts.json',
    'docs/rules-reference/context-v2-safeguards.md', 'scripts/forge/context.mjs',
    'scripts/forge/context.ps1', 'scripts/forge/context-contract.mjs', 'scripts/forge/context-install.mjs',
    'scripts/forge/safe-write.mjs',
  ]);
  for (const rule of manifest.rules || []) {
    paths.add(String(rule.card).replaceAll('\\', '/'));
    for (const cardId of rule.replacement?.card_ids || []) paths.add(`.forge/context/rules/${cardId}.md`);
  }
  return [...paths].sort();
}

export function sourceIdentity(sourceRoot, manifestVersion, platform = 'project', manifest = null) {
  const currentManifest = manifest || loadContextManifest(join(sourceRoot, '.claude', 'rules-manifest.json'), { factoryRoot: sourceRoot, requireFiles: 'runtime' }).manifest;
  const paths = sourceInputPaths(currentManifest);
  return hash(JSON.stringify({ platform, manifest_version: manifestVersion, files: paths.map((path) => [path, hash(read(sourceRoot, path))]) }));
}

function physicalDestination(plan, relPath) {
  const disk = resolvePathInside(plan.target_root, relPath);
  return existsSync(disk) ? realpathSync.native(disk) : disk;
}

function markedCustomBlocks(content) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const start = content.indexOf(CUSTOM_START, cursor);
    if (start < 0) break;
    const end = content.indexOf(CUSTOM_END, start + CUSTOM_START.length);
    if (end < 0) return { blocks: [], malformed: true, remainder: content };
    const after = end + CUSTOM_END.length;
    blocks.push(content.slice(start, after));
    content = content.slice(0, start) + content.slice(after);
    cursor = start;
  }
  return { blocks, malformed: false, remainder: content };
}

function legacyCandidates(sourceRoot, platform) {
  const candidates = { codex: ['AGENTS.md'], claude: ['.claude/CLAUDE.md', 'CLAUDE.md'], gemini: ['GEMINI.md'] }[platform] || [];
  return candidates.filter((path) => existsSync(join(sourceRoot, ...path.split('/')))).map((path) => ({ path, content: readFileSync(join(sourceRoot, ...path.split('/'))) }));
}

function classifyExistingInstruction(plan, file, current) {
  const platform = plan.target === 'global' ? plan.platform : ({ 'AGENTS.md': 'codex', '.claude/CLAUDE.md': 'claude', 'GEMINI.md': 'gemini' }[file.relPath] || 'project');
  const candidates = legacyCandidates(plan.source_root, platform);
  const exact = candidates.find((candidate) => exactSha256(candidate.content) === exactSha256(current));
  if (exact) return { classification: 'legacy_generated_exact', evidence: `exact_sha256:${exact.path}`, custom: [] };
  const generatedMarkers = current.includes('AUTOGENERATED from VibePromptRig factory')
    && current.includes('DO NOT EDIT directly');
  const marked = markedCustomBlocks(current.toString('utf8'));
  if (generatedMarkers && !marked.malformed && marked.blocks.length && candidates.some((candidate) => marked.remainder.trimEnd() === candidate.content.toString('utf8').trimEnd())) {
    return { classification: 'legacy_generated_with_marked_custom', evidence: 'generator_markers+known_source_remainder+explicit_custom_markers', custom: marked.blocks };
  }
  if (generatedMarkers) return { classification: 'legacy_marker_unresolved', evidence: 'generator_markers_without_exact_known_source_boundary', custom: [] };
  return { classification: 'custom_or_unknown', evidence: 'no_verified_legacy_generator_identity', custom: [] };
}

function appendCustom(generated, custom) {
  if (!custom) return generated;
  const body = custom.includes(CUSTOM_START) && custom.includes(CUSTOM_END)
    ? custom.trim()
    : `${CUSTOM_START}\n${custom.trim()}\n${CUSTOM_END}`;
  return `${generated.trimEnd()}\n\n## Preserved Custom Instructions\n\n${body}\n`;
}

function carryOwnedMarkedCustom(destination, file, tracked) {
  const disk = resolvePathInside(destination, file.relPath);
  const recorded = tracked.files?.[file.relPath]?.sha256;
  if (!recorded || !existsSync(disk)) return file;
  const current = readFileSync(disk, 'utf8');
  if (sha256(current) !== recorded) return file;
  const marked = markedCustomBlocks(current);
  return marked.malformed || marked.blocks.length === 0 ? file : { ...file, content: appendCustom(file.content, marked.blocks.join('\n\n')) };
}

function carryReviewedOverlay(destination, file, tracked, review) {
  const disk = resolvePathInside(destination, file.relPath);
  const recorded = tracked.files?.[file.relPath]?.sha256;
  if (!review || !recorded || !existsSync(disk)) return file;
  const current = readFileSync(disk, 'utf8');
  const inventory = review.inventory?.find((item) => item.path === file.relPath);
  const reconciliation = review.reconciliations?.find((item) => item.path === file.relPath);
  const preserved = reconciliation && ['preserve_custom', 'preserve_marked_custom'].includes(reconciliation.resolution);
  if (!preserved || inventory?.action !== 'diverged' || inventory.target_sha256 !== hash(file.content)
      || reconciliation.source_identity_sha256 !== review.source_identity_sha256
      || reconciliation.physical_destination !== physicalDestination({ target_root: destination }, file.relPath)
      || reconciliation.proposed_final_content_sha256 !== exactSha256(current)
      || recorded !== sha256(current)) return file;
  return { ...file, content: current };
}

function installationRoot(projectRoot, target, platform) {
  if (!projectRoot) throw new Error('An explicit --project-root/--target-root is required.');
  if (!['project', 'global'].includes(target)) throw new Error(`Unsupported target '${target}'.`);
  if (target === 'global' && !GLOBAL_PLATFORMS[platform]) throw new Error('Global installation requires --platform codex|claude|gemini.');
  if (target === 'project' && platform) throw new Error('--platform is only valid with --target global.');
  const requestedRoot = resolve(projectRoot);
  const destination = target === 'global' ? resolve(requestedRoot, GLOBAL_PLATFORMS[platform].directory) : requestedRoot;
  if (!existsSync(destination)) throw new Error(`Installation target does not exist: ${destination}`);
  if (target === 'global') {
    const physicalHome = realpathSync.native(requestedRoot);
    const physicalDestination = realpathSync.native(destination);
    const rel = relative(physicalHome, physicalDestination);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Global platform directory escapes the explicit home root: ${destination}`);
  }
  return destination;
}

function defaultReconciliation(plan, item) {
  const file = plan.files.find((candidate) => candidate.relPath === item.path);
  const disk = resolvePathInside(plan.target_root, item.path);
  const current = readFileSync(disk);
  const evidence = classifyExistingInstruction(plan, file, current);
  let resolution = 'unresolved', final = null;
  if (evidence.classification === 'legacy_generated_exact') { resolution = 'replace_verified_legacy'; final = file.content; }
  if (evidence.classification === 'legacy_generated_with_marked_custom') { resolution = 'preserve_marked_custom'; final = appendCustom(file.content, evidence.custom.join('\n\n')); }
  return {
    physical_destination: physicalDestination(plan, item.path), path: item.path,
    existing_file_sha256: exactSha256(current), proposed_final_content_sha256: final === null ? null : exactSha256(final),
    platform: plan.target === 'global' ? plan.platform : 'project', source_identity_sha256: plan.source_identity_sha256,
    source_classification: evidence.classification, evidence: evidence.evidence, resolution,
  };
}

export function buildReviewRecord(plan) {
  return {
    schema_version: 3, target: plan.target, platform: plan.platform, target_root: plan.target_root,
    source_root: plan.source_root, source_identity_sha256: plan.source_identity_sha256,
    bundle_version: plan.bundle_version, manifest_version: plan.manifest_version,
    inventory: plan.inventory.map(({ path, target_sha256, current_sha256, recorded_sha256, action }) => ({ path, target_sha256, current_sha256, recorded_sha256, action })),
    reconciliations: plan.inventory.filter((item) => item.action === 'diverged').map((item) => defaultReconciliation(plan, item)),
  };
}

export function buildInstallPlan({ factoryRoot: sourceRoot = factoryRoot, projectRoot, target = 'project', platform = null }) {
  sourceRoot = realpathSync.native(sourceRoot);
  const destination = installationRoot(projectRoot, target, platform);
  // Validate the root itself before inspecting any destination-owned paths.
  resolvePathInside(destination, '.forge');
  const manifestPath = join(sourceRoot, '.claude', 'rules-manifest.json');
  // Portable bundles retain runtime cards, not the legacy authoring corpus. Source
  // verification remains strict; installation validates every runtime dependency.
  const loaded = loadContextManifest(manifestPath, { factoryRoot: sourceRoot, requireFiles: 'runtime' });
  const identity = sourceIdentity(sourceRoot, loaded.manifest.version, target === 'global' ? platform : 'project', loaded.manifest);
  // This validates the normal packet budget at delivery time without pretending a native host loaded it.
  const packet = renderContextPacket({ factoryRoot: sourceRoot, manifest: loaded.manifest, resolution: resolveContext(loaded.manifest, { intent: 'unknown', paths: [], capabilities: [], risk: 'W1' }) });
  const kernel = read(sourceRoot, '.forge/context/kernel.md');
  const sourceFacts = JSON.parse(read(sourceRoot, '.forge/context/project-facts.json'));
  const tracked = readManifest(destination);
  let overlayProvenance = null;
  const reviewPath = resolvePathInside(destination, '.forge/context-install-review.json');
  if (existsSync(reviewPath)) {
    try {
      const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
      const expectedPlatform = target === 'global' ? platform : 'project';
      if (review.schema_version === 3 && review.target === target && review.platform === expectedPlatform
          && review.target_root === destination && review.source_root === resolve(sourceRoot)
          && review.bundle_version === loaded.manifest.version
          && review.manifest_version === loaded.manifest.version) overlayProvenance = review;
    } catch { /* Invalid provenance cannot establish an unchanged overlay. */ }
  }
  const destinationFactResult = target === 'global'
    ? { content: `${JSON.stringify({ ...sourceFacts, repository: { name: 'project-neutral', identity_basis: 'runtime_arguments' }, scope: 'runtime-selected', stack: ['runtime-selected'], capabilities: [], invariants: [] }, null, 2)}\n`, facts: { repository: { name: 'project-neutral' }, scope: 'runtime-selected' }, custom: false }
    : destinationFacts(destination, sourceFacts, tracked);
  const resolverRel = target === 'global' ? `${GLOBAL_SUPPORT}/scripts/forge/context.mjs` : 'scripts/forge/context.mjs';
  const resolvedResolver = resolvePathInside(destination, resolverRel);
  const resolverPath = target === 'global' ? resolvedResolver : resolverRel;
  const projectEntry = (entryPlatform) => nativeEntry(kernel, destinationFactResult.facts, entryPlatform, { resolverPath });
  const native = nativeEntry(kernel, destinationFactResult.facts, platform || 'generic', { resolverPath, projectNeutral: target === 'global' });
  if (bytes(native) > 4096) throw new Error(`Compact native entry is ${bytes(native)} bytes; limit is 4096.`);
  const sourceFiles = sourceInputPaths(loaded.manifest).filter((path) => path !== '.forge/context/project-facts.json');
  const mapSupport = (path) => target === 'global' ? `${GLOBAL_SUPPORT}/${path}` : path;
  const files = sourceFiles.map((path) => ({ relPath: mapSupport(path), content: read(sourceRoot, path), templateVersion: loaded.manifest.version }));
  if (!destinationFactResult.custom) files.push({ relPath: mapSupport('.forge/context/project-facts.json'), content: destinationFactResult.content, templateVersion: loaded.manifest.version });
  const projectEntries = [
    { relPath: 'AGENTS.md', content: projectEntry('agents'), templateVersion: loaded.manifest.version },
    { relPath: 'GEMINI.md', content: projectEntry('gemini'), templateVersion: loaded.manifest.version },
    { relPath: '.windsurfrules', content: projectEntry('windsurf'), templateVersion: loaded.manifest.version },
    { relPath: '.claude/CLAUDE.md', content: projectEntry('claude'), templateVersion: loaded.manifest.version },
    { relPath: '.cursor/rules/vf-context-core.mdc', content: `---\ndescription: Compact VibePromptRig context routing floor\nalwaysApply: true\n---\n\n${projectEntry('cursor')}`, templateVersion: loaded.manifest.version },
    { relPath: '.agents/rules/vf-context-core.md', content: projectEntry('antigravity'), templateVersion: loaded.manifest.version },
  ];
  if (target === 'global') files.push(carryOwnedMarkedCustom(destination, { relPath: GLOBAL_PLATFORMS[platform].entry, content: native, templateVersion: loaded.manifest.version }, tracked));
  else files.push(...projectEntries);
  for (let i = 0; i < files.length; i += 1) files[i] = carryReviewedOverlay(destination, files[i], tracked, overlayProvenance);
  const inventory = files.sort((a, b) => a.relPath.localeCompare(b.relPath)).map((file) => {
    const drift = classifyDrift({ projectRoot: destination, relPath: file.relPath, factoryContent: file.content, manifest: tracked });
    return { path: file.relPath, target_sha256: hash(file.content), current_sha256: drift.projectHash, recorded_sha256: drift.recordedHash, action: drift.state };
  });
  return { schema_version: 3, target, platform: target === 'global' ? platform : 'project', target_root: destination, source_root: resolve(sourceRoot),
    source_identity_sha256: identity, bundle_version: loaded.manifest.version,
    manifest_version: loaded.manifest.version, packet_bytes: packet.bytes, packet_budget_bytes: packet.budget_bytes, files, inventory };
}

function checkReview(plan, reviewPath) {
  if (!reviewPath) return new Map();
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const expected = buildReviewRecord(plan);
  const actual = { ...review }; delete actual.reviewed_at; delete actual.reconciliations;
  const base = { ...expected }; delete base.reconciliations;
  if (!isDeepStrictEqual(actual, base)) throw new Error('Installation plan differs from the exact reviewed inventory, source, bundle, or destination.');
  const records = review.reconciliations || [];
  if (records.length !== expected.reconciliations.length) throw new Error('Installation plan differs from the exact reviewed reconciliation set.');
  const replacements = new Map();
  for (const expectedRecord of expected.reconciliations) {
    const record = records.find((candidate) => candidate.path === expectedRecord.path);
    for (const key of ['physical_destination', 'path', 'existing_file_sha256', 'platform', 'source_identity_sha256', 'source_classification', 'evidence']) {
      if (!record || record[key] !== expectedRecord[key]) throw new Error(`Installation plan differs from the exact reviewed reconciliation: ${expectedRecord.path}`);
    }
    const file = plan.files.find((candidate) => candidate.relPath === record.path);
    let final = null;
    if (record.resolution === 'replace_verified_legacy' && record.source_classification === 'legacy_generated_exact') final = file.content;
    if (record.resolution === 'preserve_marked_custom' && record.source_classification === 'legacy_generated_with_marked_custom') {
      const evidence = classifyExistingInstruction(plan, file, readFileSync(resolvePathInside(plan.target_root, file.relPath)));
      final = appendCustom(file.content, evidence.custom.join('\n\n'));
    }
    if (record.resolution === 'preserve_custom' && typeof record.preserved_content === 'string' && record.preserved_content.trim()) final = appendCustom(file.content, record.preserved_content);
    if (final === null) throw new Error(`Unresolved content conflict: ${record.path}`);
    if (record.proposed_final_content_sha256 !== exactSha256(final)) throw new Error(`Reviewed proposed final content hash mismatch: ${record.path}`);
    replacements.set(record.path, final);
  }
  return replacements;
}

function assertPlanStillCurrent(plan, reviewed) {
  const tracked = readManifest(plan.target_root);
  for (const file of plan.files) {
    const expected = plan.inventory.find((item) => item.path === file.relPath);
    const drift = classifyDrift({ projectRoot: plan.target_root, relPath: file.relPath, factoryContent: file.content, manifest: tracked });
    const actual = { path: file.relPath, target_sha256: hash(file.content), current_sha256: drift.projectHash, recorded_sha256: drift.recordedHash, action: drift.state };
    if (!expected || !isDeepStrictEqual(actual, expected)) {
      const prefix = reviewed ? 'Installation plan differs from the exact reviewed inventory' : 'Installation target changed after planning';
      throw new Error(`${prefix}: ${file.relPath}`);
    }
  }
}

export function applyInstall(plan, { dryRun = false, reviewPath = null, failAfterWrites = null } = {}) {
  let currentSourceIdentity;
  try { currentSourceIdentity = sourceIdentity(plan.source_root, plan.manifest_version, plan.platform); }
  catch (cause) { throw new Error('Installation source changed after planning or review: source validation failed.', { cause }); }
  if (currentSourceIdentity !== plan.source_identity_sha256) throw new Error('Installation source changed after planning or review.');
  assertPlanStillCurrent(plan, Boolean(reviewPath));
  const replacements = checkReview(plan, reviewPath);
  const conflicts = plan.inventory.filter((item) => item.action === 'diverged' && !replacements.has(item.path));
  if (conflicts.length) return { applied: false, conflicts, inventory: plan.inventory };
  if (dryRun) return { applied: false, dry_run: true, inventory: plan.inventory };
  const pending = plan.inventory.filter((item) => item.action === 'absent' || item.action === 'upgrade' || replacements.has(item.path));
  const manifest = readManifest(plan.target_root);
  const needsOwnership = plan.files.some((file) => !manifest.files?.[file.relPath]);
  if (!pending.length && !needsOwnership) return { applied: false, noop: true, inventory: plan.inventory };
  for (const file of plan.files) resolvePathInside(plan.target_root, file.relPath);
  const tx = beginTransaction(plan.target_root, pending.map((item) => ({ relPath: item.path, action: item.action === 'absent' ? 'add' : 'upgrade' })), { pluginVersion: plan.bundle_version });
  let writes = 0;
  try {
    for (const file of plan.files) {
      const content = replacements.get(file.relPath) ?? file.content;
      const result = safeWrite({ projectRoot: plan.target_root, relPath: file.relPath, content, templateVersion: file.templateVersion, manifest, tx, allowDiverged: replacements.has(file.relPath) });
      if (result.written && failAfterWrites !== null && ++writes >= failAfterWrites) throw new Error('Injected apply failure');
    }
    writeManifest(plan.target_root, manifest, plan.bundle_version);
    recordOwnershipPostimage(tx);
    commitTransaction(tx);
  } catch (error) {
    try { restore(plan.target_root, tx.ts); } catch (restoreError) { throw new AggregateError([error, restoreError], `Apply failed and automatic recovery failed for transaction ${tx.ts}`); }
    throw error;
  }
  return { applied: true, backup: tx.ts, inventory: plan.inventory };
}

function usage(code = 0) {
  process.stderr.write('Usage: forge context-install plan|review|apply|rollback --project-root <path> [--factory-root <explicit-source>] [--target project|global] [--platform codex|claude|gemini] [--dry-run] [--review <file>] [--backup <id>]\n');
  process.exit(code);
}

export function main(argv = process.argv.slice(2)) {
  const action = argv.shift(); let projectRoot = null; let target = 'project'; let platform = null; let dryRun = false; let reviewPath = null; let backup = null; let sourceRoot = factoryRoot;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const take = () => argv[++i] || usage(1);
    if (a === '--project-root' || a === '--target-root') projectRoot = take();
    else if (a === '--factory-root') sourceRoot = take(); else if (a === '--platform') platform = take().toLowerCase();
    else if (a === '--target') target = take(); else if (a === '--dry-run') dryRun = true;
    else if (a === '--review') reviewPath = take(); else if (a === '--backup') backup = take(); else usage(1);
  }
  if (!action || !projectRoot) usage(1);
  if (action === 'rollback') { process.stdout.write(`${JSON.stringify({ rollback: restore(installationRoot(projectRoot, target, platform), backup) }, null, 2)}\n`); return; }
  const plan = buildInstallPlan({ factoryRoot: sourceRoot, projectRoot, target, platform });
  if (action === 'plan') {
    const review = buildReviewRecord(plan);
    process.stdout.write(`${JSON.stringify({ ...plan, files: undefined, reconciliations: review.reconciliations }, null, 2)}\n`);
    return;
  }
  if (action === 'review') {
    if (dryRun) throw new Error('Dry-run never writes a review record. Use plan for a zero-write inventory.');
    const out = resolvePathInside(plan.target_root, '.forge/context-install-review.json'); mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ reviewed_at: new Date().toISOString(), ...buildReviewRecord(plan) }, null, 2) + '\n');
    process.stdout.write(`${out}\n`); return;
  }
  if (action !== 'apply') usage(1);
  const result = applyInstall(plan, { dryRun, reviewPath }); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.conflicts?.length) process.exitCode = 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`[forge context-install] ${error.message}\n`); process.exitCode = 2; }
}
