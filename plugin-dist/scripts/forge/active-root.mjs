import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { resolvePathInside } from './safe-write.mjs';

export class ActiveRootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActiveRootError';
    this.code = code;
  }
}

function physicalDirectory(value, code, label) {
  if (!value) throw new ActiveRootError(code, `${label} is required`);
  const absolute = resolve(String(value));
  if (!existsSync(absolute)) throw new ActiveRootError(code, `${label} does not exist`);
  let physical;
  try {
    physical = realpathSync.native(absolute);
    if (!statSync(physical).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ActiveRootError(code, `${label} is not a readable directory`);
  }
  return physical;
}

export function resolveForgePath(projectRoot, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized !== '.forge' && !normalized.startsWith('.forge/')) {
    throw new ActiveRootError('ROOT_ESCAPE', 'resource paths must remain beneath .forge/');
  }
  try {
    return resolvePathInside(projectRoot, normalized);
  } catch {
    throw new ActiveRootError('ROOT_ESCAPE', 'resource path escapes the declared project root');
  }
}

export function readForgeFile(projectRoot, relativePath) {
  const candidate = resolveForgePath(projectRoot, relativePath);
  let descriptor;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY);
    const opened = fstatSync(descriptor);
    const revalidated = resolveForgePath(projectRoot, relativePath);
    const current = statSync(revalidated);
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new ActiveRootError('ROOT_ESCAPE', 'resource path changed during containment validation');
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new ActiveRootError('FILE_CHANGED_DURING_READ', 'resource changed while it was being read');
    }
    return content;
  } catch (error) {
    if (error instanceof ActiveRootError) throw error;
    throw new ActiveRootError('FILE_UNAVAILABLE', 'resource file is unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function resolveDeclaredProjectRoot({ declaredRoot, expectedRoot }) {
  const declared = physicalDirectory(declaredRoot, 'INVALID_DECLARED_ROOT', 'declared project root');
  const expected = physicalDirectory(expectedRoot, 'INVALID_EXPECTED_ROOT', 'server project root');
  if (declared !== expected) {
    throw new ActiveRootError(
      'DECLARED_ROOT_MISMATCH',
      'declared project root does not match the checkout containing the resource server',
    );
  }
  const forgeRoot = resolveForgePath(declared, '.forge');
  if (!existsSync(forgeRoot) || !statSync(forgeRoot).isDirectory()) {
    throw new ActiveRootError('MISSING_FORGE_ROOT', 'declared project root is missing .forge/');
  }
  return declared;
}
