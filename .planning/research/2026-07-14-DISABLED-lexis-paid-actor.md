# DISABLED: Lexis paid actor (fetchListing rung 3) — 2026-07-14

## What
The paid Apify actor **`lexis-solutions/booli-se-scraper`** (actor id
`bpf1JaYRBbia2nQU9`), called via `scrapeBooli` (`src/lib/apify/booli-scraper.ts`),
was wired in as **rung 3** — the last-resort fallback — of `fetchListing`
(`src/lib/booli/client.ts`), after two `own-playwright` rungs:

```
fetchListing:  own-playwright → own-playwright-retry → [paid-actor (Lexis)]  ← rung 3 DISABLED
```

It was **not** used by area search (`fetchAreaListings`) or sold comps
(`fetchSoldComps`) — both are own-render-only by design.

## Why disabled
- The actor's **~$30/month Apify rental** consumed most of the monthly Apify
  credits.
- It is a last-resort fallback only. Apify run history on 2026-07-14 showed
  **21 runs ever, most recent 2026-07-02** (nothing in the prior 12 days) — i.e.
  effectively idle. `own-playwright` is the proven primary transport (clears
  Cloudflare on retry; observed `health=ok`).

## Tradeoff while disabled
`fetchListing` now degrades to the two own-render rungs and **throws (HIGH-1) if
both fail** — no paid fallback. Impact:
- **Discovery image enrichment** (`enrichCandidateImages`): already non-fatal —
  a failed detail fetch just skips that candidate.
- **`/analyze` single-listing path**: a hard failure for that URL if both own
  renders fail.

Watch for a rise in `fetchListing` failures / "both own-render rungs failed"
in logs. If that climbs, restore rung 3.

## How to restore (clean uncomment)
1. `src/lib/booli/client.ts`: uncomment the `scrapeBooli` import and the
   `paid-actor` rung block in `fetchListing`.
2. `src/lib/booli/client.test.ts`: uncomment the two rung-3 tests and delete the
   "rung 3 disabled" placeholder test.
3. Re-rent `lexis-solutions/booli-se-scraper` on Apify.

The module `src/lib/apify/booli-scraper.ts` was intentionally **kept** (now
unreferenced) so restore is uncomment-only, not a rewrite.

## Verify commands
- Apify run history: `curl -s "https://api.apify.com/v2/acts/bpf1JaYRBbia2nQU9/runs?limit=10&desc=1&token=$APIFY_API_TOKEN"`
- App-side rung selection in logs: `grep -E "served by rung 3|paid-actor"`
