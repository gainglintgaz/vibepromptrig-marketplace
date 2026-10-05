#!/usr/bin/env node
// mcp.mjs -- read-only local MCP package discovery. It deliberately does not load, start, or
// contact servers: package artifacts only show what is present on disk, never that it works.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
// Discovery is tied to this installed script's layout. Do not accept cwd or VIBE_ROOT redirects.
const factoryRoot = realpathSync.native(dirname(dirname(here)));
const mcpRoot = join(factoryRoot, 'mcp-servers');
const argv = process.argv.slice(2);

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function statSafe(path) {
  try { return lstatSync(path); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw Object.assign(new Error('cannot inspect local MCP filesystem metadata'), { code: error.code || 'FS_ERROR' });
  }
}

function invalid(message, json = false, code) {
  if (json) process.stdout.write(`${JSON.stringify({ error: message, ...(code ? { code } : {}) })}\n`);
  else process.stderr.write(`forge mcp: ${message}\n`);
  process.exit(1);
}

// This is deliberately an inventory of the proof server's declared on-disk inputs.  Do not
// import the server here: imports are allowed to grow startup side effects, while `setup` must
// remain a zero-write preview that never starts the server.
const PROOF_FILES = [
  'scripts/vf-resource-server.mjs',
  'scripts/forge/active-root.mjs',
  'scripts/forge/safe-write.mjs',
  'agent-schemas/vf-resource.schema.json',
  'agent-schemas/vf-resource.generated.ts',
  '.forge/context/rules/scope-and-preservation.md',
  '.forge/context/kernel.md',
];

function requiredProofFile(relativePath) {
  const target = resolve(factoryRoot, relativePath);
  const parts = relativePath.split('/');
  if (!inside(factoryRoot, target) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error(`proof component path is unsafe: ${relativePath}`), { code: 'UNSAFE_PROOF_COMPONENT' });
  }
  let cursor = factoryRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    const segment = statSafe(cursor);
    if (!segment?.isFile() && cursor === target || segment?.isSymbolicLink()) {
      throw Object.assign(new Error(`required proof component is unavailable: ${relativePath}`), { code: 'MISSING_PROOF_COMPONENT' });
    }
  }
  return target;
}

function nearestExistingAncestor(target) {
  let ancestor = target;
  while (true) {
    const stat = statSafe(ancestor);
    if (stat) return ancestor;
    const parent = dirname(ancestor);
    if (parent === ancestor) throw Object.assign(new Error('state root has no resolvable ancestor'), { code: 'INVALID_STATE_ROOT' });
    ancestor = parent;
  }
}

function validateStateRoot(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001F\u007F]/.test(value) || !isAbsolute(value)) {
    throw Object.assign(new Error('--state-root must be an absolute directory path'), { code: 'INVALID_STATE_ROOT' });
  }
  const stateRoot = resolve(value);
  const sourceRoot = factoryRoot;
  // First reject lexical nesting. Then compare the nearest existing physical ancestor, which also
  // catches state paths that cross a junction before a preview creates any directories.
  if (inside(sourceRoot, stateRoot) || inside(stateRoot, sourceRoot)) {
    throw Object.assign(new Error('--state-root must be outside the source checkout'), { code: 'STATE_ROOT_OVERLAP' });
  }
  const existingAncestor = nearestExistingAncestor(stateRoot);
  const physicalStateAncestor = realpathSync.native(existingAncestor);
  const physicalAncestorStat = statSafe(physicalStateAncestor);
  if (!physicalAncestorStat?.isDirectory()) {
    throw Object.assign(new Error('--state-root must have a directory ancestor'), { code: 'INVALID_STATE_ROOT' });
  }
  const physicalStateRoot = resolve(physicalStateAncestor, relative(existingAncestor, stateRoot));
  const physicalStateStat = statSafe(physicalStateRoot);
  if (physicalStateStat && !physicalStateStat.isDirectory()) {
    throw Object.assign(new Error('--state-root must name a directory'), { code: 'INVALID_STATE_ROOT' });
  }
  if (inside(sourceRoot, physicalStateRoot) || inside(physicalStateRoot, sourceRoot)) {
    throw Object.assign(new Error('--state-root overlaps the source checkout through a symlink or junction'), { code: 'STATE_ROOT_OVERLAP' });
  }
  return stateRoot;
}

function parseSetup(args) {
  if (args[1] !== 'codex') throw Object.assign(new Error("setup supports only the 'codex' client"), { code: 'UNKNOWN_CLIENT' });
  const values = new Map();
  let json = false;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw Object.assign(new Error('--json may be supplied once'), { code: 'MALFORMED_OPTIONS' });
      json = true;
      continue;
    }
    if (!['--state-root', '--client-version'].includes(flag)) {
      throw Object.assign(new Error(`unknown setup option '${flag}'`), { code: 'MALFORMED_OPTIONS' });
    }
    if (values.has(flag)) throw Object.assign(new Error(`${flag} may be supplied once`), { code: 'MALFORMED_OPTIONS' });
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw Object.assign(new Error(`${flag} requires a value`), { code: 'MALFORMED_OPTIONS' });
    values.set(flag, value);
    index += 1;
  }
  if (!values.has('--state-root')) throw Object.assign(new Error('setup codex requires --state-root <absolute-directory>'), { code: 'MALFORMED_OPTIONS' });
  const requestedVersion = values.get('--client-version');
  if (requestedVersion !== undefined && (!requestedVersion.trim() || /[\u0000-\u001F\u007F]/.test(requestedVersion))) {
    throw Object.assign(new Error('--client-version must be non-blank printable text'), { code: 'INVALID_CLIENT_VERSION' });
  }
  return { json, stateRoot: values.get('--state-root'), clientVersion: requestedVersion?.trim() || 'unverified' };
}

function setupCodex(args) {
  const options = parseSetup(args);
  const files = PROOF_FILES.map(requiredProofFile);
  const stateRoot = validateStateRoot(options.stateRoot);
  const server = files[0];
  const output = {
    setup: 'codex',
    preview_only: true,
    connection: 'not_checked',
    source_git_cleanliness: 'not_checked',
    native_verification: {
      saved_switch_state: 'not_checked',
      resource_access: 'not_checked',
      note: 'A saved disabled switch state and readable resource access are separate observations. Record that combination as unresolved; do not call it PASS or promise a restart will fix it.',
    },
    server: {
      name: 'vibepromptrig-resource-proof',
      transport: 'stdio',
      source_root: factoryRoot,
      resource_uri: 'vf://rules/scope-and-preservation@1.0.0',
    },
    client: { declared_identity: 'OpenAI.Codex', version: options.clientVersion },
    command: process.execPath,
    args: [
      server,
      '--project-root', factoryRoot,
      '--state-root', stateRoot,
      '--client-name', 'OpenAI.Codex',
      '--client-version', options.clientVersion,
    ],
    context_setup: {
      commands: ['forge context install-plan', 'forge context install-review', 'forge context install'],
      note: 'Context installation is separate and requires an explicit target and reviewed plan. A project installation affects six entrypoints; global availability and per-project instructions differ; Markdown guidance is advisory while executable gates remain authoritative.',
    },
  };
  if (options.json) return process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Codex MCP setup preview (no files or configuration changed)\nServer: ${output.server.name}\nType: STDIO\nSource root: ${output.server.source_root}\nDeclared client: ${output.client.declared_identity} ${output.client.version}\nCommand: ${output.command}\nArguments:\n`);
  output.args.forEach((value, index) => process.stdout.write(`  ${index + 1}. ${value}\n`));
  process.stdout.write(`Connection: not checked\nSource Git cleanliness: not checked\nSaved switch state: not checked\nResource access: not checked\n\nIn Codex, open Settings → Plugins → MCPs → Add, then enter Type: STDIO, the command, and each numbered argument in its own argument row.\nAfter explicit host configuration, verify ${output.server.resource_uri}: list it, read it, and record the observed digest. Separately record the switch/access sequence off → denied → on.\nA saved disabled switch state and readable resource access are separate observations. Record that combination as unresolved; do not call it PASS or promise a restart will fix it.\nFor compact context, choose an explicit target, run forge context install-plan and forge context install-review, and review the plan before forge context install. A project installation affects six entrypoints; global availability and per-project instructions differ; Markdown guidance is advisory while executable gates remain authoritative.\nThe proof server requires a clean committed source when it launches. This preview does not start it.\n`);
}

function rootStatus() {
  const stat = statSafe(mcpRoot);
  if (!stat) return { available: false, reason: 'mcp-servers directory is absent from this installation' };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { available: false, reason: 'mcp-servers directory is not a real directory in this installation' };
  let resolved;
  try { resolved = realpathSync.native(mcpRoot); } catch { return { available: false, reason: 'mcp-servers directory cannot be resolved safely' }; }
  if (!inside(factoryRoot, resolved)) return { available: false, reason: 'mcp-servers directory resolves outside this installation' };
  return { available: true, path: resolved };
}

function binEntries(bin, packageName) {
  // npm's scalar form names the executable after the package (without an @scope/), not "default".
  if (bin === undefined) return [];
  if (typeof bin === 'string') return bin.trim() ? [[packageName.split('/').at(-1), bin]] : null;
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const entries = Object.entries(bin);
    return entries.every(([name, value]) => name.trim() && typeof value === 'string' && value.trim()) ? entries : null;
  }
  return null;
}

function inspectPackage(dirName, warnings) {
  const packageDir = join(mcpRoot, dirName);
  const dirStat = statSafe(packageDir);
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) {
    warnings.push(`${dirName}: skipped unsafe package directory`);
    return null;
  }
  const packageFile = join(packageDir, 'package.json');
  const fileStat = statSafe(packageFile);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    warnings.push(`${dirName}: package.json is missing or unsafe`);
    return null;
  }
  let metadata;
  try { metadata = JSON.parse(readFileSync(packageFile, 'utf8')); } catch (error) {
    warnings.push(`${dirName}: package.json ${error instanceof SyntaxError ? 'is malformed' : 'cannot be read'}`);
    return null;
  }
  if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim()) {
    warnings.push(`${dirName}: package.json has no valid name`);
    return null;
  }

  const bins = binEntries(metadata.bin, metadata.name);
  if (bins === null) {
    warnings.push(`${dirName}: package.json has malformed bin metadata`);
    return null;
  }
  const artifacts = bins.map(([name, binPath]) => {
    const target = resolve(packageDir, binPath);
    const parts = binPath.split(/[\\/]+/);
    const safePath = !isAbsolute(binPath) && !win32.isAbsolute(binPath) && inside(packageDir, target) && parts.every((part) => part && part !== '..');
    let cursor = packageDir;
    let hasSymlink = false;
    if (safePath) for (const part of parts) {
      if (part === '.') continue;
      cursor = join(cursor, part);
      const segment = statSafe(cursor);
      if (segment?.isSymbolicLink()) { hasSymlink = true; break; }
    }
    const targetStat = safePath && !hasSymlink ? statSafe(target) : null;
    const valid = safePath && !hasSymlink;
    if (!valid) warnings.push(`${dirName}: rejected unsafe bin path '${binPath}'`);
    return { name, path: binPath, present: Boolean(targetStat?.isFile()), valid };
  });
  return {
    name: metadata.name,
    directory: dirName,
    description: typeof metadata.description === 'string' ? metadata.description : null,
    bin: artifacts,
    build: { declared: typeof metadata.scripts?.build === 'string', artifact_present: artifacts.length > 0 && artifacts.every((artifact) => artifact.present) },
    runtime: 'not_checked',
    auth: 'not_checked',
    connection: 'not_checked',
    transport: 'not_checked',
  };
}

function catalog() {
  const state = rootStatus();
  if (!state.available) return { state, servers: [], warnings: [] };
  const warnings = [];
  let dirs = [];
  try { dirs = readdirSync(mcpRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name).sort(); } catch {
    return { state: { available: false, reason: 'mcp-servers directory cannot be read safely' }, servers: [], warnings };
  }
  const servers = dirs.map((dir) => inspectPackage(dir, warnings)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { state, servers, warnings };
}

function printList(result, json) {
  if (json) return process.stdout.write(`${JSON.stringify({ catalog: result.state.available ? 'available' : 'unavailable', reason: result.state.reason || null, servers: result.servers, warnings: result.warnings }, null, 2)}\n`);
  if (!result.state.available) return process.stdout.write(`MCP catalog unavailable: ${result.state.reason}.\nRuntime, authentication, and connections were not checked.\n`);
  if (result.servers.length === 0) process.stdout.write('No MCP package metadata found.\n');
  for (const server of result.servers) process.stdout.write(`${server.name}\n  ${server.description || '(no description)'}\n  build artifact: ${server.build.artifact_present ? 'present' : 'absent'}; runtime/auth/connection/transport: not checked\n`);
  for (const warning of result.warnings) process.stdout.write(`Warning: ${warning}\n`);
}

function printInspect(server, json) {
  if (json) return process.stdout.write(`${JSON.stringify(server, null, 2)}\n`);
  process.stdout.write(`${server.name}\nDirectory: ${server.directory}\nDescription: ${server.description || '(none)'}\n`);
  for (const artifact of server.bin) process.stdout.write(`Bin ${artifact.name}: ${artifact.path} (${artifact.valid ? artifact.present ? 'present' : 'absent' : 'rejected unsafe path'})\n`);
  process.stdout.write(`Build declared: ${server.build.declared ? 'yes' : 'no'}\nBuild artifact: ${server.build.artifact_present ? 'present' : 'absent'}\nRuntime, authentication, connections, and transport were not checked.\n`);
}

const json = argv.includes('--json');
const args = argv.filter((arg) => arg !== '--json');
if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
  process.stdout.write('Usage: forge mcp list [--json]\n       forge mcp inspect <known-name> [--json]\n       forge mcp setup codex --state-root <absolute-directory> [--client-version <observed-version>] [--json]\n\nList and inspect read package metadata only. Setup is a zero-write configuration preview; it never starts or contacts an MCP server.\n');
  process.exit(0);
}
if (argv[0] === 'setup') {
  try { setupCodex(argv); } catch (error) { invalid(error.message || 'invalid setup request', argv.includes('--json'), error.code || 'SETUP_ERROR'); }
  process.exit(0);
}
if (!['list', 'inspect'].includes(args[0]) || args.length === 0) invalid('usage: forge mcp list [--json] | forge mcp inspect <known-name> [--json] | forge mcp setup codex --state-root <absolute-directory> [--client-version <observed-version>] [--json]', json);
if (args[0] === 'list' && args.length !== 1) invalid('list accepts only --json', json);
if (args[0] === 'inspect' && args.length !== 2) invalid('usage: forge mcp inspect <known-name> [--json]', json);

let result;
try { result = catalog(); } catch (error) { invalid('cannot inspect local MCP filesystem metadata', json, error.code || 'FS_ERROR'); }
if (args[0] === 'list') {
  printList(result, json);
  process.exit(0);
}
if (!result.state.available) invalid(`MCP catalog unavailable: ${result.state.reason}`, json);
const name = args[1];
const matches = result.servers.filter((entry) => entry.name === name || entry.directory === name || entry.bin.some((bin) => bin.name === name));
if (matches.length > 1) invalid(`ambiguous MCP package identifier '${name}'; use an unambiguous package name or directory`, json);
const [server] = matches;
if (!server) invalid(`unknown MCP package '${name}'`, json);
printInspect(server, json);
