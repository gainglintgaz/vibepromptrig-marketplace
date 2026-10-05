#!/usr/bin/env node
// dashboard.mjs -- a tight, live "where things stand" status table in the TERMINAL.
// The engine behind the /dashboard slash command. Node twin of dashboard.ps1 (cross-platform
// port P2). Dependency-free (Node stdlib), Node >= 18, ESM, LF, UTF-8 no BOM.
//
// REUSES scripts/cockpit.mjs (gatherCockpit) as the single source of status truth (VIBE Rule 16 --
// reuse before build); this script only FORMATS that data into a compact terminal view and layers
// the customer's display preferences on top. It does NOT duplicate cockpit's aggregation.
//
// cockpit.mjs is a FACTORY sibling found relative to THIS script's location via import.meta.url --
// NOT via FactoryRoot/VIBE_ROOT (the customer/data root). Resolving a sibling via VIBE_ROOT was a
// prior bug: forge subcommands broke under a plugin layout where VIBE_ROOT != script dir.
//
// HONESTY CONTRACT (inherited from cockpit.mjs -- never fake a number):
//   [MEASURED]   hard fact from git / factory_metrics / forge doctor.
//   [ESTIMATED]  derived, approximate -- labeled.
//   [DECLARED]   human-set in .forge/cockpit.json -- labeled.
//   [NOT-TRACKED] not captured yet -- shown honestly, never guessed.
//   [PARTIAL]    events logged but no real cost captured -- never a fabricated $0.00 [MEASURED].

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import process from 'node:process';

// cockpit.mjs is imported as a SIBLING relative to this script's dir -- not FactoryRoot.
import { gatherCockpit } from './cockpit.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---- arg parsing (faithful: -Refresh/-Json/-Help and their --refresh/--json/--help twins) ----
const argv = process.argv.slice(2);
function hasFlag(...names) { return argv.some((a) => names.includes(a)); }
function flagValue(...names) {
  const i = argv.findIndex((a) => names.includes(a));
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const wantRefresh = hasFlag('-Refresh', '--refresh');
const wantJson = hasFlag('-Json', '--json');
const wantHelp = hasFlag('-Help', '--help', '-h');

// ---- FactoryRoot resolution: -FactoryRoot/--factory-root | VIBE_ROOT | dirname(scriptDir) ----
let FactoryRoot = flagValue('-FactoryRoot', '--factory-root') || process.env.VIBE_ROOT || dirname(here);

// ---- ANSI colors (terminal render only; suppressed when not a TTY or NO_COLOR set) ----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  Cyan: useColor ? '\x1b[36m' : '',
  Green: useColor ? '\x1b[32m' : '',
  Yellow: useColor ? '\x1b[33m' : '',
  DarkGray: useColor ? '\x1b[90m' : '',
  White: useColor ? '\x1b[37m' : '',
  reset: useColor ? '\x1b[0m' : '',
};
function show(s, color) {
  const c = color && C[color] !== undefined ? C[color] : '';
  process.stdout.write(`${c}${s}${c ? C.reset : ''}\n`);
}

// ---- Help ----
if (wantHelp) {
  process.stdout.write('\n');
  show('/dashboard -- VibePromptRig live status', 'Cyan');
  process.stdout.write('\n');
  show('  node scripts/dashboard.mjs [--refresh] [--json]');
  process.stdout.write('\n');
  show('  (default)   compact status table from a cached cockpit snapshot (fast).');
  show('  --refresh   re-run cockpit + forge doctor live (slower, fully current).');
  show('  --json      machine-readable dashboard model.');
  process.stdout.write('\n');
  show("  Configure what shows + the data source in the 'dashboard' block of");
  show('  .forge/cockpit.json (sections, data_source: terminal|mcp|both, refresh_cache_minutes).');
  process.stdout.write('\n');
  show('  Honesty labels: [MEASURED] hard fact | [ESTIMATED] derived | [DECLARED] human-set |');
  show('  [NOT-TRACKED] not captured yet (never guessed).');
  process.stdout.write('\n');
  show('  Full guide: docs/tutorials/dashboard.md', 'DarkGray');
  process.stdout.write('\n');
  process.exit(0);
}

// ---- Customer display config (the `dashboard` block in .forge/cockpit.json) ----
const cockpitJsonPath = join(FactoryRoot, '.forge', 'cockpit.json');
let cfgSections = ['status', 'goals', 'blockers', 'spend'];
let cfgDataSource = 'terminal';
let cfgCacheMin = 10;
if (existsSync(cockpitJsonPath)) {
  try {
    const cj = JSON.parse(readFileSync(cockpitJsonPath, 'utf8'));
    if (cj && cj.dashboard) {
      if (cj.dashboard.sections) cfgSections = [].concat(cj.dashboard.sections);
      if (cj.dashboard.data_source) cfgDataSource = String(cj.dashboard.data_source);
      if (cj.dashboard.refresh_cache_minutes !== null && cj.dashboard.refresh_cache_minutes !== undefined) {
        cfgCacheMin = parseInt(cj.dashboard.refresh_cache_minutes, 10);
        if (!Number.isFinite(cfgCacheMin)) cfgCacheMin = 10;
      }
    }
  } catch { /* malformed dashboard block -> fall back to defaults (cockpit goals still load below) */ }
}

// ---- Cache path (per-FactoryRoot, isolated; matches the PS hash-keyed temp file scheme) ----
function frHash(root) {
  // Stable 32-bit hash of the lower-cased root -> 8 hex digits (mirrors the PS cache-key intent:
  // one cache file per factory root; exact bytes need not match the .NET GetHashCode value).
  const s = String(root).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const cachePath = join(tmpdir(), `vibepromptrig-dashboard-cache-${frHash(FactoryRoot)}.json`);

let cacheAgeMin = null;
let cockpit = null;
let usedCache = false;

function getCockpitFresh() {
  const obj = gatherCockpit({ factoryRoot: FactoryRoot });
  // cache it (best-effort; never fatal)
  try { writeFileSync(cachePath, JSON.stringify(obj, null, 2), { encoding: 'utf8' }); } catch { /* ignore */ }
  return obj;
}

if (!wantRefresh && existsSync(cachePath)) {
  try {
    const st = statSync(cachePath);
    cacheAgeMin = Math.round(((Date.now() - st.mtimeMs) / 60000) * 10) / 10;
    if (cacheAgeMin <= cfgCacheMin) {
      cockpit = JSON.parse(readFileSync(cachePath, 'utf8'));
      usedCache = true;
    }
  } catch { cockpit = null; }
}

if (!cockpit) {
  try {
    cockpit = getCockpitFresh();
    cacheAgeMin = 0;
  } catch (e) {
    // Graceful degrade: cockpit could not run. Never crash; surface honestly.
    const detail = e && e.message ? e.message : String(e);
    if (wantJson) {
      process.stdout.write(JSON.stringify({ error: 'cockpit.mjs unavailable', detail, data_source: cfgDataSource }, null, 2) + '\n'); // small payload: fits the pipe buffer, flushes before the (control-flow-required) exit below
    } else {
      process.stdout.write('\n');
      show('VIBEPROMPTRIG DASHBOARD', 'Cyan');
      show(`  [NOT-TRACKED] cockpit.mjs could not run -- ${detail}`, 'Yellow');
      show('  Status data is unavailable right now. Try --refresh, or run scripts/cockpit.mjs directly.', 'DarkGray');
      process.stdout.write('\n');
    }
    process.exit(0);
  }
}

const m = cockpit.measured || {};
const d = cockpit.declared;

// ---- Spend -- data_source-aware (Tier 2 MCP-backed live data + graceful degrade) ----
// terminal (default, zero-setup -- Tier-1 estimated view, no MCP cost); mcp|both -- read the
// router's REAL ai_call provenance surfaced by cockpit as measured.ai_* fields. ai_call events
// exist -> [MEASURED]; absent / no events -> graceful fall to [NOT-TRACKED] (never crash, never fake).
const useMcpCost = cfgDataSource === 'mcp' || cfgDataSource === 'both';
const aiMeasured = useMcpCost && m.ai_measured === true;
const aiPartial = useMcpCost && m.ai_partial === true;

const spend = { data_source: cfgDataSource, mcp_backed: useMcpCost };

function fmt2(n) { return Number(n).toFixed(2); }

if (aiMeasured) {
  const dollars = fmt2(asNumber(m.ai_cost_cents_mtd) / 100);
  const anomCount = asNumber(m.ai_anomalies);
  const anom = anomCount > 0 ? ` (${m.ai_anomalies} event(s) with invalid cost excluded)` : '';
  spend.cost_label = '[MEASURED]';
  spend.cost_note = `$${dollars} month-to-date (${m.ai_calls_mtd} ai_call events via the router's provenance, A8)${anom}. Anthropic Console = billing source of truth.`;
  spend.tokens_label = '[MEASURED]';
  spend.tokens_note = `${m.ai_tokens_mtd} AI tokens month-to-date (ai_call provenance).`;
} else if (aiPartial) {
  // events were logged this month but none carried a valid cost -> honest PARTIAL, never a fake $0
  spend.cost_label = '[PARTIAL]';
  spend.cost_note = `${m.ai_calls_mtd} ai_call event(s) logged this month but none carried a valid cost -- not shown as $0.00 (that would be a fabricated number). Anthropic Console = source of truth.`;
  spend.tokens_label = '[MEASURED]';
  spend.tokens_note = `${m.ai_tokens_mtd} AI tokens month-to-date (cost unavailable for these events).`;
} else if (useMcpCost) {
  // MCP-backed mode requested, but the router has logged no ai_call events yet -> graceful degrade
  spend.cost_label = '[NOT-TRACKED]';
  spend.cost_note = `data_source=${cfgDataSource}, but the router has logged no ai_call events yet -- cost flips to [MEASURED] once agents dispatch through the router. Anthropic Console = source of truth.`;
  spend.tokens_label = m.last_context_tokens ? '[ESTIMATED]' : '[PARTIAL]';
  spend.tokens_note = m.last_context_tokens
    ? `~${m.last_context_tokens} tokens/msg (sporadic context-load measure); no ai_call totals yet`
    : 'no per-session totals yet';
} else {
  // terminal mode (default, zero-setup) -- the honest Tier-1 estimated view
  spend.cost_label = '[NOT-TRACKED]';
  spend.cost_note = "terminal mode -- Anthropic Console -> Usage is the source of truth. Set data_source=mcp in .forge/cockpit.json's dashboard block to surface real ai_call cost.";
  spend.tokens_label = m.last_context_tokens ? '[ESTIMATED]' : '[PARTIAL]';
  spend.tokens_note = m.last_context_tokens
    ? `~${m.last_context_tokens} tokens/msg (sporadic context-load measure)`
    : 'only sporadic context-load measures exist, not per-session totals';
}

// Guarded numeric coercion for display arithmetic (never NaN into a label, never sum a bad value).
function asNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- JSON mode ----
// Deliberately NO process.exit() after the write. On Unix a PIPE stdout is non-blocking, so
// process.exit() immediately after a large write() discards the unflushed tail at the pipe buffer
// (8KB on macOS < our ~16KB JSON) -- a spawnSync parent (test-factory, `forge dashboard`) then
// captured only the first 8192 bytes -> "missing contract fields". Letting the process end
// naturally lets Node drain stdout fully first (per the Node process.exit() docs). The else-branch
// keeps the terminal render from running after a --json emit.
if (wantJson) {
  process.stdout.write(JSON.stringify({
    used_cache: usedCache,
    cache_age_min: cacheAgeMin,
    data_source: cfgDataSource,
    sections: cfgSections,
    measured: m,
    declared: d,
    spend: spend,
  }, null, 2) + '\n');
} else {
  // ---- Terminal render ----
  const freshness = usedCache ? `cached ${cacheAgeMin}m ago -- --refresh for live` : 'live';
  process.stdout.write('\n');
  show('VIBEPROMPTRIG DASHBOARD', 'Cyan');
  show(`  (${freshness} | data_source: ${cfgDataSource})`, 'DarkGray');
  process.stdout.write('\n');

  if (cfgSections.includes('status')) {
    const doctorColor = /0 fail/i.test(String(m.doctor)) ? 'Green' : 'Yellow';
    show('WHERE THINGS STAND [MEASURED]', 'White');
    show(`  Branch:  ${m.branch} @ ${m.head}  "${m.head_subject}"`);
    show(`  Commits: ${m.total_commits} total | ${m.last7_commits} last 7d`);
    const doctorAge = usedCache ? ` (as of ${cacheAgeMin}m ago -- --refresh to recheck)` : '';
    show(`  Health:  forge doctor ${m.doctor}${doctorAge}`, doctorColor);
    show(`  Gates:   ${m.architect_probes} architect-probes | ${m.arch_gates} arch-gates (${m.gate_overrides} overrides)`, 'DarkGray');
    process.stdout.write('\n');
  }

  if (cfgSections.includes('goals') && d && d.goals) {
    show('GOALS + MILESTONES [DECLARED]', 'White');
    for (const g of d.goals) {
      show(`  ${g.title} -- ${g.percent_complete}%`, 'Cyan');
      if (g.milestones) {
        const all = [].concat(g.milestones);
        const open = all.filter((ms) => !/^done/i.test(String(ms.status)));
        const doneCount = all.length - open.length;
        show(`    ${doneCount}/${all.length} milestones done; open:`, 'DarkGray');
        for (const ms of open.slice(0, 6)) {
          let st = String(ms.status);
          if (st.length > 64) st = st.slice(0, 61) + '...';
          show(`      - ${ms.name}  (${st})`);
        }
        if (open.length > 6) show(`      ... +${open.length - 6} more open`, 'DarkGray');
      }
    }
    process.stdout.write('\n');
  }

  if (cfgSections.includes('blockers') && d && d.blockers) {
    show('BLOCKERS [DECLARED]', 'White');
    for (const b of d.blockers) show(`  - ${b}`, 'Yellow');
    process.stdout.write('\n');
  }

  if (cfgSections.includes('spend')) {
    show('SPEND (HONEST LIMITS)', 'White');
    show(`  Dollar cost: ${spend.cost_label} ${spend.cost_note}`, 'DarkGray');
    show(`  Tokens:      ${spend.tokens_label} ${spend.tokens_note}`, 'DarkGray');
    process.stdout.write('\n');
  }

  show("  /dashboard --refresh for live | edit .forge/cockpit.json 'dashboard' block to customize | docs/tutorials/dashboard.md", 'DarkGray');
  process.stdout.write('\n');
}
