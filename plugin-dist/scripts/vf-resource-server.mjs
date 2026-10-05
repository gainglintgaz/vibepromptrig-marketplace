#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ActiveRootError,
  readForgeFile,
  resolveDeclaredProjectRoot,
} from './forge/active-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PROJECT_ROOT = realpathSync.native(dirname(HERE));
const SCHEMA_PATH = join(SERVER_PROJECT_ROOT, 'agent-schemas', 'vf-resource.schema.json');
const GENERATED_TYPE_PATH = join(SERVER_PROJECT_ROOT, 'agent-schemas', 'vf-resource.generated.ts');
const RECEIPT_FILENAME = 'resource-proof-receipts.jsonl';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const V1_ALLOWED_PRIVACY = new Set(['factory_internal']);
const RECEIPT_KEYS = new Set([
  'schema_version', 'scope', 'session_id', 'event_id', 'sequence', 'timestamp_utc',
  'operation', 'result', 'error_code', 'resource_uri', 'resource_version',
  'resource_sha256', 'privacy_class', 'byte_count', 'source_revision',
  'source_clean', 'source_identity_basis',
  'declared_client', 'protocol_client', 'proof_transport_provider_calls',
  'proof_transport_spend_cents', 'proof_transport_usage_basis', 'remote_telemetry',
]);
const DECLARED_CLIENT_KEYS = new Set(['name', 'version', 'platform', 'package', 'executable_product_version']);
const PROTOCOL_CLIENT_KEYS = new Set(['name', 'version']);
const LEGACY_PROTOCOLS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);
const LATEST_LEGACY_PROTOCOL = '2025-11-25';
const MODERN_PROTOCOL = '2026-07-28';
const SERVER_INFO = Object.freeze({ name: 'vibepromptrig-resource-proof', version: '1.0.0' });

export const RESOURCE_URI = 'vf://rules/scope-and-preservation@1.0.0';
export const DEFAULT_RESOURCE = Object.freeze({
  uri: RESOURCE_URI,
  slug: 'scope-and-preservation',
  version: '1.0.0',
  name: 'scope-and-preservation',
  title: 'VibePromptRig Scope and Preservation',
  description: 'Compact load-bearing rule for scope control and preservation of unrelated work.',
  mimeType: 'text/markdown',
  privacyClass: 'factory_internal',
  sourcePath: '.forge/context/rules/scope-and-preservation.md',
  dependencies: [
    {
      id: 'context-kernel',
      sourcePath: '.forge/context/kernel.md',
      risk: 'W3',
      loadBearing: true,
    },
  ],
});

export class VFResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VFResourceError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function schemaError(path, message) {
  throw new VFResourceError('SCHEMA_INVALID', `${path} ${message}`);
}

function validateAgainstSchema(value, schema, path = '$') {
  if (Object.hasOwn(schema, 'const') && value !== schema.const) schemaError(path, `must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) schemaError(path, 'is not an allowed value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) schemaError(path, 'must be an object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) schemaError(`${path}.${key}`, 'is required');
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) schemaError(`${path}.${key}`, 'is not allowed');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(value[key], child, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) schemaError(path, 'must be an array');
    if (schema.minItems !== undefined && value.length < schema.minItems) schemaError(path, `must contain at least ${schema.minItems} item(s)`);
    value.forEach((item, index) => validateAgainstSchema(item, schema.items || {}, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') schemaError(path, 'must be a string');
    if (schema.minLength !== undefined && value.length < schema.minLength) schemaError(path, `must have length >= ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) schemaError(path, 'does not match the normative pattern');
  }
}

function tsType(schema, indent) {
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.type === 'string') return 'string';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'array') return `Array<${tsType(schema.items || {}, indent)}>`;
  if (schema.type === 'object') {
    const required = new Set(schema.required || []);
    const pad = ' '.repeat(indent);
    const childPad = ' '.repeat(indent + 2);
    const fields = Object.entries(schema.properties || {}).map(([name, child]) => (
      `${childPad}${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${tsType(child, indent + 2)};`
    ));
    return `{\n${fields.join('\n')}\n${pad}}`;
  }
  return 'unknown';
}

export function generateTypeSource(schema) {
  const interfaceName = String(schema.title || 'GeneratedResource').replace(/[^A-Za-z0-9_$]/g, '');
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {}).map(([name, child]) => (
    `  ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${tsType(child, 2)};`
  ));
  return [
    '// Generated from agent-schemas/vf-resource.schema.json. Do not edit by hand.',
    `// JSON Schema: ${schema.$schema}`,
    '',
    `export interface ${interfaceName} {`,
    ...fields,
    '}',
    '',
  ].join('\n');
}

function loadSchema(path = SCHEMA_PATH) {
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new VFResourceError('SCHEMA_VERSION', 'resource schema must use JSON Schema 2020-12');
  }
  return schema;
}

function defaultStateRoot(explicit) {
  if (explicit) return resolve(explicit);
  const isWindows = process.platform === 'win32';
  const base = isWindows ? process.env.LOCALAPPDATA : process.env.XDG_STATE_HOME;
  if (!base) throw new VFResourceError('STATE_ROOT_UNAVAILABLE', `${isWindows ? 'LOCALAPPDATA' : 'XDG_STATE_HOME'} is required for VibePromptRig receipts`);
  return join(base, isWindows ? 'VibePromptRig' : 'vibepromptrig');
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

function storedReceiptError(index, message) {
  throw new VFResourceError('RECEIPT_STORE_CORRUPT', `receipt line ${index + 1} ${message}`);
}

function validateStoredReceipt(record, index) {
  if (!exactKeys(record, RECEIPT_KEYS)) storedReceiptError(index, 'does not match the metadata-only contract');
  if (record.schema_version !== 1 || record.scope !== 'VF-RESOURCE-PROOF-V1') storedReceiptError(index, 'has an invalid contract identity');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(record.session_id) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(record.event_id)) storedReceiptError(index, 'has an invalid event identity');
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) storedReceiptError(index, 'has an invalid sequence');
  if (!['resources/list', 'resources/read'].includes(record.operation)) storedReceiptError(index, 'has an invalid operation');
  if (!['PASS', 'FAIL'].includes(record.result)) storedReceiptError(index, 'has an invalid result');
  if ((record.result === 'PASS' && record.error_code !== null) || (record.result === 'FAIL' && typeof record.error_code !== 'string')) storedReceiptError(index, 'has inconsistent error metadata');
  if (record.resource_uri !== null && !parseResourceUri(record.resource_uri)) storedReceiptError(index, 'has an invalid resource URI');
  if (record.resource_version !== null && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(record.resource_version)) storedReceiptError(index, 'has an invalid resource version');
  if (record.resource_sha256 !== null && !/^[a-f0-9]{64}$/.test(record.resource_sha256)) storedReceiptError(index, 'has an invalid resource digest');
  if (record.privacy_class !== null && !['public', 'factory_internal', 'project_confidential', 'pii_restricted', 'secret_prohibited'].includes(record.privacy_class)) storedReceiptError(index, 'has an invalid privacy class');
  if (record.byte_count !== null && (!Number.isSafeInteger(record.byte_count) || record.byte_count < 0)) storedReceiptError(index, 'has an invalid byte count');
  const validSourceIdentity = record.source_clean === true
    ? ['git_head_clean', 'test_injected'].includes(record.source_identity_basis)
    : record.source_clean === false && record.source_identity_basis === 'git_head_dirty';
  if (!/^[a-f0-9]{40}$/i.test(record.source_revision) || !validSourceIdentity) storedReceiptError(index, 'has invalid source identity');
  if (record.result === 'PASS' && record.source_clean !== true) storedReceiptError(index, 'cannot pass against dirty source');
  if (!exactKeys(record.declared_client, DECLARED_CLIENT_KEYS) || Object.values(record.declared_client).some((value) => typeof value !== 'string')) storedReceiptError(index, 'has invalid declared-client metadata');
  if (!exactKeys(record.protocol_client, PROTOCOL_CLIENT_KEYS) || Object.values(record.protocol_client).some((value) => typeof value !== 'string')) storedReceiptError(index, 'has invalid protocol-client metadata');
  if (record.proof_transport_provider_calls !== 0 || record.proof_transport_spend_cents !== 0 || record.proof_transport_usage_basis !== 'no_provider_or_network_capability') storedReceiptError(index, 'has invalid proof-transport usage metadata');
  if (record.remote_telemetry !== false) storedReceiptError(index, 'must keep remote telemetry disabled');
}

function readRetainedReceipts(path, nowMs) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const records = [];
  const eventIds = new Set();
  const lastSequenceBySession = new Map();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new VFResourceError('RECEIPT_STORE_CORRUPT', `receipt line ${index + 1} is invalid JSON`); }
    validateStoredReceipt(record, index);
    if (eventIds.has(record.event_id)) storedReceiptError(index, 'reuses an event identity');
    eventIds.add(record.event_id);
    const previousSequence = lastSequenceBySession.get(record.session_id);
    if (previousSequence !== undefined && record.sequence !== previousSequence + 1) {
      storedReceiptError(index, 'does not advance its session sequence by one');
    }
    lastSequenceBySession.set(record.session_id, record.sequence);
    const time = Date.parse(record.timestamp_utc);
    if (!Number.isFinite(time)) throw new VFResourceError('RECEIPT_STORE_CORRUPT', `receipt line ${index + 1} has an invalid timestamp`);
    if (time >= nowMs - RETENTION_MS) records.push(record);
  }
  return records;
}

function writeReceipt(stateRoot, record, nowMs) {
  try {
    mkdirSync(stateRoot, { recursive: true });
    if (!statSync(stateRoot).isDirectory()) throw new Error('not a directory');
    const path = join(stateRoot, RECEIPT_FILENAME);
    const lock = join(stateRoot, `.${RECEIPT_FILENAME}.lock`);
    let lockDescriptor;
    try {
      lockDescriptor = openSync(lock, 'wx');
    } catch {
      throw new VFResourceError('RECEIPT_UNAVAILABLE', 'metadata receipt store is locked by another writer');
    }
    const temp = join(stateRoot, `.${RECEIPT_FILENAME}.${randomUUID()}.tmp`);
    try {
      const records = readRetainedReceipts(path, nowMs);
      validateStoredReceipt(record, records.length);
      records.push(record);
      writeFileSync(temp, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(lockDescriptor);
      if (existsSync(lock)) unlinkSync(lock);
    }
    return path;
  } catch (error) {
    if (error instanceof VFResourceError) throw error;
    throw new VFResourceError('RECEIPT_UNAVAILABLE', 'metadata receipt could not be persisted');
  }
}

function parseResourceUri(uri) {
  const match = /^vf:\/\/rules\/([a-z0-9]+(?:-[a-z0-9]+)*)@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(String(uri || ''));
  return match ? { slug: match[1], version: match[2] } : null;
}

function requiredBytes(projectRoot, relativePath, dependencyId) {
  try {
    return readForgeFile(projectRoot, relativePath);
  }
  catch (error) {
    if (error instanceof ActiveRootError && error.code === 'ROOT_ESCAPE') {
      throw new VFResourceError('ROOT_ESCAPE', error.message);
    }
    if (error instanceof ActiveRootError && error.code === 'FILE_CHANGED_DURING_READ') {
      throw new VFResourceError('RESOURCE_CHANGED_DURING_READ', error.message);
    }
    if (error instanceof ActiveRootError && error.code === 'FILE_UNAVAILABLE') {
      throw new VFResourceError('UNAVAILABLE_DEPENDENCY', `required dependency is unavailable: ${dependencyId}`);
    }
    throw error;
  }
}

export function committedBytesAtHead(projectRoot, relativePath, workingBody, dependencyId) {
  const headObject = spawnSync('git', ['-C', projectRoot, 'rev-parse', `HEAD:${relativePath}`], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const workingObject = spawnSync('git', ['-C', projectRoot, 'hash-object', '--stdin', `--path=${relativePath}`], {
    input: workingBody,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const blob = spawnSync('git', ['-C', projectRoot, 'show', `HEAD:${relativePath}`], {
    encoding: null,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
    throw new VFResourceError('SOURCE_NOT_AT_HEAD', `required source is not available at HEAD: ${dependencyId}`);
  }
  if (headObject.status !== 0 || workingObject.status !== 0
      || !/^[a-f0-9]{40,64}$/i.test(headObject.stdout.trim())
      || workingObject.stdout.trim() !== headObject.stdout.trim()) {
    throw new VFResourceError('SOURCE_NOT_AT_HEAD', `required source bytes differ from HEAD: ${dependencyId}`);
  }
  return blob.stdout;
}

function assertResourceAllowed(resource, schema) {
  validateAgainstSchema(resource, schema);
  if (!V1_ALLOWED_PRIVACY.has(resource.privacyClass)) {
    throw new VFResourceError('DISALLOWED_PRIVACY_CLASS', 'resource privacy class is not permitted in V1');
  }
  if (resource.uri !== `vf://rules/${resource.slug}@${resource.version}`) {
    throw new VFResourceError('SCHEMA_INVALID', 'resource URI, slug, and version are inconsistent');
  }
}

function validateProtocolClient(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)
      || typeof info.name !== 'string' || !info.name.trim()
      || typeof info.version !== 'string' || !info.version.trim()) {
    throw new VFResourceError('INVALID_CLIENT_INFO', 'the proof sequence requires valid client identity');
  }
}

function normalizeClient(client = {}) {
  return {
    name: String(client.name || 'unverified'),
    version: String(client.version || 'unverified'),
    platform: String(client.platform || process.platform),
    package: String(client.package || 'unverified'),
    executable_product_version: String(client.executableProductVersion || 'unverified'),
  };
}

function gitSourceIdentity(projectRoot) {
  const revision = spawnSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (revision.status !== 0 || !/^[a-f0-9]{40}$/i.test(revision.stdout.trim())) {
    throw new VFResourceError('SOURCE_IDENTITY_UNAVAILABLE', 'clean Git source identity is unavailable');
  }
  const working = spawnSync('git', ['-C', projectRoot, 'diff', '--quiet', '--ignore-submodules=none', '--'], { encoding: 'utf8', timeout: 10_000 });
  const staged = spawnSync('git', ['-C', projectRoot, 'diff', '--cached', '--quiet', '--ignore-submodules=none', '--'], { encoding: 'utf8', timeout: 10_000 });
  const untracked = spawnSync('git', ['-C', projectRoot, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 10_000 });
  const indexFlags = spawnSync('git', ['-C', projectRoot, 'ls-files', '-v'], { encoding: 'utf8', timeout: 10_000 });
  if (![0, 1].includes(working.status) || ![0, 1].includes(staged.status)
      || untracked.status !== 0 || indexFlags.status !== 0) {
    throw new VFResourceError('SOURCE_IDENTITY_UNAVAILABLE', 'Git source status is unavailable');
  }
  const hiddenIndexState = indexFlags.stdout.split(/\r?\n/).some((line) => /^[a-zS] /.test(line));
  const clean = working.status === 0 && staged.status === 0 && !untracked.stdout.trim() && !hiddenIndexState;
  return { revision: revision.stdout.trim(), clean, basis: clean ? 'git_head_clean' : 'git_head_dirty' };
}

export function createResourceRuntime({
  projectRoot,
  expectedRoot = SERVER_PROJECT_ROOT,
  stateRoot,
  sourceIdentity,
  client,
  registry = [DEFAULT_RESOURCE],
  now = () => new Date(),
  schema = loadSchema(),
} = {}) {
  const root = resolveDeclaredProjectRoot({ declaredRoot: projectRoot, expectedRoot });
  const injectedIdentity = sourceIdentity || null;
  const identity = injectedIdentity || gitSourceIdentity(root);
  if (!/^[a-f0-9]{40}$/i.test(String(identity.revision || '')) || identity.clean !== true
      || !['git_head_clean', 'test_injected'].includes(identity.basis)) {
    throw new VFResourceError(
      identity.clean === false ? 'DIRTY_SOURCE_REVISION' : 'INVALID_SOURCE_REVISION',
      'a clean full source revision is required',
    );
  }
  const receiptRoot = defaultStateRoot(stateRoot);
  const sessionId = randomUUID();
  const declaredClient = normalizeClient(client);
  let protocolClient = { name: 'unverified', version: 'unverified' };
  let sequence = 0;
  let listed = null;

  function receipt(operation, result, details = {}) {
    const timestamp = new Date(now()).toISOString();
    const record = {
      schema_version: 1,
      scope: 'VF-RESOURCE-PROOF-V1',
      session_id: sessionId,
      event_id: randomUUID(),
      sequence: sequence + 1,
      timestamp_utc: timestamp,
      operation,
      result,
      error_code: details.errorCode || null,
      // Receipts contain catalogue identities only, never arbitrary client input.
      resource_uri: details.resource?.uri || (registry.some(item => item.uri === details.uri) ? details.uri : null),
      resource_version: details.resource?.version || null,
      resource_sha256: details.digest || null,
      privacy_class: details.resource?.privacyClass || null,
      byte_count: details.byteCount ?? null,
      source_revision: String((details.sourceIdentity || identity).revision),
      source_clean: (details.sourceIdentity || identity).clean,
      source_identity_basis: (details.sourceIdentity || identity).basis,
      declared_client: declaredClient,
      protocol_client: protocolClient,
      proof_transport_provider_calls: 0,
      proof_transport_spend_cents: 0,
      proof_transport_usage_basis: 'no_provider_or_network_capability',
      remote_telemetry: false,
    };
    writeReceipt(receiptRoot, record, Date.parse(timestamp));
    sequence = record.sequence;
    return record;
  }

  function execute(operation, uri, action) {
    let operationIdentity = identity;
    let value;
    try {
      operationIdentity = injectedIdentity || gitSourceIdentity(root);
      if (operationIdentity.clean !== true) {
        throw new VFResourceError('DIRTY_SOURCE_REVISION', 'resource proof requires a clean Git revision');
      }
      value = action();
      const afterIdentity = injectedIdentity || gitSourceIdentity(root);
      if (afterIdentity.clean !== true || afterIdentity.revision !== operationIdentity.revision) {
        operationIdentity = afterIdentity;
        throw new VFResourceError('SOURCE_CHANGED_DURING_OPERATION', 'source identity changed during the resource operation');
      }
      operationIdentity = afterIdentity;
      // Persist success outside this catch: a failed write must not be receipted again.
    } catch (error) {
      const normalized = error instanceof VFResourceError
        ? error
        : new VFResourceError('INTERNAL_ERROR', 'resource operation failed');
      if (!injectedIdentity) {
        try { operationIdentity = gitSourceIdentity(root); } catch { /* retain the last observed identity */ }
      }
      try { receipt(operation, 'FAIL', { uri, errorCode: normalized.code, sourceIdentity: operationIdentity }); }
      catch (receiptError) {
        if (receiptError instanceof VFResourceError) throw receiptError;
        throw new VFResourceError('RECEIPT_UNAVAILABLE', 'metadata receipt could not be persisted');
      }
      throw normalized;
    }
    receipt(operation, 'PASS', { ...value.receipt, sourceIdentity: operationIdentity });
    return value.result;
  }

  function checkedResource() {
    if (registry.length !== 1) throw new VFResourceError('REGISTRY_CEILING', 'V1 registry must contain exactly one resource');
    const resource = registry[0];
    assertResourceAllowed(resource, schema);
    for (const dependency of resource.dependencies) {
      const dependencyBody = requiredBytes(root, dependency.sourcePath, dependency.id);
      if (!injectedIdentity) committedBytesAtHead(root, dependency.sourcePath, dependencyBody, dependency.id);
    }
    const workingBody = requiredBytes(root, resource.sourcePath, resource.slug);
    const body = injectedIdentity
      ? workingBody
      : committedBytesAtHead(root, resource.sourcePath, workingBody, resource.slug);
    let text;
    try {
      // Preserve a UTF-8 BOM so encoding the returned text reproduces the hashed bytes.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      throw new VFResourceError('INVALID_RESOURCE_ENCODING', 'resource must contain valid UTF-8');
    }
    return { resource, body, text };
  }

  return {
    setProtocolClient(info = {}) {
      protocolClient = {
        name: String(info.name || 'unverified'),
        version: String(info.version || 'unverified'),
      };
    },
    listResources() {
      let listIdentity = null;
      const result = execute('resources/list', null, () => {
        const { resource, body } = checkedResource();
        const digest = sha256(body);
        listIdentity = { uri: resource.uri, digest };
        return {
          result: [{
            uri: resource.uri,
            name: resource.name,
            title: resource.title,
            description: resource.description,
            mimeType: resource.mimeType,
            _meta: {
              'vf/version': resource.version,
              'vf/privacyClass': resource.privacyClass,
              'vf/sha256': digest,
            },
          }],
          receipt: { resource, digest, byteCount: body.byteLength },
        };
      });
      listed = listIdentity;
      return result;
    },
    readResource(uri) {
      return execute('resources/read', uri, () => {
        const requested = parseResourceUri(uri);
        const current = parseResourceUri(registry[0]?.uri);
        if (!requested || !current || requested.slug !== current.slug) {
          throw new VFResourceError('UNKNOWN_RESOURCE', 'requested resource is unknown');
        }
        if (requested.version !== current.version) {
          throw new VFResourceError('VERSION_MISMATCH', 'requested resource version is unavailable');
        }
        const { resource, body, text } = checkedResource();
        if (!listed || listed.uri !== resource.uri) {
          throw new VFResourceError('LIST_REQUIRED', 'resource must be listed before it is read in this session');
        }
        const digest = sha256(body);
        if (digest !== listed.digest) {
          throw new VFResourceError('RESOURCE_CHANGED_AFTER_LIST', 'resource changed after it was listed');
        }
        return {
          result: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
          receipt: { resource, digest, byteCount: body.byteLength },
        };
      });
    },
    receiptPath: join(receiptRoot, RECEIPT_FILENAME),
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function runtimeFromArgs(args) {
  return createResourceRuntime({
    projectRoot: argValue(args, '--project-root'),
    stateRoot: argValue(args, '--state-root'),
    client: {
      name: argValue(args, '--client-name'),
      version: argValue(args, '--client-version'),
      platform: argValue(args, '--client-platform'),
      package: argValue(args, '--client-package'),
      executableProductVersion: argValue(args, '--client-executable-version'),
    },
  });
}

async function runStdio(args) {
  const runtime = runtimeFromArgs(args);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let legacyInitializeResponded = false;
  let legacyReady = false;
  let modernDiscovered = false;
  let modernClientIdentity = null;
  let protocolMode = null;

  function modernMetadata(request, { discovery = false } = {}) {
    const metadata = request.params?._meta || {};
    if (metadata['io.modelcontextprotocol/protocolVersion'] !== MODERN_PROTOCOL) {
      throw new VFResourceError('PROTOCOL_NOT_INITIALIZED', 'request requires legacy initialize or MCP 2026-07-28 metadata');
    }
    const capabilities = metadata['io.modelcontextprotocol/clientCapabilities'];
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw new VFResourceError('MISSING_CLIENT_CAPABILITIES', 'MCP 2026-07-28 client capabilities are required');
    }
    const info = metadata['io.modelcontextprotocol/clientInfo'];
    validateProtocolClient(info);
    const key = JSON.stringify({ name: info.name, version: info.version });
    if (discovery) {
      if (protocolMode !== null) {
        throw new VFResourceError('LIFECYCLE_ALREADY_SELECTED', 'the proof process already selected a protocol lifecycle');
      }
      protocolMode = 'modern';
      modernClientIdentity = key;
      modernDiscovered = true;
    } else if (protocolMode === null || !modernDiscovered) {
      throw new VFResourceError('DISCOVERY_REQUIRED', 'server/discover is required before the modern proof sequence');
    } else if (protocolMode !== 'modern') {
      throw new VFResourceError('LIFECYCLE_ALREADY_SELECTED', 'the proof process already selected the legacy lifecycle');
    } else if (key !== modernClientIdentity) {
      throw new VFResourceError('CLIENT_IDENTITY_CHANGED', 'client identity changed during the proof sequence');
    }
    runtime.setProtocolClient(info);
    return { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };
  }

  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    if (request.method === 'notifications/initialized') {
      if (protocolMode === 'legacy' && legacyInitializeResponded) legacyReady = true;
      continue;
    }
    if (request.id === undefined) continue;
    const response = { jsonrpc: '2.0', id: request.id ?? null };
    try {
      if (request.method === 'server/discover') {
        const metadata = modernMetadata(request, { discovery: true });
        response.result = {
          resultType: 'complete',
          supportedVersions: [MODERN_PROTOCOL],
          capabilities: { resources: {} },
          instructions: 'Call resources/list before resources/read in the same transport session.',
        };
        response._meta = metadata;
      } else if (request.method === 'initialize') {
        if (protocolMode !== null) {
          throw new VFResourceError('LIFECYCLE_ALREADY_SELECTED', 'the proof process already selected a protocol lifecycle');
        }
        validateProtocolClient(request.params?.clientInfo);
        protocolMode = 'legacy';
        runtime.setProtocolClient(request.params.clientInfo);
        legacyInitializeResponded = true;
        legacyReady = false;
        response.result = {
          protocolVersion: LEGACY_PROTOCOLS.has(request.params?.protocolVersion)
            ? request.params.protocolVersion
            : LATEST_LEGACY_PROTOCOL,
          capabilities: { resources: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
      } else if (request.method === 'ping') {
        response.result = {};
      } else if (request.method === 'tools/list' || request.method === 'resources/templates/list') {
        // Codex enumerates tools and templates even for a fixed-resource-only server.
        // Empty catalogs do not add operations or satisfy resource list-before-read.
        if (protocolMode === 'legacy' && !legacyReady) {
          throw new VFResourceError('PROTOCOL_NOT_INITIALIZED', 'legacy initialized notification is required');
        }
        const metadata = protocolMode === 'legacy' ? null : modernMetadata(request);
        const catalog = request.method === 'tools/list' ? { tools: [] } : { resourceTemplates: [] };
        response.result = { ...catalog, ...(metadata ? { resultType: 'complete' } : {}) };
        if (metadata) response._meta = metadata;
      } else if (request.method === 'resources/list') {
        if (protocolMode === 'legacy' && !legacyReady) {
          throw new VFResourceError('PROTOCOL_NOT_INITIALIZED', 'legacy initialized notification is required');
        }
        const metadata = protocolMode === 'legacy' ? null : modernMetadata(request);
        response.result = { resources: runtime.listResources(), ...(metadata ? { resultType: 'complete' } : {}) };
        if (metadata) response._meta = metadata;
      } else if (request.method === 'resources/read') {
        if (protocolMode === 'legacy' && !legacyReady) {
          throw new VFResourceError('PROTOCOL_NOT_INITIALIZED', 'legacy initialized notification is required');
        }
        const metadata = protocolMode === 'legacy' ? null : modernMetadata(request);
        response.result = { contents: runtime.readResource(request.params?.uri), ...(metadata ? { resultType: 'complete' } : {}) };
        if (metadata) response._meta = metadata;
      } else {
        response.error = { code: -32601, message: 'Method not found' };
      }
    } catch (error) {
      const normalized = error instanceof VFResourceError
        ? error
        : new VFResourceError('INTERNAL_ERROR', 'resource operation failed');
      const protocolCode = normalized.code === 'PROTOCOL_NOT_INITIALIZED' ? -32022
        : ['MISSING_CLIENT_CAPABILITIES', 'INVALID_CLIENT_INFO'].includes(normalized.code) ? -32602
          : -32000;
      response.error = { code: protocolCode, message: normalized.message, data: { vfCode: normalized.code } };
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const schema = loadSchema();
  const generated = generateTypeSource(schema);
  if (args.includes('--print-generated')) {
    process.stdout.write(generated);
    return;
  }
  if (args.includes('--write-generated')) {
    writeFileSync(GENERATED_TYPE_PATH, generated, 'utf8');
    return;
  }
  if (args.includes('--check-generated')) {
    if (!existsSync(GENERATED_TYPE_PATH) || readFileSync(GENERATED_TYPE_PATH, 'utf8') !== generated) {
      process.stderr.write('Generated TypeScript drift: run node scripts/vf-resource-server.mjs --write-generated\n');
      process.exitCode = 1;
    }
    return;
  }
  await runStdio(args);
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  await main();
}
