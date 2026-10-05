// config-lib.mjs -- reusable library for the v5.0 override layer.
// Node twin of config-lib.ps1 (cross-platform port P2, T1c). Houses the A3 path-jail,
// A10 secrets-scan, the hand-rolled JSON-schema-subset validator, the A2 merge-rule table,
// deep-merge, frontmatter-defaults parse, and the A7 tier lookup. Pure functions (no global
// state) so the resolver stays code-not-LLM (A1). Dependency-free (Node stdlib), Node >= 18.
//
// Constraints honored: A3 (path jail), A4 (callers throw), A5 (schema const), A10 (no secrets).
// Cross-OS note: the .ps1 used OrdinalIgnoreCase for the jail (correct on Windows' case-
// insensitive FS); the twin compares case-insensitively on win32 and case-sensitively on
// POSIX -- i.e. it matches the real filesystem semantics on each OS (a tightening, never a
// loosening: the traversal cases the test exercises are rejected on every OS).

import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve, sep, join } from 'node:path';
import process from 'node:process';

// Token-shaped string patterns rejected at load time (A10). VALUES come from env.
export const SECRET_PATTERNS = ['sk-ant-', 'sk-proj-', 'sbp_', 'AKIA', 'eyJ'];

// Schema contract version this build validates against (A5).
export const SCHEMA_VERSION = '1.0.0';

// A3 path jail. Returns true if Candidate stays inside Base.
export function testPathJail(base, candidate) {
  let baseFull = pathResolve(base);
  if (!baseFull.endsWith(sep)) baseFull += sep;
  let candFull;
  try { candFull = pathResolve(baseFull, candidate); } catch { return false; }
  if (process.platform === 'win32') {
    return candFull.toLowerCase().startsWith(baseFull.toLowerCase());
  }
  return candFull.startsWith(baseFull);
}

// Recursively collect every string leaf as { path, value }.
export function getStringLeaves(node, path = '$') {
  const out = [];
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') { out.push({ path, value: node }); return out; }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) out.push(...getStringLeaves(node[i], `${path}[${i}]`));
    return out;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) out.push(...getStringLeaves(node[k], `${path}.${k}`));
  }
  return out;
}

// A10 secrets scan. Returns a list of violation strings (empty = clean).
export function findSecretViolations(data) {
  const violations = [];
  for (const leaf of getStringLeaves(data)) {
    for (const pat of SECRET_PATTERNS) {
      if (leaf.value.includes(pat)) {
        violations.push(`${leaf.path} : token-shaped string matched '${pat}' -- secrets must come from env, never .forge/*.json (A10)`);
        break;
      }
    }
  }
  return violations;
}

// A3 sweep. Path-jails every path-like string leaf (name 'path'/'output_path'/'*_path').
export function findPathJailViolations(data, base) {
  const violations = [];
  for (const leaf of getStringLeaves(data)) {
    const segs = leaf.path.split('.');
    const leafName = segs[segs.length - 1].split('[')[0];
    if (leafName === 'path' || leafName === 'output_path' || leafName.endsWith('_path')) {
      if (!testPathJail(base, leaf.value)) {
        violations.push(`${leaf.path} : path '${leaf.value}' escapes the .forge jail (A3)`);
      }
    }
  }
  return violations;
}

function has(o, n) { return o !== null && o !== undefined && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, n); }
function isPlainObject(d) { return d !== null && typeof d === 'object' && !Array.isArray(d); }

// Hand-rolled JSON-Schema-subset validator (type, required, properties, items, enum, const,
// minimum, maximum, minItems, pattern, allOf, if/then/else). Type supports nullable unions.
// Returns a list of error strings (empty = valid).
export function testJsonAgainstSchema(data, schema, path = '$') {
  let errs = [];

  if (has(schema, 'allOf') && Array.isArray(schema.allOf)) {
    for (const subschema of schema.allOf) errs = errs.concat(testJsonAgainstSchema(data, subschema, path));
  }

  if (has(schema, 'if')) {
    const conditionMatches = testJsonAgainstSchema(data, schema.if, path).length === 0;
    if (conditionMatches && has(schema, 'then')) errs = errs.concat(testJsonAgainstSchema(data, schema.then, path));
    if (!conditionMatches && has(schema, 'else')) errs = errs.concat(testJsonAgainstSchema(data, schema.else, path));
  }

  if (has(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = {
      object: isPlainObject(data), array: Array.isArray(data), string: typeof data === 'string',
      integer: typeof data === 'number' && Number.isInteger(data), number: typeof data === 'number' && Number.isFinite(data),
      boolean: typeof data === 'boolean', null: data === null,
    };
    if (types.length === 0 || new Set(types).size !== types.length || types.some((type) => typeof type !== 'string' || !has(matches, type))) {
      errs.push(`${path} : invalid schema type (expected a JSON type or non-empty array of unique JSON types)`);
    } else if (!types.some((type) => matches[type])) {
      errs.push(`${path} : expected type '${types.join(' | ')}'`);
    }
  }

  if (has(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') errs.push(`${path} : invalid schema pattern (expected a string)`);
    else {
      try {
        const pattern = new RegExp(schema.pattern);
        // JSON Schema string constraints do not apply to null or other non-string values.
        if (typeof data === 'string' && !pattern.test(data)) errs.push(`${path} : string does not match pattern '${schema.pattern}'`);
      } catch { errs.push(`${path} : invalid schema pattern (not a valid regular expression)`); }
    }
  }

  if (has(schema, 'const')) {
    if (String(data) !== String(schema.const)) {
      errs.push(`${path} : expected const '${schema.const}' but got '${data}'`);
    }
  }

  if (has(schema, 'enum')) {
    if (!schema.enum.includes(data)) {
      errs.push(`${path} : value '${data}' not in enum [${schema.enum.join(', ')}]`);
    }
  }

  if (has(schema, 'minimum') && typeof data === 'number') {
    if (data < schema.minimum) errs.push(`${path} : value ${data} below minimum ${schema.minimum}`);
  }
  if (has(schema, 'maximum') && typeof data === 'number') {
    if (data > schema.maximum) errs.push(`${path} : value ${data} above maximum ${schema.maximum}`);
  }

  if ((has(schema, 'type') && schema.type === 'object') || has(schema, 'properties') || has(schema, 'required')) {
    if (isPlainObject(data)) {
      if (has(schema, 'required')) {
        for (const req of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(data, req)) errs.push(`${path}.${req} : required field missing`);
        }
      }
      if (has(schema, 'properties')) {
        for (const pn of Object.keys(schema.properties)) {
          if (Object.prototype.hasOwnProperty.call(data, pn)) {
            errs = errs.concat(testJsonAgainstSchema(data[pn], schema.properties[pn], `${path}.${pn}`));
          }
        }
      }
    }
  }

  if (Array.isArray(data)) {
    if (has(schema, 'minItems') && data.length < schema.minItems) {
      errs.push(`${path} : array has ${data.length} items, minItems ${schema.minItems}`);
    }
    if (has(schema, 'items')) {
      for (let i = 0; i < data.length; i++) errs = errs.concat(testJsonAgainstSchema(data[i], schema.items, `${path}[${i}]`));
    }
  }

  return errs;
}

// Full A3+A4+A5+A10 gate for one parsed config object against its schema.
export function testConfigArtifact(data, schema, base) {
  let errs = [];
  errs = errs.concat(testJsonAgainstSchema(data, schema));
  errs = errs.concat(findPathJailViolations(data, base));
  errs = errs.concat(findSecretViolations(data));
  return errs;
}

// A2 centralized merge-rule table.
export const MERGE_SEMANTICS = {
  'agent-config': 'deep-merge',
  'routine': 'replace',
  'skill': 'boolean-replace',
  'rule-override': 'enable-disable',
  'model-router': 'merge-by-task',
  'workflow': 'replace',
};

export function getMergeSemantics(artifactType) {
  if (!Object.prototype.hasOwnProperty.call(MERGE_SEMANTICS, artifactType)) {
    throw new Error(`RESOLVER ERROR: unknown artifact type '${artifactType}'. Known: ${Object.keys(MERGE_SEMANTICS).join(', ')}`);
  }
  return MERGE_SEMANTICS[artifactType];
}

// Deep-merge override onto base. Object keys recurse; scalars + arrays are replaced by
// override when present. Returns a NEW object (never mutates inputs).
export function invokeDeepMerge(base, override) {
  const out = {};
  if (isPlainObject(base)) for (const k of Object.keys(base)) out[k] = base[k];
  if (override === null || override === undefined) return out;
  if (!isPlainObject(override)) return out;
  for (const k of Object.keys(override)) {
    const ov = override[k];
    const bv = Object.prototype.hasOwnProperty.call(out, k) ? out[k] : null;
    const bothObjects = isPlainObject(bv) && isPlainObject(ov);
    out[k] = bothObjects ? invokeDeepMerge(bv, ov) : ov;
  }
  return out;
}

// Extract the YAML frontmatter (first ---...--- block) of an agent .md as text.
export function getAgentFrontmatter(agentMdPath) {
  if (!existsSync(agentMdPath)) throw new Error(`RESOLVER ERROR: agent file not found: ${agentMdPath}`);
  const raw = readFileSync(agentMdPath, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!m) throw new Error(`RESOLVER ERROR: no frontmatter found in ${agentMdPath}`);
  return m[1];
}

// Read an agent's factory-default config from its frontmatter `configurable.defaults`
// (YAML flow style = valid JSON). FAILS LOUD (A4) if missing/unparseable.
export function getAgentFactoryDefault(agentMdPath) {
  const fm = getAgentFrontmatter(agentMdPath);
  const dm = fm.match(/^\s{2,}defaults:\s*(\{.*\})\s*$/m);
  if (!dm) throw new Error(`RESOLVER ERROR: no 'configurable.defaults' flow-style JSON found in ${agentMdPath} frontmatter (A4)`);
  try { return JSON.parse(dm[1]); }
  catch (e) { throw new Error(`RESOLVER ERROR: 'configurable.defaults' in ${agentMdPath} is not valid JSON: ${e.message} (A4)`); }
}

// A7 -- the agents a profile's tier entitles. Returns null if no tier gate available (open).
export function getTierAgents(projectRoot, factoryRoot) {
  const readProfile = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')).profile; } catch { return null; } };
  let tier = null;
  const profilePath = join(projectRoot, '.forge', 'profile.json');
  if (existsSync(profilePath)) tier = readProfile(profilePath);
  if (!tier) {
    const dp = join(factoryRoot, '.forge', 'default-profile.json');
    if (existsSync(dp)) tier = readProfile(dp);
  }
  if (!tier) return null;
  const presetPath = join(factoryRoot, '.forge', 'profiles', `${tier}.json`);
  if (!existsSync(presetPath)) return null;
  const preset = JSON.parse(readFileSync(presetPath, 'utf8'));
  return preset.agents_enabled ?? [];
}
