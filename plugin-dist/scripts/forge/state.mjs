#!/usr/bin/env node
// state.mjs -- `forge state` CLI (VF-T14). Thin argument layer over state-lib.mjs.
// Justified: wraps the coord-state/1 library; no MCP server or Skill manages this task queue.
//
//   forge state init --project <name> [--root <dir>]
//   forge state validate [--adopt] [--root <dir>]
//   forge state next --agent <name> [--json]
//   forge state lane <name> --owner <agent> --paths <glob,...> --approved-by "<who, when>"
//   forge state add --id <id> --title <t> --owner <agent> --lane <lane> [--paths a,b] [--depends-on x,y]
//                   [--acceptance <text>] [--requires slot,slot] [--worker-actions a,b] [--timebox <min>] [--priority <n>]
//   forge state set <task> <field> <value>
//   forge state lease <task> --agent <name> --worktree <dir> [--minutes <n>] [--pid <n>]
//   forge state heartbeat <task> --agent <name> --worktree <dir> [--minutes <n>]
//   forge state receipt <task> <receipt.json> --agent <name> --worktree <dir>
//   forge state evidence <task> <slot> --ref <text>
//   forge state accept <task> --pr <n>
//   forge state block <task> --reason <text> | unblock <task> | promote | release-expired [--grace <min>]
//   forge state pack <task> [--out <dir>] [--no-context]
//
// Root: --root, else the git toplevel of the current directory (decision F1 makes the
// coordinator pass the canonical root explicitly). Events are disabled unless --metrics
// explicitly selects an output file. Exit 0 ok, 1 refused or failed, 2 usage.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as S from './state-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(process.env.VIBE_ROOT || join(here, '..', '..'));

export function parseArgs(argv) {
  const positional = [], flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' || a.startsWith('--root=')) {
      if (Object.hasOwn(flags, 'root')) throw new S.StateError('USAGE', '--root may be supplied only once');
      const value = a === '--root' ? argv[++i] : a.slice('--root='.length);
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || value.includes('\0'))
        throw new S.StateError('USAGE', '--root requires a non-empty directory path');
      flags.root = value;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const nextVal = argv[i + 1];
      if (nextVal === undefined || nextVal.startsWith('--')) flags[key] = true;
      else { flags[key] = nextVal; i += 1; }
    } else positional.push(a);
  }
  return { positional, flags };
}
const list = (v) => (v === undefined || v === true ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function resolveRoot(flags) {
  if (typeof flags.root === 'string') return resolve(flags.root);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new S.StateError('NO_ROOT', 'not inside a git repository; pass --root <dir>');
  return resolve(r.stdout.trim());
}

function contextPacketFor(task) {
  // Rule cards for the task's paths from the factory context manifest. Failure is reported in the
  // pack, never silently dropped.
  const manifestPath = join(factoryRoot, '.claude', 'rules-manifest.json');
  if (!existsSync(manifestPath)) return { packet: null, note: `context unavailable: ${manifestPath} not found` };
  return import('./context-contract.mjs').then((cc) => {
    const loaded = cc.loadContextManifest(manifestPath, { factoryRoot, requireFiles: 'runtime' });
    const resolution = cc.resolveContext(loaded.manifest, { intent: 'implementation', paths: task.paths || [], capabilities: [], risk: 'W1' });
    const rendered = cc.renderContextPacket({ factoryRoot, manifest: loaded.manifest, resolution, budgetBytes: S.PACK_BUDGET_BYTES - 8 * 1024 });
    return { packet: rendered.content, note: `context: ${rendered.card_paths.length} card(s), ${rendered.bytes} bytes` };
  }).catch((e) => ({ packet: null, note: `context unavailable: ${e.code || ''} ${e.message}`.trim() }));
}

export async function run(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  try {
    const { positional, flags } = parseArgs(argv);
    const cmd = positional[0];
    if (!cmd || cmd === 'help' || flags.help) { out('forge state <init|validate|next|lane|add|set|lease|heartbeat|receipt|evidence|accept|block|unblock|promote|release-expired|pack> ... (see scripts/forge/state.mjs header)'); return 0; }
    const root = cmd === 'init' && typeof flags.root !== 'string' ? process.cwd() : resolveRoot(flags);
    const metricsPath = typeof flags.metrics === 'string' ? resolve(flags.metrics) : null;
    const base = { metricsPath };
    const task = positional[1];
    switch (cmd) {
      case 'init': S.init(root, { project: flags.project }); out(`initialized ${S.statePath(root)}`); return 0;
      case 'validate': {
        if (flags.adopt) { S.adopt(root, base); out('adopted: integrity writer set to forge state'); }
        const { errors, warnings } = S.validateState(S.readState(root));
        for (const w of warnings) out(`WARN ${w}`);
        for (const e of errors) err(`ERROR ${e}`);
        out(errors.length ? `FAIL ${errors.length} error(s)` : 'PASS STATE.json valid');
        return errors.length ? 1 : 0;
      }
      case 'next': {
        const r = S.next(S.readState(root), { agent: flags.agent });
        if (flags.json) out(JSON.stringify({ task: r.task?.id ?? null, reason: r.reason }));
        else out(r.task ? `NEXT TASK for ${flags.agent}: ${r.task.id} "${r.task.title}" -- pack: .forge/packs/${r.task.id}.md` : `NO READY TASK for ${flags.agent}: ${r.reason}`);
        return 0;
      }
      case 'lane': S.setLane(root, { ...base, lane: task, owner: flags.owner, paths: list(flags.paths), approvedBy: flags['approved-by'] }); out(`lane ${task} -> ${flags.owner}`); return 0;
      case 'add': {
        const r = S.addTask(root, { ...base, id: flags.id, title: flags.title, owner: flags.owner, lane: flags.lane, paths: list(flags.paths), dependsOn: list(flags['depends-on']), acceptance: typeof flags.acceptance === 'string' ? flags.acceptance : '', requires: list(flags.requires), workerActions: list(flags['worker-actions']), timeboxMin: flags.timebox, priority: flags.priority ? Number(flags.priority) : 100 });
        out(`added ${flags.id} (${r.state.tasks.find((t) => t.id === flags.id).stage})`); return 0;
      }
      case 'set': S.setField(root, { ...base, task, field: positional[2], value: positional[3] }); out(`set ${task}.${positional[2]}`); return 0;
      case 'lease': S.lease(root, { ...base, task, agent: flags.agent, worktree: flags.worktree, minutes: flags.minutes ?? S.LEASE_DEFAULT_MIN, pid: flags.pid ? Number(flags.pid) : null }); out(`leased ${task} to ${flags.agent}`); return 0;
      case 'heartbeat': S.heartbeat(root, { ...base, task, agent: flags.agent, worktree: flags.worktree, minutes: flags.minutes }); out(`renewed ${task}`); return 0;
      case 'receipt': S.submitReceipt(root, { ...base, task, receiptPath: positional[2], agent: flags.agent, worktree: flags.worktree }); out(`${task} -> review (receipt validated)`); return 0;
      case 'evidence': S.recordEvidence(root, { ...base, task, slot: positional[2], ref: flags.ref }); out(`${task} evidence ${positional[2]} recorded`); return 0;
      case 'accept': S.accept(root, { ...base, task, pr: flags.pr }); out(`${task} -> done (PR #${flags.pr})`); return 0;
      case 'block': S.block(root, { ...base, task, reason: flags.reason }); out(`${task} -> blocked`); return 0;
      case 'unblock': { const r = S.unblock(root, { ...base, task }); out(`${task} -> ${r.state.tasks.find((t) => t.id === task).stage}`); return 0; }
      case 'promote': { const p = S.promote(root, base); out(p.length ? `promoted ${p.join(', ')}` : 'nothing to promote'); return 0; }
      case 'release-expired': { const r = S.releaseExpired(root, { ...base, graceMinutes: flags.grace ? Number(flags.grace) : 30 }); out(r.length ? `released ${r.join(', ')}` : 'no expired leases'); return 0; }
      case 'pack': {
        const t = S.readState(root).tasks.find((x) => x.id === task);
        if (!t) throw new S.StateError('NO_TASK', `no task ${task}`);
        const ctx = flags['no-context'] ? { packet: null, note: 'context: skipped (--no-context)' } : await contextPacketFor(t);
        const r = S.pack(root, { ...base, task, outDir: typeof flags.out === 'string' ? resolve(flags.out) : undefined, contextPacket: ctx.packet ? `${ctx.note}\n\n${ctx.packet}` : `${ctx.note}\n` });
        if (!ctx.packet) err(`WARN ${ctx.note}`);
        out(`pack ${r.file} (${r.bytes} bytes)`); return 0;
      }
      default: err(`unknown state command: ${cmd}`); return 2;
    }
  } catch (e) {
    if (e instanceof S.StateError) { err(`REFUSED ${e.code}: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
    err(`ERROR ${e.stack || e.message}`); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
