# AI Purchase Research — Client Intake Form

> **Pack:** `ai-purchase-research`. Used for AI consumer recommendation products (purchase research, deal scoring, gift suggestions, product comparison).
> **Stacks on:** `consulting/CLIENT_INTAKE_FORM.md` (general intake).

---

## 1. Product scope

- **Categories covered** (e.g., electronics, kitchenware, baby gear, automotive parts, supplements):
- **Categories explicitly excluded** (regulated: pharma, firearms, alcohol, financial products):
- **Geographic scope** (US-only, US+CA, English-speaking, global):
- **Price range** (luxury, mass-market, both):

## 2. Recommendation surface

- **Primary entry point** (search bar, browse, conversational agent, weekly email digest):
- **Quantity per request** (5 recommendations, 25, configurable):
- **Personalization signal source** (user preferences declared upfront, behavioral inference, both):
- **Result freshness target** (real-time, daily, weekly):

## 3. Data sources

- **Product catalog source** (curated DB, retailer APIs, scraped, hybrid):
- **Price data source** (retailer APIs, scraping, third-party feed like Honey/Capital One):
- **Review data source** (retailer reviews, aggregator, first-party only):
- **AI provider** (Anthropic / OpenAI / Gemini / Perplexity for research):

## 4. Fabrication defense (mandatory)

- **URL validation strategy** (see purchase-research-rules.md §1):
- **Browser-UA fallback for 403 retailers** (Walmart/Amazon/Costco): yes / no
- **Citation cross-check enabled** for any LLM with citations array (Perplexity, Gemini grounding): yes / no
- **What's the empty state when 0 products pass validation?**

## 5. Deal score discipline

- **Per-category minimum price points** (see purchase-research-rules.md §3):
  - Groceries: ___ points / ___ days
  - Electronics: ___ points / ___ days
  - Vehicles: ___ points / ___ days
  - Other: ___ points / ___ days
- **`data_confidence` levels rendered** (high / medium only? or all three?):
- **Below-threshold copy** ("tracking" / "more data needed" / other):

## 6. Cost guardrails

- **Per-report scrape cap** (count + cents):
- **Per-user monthly query cap** (free tier / paid tier):
- **AI API budget per query** (cents):
- **Per-tenant budget audit** (if SaaS): see GP-017 dispatcher cost-audit pattern.

## 7. Compliance + trust

- **Affiliate disclosure** (FTC requires clear "we earn commission"):
- **Refurb / used / new tagging** (always required):
- **Stock-status freshness** (real-time check or labeled "not verified"):
- **Returns / warranty info** displayed: yes / no
- **PII boundaries** (cart history, wishlist — what crosses to AI per `privacy.md`):

## 8. Moat + flywheel

- **Why won't a competitor clone this in 4 weeks?** (network effects, proprietary data, user-uploaded reviews, locked deal feeds):
- **What does usage make smarter?** (rating data, click-through rates, save patterns, dismiss patterns):
- **Cold-start strategy** (how the first 100 users see useful results before flywheel kicks in):

## 9. Revenue model

- **Free tier scope** (how much works without payment):
- **Paid tier value proposition** (priority results / more queries / premium retailers / B2B export):
- **Affiliate revenue share** (% of revenue or fixed bounty):

## 10. Pre-launch QA gates (mandatory)

- [ ] HA Phase 1.6 (8 scenarios) + pack-specific 4 scenarios = 12 total stress-tested
- [ ] Fabrication defense verified end-to-end against live retailer URLs
- [ ] Schema fingerprint baseline captured for `prompt_version` v1.0
- [ ] Blocklist seeded + `last_reviewed_at` set
- [ ] Per-report scrape cap enforced (test with 100-product synthetic request — should bail at cap)
- [ ] Affiliate disclosure visible on every product card
- [ ] Refurb / used / new tag visible on every product card
- [ ] Empty-state copy reviewed (NEVER "no products found" without retailer-specific context)

---

*Reference: Example Research App harvest at `<Example Research App project>/.claude/v4.3-harvest.md` §9 for source intake content.*
