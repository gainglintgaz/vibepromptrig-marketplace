#!/usr/bin/env node
// Exact, source-linked instruction maintenance. No commands from documents are executed.
import { resolve, posix } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { readCheckup } from './checkup.mjs';
import { parseProjectJson, ProjectJsonError } from './project-json.mjs';
import { readBytes, inspectSources, exactHash, reviewChange, applyChange, undoChange, reviewUndo } from './reviewed-edits.mjs';

const LIMIT = 256 * 1024;
const RECORD = '.vibepromptrig/checkup.json';
const stop = message => { throw new Error(message + ' Nothing was changed.'); };
const canonical = text => text.replaceAll('\r\n', '\n');
const keys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key))) stop('Invalid ' + label + ' fields.');
};
const shortText = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 2048 || value.split('\n').length > 12 || value.includes('\0')) stop('Use a short exact ' + label + '.'); };
const targetAllowed = target => {
  if (typeof target !== 'string' || !/^(?:CLAUDE\.md|AGENTS\.md|README\.md|\.claude\/rules\/[a-z0-9][a-z0-9-]*\.md)$/.test(target)) stop('Choose a supported project instruction target.');
};
function decode(bytes, label) {
  if (bytes === null) stop('The selected project file is missing: ' + label + '.');
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) offset = 3;
  else if (bytes[0] === 255 && bytes[1] === 254) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 254 && bytes[1] === 255) { encoding = 'utf-16be'; offset = 2; }
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
    if (text.includes('\0')) stop('The selected text encoding is unsupported.');
    return { text, encoding, bom: bytes.subarray(0, offset) };
  } catch { stop('We could not read the text encoding in ' + label + '. Keep the file for review.'); }
}
function encode(document, text) {
  const bytes = Buffer.from(text, document.encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (document.encoding === 'utf-16be') bytes.swap16();
  return Buffer.concat([document.bom, bytes]);
}
function uniqueIndex(text, quote, label) {
  const index = text.indexOf(quote);
  if (index < 0 || text.indexOf(quote, index + 1) >= 0) stop(label + ' must match one unique exact anchor.');
  return index;
}
// Canonical LF indexes map back to the original string without rewriting unrelated CRLF/mixed text.
function rawOffset(text, index) {
  let raw = 0, normalized = 0;
  while (normalized < index) { raw += text[raw] === '\r' && text[raw + 1] === '\n' ? 2 : 1; normalized++; }
  return raw;
}
function currentFindings(root) {
  const findings = readCheckup(root);
  if (!findings.state || findings.scoped_fresh !== true || findings.runtime_evidence_freshness !== 'not_run') stop('Checkup findings are missing, stale, or include unbound runtime evidence. Run checkup and reconcile first.');
  const seen = new Set(), claims = new Map();
  for (const observation of findings.state.observations) {
    const identity = observation.location + '\0' + observation.claim;
    if (seen.has(identity)) stop('Duplicate checkup findings require reconciliation.');
    seen.add(identity);
    if (claims.has(observation.claim) && claims.get(observation.claim) !== observation.status) stop('Contradictory checkup observations require reconciliation.');
    claims.set(observation.claim, observation.status);
  }
  return findings;
}
function commandSources(root, text, expectedWrong = false) {
  const identities = [];
  for (const match of text.matchAll(/\bnode\s+["']?((?:[\w.-]+\/)+[\w.-]+\.m?js)\b/g)) {
    const source = inspectSources(root, [match[1]])[0];
    if ((source.hash === 'new') !== expectedWrong) stop('The literal command evidence contradicts the proposed change.');
    identities.push(source);
  }
  for (const match of text.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:-]+)/g)) {
    const bytes = readBytes(root, 'package.json');
    const manifest = bytes ? parseProjectJson(bytes, 'package.json') : {};
    const exists = typeof manifest?.scripts?.[match[1]] === 'string';
    if (exists === expectedWrong) stop('The declared command evidence contradicts the proposed change.');
    identities.push({ path: 'package.json', hash: exactHash(bytes) });
  }
  return identities;
}
const reviewHash = review => { const { review_hash, ...payload } = review; return exactHash(Buffer.from(JSON.stringify(payload))); };

export function reviewRefresh(root, input) {
  keys(input, ['target', 'hunks'], 'refresh request'); targetAllowed(input.target);
  if (!Array.isArray(input.hunks) || !input.hunks.length || input.hunks.length > 8) stop('Choose one to eight minimal hunks for one file.');
  const findings = currentFindings(root), original = readBytes(root, input.target), document = decode(original, input.target), text = canonical(document.text);
  const edits = [], dependencies = new Set([RECORD, ...findings.state.source.scope.filter(path => path !== input.target)]);
  const sourceHashes = new Map([[RECORD, findings.etag]]);
  const registerSources = identities => {
    for (const identity of identities) {
      if (sourceHashes.has(identity.path) && sourceHashes.get(identity.path) !== identity.hash) stop('A source changed during instruction review.');
      sourceHashes.set(identity.path, identity.hash); dependencies.add(identity.path);
    }
  };
  const metadata = [];
  for (const hunk of input.hunks) {
    keys(hunk, ['before', 'after', 'finding', 'sources'], 'hunk'); keys(hunk.finding, ['location', 'claim'], 'finding link');
    shortText(hunk.before, 'before text'); shortText(hunk.after, 'replacement text'); shortText(hunk.finding.location, 'finding location'); shortText(hunk.finding.claim, 'finding claim');
    const before = canonical(hunk.before), after = canonical(hunk.after);
    if (before === after) stop('Duplicate or unchanged hunks are unnecessary.');
    if (before !== hunk.finding.claim || before.includes('\n') || before.includes('\r')) stop('A minimal hunk may replace only its exact single-line finding claim; preserve surrounding custom text.');
    const start = uniqueIndex(text, before, 'Each hunk'), line = text.slice(0, start).split('\n').length;
    const observations = findings.state.observations.filter(o => o.location === hunk.finding.location && o.claim === hunk.finding.claim);
    if (observations.length !== 1 || observations[0].status !== 'WRONG') stop('Each hunk needs one current WRONG finding at its exact location.');
    const location = input.target + ':' + line;
    if (hunk.finding.location !== location || !before.includes(hunk.finding.claim)) stop('The finding location and claim must match the exact target line and hunk.');
    registerSources(commandSources(root, hunk.finding.claim, true));
    if (!Array.isArray(hunk.sources) || !hunk.sources.length || hunk.sources.length > 4) stop('Each hunk needs one to four exact quoted sources.');
    const paths = hunk.sources.map(source => { keys(source, ['path', 'quote'], 'source quote'); shortText(source.quote, 'source quote'); return source.path; });
    if (new Set(paths).size !== paths.length) stop('Duplicate source links require reconciliation.');
    const identities = inspectSources(root, paths), links = [];
    registerSources(identities);
    let supported = false;
    for (let index = 0; index < hunk.sources.length; index++) {
      const source = hunk.sources[index], quote = canonical(source.quote), sourceBytes = readBytes(root, source.path);
      if (exactHash(sourceBytes) !== identities[index].hash) stop('A quoted source changed during instruction review.');
      const sourceText = canonical(decode(sourceBytes, source.path).text);
      const sourceIndex = uniqueIndex(sourceText, quote, 'Source quote');
      // Require a complete source line or a complete inline command, never a word fragment.
      if (quote.includes(after) && (('\n' + sourceText + '\n').includes('\n' + after + '\n') ||
        (/^(?:node\s|(?:npm|pnpm|yarn)\s+run\s)/.test(after) && sourceText.includes('`' + after + '`')))) supported = true;
      if (findings.state.observations.some(o => o.location.startsWith(source.path + ':') && o.status !== 'VERIFIED' && quote.includes(o.claim))) stop('A selected source contradicts the replacement or remains UNVERIFIED.');
      registerSources(commandSources(root, quote));
      links.push({ ...source, line: sourceText.slice(0, sourceIndex).split('\n').length, hash: identities[index].hash });
    }
    if (!supported) stop('The exact replacement needs support in a quoted source.');
    registerSources(commandSources(root, after));
    if (edits.some(edit => start < edit.end && start + before.length > edit.start)) stop('Duplicate or overlapping hunks require reconciliation.');
    edits.push({ start, end: start + before.length, after });
    metadata.push({ before, after, finding: { ...hunk.finding }, sources: links });
  }
  let result = document.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const start = rawOffset(document.text, edit.start), end = rawOffset(document.text, edit.end);
    const matched = document.text.slice(start, end), eol = matched.includes('\r\n') || (!matched.includes('\n') && document.text.includes('\r\n')) ? '\r\n' : '\n';
    result = result.slice(0, start) + edit.after.replaceAll('\n', eol) + result.slice(end);
  }
  dependencies.delete(input.target);
  // Validate and hash all bounded sources before creating a shared zero-write proposal.
  const sourcePaths = [...dependencies].sort(); inspectSources(root, sourcePaths);
  const change = reviewChange(root, { kind: 'instructions', target: input.target, content: encode(document, result), dependencies: sourcePaths });
  if (change.before_hash !== exactHash(original) || change.dependencies.some(source => sourceHashes.has(source.path) && sourceHashes.get(source.path) !== source.hash)) stop('The target or a source changed during instruction review.');
  const finalFindings = currentFindings(root);
  if (finalFindings.etag !== findings.etag || finalFindings.state.source.fingerprint !== findings.state.source.fingerprint) stop('Checkup or its sources changed during instruction review.');
  // Render whole changed lines from the actual before/after texts, including surrounding prose.
  const beforeLines = text.split('\n'), afterLines = canonical(result).split('\n');
  const changedLines = [...new Set(edits.flatMap(edit => {
    const first = text.slice(0, edit.start).split('\n').length - 1;
    return [first];
  }))].sort((a, b) => a - b);
  // Replacements may span lines, so carry the cumulative line offset for later hunks.
  let offset = 0;
  const diffHunks = changedLines.map(line => {
    const added = edits.filter(edit => text.slice(0, edit.start).split('\n').length - 1 === line)
      .reduce((n, edit) => n + edit.after.split('\n').length - 1, 0);
    const next = line + offset, after = afterLines.slice(next, next + added + 1);
    offset += added;
    return '@@ -' + (line + 1) + ',1 +' + (next + 1) + ',' + after.length + ' @@\n-' + beforeLines[line] + '\n' + after.map(value => '+' + value).join('\n');
  });
  const diff = '--- ' + input.target + '\n+++ ' + input.target + '\n' + diffHunks.join('\n') + '\n';
  const review = { schema_version: 1, change, hunks: metadata, findings_hash: findings.etag, source_fingerprint: findings.state.source.fingerprint, diff };
  review.review_hash = reviewHash(review);
  return review;
}
export function saveRefresh(root, review, hash, approved = false) {
  if (approved !== true) stop('Explicit user approval is required for this exact instruction save.');
  keys(review, ['schema_version', 'change', 'hunks', 'findings_hash', 'source_fingerprint', 'diff', 'review_hash'], 'refresh review');
  if (review.schema_version !== 1 || hash !== review.review_hash || reviewHash(review) !== hash || review.change?.kind !== 'instructions') stop('The instruction review changed. Review it again.');
  targetAllowed(review.change.target);
  if (exactHash(readBytes(root, RECORD)) !== review.findings_hash) stop('Checkup findings changed since review.');
  if (exactHash(readBytes(root, review.change.target)) !== review.change.after_hash) {
    const findings = currentFindings(root);
    if (findings.state.source.fingerprint !== review.source_fingerprint) stop('The checkup source changed since review.');
    if (!Array.isArray(review.hunks)) stop('Invalid reviewed hunks.');
    const reconstructed = reviewRefresh(root, { target: review.change.target, hunks: review.hunks.map(hunk => ({ before: hunk.before, after: hunk.after, finding: hunk.finding, sources: hunk.sources.map(source => ({ path: source.path, quote: source.quote })) })) });
    for (const field of ['kind', 'target', 'before_hash', 'after_hash', 'content_base64', 'dependencies']) if (JSON.stringify(reconstructed.change[field]) !== JSON.stringify(review.change[field])) stop('The reviewed change does not match its exact source-backed hunks.');
    if (reconstructed.diff !== review.diff || JSON.stringify(reconstructed.hunks) !== JSON.stringify(review.hunks) || reconstructed.findings_hash !== review.findings_hash || reconstructed.source_fingerprint !== review.source_fingerprint) stop('The reviewed diff and source links do not match their reconstructed hunks.');
  }
  return applyChange(root, review.change, review.change.review_hash, true);
}
export const undoRefresh = (root, backup, expected, approved = false) => undoChange(root, backup, expected, approved);
export const reviewUndoRefresh = (root, backup) => reviewUndo(root, backup);

// Validate references as they will resolve after selected packs are installed, never against
// private factory source files. Self-contained packs have no external local dependencies.
export function auditCatalogPacks(bundleRoot) {
  const catalogPath = readBytes(bundleRoot, 'catalog.json') ? 'catalog.json' : '.claude-plugin/catalog.json';
  const catalog = parseProjectJson(readBytes(bundleRoot, catalogPath), catalogPath);
  if (!Array.isArray(catalog?.entries)) stop('Invalid catalog entries.');
  const packs = catalog.entries.filter(entry => entry.kind === 'rule-pack' && !entry.tombstoned), installed = new Set(packs.map(pack => pack.install?.target));
  if (new Set(packs.map(pack => pack.id)).size !== packs.length || installed.size !== packs.length) stop('Duplicate catalog packs or targets.');
  return packs.map(pack => {
    if (!pack.install || typeof pack.install.source !== 'string' || typeof pack.install.target !== 'string' || !/^docs\/rules-reference\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(pack.install.target)) stop('Invalid catalog reference target.');
    inspectSources(bundleRoot, [pack.install.source]);
    const body = decode(readBytes(bundleRoot, pack.install.source), pack.install.source).text;
    const audience = body.match(/^Audience:\s*(.+)$/m)?.[1];
    if (!audience || /VIBE Rule|SS\d|\bDMG\b|auto-loaded global rule|auditor agent veto|VibePromptRig projects/.test(body)) stop('Pack audience still assumes private factory rules: ' + pack.id + '.');
    const references = [...new Set([
      ...[...body.matchAll(/\[[^\]]*\]\(([^)]+)\)|`([^`\n]+\.md(?:#[^`\n]+)?)`/g)].map(match => match[1] || match[2]),
      ...[...body.matchAll(/(?:^|[\s`("'\[])((?:[\w.-]+\/)*[\w.-]+\.md(?:#[\w.-]+)?)/gm)].map(match => match[1]),
    ])];
    for (const reference of references) {
      if (/^(?:https?:|#)/.test(reference)) continue;
      if (/[:\\]/.test(reference) || reference.startsWith('/')) stop('Invalid pack reference: ' + pack.id + '.');
      const target = posix.normalize(posix.join(posix.dirname(pack.install.target), reference.split('#')[0]));
      if (!installed.has(target)) stop('Missing installed pack reference: ' + pack.id + ' -> ' + reference + '.');
    }
    return { id: pack.id, source: pack.install.source, target: pack.install.target, audience, references };
  });
}
export function main(args, root = process.cwd(), input) {
  const [action, ...rest] = args;
  if (action === 'review' && !rest.length && input) return JSON.stringify(reviewRefresh(root, parseProjectJson(input, 'reviewed instruction hunks')), null, 2) + '\n';
  if (action === 'save' && rest.length === 2 && rest[1] === '--approved' && input) return JSON.stringify(saveRefresh(root, parseProjectJson(input, 'reviewed instruction proposal'), rest[0], true), null, 2) + '\n';
  if (action === 'undo' && rest.length === 3 && rest[2] === '--approved') return JSON.stringify(undoRefresh(root, rest[0], rest[1], true), null, 2) + '\n';
  if (action === 'review-undo' && rest.length === 1) return JSON.stringify(reviewUndoRefresh(root, rest[0]), null, 2) + '\n';
  if (action === 'audit-packs' && !rest.length) return JSON.stringify(auditCatalogPacks(resolve(fileURLToPath(new URL('../..', import.meta.url)))), null, 2) + '\n';
  stop('Use review (hunks JSON on stdin), save <review-hash> --approved (review JSON on stdin), review-undo <backup>, undo <backup> <undo-hash> --approved, or audit-packs.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const chunks = []; let size = 0;
    if (!process.stdin.isTTY && ['review', 'save'].includes(process.argv[2])) for await (const chunk of process.stdin) {
      size += chunk.length; if (size > LIMIT * 3) stop('Keep the reviewed instruction proposal bounded.'); chunks.push(chunk);
    }
    process.stdout.write(main(process.argv.slice(2), process.cwd(), chunks.length ? Buffer.concat(chunks) : undefined));
  } catch (error) {
    process.stderr.write('Instruction refresh could not continue: ' + (error instanceof ProjectJsonError ? error.message : error.code ? 'The project file operation failed. Nothing was changed; preserve the project and recovery files for review.' : error.message) + '\n');
    process.exitCode = 1;
  }
}
