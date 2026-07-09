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
 * Computes the SEK cost of a discovery job from its Haiku intent-parse usage
 * and render count. Composes the existing `costSek` (Haiku) precedent with
 * the render-cost term used by `soldSourceCostSek` (`src/lib/market/cost.ts`).
 * Pure function — no side effects, no network.
 *
 * @param usage - Haiku token usage + render count
 * @returns the job's cost in SEK
 */
export function discoveryCostSek(usage: DiscoveryUsage): number {
  const renders = Number.isFinite(usage.renders) ? Math.max(0, usage.renders) : 0;
  const haikuSek = costSek(usage.haikuUsage);
  const renderSek = renders * USD_PER_RENDER * USD_SEK_RATE;
  return haikuSek + renderSek;
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
 * Worst case: `CAP_IMAGES_PER_LISTING` images sent TWICE (once to Haiku,
 * once to Sonnet — `runVisionForCandidate` always runs the pre-filter, and
 * MAY run the full-image-set Sonnet deep pass), each image priced at the
 * Standard-tier ~1568-visual-token estimate, plus each call's `max_tokens`
 * ceiling billed as pure output. This is a genuine upper bound on what the
 * imminent call can cost — never an average that shrinks as the candidate
 * count grows.
 *
 * @returns the worst-case SEK cost of ONE candidate's full two-pass vision call
 */
export function estimateVisionCallSek(): number {
  const imageTokens = CAP_IMAGES_PER_LISTING * IMAGE_TOKENS_STANDARD_TIER;

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
