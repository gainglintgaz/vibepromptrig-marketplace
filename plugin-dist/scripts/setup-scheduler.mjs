#!/usr/bin/env node
// setup-scheduler.mjs -- reads .forge/routines.json (THE source of truth) and registers ONE OS-native
// scheduled task per ENABLED routine that has a runnable local body (scripts/<name>.mjs) AND a cron
// schedule. cron on macOS/Linux, Task Scheduler (schtasks) on Windows -- each invoking
// `node scripts/<name>.mjs` LOCALLY, per docs/architecture/cross-platform-port-t3-schedulers.md
// (founder-approved 2026-06-14). Replaces the old hardcoded 3-job list -- add a routine to
// routines.json (with a matching scripts/<name>.mjs) and it registers automatically.
//
// NOT OS-scheduled (skipped with a printed note):
//   - agent routines with no local runner (synthesizer / tech-radar / outcome-tracker / schema-auditor)
//     -> they are Claude agents; they belong on cloud Routines. Tracked as a separate architect-probe:
//     docs/architecture/agent-routines-cloud-routines.md. forge doctor WARNs on them until then.
//   - event routines (schedule "stop-hook", e.g. debrief) -> fire via the Claude Stop hook, not the OS.
//   - disabled routines. restore-drill stays MANUAL (quarterly).
//
// This module is ALSO imported by scripts/forge/doctor.mjs for its scheduler health check, so the
// registration side effects run ONLY when it is invoked as the main script (guard at the bottom).
// Dependency-free, Node >= 18.
//
// Usage: node scripts/setup-scheduler.mjs            (registers triggers; Windows needs admin)
//        node scripts/setup-scheduler.mjs --dry-run  (prints the planned triggers; no side effects)

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));   // scripts/
const FACTORY_ROOT_DEFAULT = dirname(here);             // scripts/ -> repo root

export const CRON_MARKER = '# VibePromptRig-scheduler';

const DOW3 = { '0': 'SUN', '7': 'SUN', '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT' };
const DOW_NAME = { '0': 'Sundays', '7': 'Sundays', '1': 'Mondays', '2': 'Tuesdays', '3': 'Wednesdays', '4': 'Thursdays', '5': 'Fridays', '6': 'Saturdays' };
const pad2 = (n) => String(n).padStart(2, '0');

export function taskNameFor(routineName) { return `VibePromptRig-${routineName}`; }
export function catchupTaskNameFor(routineName) { return `${taskNameFor(routineName)}-startup-catchup`; }
// Task Scheduler does not inherit the interactive shell's PATH reliably. Use this running Node's
// absolute executable path; the backup script resolves its own factory root from its script path.
export function nodeCmd(scriptAbsPath, args = []) {
  return `"${process.execPath}" "${scriptAbsPath}"${args.length ? ` ${args.join(' ')}` : ''}`;
}

// Build the complete Unix crontab surface without reading or writing the live crontab. Keeping this
// pure makes path resolution and the @reboot catch-up contract testable on every CI operating system.
export function unixCrontabEntries(jobs) {
  const entries = jobs.map((j) => `${j.cron} ${nodeCmd(j.script)}  ${CRON_MARKER}:${j.taskName}`);
  const backup = jobs.find((j) => j.name === 'pg-dump-offsite');
  if (backup) {
    entries.push(`@reboot ${nodeCmd(backup.script, ['--startup-catchup'])}  ${CRON_MARKER}:${catchupTaskNameFor(backup.name)}`);
  }
  return entries;
}

// Parse a standard 5-field cron into {min,hour,dom,mon,dow}; null if it is not 5 fields.
function parseCron(cron) {
  if (typeof cron !== 'string') return null;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  return { min, hour, dom, mon, dow };
}

// cron -> schtasks flags. Returns { sc:[...], st:'HH:MM' } or null when it cannot map to ONE schtasks
// trigger (ranges/lists/steps, month-specific, both dom+dow set). Windows registration warns+skips null;
// cron itself (macOS/Linux) takes the raw expression verbatim, so those still register on Unix.
export function cronToSchtasks(cron) {
  const c = parseCron(cron);
  if (!c) return null;
  if (!/^\d{1,2}$/.test(c.min) || !/^\d{1,2}$/.test(c.hour)) return null; // need a concrete HH:MM
  if (c.mon !== '*') return null;
  const st = `${pad2(c.hour)}:${pad2(c.min)}`;
  if (c.dom === '*' && c.dow === '*') return { sc: ['DAILY'], st };
  if (c.dom === '*' && /^[0-7]$/.test(c.dow)) return { sc: ['WEEKLY', '/d', DOW3[c.dow]], st };
  if (c.dow === '*' && /^\d{1,2}$/.test(c.dom) && +c.dom >= 1 && +c.dom <= 31) return { sc: ['MONTHLY', '/d', c.dom], st };
  return null;
}

// cron -> nominal cadence in hours (24 daily / 168 weekly / 720 monthly); null when unknown.
export function cadenceHoursFromCron(cron) {
  const c = parseCron(cron);
  if (!c || c.mon !== '*') return null;
  if (c.dom === '*' && c.dow === '*') return 24;
  if (c.dom === '*' && /^[0-7]$/.test(c.dow)) return 168;
  if (c.dow === '*' && /^\d{1,2}$/.test(c.dom)) return 720;
  return null;
}

export function cronLabel(cron) {
  const c = parseCron(cron);
  if (!c) return cron;
  const t = /^\d{1,2}$/.test(c.hour) && /^\d{1,2}$/.test(c.min) ? `${pad2(c.hour)}:${pad2(c.min)}` : cron;
  if (c.mon === '*' && c.dom === '*' && c.dow === '*') return `daily at ${t}`;
  if (c.mon === '*' && c.dom === '*' && DOW_NAME[c.dow]) return `${DOW_NAME[c.dow]} at ${t}`;
  if (c.mon === '*' && c.dow === '*' && /^\d{1,2}$/.test(c.dom)) return `monthly on day ${c.dom} at ${t}`;
  return cron;
}

export function readRoutines(factoryRoot = FACTORY_ROOT_DEFAULT) {
  const p = join(factoryRoot, '.forge', 'routines.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Classify every routine in routines.json. The `schedulable` set is what setup-scheduler registers
// AND what forge doctor expects to find as OS tasks -- one predicate, two consumers (no drift).
export function resolveRoutinePlan(factoryRoot = FACTORY_ROOT_DEFAULT) {
  const doc = readRoutines(factoryRoot);
  const plan = {
    ok: !!(doc && Array.isArray(doc.routines)),
    routinesFile: join(factoryRoot, '.forge', 'routines.json'),
    schedulable: [], agentsNoRunner: [], eventRoutines: [], disabled: [],
  };
  if (!plan.ok) return plan;
  for (const r of doc.routines) {
    const name = r.name;
    if (r.enabled === false) { plan.disabled.push({ name, schedule: r.schedule }); continue; }
    if (r.schedule === 'stop-hook') { plan.eventRoutines.push({ name }); continue; }
    const script = join(factoryRoot, 'scripts', `${name}.mjs`);
    if (!existsSync(script)) { plan.agentsNoRunner.push({ name, schedule: r.schedule }); continue; }
    plan.schedulable.push({
      name, taskName: taskNameFor(name), script, scriptRel: `scripts/${name}.mjs`,
      cron: r.schedule, schtasks: cronToSchtasks(r.schedule),
      cadenceHours: cadenceHoursFromCron(r.schedule), label: cronLabel(r.schedule),
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Registration (runs only when invoked as the main script -- see the guard below)
// ---------------------------------------------------------------------------

function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const factoryRoot = argVal('--factory-root') || argVal('-FactoryRoot') || process.env.VIBE_ROOT || FACTORY_ROOT_DEFAULT;
  const plan = resolveRoutinePlan(factoryRoot);

  console.log('\n  VibePromptRig Scheduler Setup (Node, cross-OS)\n');
  if (!plan.ok) {
    process.stderr.write(`  .forge/routines.json not found or invalid at ${plan.routinesFile} -- nothing to register.\n`);
    process.exit(1);
  }

  for (const a of plan.agentsNoRunner)
    console.log(`  [skip] ${a.name} -- agent routine, no local runner (belongs on cloud Routines; see docs/architecture/agent-routines-cloud-routines.md)`);
  for (const ev of plan.eventRoutines)
    console.log(`  [skip] ${ev.name} -- event routine (schedule: stop-hook), fires via the Claude Stop hook, not the OS scheduler`);
  for (const d of plan.disabled)
    console.log(`  [skip] ${d.name} -- disabled in routines.json`);

  if (plan.schedulable.length === 0) { console.log('\n  No OS-schedulable routines found (need an enabled routine with a scripts/<name>.mjs body).\n'); return; }

  if (process.platform === 'win32') registerWindows(plan.schedulable, dryRun);
  else registerUnix(plan.schedulable, dryRun);

  finishNote(plan, dryRun);
}

function registerWindows(jobs, dryRun) {
  if (!dryRun && !isAdminWindows()) {
    process.stderr.write('  This must run as Administrator (schtasks /rl HIGHEST). Re-open the terminal as Administrator.\n');
    process.exit(1);
  }
  for (const j of jobs) {
    if (!j.schtasks) {
      process.stderr.write(`  [warn] ${j.name}: cron '${j.cron}' can't map to a single Task Scheduler trigger -- register it manually or simplify the schedule. Skipped.\n`);
      continue;
    }
    const createArgs = ['/create', '/tn', j.taskName, '/tr', nodeCmd(j.script), '/sc', ...j.schtasks.sc, '/st', j.schtasks.st, '/rl', 'HIGHEST', '/f'];
    if (dryRun) {
      console.log(`  [dry-run] schtasks /delete /tn ${j.taskName} /f`);
      console.log(`  [dry-run] schtasks ${createArgs.join(' ')}`);
      if (j.name === 'pg-dump-offsite') {
        console.log(`  [dry-run] schtasks /create /tn ${catchupTaskNameFor(j.name)} /tr ${nodeCmd(j.script, ['--startup-catchup'])} /sc ONSTART /delay 0001:00 /rl HIGHEST /f`);
      }
      continue;
    }
    spawnSync('schtasks', ['/delete', '/tn', j.taskName, '/f'], { stdio: 'ignore' });
    const r = spawnSync('schtasks', createArgs, { encoding: 'utf8' });
    if (r.status !== 0) { process.stderr.write(`  Failed to create ${j.taskName}: ${(r.stderr || r.stdout || '').trim()}\n`); process.exit(1); }
    console.log(`  Created: ${j.taskName} (${j.label})`);
    if (j.name === 'pg-dump-offsite') {
      const catchupName = catchupTaskNameFor(j.name);
      spawnSync('schtasks', ['/delete', '/tn', catchupName, '/f'], { stdio: 'ignore' });
      const catchupArgs = ['/create', '/tn', catchupName, '/tr', nodeCmd(j.script, ['--startup-catchup']), '/sc', 'ONSTART', '/delay', '0001:00', '/rl', 'HIGHEST', '/f'];
      const catchup = spawnSync('schtasks', catchupArgs, { encoding: 'utf8' });
      if (catchup.status !== 0) {
        process.stderr.write(`  Failed to create ${catchupName}: ${(catchup.stderr || catchup.stdout || '').trim()}\n`);
        process.exit(1);
      }
      console.log(`  Created: ${catchupName} (startup catch-up; only runs when custody evidence is stale)`);
    }
  }
}

function registerUnix(jobs, dryRun) {
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const prior = (existing.status === 0 ? (existing.stdout || '') : '').split('\n');
  const kept = prior.filter((l) => l.trim() !== '' && !l.includes(CRON_MARKER)); // replace only our entries
  const ours = unixCrontabEntries(jobs);
  const newCrontab = [...kept, ...ours].join('\n') + '\n';
  if (dryRun) {
    console.log('  [dry-run] would install this crontab (user crontab; no root needed):');
    for (const o of ours) console.log(`    ${o}`);
    return;
  }
  const install = spawnSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
  if (install.status !== 0) { process.stderr.write(`  crontab install failed: ${(install.stderr || '').trim()}\n`); process.exit(1); }
  for (const j of jobs) console.log(`  Installed cron: ${j.taskName} (${j.label})`);
  const backup = jobs.find((j) => j.name === 'pg-dump-offsite');
  if (backup) console.log(`  Installed cron: ${catchupTaskNameFor(backup.name)} (@reboot; runs only when custody evidence is stale)`);
}

function isAdminWindows() {
  return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0; // succeeds only with admin rights
}

function finishNote(plan, dryRun) {
  const verify = process.platform === 'win32' ? `schtasks /query /tn ${taskNameFor(plan.schedulable[0].name)}` : 'crontab -l';
  console.log('\n  Setup complete!' + (dryRun ? ' (dry-run -- nothing was registered)' : ''));
  console.log(`  Verify with:  ${verify}`);
  console.log('  Note: restore-drill is MANUAL (quarterly) -- run `node scripts/restore-drill.mjs` by hand.');
  if (plan.schedulable.some((j) => j.name === 'pg-dump-offsite')) {
    console.log('  Note: pg-dump-offsite and its startup catch-up task are REGISTERED here, but custody only');
    console.log('        succeeds when the secret-free registry has the named DB + public age-recipient env');
    console.log('        vars, a local R2 rclone remote, and any optional Proton remote configured. See');
    console.log('        docs/architecture/cross-platform-port-t3-schedulers.md.');
  }
  if (plan.agentsNoRunner.length) {
    console.log(`  Note: ${plan.agentsNoRunner.length} agent routine(s) are NOT scheduled locally (no runner). They belong on`);
    console.log('        cloud Routines -- tracked in docs/architecture/agent-routines-cloud-routines.md.');
  }
  console.log('');
}

// Run registration ONLY when invoked directly (`node scripts/setup-scheduler.mjs`), never on import
// (doctor.mjs imports resolveRoutinePlan from here for its health check).
const invokedAsMain = !!process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedAsMain) main();
