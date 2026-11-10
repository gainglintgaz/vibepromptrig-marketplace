# Golden Paths — Proven Patterns

Project labels in the examples below are anonymized teaching labels.
Patterns that worked in production. Reference before building. Updated via Post-Mortem Protocol.

---

## GP-001: Vanilla JS Feature Module (Zero Dependencies)
**Used in:** Example Wellness App family-profile.js
**When to use:** Static HTML sites, no framework, need persistent user state

```js
// Pattern: IIFE module with localStorage persistence + window API exposure
(function() {
  var STORAGE_KEY = 'appname_feature_key';

  function get() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch(e) { return null; }
  }

  function save(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  // Expose clean API
  window.FeatureName = { get, save, has: function() { return !!get(); } };

  // Auto-init after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```
**Notes:** Wrap in try/catch everywhere localStorage is touched (Safari private mode throws). Always expose via window.X for cross-script access.

---

## GP-002: Claude Code Permissions Setup (Broad Wildcards)
**Used in:** VibePromptRig factory, Example Wellness App, Example Research App
**When to use:** Any new project to minimize Allow clicking

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(powershell *)",
      "Bash(vercel *)",
      "Read(*)",
      "Edit(*)",
      "Write(*)",
      "Glob(*)",
      "Grep(*)",
      "Agent(*)",
      "TodoWrite",
      "WebFetch(*)",
      "WebSearch(*)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force *main*)",
      "Bash(git push --force *master*)",
      "Bash(git reset --hard)"
    ]
  }
}
```
**Notes:** Place in `.claude/settings.local.json` in project root. Never commit. Copy from `scripts/templates/shared/.claude/settings.local.json`.

---

## GP-003: Stop Hook for Post-Session Learning
**Used in:** VibePromptRig factory
**When to use:** Any project where you want automatic SESSION_DEBRIEF + CHANGELOG

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NonInteractive -File \"C:\\path\\to\\post-session-enforcer.ps1\""
          }
        ]
      }
    ]
  }
}
```
**Place in:** `.claude/settings.json` (not settings.local.json — this one is intentional)
**Notes:** Use NonInteractive flag or PowerShell hangs waiting for input. The script reads recent git commits and generates debrief automatically.

---

## GP-004: X API Recent Search (Destination Sentiment)
**Used in:** Example Wellness App fetch_x_sentiment.py
**When to use:** Pull real traveler posts for any destination-based product

```python
def search_recent(query, max_results=10):
    url = "https://api.x.com/2/tweets/search/recent"
    params = {
        "query": query,
        "max_results": min(max_results, 100),
        "tweet.fields": "created_at,public_metrics,author_id,lang",
    }
    resp = requests.get(url, headers={"Authorization": f"Bearer {BEARER_TOKEN}"}, params=params, timeout=15)
    if resp.status_code == 429:
        wait = max(int(resp.headers.get("x-rate-limit-reset", time.time() + 60)) - int(time.time()), 5)
        time.sleep(wait)
        return search_recent(query, max_results)  # retry after rate limit
    return resp.json().get("data", []) if resp.status_code == 200 else []
```
**Cost:** ~$0.10-0.30 per full run across 7 destinations. Run weekly, not daily.
**Query format that works:** `'"Destination" "with kids" -is:retweet lang:en'`

---

## GP-005: Social Proof Section (Lazy Load from JSON)
**Used in:** Example Wellness App hotel_results.html
**When to use:** Any page where you want to display external data that may not exist yet

```js
// Fetch JSON, show section only if data exists, hide if not
(function() {
  function load() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'data-file.json', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try { render(JSON.parse(xhr.responseText)); } catch(e) {}
      }
    };
    xhr.send();
  }

  function render(data) {
    var section = document.getElementById('mySection');
    if (!data || !data.items || !data.items.length) {
      section.style.display = 'none'; return;
    }
    // build DOM...
    section.style.display = 'block';
  }

  window.addEventListener('DOMContentLoaded', load);
})();
```
**Notes:** Always hide section by default (`display:none`). Only show when data confirms it has content. Gracefully handles missing file (404 silently swallowed).

---

## GP-006: VibePromptRig Project Scaffold Command
**Used in:** Every new project
**When to use:** Starting any new project — the project owner's or client

```powershell
# Standard project
.\scripts\scaffold-new-project.ps1 -Name "ProjectName" -Template vite

# Client-ready (sanitizes VibePromptRig references, adds HANDOFF_GUIDE.md)
.\scripts\scaffold-new-project.ps1 -Name "ClientProjectName" -Template vite -ClientReady

# Templates: vite | nextjs | empty
```
**What you get:** Git init, 8 rule files, CLAUDE.md, CURRENT_SPRINT.md, V1_FEATURE_BACKLOG.md, errors-fixed.json, golden-paths.md, .env.example, permissions template, initial commit.

---

## GP-007: Hostile Architect Before Every Build
**Used in:** Every project before writing code
**When to use:** After blueprint, before any code — catches critical issues early

Key phases that catch the most bugs:
- **Phase 0:** Cost estimate — total monthly burn at V1 and 1K users
- **Phase 2:** Persistence audit — trace UI → DB → SELECT, not just UI → UI
- **Phase 4:** Honest strings — every % and $ must come from real data
- **Phase 5:** System boundary — RLS, Edge Function cold starts, API format changes

**Trigger:** Say "Hostile Architect [feature name]" — Claude runs all 8 phases automatically.

---

## GP-008: Supabase Edge Function + MCP Deploy
**Used in:** Example Finance App
**When to use:** Deploying server-side AI logic

Critical rule: **inline all shared code**. Relative imports fail silently.

```typescript
// BAD — breaks MCP deploy
import { sanitize } from './utils.ts';

// GOOD — inline everything
function sanitize(text: string): string {
  return text.substring(0, 20).replace(/[<>]/g, '');
}

Deno.serve(async (req) => {
  const apiKey = Deno.env.get('GEMINI_API_KEY'); // never hardcode
  // ... rest of function
});
```

---

## GP-009: Filter-Aware Component (Re-filter on Dropdown Change)
**Used in:** Example Wellness App social proof section
**When to use:** Any UI component that should react to existing filter state

```js
// Hook into existing filter function without breaking it
var originalFilter = window.filterCards;
if (typeof originalFilter === 'function') {
  window.filterCards = function() {
    originalFilter.apply(this, arguments); // run original first
    myComponent.render();                  // then update component
  };
}
```
**Notes:** Check typeof before wrapping — the function may not exist yet if script loads before main JS. Always call original first.

---

## GP-010: Client Proposal Structure (1-Page Max)
**Used in:** Consulting engagements
**When to use:** Any client proposal

Proven structure that closes:
1. **One sentence** — what it does
2. **Three bullets** — specific pain points it solves
3. **Tech Stack Assessment** — KEEP/SWITCH/SELF-HOST table per layer
4. **Monthly cost** — at launch and at 1K users (builds trust)
5. **Timeline** — V1 date, V1.1 scope boundary
6. **Price** — one number, value-based not hourly
7. **Retainer option** — always offer $1-2K/mo AI Webmaster tier

Rule: If it doesn't fit one page, cut scope not content.

---

## GP-011: AI Purchase Research — 3-Layer Fabrication Defense
**Used in:** Example Research App ask-example-research-app edge function (2026)
**When to use:** Any AI that generates product recommendations, prices, or review content

Layer 1 — Prompt hardening: "ZERO URL POLICY — emit brand names only, no URLs in your JSON response body."
Layer 2 — Backend citation sanitization: compare every URL in the AI JSON against the API's real citation array. Domain not in citations → strip → Google search fallback.
Layer 3 — Deterministic category/brand blocklist: known component brands that should never appear as complete product picks.
All 3 layers must be present. Removing any one defeats the others.

---

## GP-012: AI Purchase Research — k=5 Privacy Gate + Trust Ladder
**Used in:** Example Research App buyer_insights UX (2026)
**When to use:** Any feature that aggregates user-submitted ratings/reviews

Never render aggregate scores below k=5 real submissions.
LOCKED state copy: "🔒 5 owner reviews unlock here. N/5 so far. Bought this? Share."
Trust Ladder: user with 1+ submissions sees PREVIEW state on their next query — creates contribution incentive.
SQL: `COUNT(*) >= 5` in pick_aggregates materialized view gates all downstream features.

---

## GP-013: AI Purchase Research — Multi-Vendor AI Config
**Used in:** Example Research App (Perplexity + Gemini + xAI stack, 2026)
**When to use:** Any AI product requiring research + structured output + cheap tasks

Perplexity sonar-pro → Gemini 2.5 Pro (research). Never Flash for research — too thin.
xAI Grok → Gemini 2.5 Flash (structured JSON). Grok lowest hallucination rate on structured output.
Hard rule: never call Perplexity inside a loop. Cache results. Per-query cost is ~$0.03.

---

## GP-014: AI Purchase Research — Data Maturity Gating (DMG)
**Used in:** Example Research App price + deal features
**When to use:** Any derived score/signal that requires historical data

4 levels required: Insufficient (n<3) → show "not enough data yet", Sparse (3-12) → show with caveat, Adequate (12-50) → show with basis, Rich (50+) → show confidently.
Never skip Insufficient level. Empty tables rendered as features break trust permanently.

---

## GP-015: AI Purchase Research — Retailer URL Verification Fallback
**Used in:** Example Research App url-verify.ts (2026)
**When to use:** Any feature that verifies product URLs

HEAD request → retailers return 403. Progressive fallback required:
1. HEAD with browser User-Agent (~200ms)
2. GET with Range: bytes=0-2047 (catches Amazon, Walmart, HD, etc.)
3. Firecrawl headless browser (budget-cap at 2/report; only if FIRECRAWL_API_KEY set)
Always flag url_verified: boolean on picks. Never remove picks based on verification failure.

---

## GP-016: AI Purchase Research — Bot Protection for Expensive Endpoints
**Used in:** Example Research App ask-example-research-app (2026)
**When to use:** Any publicly accessible AI endpoint that costs real money per call

Stack (all free or near-free):
- Cloudflare Bot Fight Mode (free, enable on zone)
- WAF rate-limit rule: 10 req/min/IP on /functions/v1/ask-* path
- IP-hash deduplication inside edge function (agent_queries table, 200 calls/hr/IP)
- Daily spend cap on AI vendor dashboards ($5 alert, $20 hard cutoff)
Never use hard login as bot protection — kills SEO and LLM discoverability.

---

## GP-017: SaaS Dispatcher Cost-Audit Pattern (Per-Tenant AI Spend Guard)
**Used in:** Example Agent App (2026), v5.0 commercial harness
**When to use:** Any SaaS product where authenticated tenants consume AI credits (billed or plan-capped)

This solves the authenticated-tenant version of spend control. GP-016 solves the public-endpoint version — different threat model.

```sql
-- Schema: tenant_agent_runs (already in v5.0 schema)
-- Add spend tracking:
ALTER TABLE tenant_agent_runs ADD COLUMN cost_usd NUMERIC(10,6);
ALTER TABLE tenant_agent_runs ADD COLUMN billing_period DATE NOT NULL DEFAULT date_trunc('month', NOW())::date;
CREATE INDEX ON tenant_agent_runs(tenant_id, billing_period);

-- Nightly cost-audit view:
CREATE OR REPLACE VIEW tenant_spend_this_period AS
SELECT
  tenant_id,
  SUM(cost_usd) AS period_spend_usd,
  (SELECT budget_usd FROM tenant_agents WHERE tenant_id = tar.tenant_id LIMIT 1) AS plan_budget_usd,
  ROUND(SUM(cost_usd) / NULLIF((SELECT budget_usd FROM tenant_agents WHERE tenant_id = tar.tenant_id LIMIT 1), 0) * 100, 1) AS pct_used
FROM tenant_agent_runs tar
WHERE billing_period = date_trunc('month', NOW())::date
GROUP BY tenant_id;
```

```typescript
// Edge Function: cost-audit (runs nightly via scheduled-tasks MCP)
// 1. Query tenant_spend_this_period
// 2. Flag tenants where pct_used >= 80 → send "approaching quota" email
// 3. Hard-cap: if pct_used >= 100, update tenant_agents SET enabled=false for all agents
//    → agent invocations return graceful "quota reached until [billing_reset_date]"
// 4. Reset: on billing period close, re-enable agents + zero the period spend
```

3-tier response:
- **< 80% budget used** → run normally, no notification
- **80–99% budget used** → warning email, continue running (tenant can upgrade or wait)
- **100% budget used** → hard disable, graceful "quota reached" response, no silent overrun

Rule: NEVER silently overrun plan budget. Tenants must always be able to predict their bill.
Cost to run the audit: ~$0 (pure SQL, no AI calls).
Reference implementation: Example Agent App Phase 2 commit `e2b46b8`.
