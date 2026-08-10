import { costSek, costSekSonnet, USD_SEK_RATE, type ClaudeUsage } from "@/lib/brf/cost";
import { CAP_SEK_MAX, CAP_IMAGES_PER_LISTING } from "@/lib/discovery/filter-schema";

/**
 * Apify `apify/playwright-scraper` per-render cost in USD (mirrors
 * `src/lib/market/cost.ts`'s verified rate: mean ~$0.0055/URL-render).
 */
export const USD_PER_RENDER = 0.0055 as const;

/**
 * The per-discovery-job SEK spend cap, re-exported from `filter-schema.ts`'s
 * `CAP_SEK_MAX` so `job.ts`'s incremental per-slice cost gate reads a single
 * named constant colocated with the other discovery cost primitives.
 */
export const DISCOVERY_COST_CAP_SEK: number = CAP_SEK_MAX;

/** Usage for a single discovery-job tick: one Haiku intent parse (billed once
 * per job) plus the render count consumed scraping area listings so far. */
export interface DiscoveryUsage {
  haikuUsage: ClaudeUsage;
  renders: number;
}

/**
 * The SINGLE render→SEK conversion (14-RESEARCH.md "Don't Hand-Roll"). Every
 * caller that needs to price a render count (discovery scrape renders, area
 * comps fetches, …) MUST go through this function rather than re-inlining the
 * per-render USD rate times the FX rate below — a second inline copy of that
 * arithmetic would silently drift from the two underlying rate constants on a
 * future rate change. Non-finite/negative input is treated as 0 renders
 * (never a negative or NaN cost). Pure function — no side effects, no network.
 *
 * @param renders - the number of Apify renders to price
 * @returns the SEK cost of that many renders
 */
export function renderSek(renders: number): number {
  const n = Number.isFinite(renders) ? Math.max(0, renders) : 0;
  return n * USD_PER_RENDER * USD_SEK_RATE;
}

/**
 * Computes the SEK cost of a discovery job from its Haiku intent-parse usage
 * and render count. Composes the existing `costSek` (Haiku) precedent with
 * `renderSek`, the single render-cost conversion. Pure function — no side
 * effects, no network.
 *
 * @param usage - Haiku token usage + render count
 * @returns the job's cost in SEK
 */
export function discoveryCostSek(usage: DiscoveryUsage): number {
  const haikuSek = costSek(usage.haikuUsage);
  return haikuSek + renderSek(usage.renders);
}

/**
 * `fetchSoldComps`'s (`src/lib/booli/client.ts`) worst case: its own
 * fallback tree has exactly two own-render rungs (`own-playwright` +
 * `own-playwright-retry`), and it returns `rendersUsed: result.rung`, so a
 * single area's comps fetch costs AT MOST 2 renders.
 */
export const COMPS_MAX_RENDERS_PER_AREA = 2 as const;

/**
 * The worst-case pre-spend estimate for ONE area's comps fetch — mirrors
 * `estimateVisionCallSek`'s named-worst-case-estimator precedent (a REAL,
 * priced upper bound, never an arbitrary average).
 *
 * @returns the worst-case SEK cost of fetching comps for ONE area
 */
export function estimateCompsFetchSek(): number {
  return renderSek(COMPS_MAX_RENDERS_PER_AREA);
}

/**
 * `fetchAreaListings`'s own render rungs per till-salu PAGE — mirrors
 * `client.ts`'s `AREA_RENDER_RUNGS` (own-playwright + own-playwright-retry).
 * Hand-mirrored rather than imported for the same reason
 * `COMPS_MAX_RENDERS_PER_AREA` is: `client.ts` pulls in the Apify transport,
 * which this pure cost module (and its test) must not depend on. A drift guard
 * in `client.test.ts` asserts the two stay equal.
 */
export const AREA_RENDER_RUNGS_PER_PAGE = 2 as const;

/**
 * `fetchAreaListings`'s page cap per area — mirrors `client.ts`'s
 * `MAX_AREA_PAGES` (page 1 sequential + pages 2..N in parallel). Same
 * hand-mirroring rationale and drift guard as
 * `AREA_RENDER_RUNGS_PER_PAGE` above.
 */
export const AREA_MAX_PAGES_PER_AREA = 5 as const;

/**
 * CR-01 (14-REVIEW.md): ONE area's worst-case paid-render count. Before this
 * existed, `runSlice`'s pre-gate priced ONE render per area while
 * `fetchAreaListings` could perform up to `MAX_AREA_PAGES × AREA_RENDER_RUNGS`
 * = 10 — so `CAP_SEK_MAX` authorised a spend up to 10x below what the slice
 * could actually incur, and was therefore not enforceable.
 */
export const AREA_MAX_RENDERS_PER_AREA: number =
  AREA_MAX_PAGES_PER_AREA * AREA_RENDER_RUNGS_PER_PAGE;

/**
 * The worst-case pre-spend estimate for ONE area's till-salu sweep — mirrors
 * `estimateCompsFetchSek`/`estimateVisionCallSek`'s named-worst-case-estimator
 * precedent (a REAL, priced upper bound, never an average). Used by `runSlice`'s
 * step-3 cost pre-check, which must NEVER under-count.
 *
 * @returns the worst-case SEK cost of fetching every till-salu page for ONE area
 */
export function estimateAreaFetchSek(): number {
  return renderSek(AREA_MAX_RENDERS_PER_AREA);
}

/**
 * A conservative upper bound on a single BRF extraction call's input tokens.
 * A full årsredovisning iXBRL text is the dominant input-token cost; 60k
 * input tokens is chosen so `estimateBrfLookupSek` exceeds the ~0.71 SEK per
 * real call documented in `run-extraction.ts` — the two Allabrf `undici`
 * fetches that precede the extraction carry ZERO SEK (they are not Apify
 * renders — only latency).
 */
export const BRF_EXTRACT_INPUT_TOKENS_ESTIMATE = 60_000 as const;

/** The real output ceiling for the single BRF Haiku call (`extract.ts:268`'s `max_tokens: 2048`). */
export const BRF_EXTRACT_MAX_OUTPUT_TOKENS = 2048 as const;

/**
 * The worst-case pre-spend estimate for ONE BRF lookup's extraction call —
 * mirrors `estimateCompsFetchSek`/`estimateVisionCallSek`'s named-worst-case-
 * estimator precedent, built from the real Haiku cost model (`costSek`).
 *
 * @returns the worst-case SEK cost of ONE BRF extraction call
 */
export function estimateBrfLookupSek(): number {
  return costSek({
    input_tokens: BRF_EXTRACT_INPUT_TOKENS_ESTIMATE,
    output_tokens: BRF_EXTRACT_MAX_OUTPUT_TOKENS,
  });
}

/**
 * Phase 11 (DISC-04) — the per-search vision spend ceiling. This is a
 * DISTINCT, independently-tracked cap from `CAP_SEK_MAX`/`DISCOVERY_COST_CAP_SEK`
 * (which cover scrape+parse only, Phase 9) — 11-RESEARCH.md Pitfall 2 warns
 * explicitly against blending the two: a job that hits its scrape cap should
 * still report candidates with NO vision data, and a job that hits its vision
 * cap should stop running vision, not stop the whole job. Checked
 * incrementally BEFORE each Sonnet call (mirrors `runSlice`'s
 * check-before-spend discipline), never only after a call completes.
 *
 * Value (10 SEK) is ~1 SEK above the worst-case-all-25-candidates figure
 * (9.25 SEK, 11-RESEARCH.md Cost Math), giving a small safety margin while
 * remaining a real, enforceable ceiling.
 */
export const CAP_VISION_SEK_MAX = 10 as const;

/**
 * Composes ONE candidate's vision spend from its Haiku pre-filter usage
 * (always incurred) plus its Sonnet deep-pass usage (only incurred when the
 * pre-filter flags the candidate as worth a deep pass — `sonnetUsage` is
 * `null` otherwise). Reuses `costSek`/`costSekSonnet` (`src/lib/brf/cost.ts`)
 * unchanged — vision tokens are billed as ordinary input/output tokens by the
 * Anthropic API, so no new rate constants are defined here (11-RESEARCH.md
 * "Don't Hand-Roll": cost accounting).
 *
 * @param haikuUsage - token usage from the Haiku pre-filter call
 * @param sonnetUsage - token usage from the Sonnet deep-pass call, or `null`
 *   when the pre-filter did not flag this candidate for a deep pass
 * @returns this candidate's total vision spend in SEK
 */
export function visionCostSek(
  haikuUsage: ClaudeUsage,
  sonnetUsage: ClaudeUsage | null,
): number {
  const haikuSek = costSek(haikuUsage);
  const sonnetSek = sonnetUsage ? costSekSonnet(sonnetUsage) : 0;
  return haikuSek + sonnetSek;
}

/**
 * Anthropic's Standard-tier image-token estimate: ~1568 visual tokens per
 * image (documented rate this module's own doc comments reference — see
 * CR-01, 11-REVIEW.md). Used ONLY to build a real, priced worst-case
 * per-call estimate; never sent to the API itself.
 */
const IMAGE_TOKENS_STANDARD_TIER = 1568 as const;

/**
 * The number of independently-capped image SETS `runVisionForCandidate` sends
 * in one message: the Booli/bcdn.se URL set and the broker-gallery byte set,
 * each `.slice(0, CAP_IMAGES_PER_LISTING)`d on its own (`vision.ts`). WR-04
 * (14-REVIEW.md) — pricing only one of them understated the per-call worst
 * case by ~60%.
 */
const VISION_IMAGE_SETS_PER_CALL = 2 as const;

/**
 * The real per-call image ceiling: both independently-capped sets. Exported so
 * a test can pin it against `CAP_IMAGES_PER_LISTING` rather than a literal.
 */
export const VISION_MAX_IMAGES_PER_CALL: number =
  CAP_IMAGES_PER_LISTING * VISION_IMAGE_SETS_PER_CALL;

/** Conservative max output tokens per call (mirrors `max_tokens` in
 * `vision.ts`'s Haiku pre-filter (300) and Sonnet deep-pass (1024) calls). */
const HAIKU_MAX_OUTPUT_TOKENS = 300 as const;
const SONNET_MAX_OUTPUT_TOKENS = 1024 as const;

/**
 * `estimateVisionCallSek` — CR-01 (11-REVIEW.md): a REAL, priced worst-case
 * per-call estimate for ONE candidate's Haiku pre-filter + Sonnet deep-pass
 * call, mirroring `estimatedSliceCostSek`'s (`job.ts`) precedent of a named,
 * reusable pre-spend-gate helper tied to the actual cost model — NOT an
 * arbitrary `CAP_VISION_SEK_MAX / candidates.length` average.
 *
 * Worst case: `VISION_MAX_IMAGES_PER_CALL` images sent TWICE (once to Haiku,
 * once to Sonnet — `runVisionForCandidate` always runs the pre-filter, and
 * MAY run the full-image-set Sonnet deep pass), each image priced at the
 * Standard-tier ~1568-visual-token estimate, plus each call's `max_tokens`
 * ceiling billed as pure output. This is a genuine upper bound on what the
 * imminent call can cost — never an average that shrinks as the candidate
 * count grows.
 *
 * WR-04 (14-REVIEW.md): the per-call image count is `2 ×
 * CAP_IMAGES_PER_LISTING`, not `CAP_IMAGES_PER_LISTING` — `runVisionForCandidate`
 * caps the Booli URL set and the broker-gallery byte set INDEPENDENTLY
 * (`vision.ts`: `imageUrls.slice(0, CAP)` + `brokerImages.slice(0, CAP)`) and
 * sends both in the same message. Pricing one cap made this "genuine upper
 * bound" ~60% low, which is the wrong direction for a pre-spend gate.
 *
 * @returns the worst-case SEK cost of ONE candidate's full two-pass vision call
 */
export function estimateVisionCallSek(): number {
  const imageTokens = VISION_MAX_IMAGES_PER_CALL * IMAGE_TOKENS_STANDARD_TIER;

  const haikuUsage: ClaudeUsage = {
    input_tokens: imageTokens,
    output_tokens: HAIKU_MAX_OUTPUT_TOKENS,
  };
  const sonnetUsage: ClaudeUsage = {
    input_tokens: imageTokens,
    output_tokens: SONNET_MAX_OUTPUT_TOKENS,
  };

  return costSek(haikuUsage) + costSekSonnet(sonnetUsage);
}
