/**
 * cost.ts — the per-analysis sold-source cost guard (PRICE-01).
 *
 * Mirrors `src/lib/brf/cost.ts`: a published-rate const + an FX const
 * (`USD_SEK_RATE`) + a pure cost function. The sold source is the Apify
 * `apify/playwright-scraper` chromium render (03-SPIKE.md §1.5): actual billing
 * ~$0.0055 / URL-render; a paginated 3-render analysis ~$0.0166; worst realistic
 * case ~$18/mo at 800 analyses/mo — comfortably under the <$100/mo budget.
 *
 * The keyless direct path does not exist (the `/graphql` API is Cloudflare-
 * walled; a real browser render is mandatory — 03-SPIKE.md §1.2), so every sold
 * fetch costs at least one render. The function + cap are kept so Plan 05's
 * persist-gate is uniform with the BRF `COST_CAP_SEK` gate.
 */

/**
 * Apify `apify/playwright-scraper` per-render cost in USD (03-SPIKE.md §1.5):
 * mean ~$0.0055 / URL-render (chromium render time dominates, ~0.034 CU/render).
 */
export const USD_PER_RENDER = 0.0055 as const;

/**
 * USD→SEK conversion rate, exposed as a named config constant rather than
 * hardcoded inline (assumption A1, mirrors brf/cost.ts:19). Update this single
 * value when the FX rate moves materially.
 */
export const USD_SEK_RATE = 11;

/**
 * The per-analysis sold-source spend cap in SEK. A worst-case 3-render
 * paginated analysis costs ~$0.0166 ≈ 0.18 SEK; the cap sits well above that
 * with headroom for transport-retry overhead, while still bounding a runaway
 * fetch-walk (the D-01 tier walk is itself capped at ≤3 source calls — see
 * the threat register T-03-13). Plan 05 refuses to persist over this cap.
 */
export const SOLD_SOURCE_COST_CAP_SEK = 1.0;

/** Render usage for a single sold-source analysis. */
export interface SoldSourceUsage {
  /** Number of `playwright-scraper` page renders this analysis consumed. */
  renders: number;
}

/**
 * Computes the SEK cost of a single sold-source analysis from its render count.
 *
 * Pure function — no side effects, no network (mirrors `costSek`). Each render
 * bills at `USD_PER_RENDER`, converted to SEK via `USD_SEK_RATE`. Scales with
 * render count so a paginated (multi-page) analysis costs proportionally more.
 *
 * @param usage - the render count from the actor run
 * @returns the analysis cost in SEK
 */
export function soldSourceCostSek(usage: SoldSourceUsage): number {
  const renders = Number.isFinite(usage.renders) ? Math.max(0, usage.renders) : 0;
  return renders * USD_PER_RENDER * USD_SEK_RATE;
}
