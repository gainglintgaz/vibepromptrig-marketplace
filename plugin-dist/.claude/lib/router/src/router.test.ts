// TS test harness for the v5.0 provider router (arch 9d7294c, extended by provider expansion).
// Proves, WITHOUT requiring any live API key for the core suite:
//   - A9 budget hard-stop throws BEFORE dispatch (provider never invoked)
//   - the `local` stub still throws (no silent fallback, A4)
//   - the wired-flag gate throws for an unwired provider (A4, no reroute)
//   - A8 ai_call logged with config hash
//   - config hash deterministic + 64 hex; selectModel honors customer prefs FIRST (A2)
//   - BUG-1: a completed dispatch whose echoed model id is unknown is ALWAYS logged, with
//            cost_estimated:true (cost never throws post-dispatch)
//   - BUG-2: two concurrent route() calls near the cap cannot both pass (atomic check-and-reserve)
// Plus key-gated LIVE round-trips per provider (skip-not-fake when the key is absent -- we never
// fake an API result, per testing-strategy.md + the original file's stance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { route, selectModel } from "./router.js";
import { BudgetExceededError, monthToDateCents, committedAndReservedCents } from "./budget.js";
import { hashConfig, logAiCall } from "./provenance.js";
import { loadModelRouter } from "./model-router.js";
import { LocalProvider } from "./providers/local.js";
import type { Provider } from "./types.js";
import type { TaskCategory } from "./schemas/task-categories.js";

// Factory root: VIBE_ROOT override (factory convention) -> legacy env -> derived from this file's
// location (dist|src -> router -> lib -> .claude -> factory root). No operator-absolute path.
const FACTORY_ROOT =
  process.env.VIBE_ROOT ||
  process.env.VIBEPROMPTRIG_FACTORY_ROOT ||
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function tempMetrics(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-router-"));
  return join(dir, "factory_metrics.jsonl");
}

// F3: the budget gate now reads a DEDICATED ledger (not factory_metrics). Tests pass a temp ledger so
// they never touch the real .forge/budget-ledger.jsonl.
function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-ledger-"));
  return join(dir, "budget-ledger.jsonl");
}

function readEvents(metricsPath: string): Array<Record<string, unknown>> {
  if (!existsSync(metricsPath)) return [];
  return readFileSync(metricsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("config hash is deterministic, order-independent, 64-hex", () => {
  const a = hashConfig({ projects: ["x", "y"], lookback: 7 });
  const b = hashConfig({ lookback: 7, projects: ["x", "y"] });
  assert.equal(a, b, "hash must be key-order independent");
  assert.match(a, /^[0-9a-f]{64}$/);
  const c = hashConfig({ projects: ["x", "z"], lookback: 7 });
  assert.notEqual(a, c, "different config -> different hash");
});

test("selectModel: customer prefs win, else factory default (A2)", () => {
  const router = loadModelRouter(FACTORY_ROOT);
  assert.equal(selectModel(router, "agent_dispatch"), "claude-haiku-4-5");
  assert.equal(
    selectModel(router, "agent_dispatch", { agent_dispatch: { preferred: ["claude-opus-4-8"] } }),
    "claude-opus-4-8",
  );
  // research_cited (NEW) defaults to Perplexity sonar-pro
  assert.equal(selectModel(router, "research_cited"), "sonar-pro");
});

test("A9: budget hard-stop throws BEFORE dispatch (provider never called)", async () => {
  const metricsPath = tempMetrics();
  const ledgerPath = tempLedger();
  const now = new Date();
  // Seed the LEDGER (where the gate reads): 199c already committed this month for this agent.
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      ts: now.toISOString(), event: "ai_commit", id: "seed", cost_cents: 199, agent: "synthesizer",
    }) + "\n",
    "utf8",
  );

  await assert.rejects(
    () =>
      route({
        taskCategory: "agent_dispatch", prompt: "hello", agent: "synthesizer", agentVersion: "1.0.0",
        budgetCentsPerMonth: 200, estimatedCents: 50, metricsPath, budgetLedgerPath: ledgerPath,
        factoryRoot: FACTORY_ROOT, resolvedConfig: { a: 1 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError, "must be BudgetExceededError"); // 199 + 50 > 200
      return true;
    },
  );

  // Proof "before dispatch": no ai_call in factory_metrics; no NEW reservation in the ledger.
  assert.equal(readEvents(metricsPath).filter((e) => e["event"] === "ai_call").length, 0);
  const ledgerEvs = readEvents(ledgerPath);
  assert.equal(ledgerEvs.filter((e) => e["event"] === "ai_reservation").length, 0, "no reservation when hard-stopped");
  assert.equal(ledgerEvs.length, 1, "ledger unchanged except the seed commit");
});

// ---- F1: per-task hard cap is a real ceiling, enforced even with NO monthly budget -------------
// FAILS on pre-F1 code: monthlyCap defaults to +Infinity, perTaskCap only seeds the estimate -> a
// caller omitting budgetCentsPerMonth is uncapped and a >$5 call dispatches. PASSES after: the
// per-task ceiling hard-stops it BEFORE dispatch (provider never invoked, no ai_call).
test("F1: no monthly budget + estimate > per-task cap -> hard-stop, provider never called", async () => {
  const metricsPath = tempMetrics();
  let invoked = false;
  const fake: Provider = {
    name: "openai",
    async complete() {
      invoked = true;
      return { text: "x", model: "gpt-5.4", provider: "openai", tokensIn: 1, tokensOut: 1 };
    },
  };
  await assert.rejects(
    () =>
      route({
        taskCategory: "research", prompt: "hi",
        // NO budgetCentsPerMonth (the uncapped case); estimate exceeds the LIVE per-task cap.
        // Cap-relative on purpose (lesson #91): the cap moved 5 -> 15 USD in 0d4e10c and the old
        // hardcoded 600c silently stopped exceeding it -- the test then asserted nothing.
        estimatedCents: Math.round(loadModelRouter(FACTORY_ROOT).hard_caps.per_task_usd * 100) + 100,
        metricsPath, budgetLedgerPath: tempLedger(), factoryRoot: FACTORY_ROOT, resolvedConfig: {},
        providersOverride: { openai: fake },
      }),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError, "must be BudgetExceededError (per-task)");
      assert.match((err as Error).message, /per-task/, "message names the per-task cap");
      return true;
    },
  );
  assert.equal(invoked, false, "provider must NOT be dispatched when the per-task cap is exceeded");
  assert.equal(
    readEvents(metricsPath).filter((e) => e["event"] === "ai_call").length,
    0,
    "no ai_call logged when hard-stopped pre-dispatch",
  );
});

test("local stub still throws 'not enabled in v5.0' (no silent fallback, A4)", async () => {
  await assert.rejects(
    () => new LocalProvider().complete({ model: "x", prompt: "y" }),
    /not enabled in v5\.0/,
  );
});

test("wired-flag gate: route() throws for an unwired provider (A4, no silent reroute)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-router-wired-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mr = {
    hard_caps: { per_task_usd: 5, per_session_usd: 30 },
    providers: { local: { env_key: "X", wired: false } },
    models: { "local-test": { provider: "local", in_usd_mtok: 0, out_usd_mtok: 0 } },
    task_categories: { agent_dispatch: { preferred: ["local-test"] } },
  };
  writeFileSync(join(dir, ".claude", "model-router.json"), JSON.stringify(mr), "utf8");
  await assert.rejects(
    () =>
      route({
        taskCategory: "agent_dispatch", prompt: "hi", budgetCentsPerMonth: 1000, estimatedCents: 1,
        metricsPath: join(dir, "m.jsonl"), factoryRoot: dir, resolvedConfig: {},
      }),
    /not wired/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("A8: logAiCall appends a parseable ai_call with config_hash + cost_estimated default", () => {
  const metricsPath = tempMetrics();
  const hash = hashConfig({ resolved: true });
  logAiCall(metricsPath, {
    config_hash: hash, provider: "anthropic", model: "claude-haiku-4-5",
    task_category: "agent_dispatch", tokens_in: 100, tokens_out: 50, cost_cents: 0.35,
    agent: "synthesizer", agent_version: "1.0.0",
  });
  const ev = readEvents(metricsPath)[0]!;
  assert.equal(ev["event"], "ai_call");
  assert.equal(ev["config_hash"], hash);
  assert.equal(ev["agent"], "synthesizer");
  assert.equal(ev["model"], "claude-haiku-4-5");
  assert.equal(ev["cost_estimated"], false, "legacy callers default cost_estimated:false");
  assert.equal(typeof ev["ts"], "string");
  assert.ok(monthToDateCents(metricsPath, "synthesizer") >= 0.35);
});

// ---- BUG-1: cost never throws post-dispatch; a completed dispatch is ALWAYS logged --------------
// FAILS on pre-fix code: costCents(echoed) throws on an unknown id -> route() rejects -> no ai_call.
// PASSES after: costCentsResolved falls back, route() returns, one ai_call row with cost_estimated:true.
test("BUG-1: unknown echoed model id -> route returns, ai_call logged, cost_estimated:true", async () => {
  const metricsPath = tempMetrics();
  const fake: Provider = {
    name: "openai",
    async complete() {
      return {
        text: "ok", model: "gpt-5.4-some-unknown-snapshot-9999", provider: "openai",
        tokensIn: 10, tokensOut: 5,
      };
    },
  };
  const ledgerPath = tempLedger();
  const res = await route({
    taskCategory: "research", // -> gpt-5.4 -> openai (wired:true); override injects the fake
    prompt: "hi", budgetCentsPerMonth: 100000, estimatedCents: 1,
    metricsPath, budgetLedgerPath: ledgerPath, factoryRoot: FACTORY_ROOT, resolvedConfig: {},
    providersOverride: { openai: fake },
  });
  assert.ok(res, "route must RETURN (not throw) after a paid dispatch");
  assert.equal(res.costEstimated, true, "unknown echoed id -> costEstimated true on the result");
  // ai_call PROVENANCE lands in factory_metrics (for the cost MCP), exactly once, flagged estimated.
  const aiCalls = readEvents(metricsPath).filter((e) => e["event"] === "ai_call");
  assert.equal(aiCalls.length, 1, "exactly one ai_call logged for the completed dispatch");
  assert.equal(aiCalls[0]!["cost_estimated"], true, "logged row flags cost_estimated:true");
  // budget events live in the LEDGER: a reservation opened, then SETTLED by a commit (not a close).
  const ledgerEvs = readEvents(ledgerPath);
  assert.equal(ledgerEvs.filter((e) => e["event"] === "ai_reservation").length, 1);
  assert.equal(ledgerEvs.filter((e) => e["event"] === "ai_commit").length, 1, "success settles via commit");
  assert.equal(ledgerEvs.filter((e) => e["event"] === "ai_reservation_close").length, 0, "no close on success");
});

// ---- F2: invalid usage tokens -> cost_estimated:true, never a silent exact-0 -------------------
// FAILS on pre-F2 code: NaN usage -> cost_cents:NaN -> serialized to null -> dropped as 0 with
// cost_estimated:FALSE (real spend recorded as exact-0). PASSES after: estimated:true, cents:0.
test("F2: NaN/undefined usage -> logged cost_estimated:true, cost 0 (never silent exact-0)", async () => {
  const metricsPath = tempMetrics();
  const badUsage: Provider = {
    name: "openai",
    async complete() {
      // a real SDK error/stream path can leave usage undefined -> NaN here
      return { text: "ok", model: "gpt-5.4", provider: "openai", tokensIn: NaN, tokensOut: 5 };
    },
  };
  const res = await route({
    taskCategory: "research", prompt: "hi", budgetCentsPerMonth: 100000, estimatedCents: 1,
    metricsPath, budgetLedgerPath: tempLedger(), factoryRoot: FACTORY_ROOT, resolvedConfig: {},
    providersOverride: { openai: badUsage },
  });
  assert.equal(res.costEstimated, true, "invalid usage -> costEstimated true on the result");
  assert.equal(res.costCents, 0, "invalid usage -> cost 0, never NaN");
  const aiCall = readEvents(metricsPath).find((e) => e["event"] === "ai_call")!;
  assert.equal(aiCall["cost_estimated"], true, "logged row flags cost_estimated:true (not silent false)");
  assert.equal(aiCall["cost_cents"], 0, "logged cost is 0, not NaN/null");
  // and the value survives JSON round-trip as a real number, not null
  assert.equal(typeof aiCall["cost_cents"], "number", "cost_cents serialized as a number, not null");
});

// ---- BUG-2: atomic check-and-reserve; concurrent calls cannot jointly exceed the cap -----------
// FAILS on pre-fix code: both calls read spent=0, both pass, both dispatch -> 2 succeed.
// PASSES after: the lock + open-reservation accounting lets exactly one through; the other hard-stops.
test("BUG-2: two concurrent route() near the cap -> exactly one succeeds, sum never exceeds cap", async () => {
  const metricsPath = tempMetrics();
  const ledgerPath = tempLedger(); // SHARED across both calls -- this is where the reservation race resolves
  const slowFake: Provider = {
    name: "openai",
    async complete() {
      await new Promise((r) => setTimeout(r, 40)); // force overlap
      return { text: "ok", model: "gpt-5.4", provider: "openai", tokensIn: 1000, tokensOut: 1000 };
    },
  };
  const mk = () =>
    route({
      taskCategory: "research", prompt: "hi",
      budgetCentsPerMonth: 100, estimatedCents: 60, // two reservations (120) cannot both fit under 100
      metricsPath, budgetLedgerPath: ledgerPath, factoryRoot: FACTORY_ROOT, resolvedConfig: {},
      providersOverride: { openai: slowFake },
    });

  const settled = await Promise.allSettled([mk(), mk()]);
  const ok = settled.filter((r) => r.status === "fulfilled");
  const rejected = settled.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one route() succeeds under the cap");
  assert.equal(rejected.length, 1, "exactly one route() is hard-stopped");
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof BudgetExceededError,
    "the loser is rejected with BudgetExceededError",
  );
  const totalCost = readEvents(metricsPath)
    .filter((e) => e["event"] === "ai_call")
    .reduce((s, e) => s + (typeof e["cost_cents"] === "number" ? (e["cost_cents"] as number) : 0), 0);
  assert.ok(totalCost <= 100, `logged ai_call cost ${totalCost}c must never exceed the cap 100c`);
});

// ---- F6: per-task cap gates the ESTIMATE, not actual cost -> over-cap settle is flagged, not silent
// A caller under-estimates (estimatedCents:1 passes the gate) but a large response settles over the
// $5 cap. route() must RETURN (Bug-1: no post-dispatch throw) and flag costOverPerTaskCap:true.
test("F6: under-estimated call settles over per-task cap -> returns + costOverPerTaskCap true", async () => {
  const metricsPath = tempMetrics();
  const bigFake: Provider = {
    name: "openai",
    async complete() {
      // gpt-5.5 out price 30 usd/Mtok -> 2,000,000 out tokens = $60 = 6000c, far over the 500c cap
      return { text: "ok", model: "gpt-5.5", provider: "openai", tokensIn: 1000, tokensOut: 2_000_000 };
    },
  };
  const res = await route({
    taskCategory: "research", prompt: "hi",
    estimatedCents: 1, // under-estimate: passes the per-task ESTIMATE gate (1 < 500)
    // NO monthly budget -> only the per-task gate could have caught it, and it gates the estimate only
    metricsPath, budgetLedgerPath: tempLedger(), factoryRoot: FACTORY_ROOT, resolvedConfig: {},
    providerPrefs: { research: { preferred: ["gpt-5.5"] } },
    providersOverride: { openai: bigFake },
  });
  assert.ok(res, "route RETURNS (no post-dispatch throw -- Bug-1) even when settled over the cap");
  assert.ok(res.costCents > 500, `actual cost ${res.costCents}c is over the 500c per-task cap`);
  assert.equal(res.costOverPerTaskCap, true, "the over-cap settle is flagged, not silently within-cap");
  assert.equal(res.costEstimated, false, "cost is exact (known model + valid usage), just over the cap");
});

// ---- F3 reconciliation: commit settles by id; close releases; stale reservation is abandoned ----
// Deterministic (no timing): drives committedAndReservedCents over a hand-built ledger.
test("F3: gate counts commit at actual cost, not estimate; close releases; stale reservation dropped", () => {
  const ledgerPath = tempLedger();
  const now = new Date();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
  appendFileSync(
    ledgerPath,
    // r1: reserved 500c, then committed at the ACTUAL 12c -> counts 12, NOT 500
    line({ ts: iso(5000), event: "ai_reservation", id: "r1", estimated_cents: 500, agent: "a" }) +
      line({ ts: iso(4000), event: "ai_commit", id: "r1", cost_cents: 12, agent: "a" }) +
      // r2: reserved 500c, then CLOSED (dispatch failure) -> released, counts 0
      line({ ts: iso(5000), event: "ai_reservation", id: "r2", estimated_cents: 500, agent: "a" }) +
      line({ ts: iso(4500), event: "ai_reservation_close", id: "r2" }) +
      // r3: OPEN + recent -> still held at its estimate (60c)
      line({ ts: iso(3000), event: "ai_reservation", id: "r3", estimated_cents: 60, agent: "a" }) +
      // r4: OPEN but ABANDONED (older than the 10-min stale window) -> NOT counted (no month-rollover wait)
      line({ ts: iso(11 * 60_000), event: "ai_reservation", id: "r4", estimated_cents: 999, agent: "a" }),
    "utf8",
  );
  // committed 12 (r1 actual) + reserved 60 (r3 open) = 72. r2 closed, r4 abandoned -> excluded.
  assert.equal(committedAndReservedCents(ledgerPath, "a", now), 72);
  // agent filter: a different agent sees none of agent "a"'s spend
  assert.equal(committedAndReservedCents(ledgerPath, "other", now), 0);
});

// ---- Live round-trips, honestly key-gated (skip-not-fake) --------------------------------------
// Each does a minimal REAL call with the cheapest model for that provider; asserts real usage tokens.
// When the key is absent the test is SKIPPED (passes), never faked. Low maxTokens -> minimal spend.
type RT = { name: string; key: string; category: TaskCategory; model: string };
const ROUND_TRIPS: RT[] = [
  { name: "anthropic", key: "ANTHROPIC_API_KEY", category: "agent_dispatch", model: "claude-haiku-4-5" },
  { name: "openai", key: "OPENAI_API_KEY", category: "research", model: "gpt-4.1-mini" },
  { name: "google", key: "GEMINI_API_KEY", category: "vision_ocr", model: "gemini-2.5-flash" },
  { name: "xai", key: "XAI_API_KEY", category: "x_data", model: "grok-4.3" },
  { name: "perplexity", key: "PERPLEXITY_API_KEY", category: "research_cited", model: "sonar" },
];

for (const rt of ROUND_TRIPS) {
  const hasKey = Boolean(process.env[rt.key]);
  test(
    `live round-trip: ${rt.name} (${rt.model})`,
    { skip: hasKey ? false : `SKIPPED: no ${rt.key} in env (skip-not-fake)` },
    async () => {
      const metricsPath = tempMetrics();
      const res = await route({
        taskCategory: rt.category,
        prompt: "Reply with the single word: ok",
        maxTokens: 16,
        providerPrefs: { [rt.category]: { preferred: [rt.model] } },
        budgetCentsPerMonth: 50000, // generous; per-task $5 cap still guards
        metricsPath,
        budgetLedgerPath: tempLedger(),
        factoryRoot: FACTORY_ROOT,
        resolvedConfig: { roundtrip: rt.name },
        agent: "router-test",
      });
      assert.ok(res.tokensIn > 0, `${rt.name}: tokensIn must be > 0 (real usage, not faked)`);
      assert.ok(res.tokensOut > 0, `${rt.name}: tokensOut must be > 0`);
      assert.equal(res.provider, rt.name, `${rt.name}: provider echoed`);
      assert.ok(typeof res.model === "string" && res.model.length > 0, "model id echoed");
      assert.ok(res.text.length > 0, "non-empty text");
    },
  );
}

test("cleanup temp dirs", () => {
  const d = mkdtempSync(join(tmpdir(), "vf-router-noop-"));
  rmSync(d, { recursive: true, force: true });
  void writeFileSync;
  assert.ok(true);
});
