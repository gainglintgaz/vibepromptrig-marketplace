// Resolves the operator display name from identity/operator.json, the single source of truth.
// llcApproved false -> base name only; true -> base name plus entity suffix.
// The full entity name is never stored as one string, so it cannot leak by copy-paste.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'operator.json');
export const ALLOWED_KEYS = ['$comment', 'operatorBaseName', 'entitySuffix', 'llcApproved'];

export function loadOperatorConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function operatorName(config = loadOperatorConfig()) {
  if (typeof config.llcApproved !== 'boolean') throw new Error('llcApproved must be a boolean');
  if (!config.operatorBaseName) throw new Error('operatorBaseName is missing');
  return config.llcApproved ? `${config.operatorBaseName} ${config.entitySuffix}` : config.operatorBaseName;
}
