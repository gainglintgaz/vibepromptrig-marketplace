# Travel — Client Intake Form

> **Pack:** `travel`. For family-travel / destination-planning / activity-finder products.

## 1. Product scope

- **Trip types** (family vacation / business travel / solo / group / honeymoon / day-trips):
- **Destination scope** (US / North America / global / specific regions):
- **Trip length** (day-trips / weekend / 1-2 week / extended / mixed):
- **Activity categories** (lodging, dining, attractions, transit, events):

## 2. Personalization

- **Traveler profile model** (single user / family with N members / group):
- **PII handling** (ages / allergies / accessibility — hash + truncate before AI? aggregate only?):
- **Preferences captured** (budget tier, pace, food preferences, mobility, must-haves):
- **Save / dismiss / favorite** for flywheel learning: yes / no

## 3. Data sources

- **Hotel data** (Booking / Hotels.com / Expedia / Amadeus / scraping / hybrid):
- **Flight data** (Skyscanner / Amadeus / direct airline APIs / aggregator):
- **Activity data** (Google Places / Tripadvisor / Yelp / curated):
- **Sentiment source** (X API / Reddit scrape / Tripadvisor reviews):
- **AI provider for synthesis** (Anthropic / Perplexity / Gemini for grounding):

## 4. Fabrication defense

- **URL validator subagent** active for hotel + activity URLs: yes / no (must be yes)
- **Flight prices NEVER from LLM** — only from API: yes / no (must be yes)
- **Canonical-domain whitelist** for activity reviews: yes / no
- **Currency conversion source** (canonical rate API):

## 5. Sentiment pipeline

- **Sentiment refresh cadence** (daily / weekly / on-demand):
- **`valid_until` TTL** (default 7 days):
- **Spam/bot filtering** (account age, follower threshold, verified):
- **Storage** (`destination_sentiment` table per travel-rules.md §4):

## 6. Destination canonicalization

- **Destinations table** populated for top N destinations on launch: yes / no
- **Aliases captured** ("NYC" → "New York City" → canonical New York):
- **Disambiguation UI** for ambiguous user input (Paris TX vs Paris FR): yes / no
- **WOEID populated** for X API queries: yes / no

## 7. Family-specific features (if applicable)

- **Age-band recommendations** (toddler-friendly, teen-friendly):
- **Dietary restrictions** stored per-traveler (encrypted, never raw to AI): yes / no
- **Accessibility needs** stored per-traveler: yes / no
- **Family-budget tracking** (per-trip cost vs budget): yes / no

## 8. Cost guardrails

- **Per-trip-plan budget** (cents) — caps X API + Perplexity + Gemini calls per plan:
- **X API monthly budget** + alerts at 80%/100%:
- **Hard cap behavior** (graceful partial + upsell, vs error):

## 9. Compliance

- **PII per traveler** — what's collected, encrypted, ever sent to AI:
- **Booking integration** (does product book? or hand off to operator?):
- **Affiliate disclosure** (if any commission from booking partners):
- **Refund / cancellation visible**: yes / no
- **Data retention** (how long traveler profiles + trip history kept):

## 10. Pre-launch QA gates

- [ ] X API keyword-filter wrapper enforces destination + sentiment keywords
- [ ] Destination canonicalization tested with ambiguous inputs (Paris, Springfield, etc.)
- [ ] All 12 travel HA scenarios + 8 AI Purchase Research HA scenarios stress-tested
- [ ] Family PII never reaches LLM in raw form (verified via prompt logs)
- [ ] Stale sentiment auto-revert tested (insert 8-day-old row → read path returns null)
- [ ] X_BEARER_TOKEN existence check fires on every cron entry
- [ ] Currency conversion correct for top 5 currencies
- [ ] Hotel URL validator + flight-price-from-API integration tested end-to-end

---

*Reference: Example Wellness App harvest at `<example-wellness-app>/.claude/v4.3-harvest.md` for source content.*
