#!/usr/bin/env node
// init.mjs -- Node twin of init.ps1 (cross-platform port P2, must-port set).
// forge init: interactive profile wizard for the current project. Asks plain-English questions
// (AI plan + project kind), recommends a preset from the combo, then writes .forge/profile.json by
// delegating to `profile.mjs set <name>` (reusing its preset-copy + date-stamp + AGENTS-variant
// activation) and stamping `ai_plan` into the result.
//
// Non-interactive:  forge init --profile solo-pro --plan claude-pro --no-prompt
//
// The interactive prompts use node:readline but are ALSO headless-drivable: answers are read from
// piped stdin line by line, so a test can run the wizard without a TTY. When stdin is not a TTY and
// no piped answers are available, the wizard exits cleanly with guidance instead of hanging.
//
// Dependency-free (Node stdlib only), node:path throughout, ESM, Node >= 18. UTF-8 (no BOM), LF.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as readlineModule from 'node:readline';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const FactoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));
const ProjectRoot = process.cwd();
const PresetsDir = join(FactoryRoot, '.forge', 'profiles');
const ProjectProfile = join(ProjectRoot, '.forge', 'profile.json');
const TranslationsPath = join(FactoryRoot, '.forge', 'plan-translations.json');
const ProfileScript = join(here, 'profile.mjs'); // sibling -- resolve via own dir, NOT VIBE_ROOT (which may point elsewhere)

// ----------------------------------------------------------------
// Argument parsing -- mirror init.ps1's token reparse.
// Tolerate --flag style + bare positionals; bare positionals land in Profile then Plan.
// ----------------------------------------------------------------
let Profile = '';
let Plan = '';
let NoPrompt = false;
let Force = false;

{
  const tokens = process.argv.slice(2);
  let i = 0;
  while (i < tokens.length) {
    const a = String(tokens[i]);
    let m;
    if (/^--no-prompt$/i.test(a)) { NoPrompt = true; }
    else if (/^--force$/i.test(a)) { Force = true; }
    else if ((m = a.match(/^--profile=(.+)$/i))) { Profile = m[1]; }
    else if ((m = a.match(/^--plan=(.+)$/i))) { Plan = m[1]; }
    else if (/^--profile$/i.test(a)) {
      if (i + 1 < tokens.length) { Profile = String(tokens[i + 1]); i++; }
    }
    else if (/^--plan$/i.test(a)) {
      if (i + 1 < tokens.length) { Plan = String(tokens[i + 1]); i++; }
    }
    else {
      // Bare positional value (no leading --) lands in Profile then Plan.
      if (!Profile && !/^--/.test(a)) Profile = a;
      else if (!Plan && !/^--/.test(a)) Plan = a;
    }
    i++;
  }
}

// ----------------------------------------------------------------
// Recommendation matrix: (plan, project_kind) -> preset
// ----------------------------------------------------------------
function getPlanTier(planKey) {
  switch (planKey) {
    case 'claude-free': return 'free';
    case 'cursor-free': return 'free';
    case 'codex-free': return 'free';
    case 'claude-pro': return 'pro';
    case 'cursor-pro': return 'pro';
    case 'codex-paid': return 'pro';
    case 'claude-max': return 'heavy';
    case 'cursor-business': return 'heavy';
    case 'api-direct': return 'api';
    case 'byok': return 'api';
    default: return 'pro';
  }
}

function getRecommendedPreset(planKey, kind) {
  const tier = getPlanTier(planKey);
  switch (`${tier}|${kind}`) {
    case 'free|simple': return 'indie-free';
    case 'free|multi': return 'indie-free';
    case 'free|production': return 'solo-pro';
    case 'free|agency': return 'solo-pro';
    case 'free|regulated': return 'senior-dev';
    case 'pro|simple': return 'solo-pro';
    case 'pro|multi': return 'solo-pro';
    case 'pro|production': return 'senior-dev';
    case 'pro|agency': return 'agency';
    case 'pro|regulated': return 'enterprise';
    case 'heavy|simple': return 'solo-pro';
    case 'heavy|multi': return 'senior-dev';
    case 'heavy|production': return 'senior-dev';
    case 'heavy|agency': return 'agency';
    case 'heavy|regulated': return 'enterprise';
    case 'api|simple': return 'solo-pro';
    case 'api|multi': return 'senior-dev';
    case 'api|production': return 'senior-dev';
    case 'api|agency': return 'agency';
    case 'api|regulated': return 'enterprise';
    default: return 'solo-pro';
  }
}

// ----------------------------------------------------------------
// Validation helpers
// ----------------------------------------------------------------
function testPresetExists(name) {
  return existsSync(join(PresetsDir, `${name}.json`));
}

function testPlanKnown(key) {
  if (!existsSync(TranslationsPath)) return true; // tolerate missing file
  try {
    const t = JSON.parse(readFileSync(TranslationsPath, 'utf8'));
    return !!(t && t.plans && Object.prototype.hasOwnProperty.call(t.plans, key) && t.plans[key] != null);
  } catch {
    return true; // tolerate unparseable file, matching the .ps1's lenient posture
  }
}

// ----------------------------------------------------------------
// Apply: write profile (via profile.mjs set) + stamp ai_plan
// ----------------------------------------------------------------
function applyProfile(presetName, planKey) {
  // Delegate to the profile twin's `set` -- reuses its preset-copy, date-stamp, and AGENTS-variant
  // activation, and prints the same "Profile set" output. Exit code propagates.
  const r = spawnSync(process.execPath, [ProfileScript, 'set', presetName], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  if (code !== 0) process.exit(code);

  // Stamp ai_plan into the freshly-written profile.json.
  if (planKey && existsSync(ProjectProfile)) {
    const p = JSON.parse(readFileSync(ProjectProfile, 'utf8'));
    p.ai_plan = planKey;
    writeFileSync(ProjectProfile, JSON.stringify(p, null, 2) + '\n');
  }
}

// ----------------------------------------------------------------
// ANSI color helpers (match the .ps1's Write-Host color intent; honest plain text on no-color TTYs).
// ----------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  cyan: (s) => useColor ? `\x1b[36m${s}\x1b[0m` : s,
  green: (s) => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  red: (s) => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: (s) => useColor ? `\x1b[33m${s}\x1b[0m` : s,
  gray: (s) => useColor ? `\x1b[90m${s}\x1b[0m` : s,
  white: (s) => useColor ? `\x1b[37m${s}\x1b[0m` : s,
};
function out(s = '') { process.stdout.write(s + '\n'); }
function err(s = '') { process.stderr.write(s + '\n'); }

// ----------------------------------------------------------------
// Non-interactive path
// ----------------------------------------------------------------
if (NoPrompt) {
  if (!Profile) {
    err('forge init --no-prompt requires --profile <name>');
    process.exit(1);
  }
  if (!testPresetExists(Profile)) {
    out('');
    out(C.red(`Unknown preset: ${Profile}`));
    out(C.gray('Available: indie-free, solo-pro, senior-dev, agency, enterprise'));
    out('');
    process.exit(1);
  }
  if (Plan && !testPlanKnown(Plan)) {
    out(C.yellow(`Warning: '${Plan}' is not in plan-translations.json. Recording anyway.`));
  }
  if (existsSync(ProjectProfile) && !Force) {
    err(`Profile already exists at ${ProjectProfile}. Re-run with --force to overwrite.`);
    process.exit(1);
  }
  applyProfile(Profile, Plan);
  process.exit(0);
}

// ----------------------------------------------------------------
// Interactive path -- node:readline, but headless-drivable from piped stdin.
// ----------------------------------------------------------------

// Pre-read any piped (non-TTY) stdin synchronously, split into answer lines. If stdin IS a TTY we
// read interactively via readline. If it's piped/empty we consume from this buffer; once exhausted
// with no TTY, we stop (never hang).
let pipedLines = null; // null => TTY interactive; array => headless answers queue
let pipedIdx = 0;
const stdinIsTTY = process.stdin.isTTY === true;

if (!stdinIsTTY) {
  let raw = '';
  try {
    // fd 0 read; on an empty/closed pipe this returns '' rather than blocking.
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  pipedLines = raw.length ? raw.replace(/\r\n/g, '\n').split('\n') : [];
  // Drop a single trailing empty element from a final newline so it isn't read as a blank answer.
  if (pipedLines.length && pipedLines[pipedLines.length - 1] === '') pipedLines.pop();
}

// Lazily-created readline interface (only when interactive).
let rl = null;
function getRl() {
  if (!rl) {
    // Import synchronously is not possible at top here; readline is stdlib and already imported below.
    rl = readlineModule.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  }
  return rl;
}

// Sentinel returned when no more input is available in headless mode.
const NO_INPUT = Symbol('no-input');

function askInteractive(prompt) {
  return new Promise((resolve) => {
    const iface = getRl();
    iface.question(prompt, (answer) => resolve(answer));
  });
}

async function ask(prompt) {
  if (pipedLines !== null) {
    // Headless: echo the prompt (so transcripts/tests show context) and pull the next queued line.
    process.stdout.write(prompt);
    if (pipedIdx < pipedLines.length) {
      const line = pipedLines[pipedIdx++];
      process.stdout.write(line + '\n');
      return line;
    }
    process.stdout.write('\n');
    return NO_INPUT;
  }
  return askInteractive(prompt);
}

function closeRl() { if (rl) { rl.close(); rl = null; } }

function bailNoInput() {
  out('');
  out(C.yellow('No input available (stdin not a TTY and no answers piped).'));
  out(C.gray('Run interactively, or use: forge init --profile <name> [--plan <plan>] --no-prompt'));
  out('');
  closeRl();
  process.exit(0);
}

async function main() {
  out('');
  out(C.cyan('forge init -- profile wizard'));
  out(C.gray(`  Project: ${ProjectRoot}`));
  out('');

  if (existsSync(ProjectProfile) && !Force) {
    out(C.yellow('A profile already exists at:'));
    out(C.gray(`  ${ProjectProfile}`));
    out('');
    const resp = await ask('Overwrite? (y/N): ');
    if (resp === NO_INPUT) return bailNoInput();
    if (!/^[yY]/.test(resp)) {
      out(C.gray("Cancelled. Run 'forge profile show' to see current config."));
      out('');
      closeRl();
      process.exit(0);
    }
  }

  // ---- Question 1: AI plan ----
  out(C.white('1) What\'s your AI plan?'));
  out('');
  const planChoices = [
    { Key: 'claude-free', Label: 'Claude Free ($0/mo)' },
    { Key: 'claude-pro', Label: 'Claude Pro ($20/mo)' },
    { Key: 'claude-max', Label: 'Claude Max ($100-200/mo)' },
    { Key: 'cursor-free', Label: 'Cursor Free ($0/mo)' },
    { Key: 'cursor-pro', Label: 'Cursor Pro ($20/mo)' },
    { Key: 'cursor-business', Label: 'Cursor Business ($40/user/mo)' },
    { Key: 'codex-free', Label: 'Codex CLI Free ($0/mo)' },
    { Key: 'codex-paid', Label: 'Codex CLI Paid (pay-per-use)' },
    { Key: 'api-direct', Label: 'Direct API billing (Anthropic/OpenAI/Gemini)' },
    { Key: 'byok', Label: 'Bring Your Own Key (managed for clients)' },
  ];
  for (let i = 0; i < planChoices.length; i++) {
    // "  {0,2})  {1}" -- right-align the index in a 2-wide field.
    out(C.gray(`  ${String(i + 1).padStart(2)})  ${planChoices[i].Label}`));
  }
  out('');
  let planIdx = 0;
  for (;;) {
    const resp = await ask(`Pick 1-${planChoices.length}: `);
    if (resp === NO_INPUT) return bailNoInput();
    if (/^\d+$/.test(resp) && parseInt(resp, 10) >= 1 && parseInt(resp, 10) <= planChoices.length) {
      planIdx = parseInt(resp, 10) - 1;
      break;
    }
    out(C.yellow(`  Please enter a number from 1 to ${planChoices.length}.`));
  }
  const planKey = planChoices[planIdx].Key;
  const planLabel = planChoices[planIdx].Label;

  // ---- Question 2: project kind ----
  out('');
  out(C.white('2) What\'s the project like?'));
  out('');
  const kindChoices = [
    { Key: 'simple', Label: 'Simple side-project or prototype' },
    { Key: 'multi', Label: 'Multi-feature app, still small' },
    { Key: 'production', Label: 'Production app with real users' },
    { Key: 'agency', Label: 'Agency / multi-client work' },
    { Key: 'regulated', Label: 'Regulated (fintech, healthcare, legal, compliance-heavy)' },
  ];
  for (let i = 0; i < kindChoices.length; i++) {
    out(C.gray(`  ${i + 1})  ${kindChoices[i].Label}`));
  }
  out('');
  let kindIdx = 0;
  for (;;) {
    const resp = await ask(`Pick 1-${kindChoices.length}: `);
    if (resp === NO_INPUT) return bailNoInput();
    if (/^\d+$/.test(resp) && parseInt(resp, 10) >= 1 && parseInt(resp, 10) <= kindChoices.length) {
      kindIdx = parseInt(resp, 10) - 1;
      break;
    }
    out(C.yellow(`  Please enter a number from 1 to ${kindChoices.length}.`));
  }
  const kindKey = kindChoices[kindIdx].Key;
  const kindLabel = kindChoices[kindIdx].Label;

  // ---- Recommendation ----
  const recommended = getRecommendedPreset(planKey, kindKey);

  out('');
  out(C.cyan('Recommendation'));
  out(C.gray(`  AI plan:       ${planLabel}`));
  out(C.gray(`  Project kind:  ${kindLabel}`));
  out(C.green(`  Profile:       ${recommended}`));
  out('');

  // ---- Confirm ----
  const resp = await ask('Apply this profile? (Y/n, or type a different preset name): ');
  if (resp === NO_INPUT) return bailNoInput();
  let chosen = recommended;
  if (/^[nN]/.test(resp)) {
    out(C.gray('Cancelled. No profile written.'));
    out('');
    closeRl();
    process.exit(0);
  } else if (resp && !/^[yY]/.test(resp)) {
    if (!testPresetExists(resp)) {
      out(C.red(`Unknown preset: ${resp}`));
      out(C.gray('Available: indie-free, solo-pro, senior-dev, agency, enterprise'));
      out('');
      closeRl();
      process.exit(1);
    }
    chosen = resp;
  }

  // applyProfile spawns profile.mjs with stdio:inherit, so close our readline first to release stdin.
  closeRl();
  applyProfile(chosen, planKey);

  out('');
  out(C.gray('Next:'));
  out(C.gray('  forge profile show     # see effective config'));
  out(C.gray('  forge rule list        # see active rules'));
  out(C.gray('  forge doctor           # verify factory health'));
  out('');
  process.exit(0);
}

main().catch((e) => {
  err(`forge init: ${e && e.message ? e.message : e}`);
  closeRl();
  process.exit(1);
});
