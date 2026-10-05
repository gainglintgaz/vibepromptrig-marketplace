// A9 -- budget hard-stop, checked BEFORE dispatch. Hard-stop: refuse to dispatch past cap, NEVER
// silent overrun (VIBE Rule 21 + 58). Arch 9d7294c. Provider expansion: F1 per-task ceiling, F2
// finite-cost hardening, F3 dedicated budget ledger (decoupled from the shared metric stream).
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { factoryRoot } from "./model-router.js";

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly spentCents: number,
    readonly estimatedCents: number,
    readonly capCents: number,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** factory_metrics.jsonl -- the SHARED metric stream. Holds the ai_call PROVENANCE row (read by the
 *  dashboard cost MCP). NOT read by the budget gate anymore (see budgetLedgerPathFor + F3). */
export function metricsPathFor(root?: string, override?: string): string {
  return override || join(factoryRoot(root), "factory_metrics.jsonl");
}

/** Sum cost_cents of ai_call events in the current calendar month, optionally for one agent. Reads
 *  factory_metrics (the provenance stream) -- this is COST REPORTING (cost MCP + the A8 test), NOT the
 *  A9 gate (the gate uses committedAndReservedCents against the dedicated ledger). */
export function monthToDateCents(metricsPath: string, agent?: string, now?: Date): number {
  if (!existsSync(metricsPath)) return 0;
  const ref = now ?? new Date();
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  let total = 0;
  const raw = readFileSync(metricsPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // skip malformed line, don't abort (lessons-archive: skip bad JSONL line)
    }
    if (e["event"] !== "ai_call") continue;
    if (agent && e["agent"] !== agent) continue;
    const ts = typeof e["ts"] === "string" ? new Date(e["ts"] as string) : null;
    if (!ts || isNaN(ts.getTime())) continue;
    if (ts.getUTCFullYear() !== y || ts.getUTCMonth() !== m) continue;
    const c = e["cost_cents"];
    if (typeof c === "number" && Number.isFinite(c)) total += c; // F2: never let NaN poison the total
  }
  return Math.round(total * 100) / 100;
}

// NOTE (F4): the old non-atomic `assertWithinBudget` (check-then-act -- the Bug-2 TOCTOU itself) was
// removed. It is superseded by `checkAndReserve` (atomic, against the dedicated ledger). Removing it
// stops the footgun from being re-imported and copy-pasted into a new TOCTOU (lessons-archive #86).

// ---------------------------------------------------------------------------------------------------
// F3 -- atomic check-and-reserve against a DEDICATED budget ledger (.forge/budget-ledger.jsonl).
//
// Why a dedicated ledger and not factory_metrics.jsonl (the original Bug-2 fix used factory_metrics):
//   - The gate must read committed+reserved spend INSIDE the lock. Reading the shared, unbounded
//     factory_metrics stream (other tooling appends to it; we can never rotate it) made the critical
//     section grow with an unrelated log; at proper-lockfile stale:5000 a slow scan let the lock be
//     STOLEN -> two writers in the section -> the Bug-2 TOCTOU window reopened.
//   - The ai_call PROVENANCE row still appends to factory_metrics (the dashboard cost MCP reads it) --
//     untouched. The ledger holds ONLY budget events (reservation / commit / close), stays small, is
//     month-scoped on read, and is compacted under the lock, so the critical section is O(small) and
//     the lock stale can be raised far above any realistic scan.
//
// Reconciliation by id (folds in the two reservation MEDIUMs):
//   - dispatch SUCCESS -> route() appends ai_commit{id, cost_cents}: records the ACTUAL cost AND
//     settles the reservation (committed reservations count at real cost, never the estimate).
//   - dispatch FAILURE -> route() appends ai_reservation_close{id}: releases the held estimate.
//   - a reservation is OPEN only if no commit/close cites its id. An open reservation older than
//     STALE_RESERVATION_MS (a crash between reserve and commit) is treated as abandoned and NOT
//     counted -- no reliance on month rollover to drop phantom budget.
// ---------------------------------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000; // tiny (budget-only) critical section -> huge headroom vs lock theft
const STALE_RESERVATION_MS = 10 * 60_000; // open reservation older than this == abandoned (crash); skip. Far > any real completion.
const COMPACT_THRESHOLD_LINES = 5_000; // opportunistic prune under the lock keeps the ledger bounded

/** The dedicated budget ledger -- ONLY budget events, separate from the shared factory_metrics. */
export function budgetLedgerPathFor(root?: string, override?: string): string {
  return override || join(factoryRoot(root), ".forge", "budget-ledger.jsonl");
}

function ensureLedgerFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "", "utf8");
  }
}

function inMonth(ts: unknown, y: number, m: number): boolean {
  if (typeof ts !== "string") return false;
  const d = new Date(ts);
  return !isNaN(d.getTime()) && d.getUTCFullYear() === y && d.getUTCMonth() === m;
}

/**
 * The A9 gate's view of spend THIS MONTH = committed (sum of ai_commit.cost_cents) + reserved (sum of
 * OPEN ai_reservation.estimated_cents). A reservation is open unless a commit/close cites its id; an
 * open reservation older than STALE_RESERVATION_MS is abandoned (crash) and skipped. Reads ONLY the
 * dedicated ledger -- never the shared, unbounded factory_metrics.
 */
export function committedAndReservedCents(ledgerPath: string, agent?: string, now?: Date): number {
  if (!existsSync(ledgerPath)) return 0;
  const ref = now ?? new Date();
  const refMs = ref.getTime();
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  let committed = 0;
  const open = new Map<string, { est: number; tsMs: number }>();
  const settled = new Set<string>();
  const raw = readFileSync(ledgerPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // skip malformed line, don't abort (lessons-archive: skip bad JSONL line)
    }
    const ev = e["event"];
    const id = e["id"];
    if (ev === "ai_commit") {
      if (typeof id === "string") settled.add(id); // a commit settles its reservation by id
      if (agent && e["agent"] !== agent) continue;
      if (!inMonth(e["ts"], y, m)) continue;
      const c = e["cost_cents"];
      if (typeof c === "number" && Number.isFinite(c)) committed += c;
    } else if (ev === "ai_reservation_close") {
      if (typeof id === "string") settled.add(id); // a close (failure) releases its reservation by id
    } else if (ev === "ai_reservation") {
      if (agent && e["agent"] !== agent) continue;
      if (!inMonth(e["ts"], y, m)) continue;
      const est = e["estimated_cents"];
      const tsMs = typeof e["ts"] === "string" ? Date.parse(e["ts"] as string) : NaN;
      if (typeof id === "string" && typeof est === "number" && Number.isFinite(est)) {
        open.set(id, { est, tsMs });
      }
    }
  }
  let reserved = 0;
  for (const [id, r] of open) {
    if (settled.has(id)) continue; // committed or closed
    if (Number.isFinite(r.tsMs) && refMs - r.tsMs > STALE_RESERVATION_MS) continue; // abandoned (crash)
    reserved += r.est;
  }
  return Math.round((committed + reserved) * 100) / 100;
}

/**
 * Keep the ledger bounded. Called UNDER the lock. When the file exceeds COMPACT_THRESHOLD_LINES, drop
 * every line older than the start of LAST month -- the gate only counts the current month, and an open
 * reservation that old is far past STALE_RESERVATION_MS, so dropping it is correct.
 */
function compactLedgerLocked(ledgerPath: string, now: Date): void {
  const raw = readFileSync(ledgerPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length <= COMPACT_THRESHOLD_LINES) return;
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const kept: string[] = [];
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = e["ts"];
    const d = typeof ts === "string" ? Date.parse(ts) : NaN;
    if (Number.isFinite(d) && d >= cutoff) kept.push(line);
  }
  writeFileSync(ledgerPath, kept.length ? kept.join("\n") + "\n" : "", "utf8");
}

/**
 * A9 gate, ATOMIC. (1) F1 per-call ceiling: reject before the lock if this call's estimate exceeds the
 * per-task cap, independent of the monthly cap. (2) Acquire a cross-process lock on the ledger, compute
 * committed+reserved, throw if (spent + estimate) would exceed the monthly cap, else append a
 * reservation row + opportunistically compact, and release. The lock window is TINY (read a small
 * budget-only file + one append) and released BEFORE the caller dispatches. A concurrent caller blocks
 * on the lock, then sees this reservation in `spent`. Returns spent-to-date (for spentBeforeCents).
 */
export async function checkAndReserve(opts: {
  capCents: number;
  estimatedCents: number;
  /**
   * F1 (CRITICAL) -- the per-call hard ceiling (effective per_task cap, already lowered by any
   * customer max_cost_per_task override). A single call whose ESTIMATE exceeds this is refused BEFORE
   * the lock + BEFORE dispatch, INDEPENDENT of the monthly cap. Without it, a caller that omits the
   * monthly budget had monthlyCap=+Infinity and was completely uncapped (A9 / VIBE Rule 21).
   *
   * F6 honesty: this gates the pre-dispatch ESTIMATE, not the ACTUAL settled cost. A caller that
   * under-estimates (low estimatedCents + large maxTokens) can still settle above the cap; route()
   * does NOT throw post-dispatch (spend already happened -- Bug-1) but flags RouteResult
   * .costOverPerTaskCap + warns to stderr so the overage is observable. (Follow-up: derive a
   * conservative estimate from maxTokens x out-price when estimatedCents is omitted -- tracked.)
   */
  perTaskCapCents?: number;
  ledgerPath: string;
  reservationId: string;
  agent?: string;
  now?: Date;
}): Promise<number> {
  // F1: per-call ceiling first -- pure comparison, no file/lock. Enforced even with no monthly cap.
  if (opts.perTaskCapCents !== undefined && opts.estimatedCents > opts.perTaskCapCents) {
    throw new BudgetExceededError(
      `BUDGET HARD-STOP (A9 per-task): ${opts.agent ?? "agent"} this call ` +
        `${opts.estimatedCents.toFixed(2)}c exceeds the per-task cap ${opts.perTaskCapCents.toFixed(2)}c. ` +
        `Refusing to dispatch (no silent overrun).`,
      0,
      opts.estimatedCents,
      opts.perTaskCapCents,
    );
  }
  ensureLedgerFile(opts.ledgerPath);
  const release = await lockfile.lock(opts.ledgerPath, {
    retries: { retries: 20, factor: 1.4, minTimeout: 15, maxTimeout: 300 },
    stale: LOCK_STALE_MS,
    realpath: false,
  });
  try {
    const spent = committedAndReservedCents(opts.ledgerPath, opts.agent, opts.now);
    const projected = spent + opts.estimatedCents;
    if (projected > opts.capCents) {
      throw new BudgetExceededError(
        `BUDGET HARD-STOP (A9): ${opts.agent ?? "agent"} month-to-date ${spent.toFixed(2)}c + this call ` +
          `${opts.estimatedCents.toFixed(2)}c = ${projected.toFixed(2)}c exceeds cap ${opts.capCents.toFixed(2)}c. ` +
          `Refusing to dispatch (no silent overrun).`,
        spent,
        opts.estimatedCents,
        opts.capCents,
      );
    }
    appendFileSync(
      opts.ledgerPath,
      JSON.stringify({
        ts: (opts.now ?? new Date()).toISOString(),
        event: "ai_reservation",
        id: opts.reservationId,
        estimated_cents: opts.estimatedCents,
        agent: opts.agent ?? "unknown",
      }) + "\n",
      "utf8",
    );
    compactLedgerLocked(opts.ledgerPath, opts.now ?? new Date());
    return spent;
  } finally {
    await release();
  }
}

/**
 * Settle a reservation on dispatch SUCCESS: records the ACTUAL cost AND cancels the reservation by id
 * (so committed spend counts at real cost, and the reservation no longer counts as in-flight). Append-
 * only; no lock needed (committedAndReservedCents reconciles by id).
 */
export function commitReservation(
  ledgerPath: string,
  ev: { reservationId: string; costCents: number; agent?: string },
  now?: Date,
): void {
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      ts: (now ?? new Date()).toISOString(),
      event: "ai_commit",
      id: ev.reservationId,
      cost_cents: ev.costCents,
      agent: ev.agent ?? "unknown",
    }) + "\n",
    "utf8",
  );
}

/**
 * Release a reservation on dispatch FAILURE -- frees the held estimate so a failed call doesn't
 * permanently consume budget. Append-only; no lock needed (reconciled by id).
 */
export function closeReservation(ledgerPath: string, reservationId: string, now?: Date): void {
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      ts: (now ?? new Date()).toISOString(),
      event: "ai_reservation_close",
      id: reservationId,
    }) + "\n",
    "utf8",
  );
}
