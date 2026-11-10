// portfolio-policy.mjs -- Card04 S5-A: one strict validator for the runtime portfolio.json, used BEFORE any
// project is read, coordinated or written for. Pure decisions + read-only filesystem checks; it never writes.
// Justified: no existing helper validated enrollment; dispatch-lib.readPortfolio only coerces numbers (S5-B
// moves that consumer onto this module).
//
// Decisions (S5 brief, docs/plans/vpr-card04-s5-s8-build-briefs-2026-10-09.md):
//  - A root must be a non-blank, local, drive-qualified (Windows) or rooted (POSIX) path with no ".." segment.
//    UNC, \\?\ and \\.\ device/extended forms, rooted no-drive (\foo) and drive-relative (C:foo) are refused.
//  - The root must exist and be a directory. Native dev/ino identify it; realpath expands aliases.
//  - Every root/ancestor link is refused, including root-owned POSIX links. Link ownership alone does
//    not protect a link in a writable parent. Use canonical non-linked paths (for example /private/var).
//  - Duplicates (same canonical identity), case-fold collisions between different identities, and nesting in
//    either direction refuse EVERY entry involved. Lowercasing is never treated as proof of sameness.
//  - Top-level: only known keys; caps finite and positive, maxWorkers an integer 1-16, timezone accepted by
//    Intl (no host fallback). Any top-level error refuses the whole portfolio. Absent fields grant nothing.
//  - Identity can change after validation (TOCTOU): revalidate() must be called immediately before use.
import { lstatSync, realpathSync } from 'node:fs';
import { probeWindowsDrive } from './windows-drive-probe.mjs';
import path from 'node:path';

export const POLICY_VERSION = 's5-3-native-identity';
const TOP_KEYS = new Set(['projects', 'mode', 'capMinutes', 'maxWorkers', 'timezone']);
const ENTRY_KEYS = new Set(['stateRoot', 'id']);
const MODES = new Set(['shadow', 'execute']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_WORKERS = 16;

// Syntax only (no filesystem). Returns a refusal reason or null. `platform` lets every rule be tested anywhere.
export function rootSyntaxError(input, platform = process.platform) {
  if (typeof input !== 'string' || !input.trim()) return 'stateRoot must be a non-empty string';
  if (input !== input.trim()) return 'stateRoot has leading or trailing whitespace';
  if (input.includes('\0')) return 'stateRoot contains a NUL character';
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(input)) return 'UNC, \\\\?\\ and \\\\.\\ device or extended paths are not accepted';
    if (!/^[A-Za-z]:[\\/]/.test(input)) return /^[A-Za-z]:/.test(input) ? 'drive-relative path (C:foo) is not accepted' : 'path must start with a drive letter (C:\\...); rooted or relative paths are not accepted';
    if (/[\\/](\.\.)(?=[\\/]|$)/.test(input)) return 'stateRoot must not contain ".." segments';
    if (input.slice(3).split(/[\\/]+/).some(part => /[. ]$/.test(part))) return 'stateRoot segments must not end with a dot or space (Windows strips them)';
    return null;
  }
  if (!input.startsWith('/')) return 'stateRoot must be an absolute path';
  if (/\/\.\.(?=\/|$)/.test(input)) return 'stateRoot must not contain ".." segments';
  return null;
}

// DriveInfo.DriveType classifies the drive without opening the target directory.
// Recheck every time: drive mappings can change between enrollment and use.
function localDriveError(input) {
  const drive = input.slice(0, 2);
  try {
    const probe = () => probeWindowsDrive(drive);
    let result = probe();
    // A load spike may time out once; only a successful local classification grants access.
    if (result.error?.code === 'ETIMEDOUT') result = probe();
    const type = Number((result.stdout || '').trim());
    if (result.error || result.status !== 0 || ![2, 3, 5, 6].includes(type))
      return `stateRoot drive ${drive} is remote or its local drive type could not be established; refusing`;
  } catch {
    return `stateRoot drive ${drive} could not be classified; refusing`;
  }
  return null;
}

// Walk root-to-leaf using lstat before any operation that follows the full path.
function inspectComponents(p, platform) {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const abs = mod.resolve(p);
  const { root } = mod.parse(abs);
  const parts = abs.slice(root.length).split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
  let cur = root;
  let st = lstatSync(cur, { bigint: true });
  if (st.isSymbolicLink()) return { reason: `filesystem root of stateRoot ${p} is a link or junction` };
  for (let i = 0; i < parts.length; i += 1) {
    cur = mod.join(cur, parts[i]);
    st = lstatSync(cur, { bigint: true });
    if (st.isSymbolicLink()) return { reason: i === parts.length - 1
      ? `stateRoot ${p} is itself a link or junction`
      : `an ancestor of stateRoot ${p} is a link or junction (${cur})` };
    if (!st.isDirectory()) return { reason: `stateRoot ${p} is not a directory` };
  }
  return { st };
}

// Return canonical spelling AND lossless native device/inode identity.
export function inspectRoot(input, { platform = process.platform } = {}) {
  const syntax = rootSyntaxError(input, platform);
  if (syntax) return { reason: syntax };
  if (platform === 'win32') {
    const reason = localDriveError(input);
    if (reason) return { reason };
  }
  try {
    const checked = inspectComponents(input, platform);
    if (checked.reason) return checked;
    const { st } = checked;
    if (!st.isDirectory()) return { reason: `stateRoot ${input} is not a directory` };
    if (typeof st.dev !== 'bigint' || typeof st.ino !== 'bigint' || st.dev < 0n || st.ino <= 0n)
      return { reason: `stateRoot ${input} native identity is unavailable; refusing` };
    const canonical = realpathSync.native(input);
    const canonicalError = rootSyntaxError(canonical, platform);
    if (canonicalError) return { reason: `stateRoot canonical path refused: ${canonicalError}` };
    if (platform === 'win32' && canonical.slice(0, 2).toLowerCase() !== input.slice(0, 2).toLowerCase()) {
      const reason = localDriveError(canonical);
      if (reason) return { reason };
    }
    return { canonical, identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
  } catch (e) {
    return { reason: e.code === 'ENOENT' ? `stateRoot ${input} does not exist`
      : `stateRoot ${input} cannot be inspected (${e.code || e.message})` };
  }
}

// Pure: duplicate / case-fold / nested conflicts between canonical identities. Returns Map(index -> reason).
export function findConflicts(items, platform = process.platform) {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const out = new Map();
  const add = (i, r) => { if (!out.has(i)) out.set(i, r); };
  const inside = (base, p) => { const r = mod.relative(base, p); return r !== '' && r !== '..' && !r.startsWith(`..${mod.sep}`) && !mod.isAbsolute(r); };
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const A = items[a], B = items[b];
      let r = null;
      if (A.canonical === B.canonical) r = `duplicate of entry #${A.index + 1} and #${B.index + 1} (same folder ${A.canonical})`;
      else if (A.canonical.toLowerCase() === B.canonical.toLowerCase()) r = `entries #${A.index + 1} and #${B.index + 1} differ only by letter case; identity is ambiguous`;
      else if (inside(A.canonical, B.canonical) || inside(B.canonical, A.canonical)) r = `entries #${A.index + 1} and #${B.index + 1} are nested (one folder is inside the other)`;
      else if (A.id && B.id && A.id.toLowerCase() === B.id.toLowerCase()) r = `entries #${A.index + 1} and #${B.index + 1} use the same id "${A.id}"`;
      if (r) { add(A.index, r); add(B.index, r); }
    }
  }
  return out;
}

function topLevelErrors(doc) {
  const errors = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['portfolio.json must contain a JSON object'];
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  if (doc.projects !== undefined && !Array.isArray(doc.projects)) errors.push('"projects" must be an array');
  if (doc.mode !== undefined && !MODES.has(doc.mode)) errors.push(`"mode" must be "shadow" or "execute"`);
  if (doc.capMinutes !== undefined && !(typeof doc.capMinutes === 'number' && Number.isFinite(doc.capMinutes) && doc.capMinutes > 0)) errors.push('"capMinutes" must be a finite number greater than 0');
  if (doc.maxWorkers !== undefined && !(Number.isInteger(doc.maxWorkers) && doc.maxWorkers >= 1 && doc.maxWorkers <= MAX_WORKERS)) errors.push(`"maxWorkers" must be an integer from 1 to ${MAX_WORKERS}`);
  if (doc.timezone !== undefined && !resolveTimezone(doc.timezone)) errors.push('"timezone" is not a valid IANA time zone');
  return errors;
}

// Returns the resolved zone name, or null. No host-timezone fallback.
export function resolveTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}

// The single decision. Returns {errors, mode, entries:[{index,input,canonical,id}], refused:[{index,input,reason}], policy}.
export function validatePortfolio(doc, { platform = process.platform, inspect = inspectRoot } = {}) {
  const errors = topLevelErrors(doc);
  const policy = { version: POLICY_VERSION, capMinutes: doc?.capMinutes ?? null, maxWorkers: doc?.maxWorkers ?? null, timezone: errors.length ? null : resolveTimezone(doc?.timezone) };
  const list = Array.isArray(doc?.projects) ? doc.projects : [];
  const candidates = [], refused = [];
  list.forEach((x, index) => {
    const input = typeof x === 'string' ? x : (x && typeof x === 'object' && !Array.isArray(x) ? x.stateRoot : undefined);
    const shown = typeof input === 'string' ? input : '(missing)';
    if (!x || typeof x !== 'object' || Array.isArray(x)) { refused.push({ index, input: shown, reason: 'entry must be an object with explicit id and stateRoot; legacy strings are refused' }); return; }
    {
      const extra = Object.keys(x).filter((k) => !ENTRY_KEYS.has(k));
      if (extra.length) { refused.push({ index, input: shown, reason: `unknown field(s) ${extra.map((k) => `"${k}"`).join(', ')}` }); return; }
      if (!(typeof x.id === 'string' && ID.test(x.id))) { refused.push({ index, input: shown, reason: '"id" must be letters, digits, . _ - (max 64)' }); return; }
    }
    const syntax = rootSyntaxError(input, platform);
    if (syntax) { refused.push({ index, input: shown, reason: syntax }); return; }
    const found = inspect(input, { platform });
    if (found.reason) { refused.push({ index, input, reason: found.reason }); return; }
    candidates.push({ index, input, canonical: found.canonical, identity: found.identity, id: x.id });
  });
  const conflicts = findConflicts(candidates, platform);
  const entries = [];
  for (const c of candidates) {
    if (conflicts.has(c.index)) refused.push({ index: c.index, input: c.input, reason: conflicts.get(c.index) });
    else entries.push(c);
  }
  refused.sort((a, b) => a.index - b.index);
  // A top-level error refuses the whole portfolio: nothing is enrolled.
  if (errors.length) return { errors, mode: null, entries: [], refused: [...refused, ...entries.map((e) => ({ index: e.index, input: e.input, reason: 'portfolio refused (top-level errors)' }))].sort((a, b) => a.index - b.index), policy };
  return { errors, mode: doc?.mode ?? null, entries, refused, policy };
}

// Immediately before use: the same root must still pass the link checks and resolve to the same identity.
export function revalidate(entry, { platform = process.platform, inspect = inspectRoot } = {}) {
  const found = inspect(entry.input, { platform });
  if (found.reason) return found.reason;
  if (found.canonical !== entry.canonical) return `stateRoot ${entry.input} now resolves to ${found.canonical}, not ${entry.canonical}; refusing`;
  if (!entry.identity || !found.identity || entry.identity.dev !== found.identity.dev || entry.identity.ino !== found.identity.ino)
    return `stateRoot ${entry.input} native identity changed or is unavailable; refusing`;
  return null;
}
