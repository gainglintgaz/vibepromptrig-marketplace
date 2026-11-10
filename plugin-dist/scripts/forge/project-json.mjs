// Strict project JSON reads: accept UTF-8 and BOM-marked UTF-16, never repair JSON.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TextDecoder } from 'node:util';

export class ProjectJsonError extends Error {
  constructor(file) {
    super('We could not read "' + file + '". Nothing was changed. You can choose "Ask me the questions instead" to continue without using this file. Keep it unchanged until it can be reviewed.');
    this.name = 'ProjectJsonError';
  }
}

export function parseProjectJson(bytes, label) {
  return parseProjectJsonDocument(bytes, label).value;
}

function parseProjectJsonDocument(bytes, label) {
  try {
    let encoding = 'utf-8';
    let offset = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
    // Strip exactly one leading BOM. Fatal decoding rejects damaged bytes rather than
    // replacing them; JSON.parse still rejects comments, trailing commas and extra data.
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
    return { value: JSON.parse(text), text };
  } catch { throw new ProjectJsonError(label); }
}

export function readProjectJson(path, label = basename(path)) {
  return readProjectJsonDocument(path, label).value;
}

// Preserve decoded source length for callers enforcing a review budget.
export function readProjectJsonDocument(path, label = basename(path)) {
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new ProjectJsonError(label); }
  return parseProjectJsonDocument(bytes, label);
}

// These are the strict JSON files inspected by /setup and its cleanup/onboarding
// helpers. JSONC (wrangler.jsonc) and non-JSON manifests retain their own syntax.
export const SETUP_PROJECT_JSON = Object.freeze([
  'package.json', 'vercel.json', '.mcp.json', '.claude/setup-manifest.json',
  '.claude/vibepromptrig.json', '.forge/factory-manifest.json', '.forge/context/project-facts.json',
  '.forge/context-install-review.json',
]);

export function checkSetupProjectJson(projectRoot) {
  for (const file of SETUP_PROJECT_JSON) {
    const path = join(projectRoot, file);
    if (existsSync(path)) readProjectJson(path, file);
  }
}
