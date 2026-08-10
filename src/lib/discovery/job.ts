import {
  fetchAreaListings,
  fetchListing,
  fetchSoldComps,
  isAllowedImageHost,
  DETAIL_ENRICH_WAIT_SECS,
  DETAIL_ENRICH_MAX_RETRIES,
  type SoldSourceQuery,
} from "@/lib/booli/client";
import { fetchBrokerListingPage } from "@/lib/broker/fetch-broker-page";
import { fetchBrokerImageBytes, type BrokerImageBytes } from "@/lib/broker/broker-images";
import {
  resolveArea,
  splitAreaQuery,
  MAX_AREAS_PER_SEARCH,
  type AreaResolution,
} from "@/lib/discovery/resolve-area";
import {
  toCandidate,
  filterCandidates,
  pricePerSqm,
  type DiscoveryCandidate,
} from "@/lib/discovery/candidate";
import {
  discoveryCostSek,
  renderSek,
  estimateAreaFetchSek,
  estimateCompsFetchSek,
  estimateBrfLookupSek,
  AREA_RENDER_RUNGS_PER_PAGE,
  CAP_VISION_SEK_MAX,
} from "@/lib/discovery/cost";
import { runVisionPass } from "@/lib/discovery/vision";
import { extractOrientationFromDescription } from "@/lib/discovery/sun-path";
import { normalizeSoldOutput, type SoldComp } from "@/lib/market/sold-schema";
import { computeAreaComps, MIN_COMPS_FOR_CONFIDENCE } from "@/lib/discovery/area-comps";
import {
  normalizeForConfounders,
  buildHolisticBrief,
  WIDENED_SIZE_BAND_PCT,
  WIDENED_MAX_AGE_MONTHS,
} from "@/lib/discovery/confounder-guard";
import {
  lookupBrfSummary,
  BRF_TOP_N,
  MAX_BILLED_CALLS_PER_LOOKUP,
} from "@/lib/discovery/brf-lookup";
import type { AreaCompsSummary, BrfSummary } from "@/lib/discovery/holistic-schema";
import type { DiscoveryFilter } from "@/lib/discovery/filter-schema";
import type { createClient } from "@/lib/supabase/server";

/**
 * job.ts — `runSlice`, the claim-row-driven orchestrator that runs exactly
 * ONE bounded slice of a discovery job: incremental cap gate → area resolve
 * → cost pre-check → kill-switch scrape → PII-safe persist. `runVisionForJob`
 * is a SEPARATE, additive post-scrape pass (Phase 11 DISC-04) — it does NOT
 * run inside `runSlice` itself; a caller invokes it once a job reaches its
 * terminal scrape state, so `runSlice`'s own incremental cap/kill-switch/
 * persist behavior is completely unchanged by Phase 11.
 *
 * Pitfall 4 discipline (09-RESEARCH.md lines 381-385): every counter this
 * function reads (`candidate_count`, `cost_sek_total`, `processed_count`,
 * `results`) comes from `claimedRow` — the row `claim_discovery_slice`'s
 * `RETURNING` clause handed back, freshly locked. This function NEVER issues
 * a fresh `SELECT` of the same job between claim and persist; doing so would
 * reopen the exact stale-counter race the atomic claim exists to prevent.
 */

/**
 * The minimal shape of a Supabase client this module needs (one table
 * write). Mirrors `generate-report.ts`'s `StatusWriter` typing precedent:
 * derive the real client type from `createClient`'s return so both the
 * production Supabase client and a test's minimal awaitable-chain mock
 * satisfy the same structural type without over-constraining the mock.
 */
export type DiscoveryJobsWriter = Awaited<ReturnType<typeof createClient>>;

/** The row shape returned by `claim_discovery_slice` (authoritative, locked). */
export interface ClaimedDiscoveryJob {
  id: string;
  user_id: string;
  status: string;
  filters: DiscoveryFilter;
  cap_candidates: number;
  cap_sek: number;
  processed_count: number;
  candidate_count: number;
  cost_sek_total: number;
  results: unknown[];
}

/**
 * Prices a known render count for this slice — used for the POST-scrape
 * persisted ledger, where `renders` is the real count `fetchAreaListings`
 * reported (CR-01, 14-REVIEW.md). It deliberately ignores the (comparatively
 * tiny) Haiku parse cost already spent in `startDiscovery`.
 *
 * The step-3 PRE-spend gate does NOT use this with an assumed count: one
 * `fetchAreaListings` call walks up to `MAX_AREA_PAGES` pages × two own-render
 * rungs, so the gate prices `estimateAreaFetchSek()` per area — the real
 * worst case. Assuming one render per area here made the gate a systematic
 * UNDER-count of up to 10x, which is the one direction a spend cap must never
 * err in.
 */
function estimatedSliceCostSek(renders: number = 1): number {
  return discoveryCostSek({
    haikuUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    renders,
  });
}

/**
 * Writes the terminal/incremental status update for `claimedRow.id`.
 *
 * WR-04 (11-REVIEW.md): returns `true`/`false` so a caller whose write is
 * spend-sensitive (e.g. `runVisionForJob`, where Anthropic has already been
 * billed by the time this runs) can detect and surface a failed persist
 * instead of it being silently swallowed behind a log line only. `runSlice`'s
 * own call sites are unaffected — they do not read the return value, exactly
 * mirroring their pre-existing fire-and-forget behavior.
 */
async function updateJob(
  supabase: DiscoveryJobsWriter,
  jobId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from("discovery_jobs").update(payload).eq("id", jobId);
  if (error) {
    console.error("[discovery-job] update failed", { jobId, code: error.code });
    return false;
  }
  return true;
}

/**
 * Runs exactly one bounded slice of `claimedRow`'s discovery job.
 *
 * Order (each step gates the next — no step is reordered):
 *  1. INCREMENTAL CAP GATE — already at/over cap_candidates or cap_sek →
 *     flip to done+cap_reached, no scrape (DISC-02: caps checked BEFORE the
 *     next render, not only at job end).
 *  2. Resolve the free-text area to a Booli areaId; unresolvable → failed.
 *  3. COST PRE-CHECK — would this slice's estimated spend push the job over
 *     cap_sek? → done+cap_reached, no scrape (gates the spend, not just the
 *     already-spent total).
 *  4. KILL SWITCH — `fetchAreaListings` throwing IS the CAPTCHA/blocking
 *     signal from the owned client; degrade the job and halt (DISC-07: never
 *     retry into more spend).
 *  5. Map + deterministically filter the scraped listings to PII-safe
 *     candidates, capped to the remaining candidate budget.
 *  6. PERSIST — one UPDATE writing the appended PII-safe results and the
 *     counters computed from `claimedRow` (never re-read), flipping to done
 *     if this slice's persisted count reaches cap_candidates.
 *
 * @param supabase - a Supabase client scoped to write `discovery_jobs`
 * @param claimedRow - the row returned by `claim_discovery_slice` (authoritative)
 */
export async function runSlice(
  supabase: DiscoveryJobsWriter,
  claimedRow: ClaimedDiscoveryJob,
): Promise<void> {
  const { id: jobId, filters, cap_candidates, cap_sek, candidate_count, cost_sek_total } =
    claimedRow;

  // (1) INCREMENTAL CAP GATE — read from the claimed row, never a fresh SELECT.
  if (candidate_count >= cap_candidates || cost_sek_total >= cap_sek) {
    await updateJob(supabase, jobId, { status: "done", cap_reached: true });
    return;
  }

  // (2) Resolve the area(s). A multi-area query ("Södermalm och Vasastan") is
  // split into individual names and each is resolved independently — Booli has
  // no single "Södermalm och Vasastan" area, so resolving the combined string
  // always missed and silently failed the job. A miss on ALL names is an honest
  // "we don't cover that area yet" failure, never a fabricated areaId.
  const areaNames = splitAreaQuery(filters.areaQuery);
  const resolutions: AreaResolution[] = [];
  for (const name of areaNames) {
    const r = await resolveArea(name, supabase);
    if (r) resolutions.push(r);
  }
  // De-dupe by areaId (two names could resolve to the same area).
  const areaIds = [...new Set(resolutions.map((r) => r.areaId))];
  if (areaIds.length === 0) {
    // Diagnostic (previously silent): surface WHICH query couldn't resolve so a
    // failed job is debuggable from the server logs.
    console.error("[discovery-job] area resolution failed", {
      jobId,
      areaQuery: filters.areaQuery,
    });
    await updateJob(supabase, jobId, { status: "failed" });
    return;
  }

  // (3) COST PRE-CHECK — gates the SPEND for ALL area renders this slice, not
  // just the already-recorded total. CR-01 (14-REVIEW.md): priced at
  // `estimateAreaFetchSek()` per area — `fetchAreaListings`'s real worst case
  // (`MAX_AREA_PAGES` pages × two own-render rungs), NOT one render per area.
  // The gate must never authorise less than the slice can actually spend.
  const projectedCost = cost_sek_total + estimateAreaFetchSek() * areaIds.length;
  if (projectedCost > cap_sek) {
    await updateJob(supabase, jobId, { status: "done", cap_reached: true });
    return;
  }

  // (4) KILL SWITCH — a thrown error from the owned Booli client IS the
  // CAPTCHA/blocking signal (transport.ts's HIGH-1 discipline: it never
  // returns [] to mean "dead", it throws). Scrape every area CONCURRENTLY
  // (D-01) via Promise.allSettled — mirroring fetchAreaListings's own
  // pages-2..N pattern (booli/client.ts:719-736) one level up: collect every
  // success, and remember if any area threw. Only when NOTHING came back do
  // we decide — a throw with zero results is the block signal (degrade),
  // zero results with no throw is a genuinely empty area (done). This
  // collapses sum(area times) to max(area times) for multi-area queries
  // (RESEARCH Pitfall 1/2) while staying pure in-memory aggregation — zero DB
  // writes inside this loop, preserving D-03's race-free cost-cap invariant.
  const settled = await Promise.allSettled(
    areaIds.map((areaId) => fetchAreaListings(areaId, filters.objectType)),
  );
  const raw: Record<string, unknown>[] = [];
  let anyThrew = false;
  let rendersUsed = 0;
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      // CR-01: the REAL render count the client reported (1..MAX_AREA_PAGES ×
      // AREA_RENDER_RUNGS), never a hardcoded 1.
      rendersUsed += outcome.value.rendersUsed;
      raw.push(...outcome.value.listings);
    } else {
      // A thrown area means page 1 exhausted EVERY rung — those renders were
      // paid for and must be recorded, not written off as free.
      rendersUsed += AREA_RENDER_RUNGS_PER_PAGE;
      anyThrew = true;
      console.error("[discovery-job] kill-switch degraded", {
        jobId,
        areaId: areaIds[i],
        code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
      });
    }
  }
  if (raw.length === 0) {
    // CR-01: even a fully-failed sweep burned real renders (page 1 exhausting
    // both rungs per area). Persist that spend — silently discarding it let
    // repeated blocked slices spend without ever advancing `cost_sek_total`
    // toward `cap_sek`.
    await updateJob(supabase, jobId, {
      status: anyThrew ? "degraded" : "done",
      cost_sek_total: cost_sek_total + estimatedSliceCostSek(rendersUsed),
    });
    return;
  }

  // (5) Map to the PII-safe allowlist shape, de-dupe across areas (a listing on
  // an area border can surface in two area searches), then deterministically
  // filter — NEVER Claude-driven, and capped to the remaining candidate budget
  // so a single slice cannot blow past cap_candidates.
  const candidates = dedupeCandidates(raw.map(toCandidate));
  const remaining = Math.max(0, cap_candidates - candidate_count);
  const { shown, scanned } = filterCandidates(candidates, filters, remaining);

  // (6) PERSIST — a single UPDATE computed entirely from claimedRow's values
  // (Pitfall 4), never a fresh SELECT of the same job.
  const newCandidateCount = candidate_count + shown.length;
  const newProcessedCount = claimedRow.processed_count + scanned;
  const sliceCostSek = discoveryCostSek({
    haikuUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    renders: rendersUsed,
  });
  const newCostSekTotal = cost_sek_total + sliceCostSek;
  const capReached = newCandidateCount >= cap_candidates;

  // A successful sweep is TERMINAL. `fetchAreaListings` walks the till-salu
  // pagination to `MAX_AREA_PAGES` ITSELF (page 1 sequentially, then pages
  // 2..N in parallel — booli/client.ts) and stops early on a short page, so
  // once a slice returns there is no further page a later slice could fetch:
  // the job is done whether or not it hit `cap_candidates`. (CR-01,
  // 14-REVIEW.md: this used to claim `fetchAreaListings` was "one-shot (no
  // pagination)", which the client has not been true of since the &page=N
  // walk landed — the terminality conclusion is unchanged, but it rests on
  // the walk being EXHAUSTIVE, not absent.) Gating `done` on `capReached`
  // left any UNDER-cap search
  // (e.g. few 1-rok under 4M) stuck in "processing" forever — no second page
  // existed to reach the cap, the 5-min stale-reclaim window matched the
  // client's 5-min poll timeout so no further slice ran in time, and the vision
  // pass (gated on status "done") therefore never started → no results, "Det
  // tar längre tid än väntat". `cap_reached` still records whether we truncated.
  await updateJob(supabase, jobId, {
    results: [...claimedRow.results, ...shown],
    candidate_count: newCandidateCount,
    processed_count: newProcessedCount,
    cost_sek_total: newCostSekTotal,
    status: "done",
    cap_reached: capReached,
  });
}

/**
 * `claimVisionSlice` — CR-04 (11-REVIEW.md) — the atomic single-row CAS
 * status transition (`"done"` → `"vision_processing"`) that gates
 * `runVisionForJob`. Mirrors `generate-report.ts`'s conditional-update
 * pattern exactly: `.update({...}).eq("id", id).eq("status", "done")
 * .select().maybeSingle()` — a single conditional UPDATE that only flips the
 * row when it is STILL `"done"`, atomically, so two concurrent callers can
 * never both observe a winning transition. `status` is a bare `text` column
 * with no check constraint (`010_discovery_jobs.sql`), so `"vision_processing"`
 * is a safe new status word — no migration needed, mirroring that file's own
 * "a new status word never needs DDL" precedent.
 *
 * Without this, two different ticks that BOTH successfully ran the final
 * scrape slice in an overlapping window (a client tab racing the daily sweep
 * resuming the same job, or a retried Server Action invocation) could both
 * observe `status === "done"` via a plain `SELECT` and both call
 * `runVisionForJob`, each running a full, uncoordinated `runVisionPass` over
 * the SAME `results` array — doubling real Anthropic spend with no cap
 * coordination between the two concurrent passes (each tracks its own
 * independent running total against the same `CAP_VISION_SEK_MAX`).
 *
 * Note: this does NOT use `.is()`/`.or()` NULL-filter handling
 * (`postgrest-eq-null.md`) because `status` is NOT NULL with a default
 * (`010_discovery_jobs.sql:21`) — a plain `.eq("status", "done")` is the
 * correct, safe predicate here; the NULL-filter trap only applies to
 * nullable columns.
 *
 * @param supabase - a Supabase client scoped to write `discovery_jobs`
 * @param jobId - the job to attempt the `done` → `vision_processing` claim on
 * @returns the job's `results` if THIS call won the CAS transition, or
 *   `null` if the row was not in `"done"` status (already claimed by another
 *   invocation, still processing, or terminal in some other state) — a
 *   benign no-op, never an error, mirroring `claim_discovery_slice`'s own
 *   "zero rows IS the outcome" contract.
 */
export async function claimVisionSlice(
  supabase: DiscoveryJobsWriter,
  jobId: string,
): Promise<DiscoveryCandidate[] | null> {
  const { data: claimed, error } = await supabase
    .from("discovery_jobs")
    .update({ status: "vision_processing" })
    .eq("id", jobId)
    .eq("status", "done")
    .select("results")
    .maybeSingle();

  if (error) {
    // Fail closed: never proceed to spend on vision if the claim errored.
    console.error("[discovery-vision-job] claim failed", { jobId, code: error.code });
    return null;
  }
  if (!claimed) {
    // Another invocation already won the transition, or the job is not
    // (yet, or no longer) in "done" status — benign no-op.
    return null;
  }

  // WR-03 (shard-1 review): this raw `.select("results")` bypasses
  // discoveryCandidateSchema's read-path `imageUrls` allowlist transform, and
  // these URLs flow straight into `runVisionPass` → Anthropic's server-side
  // image fetch (`source: { type: "url" }`). Re-apply `isAllowedImageHost`
  // here so a tampered/corrupted persisted row can never make Anthropic fetch
  // an arbitrary host — the defense-in-depth the write path alone must not be
  // the sole guarantor of.
  const results = (claimed.results ?? []) as unknown as DiscoveryCandidate[];
  return results.map((candidate) =>
    candidate.imageUrls
      ? { ...candidate, imageUrls: candidate.imageUrls.filter(isAllowedImageHost) }
      : candidate,
  );
}

/**
 * `runVisionForJob` — Phase 11 (DISC-04), extended by Phase 14
 * (ANL-01/02/03) — a SEPARATE, additive post-scrape pass that runs a
 * completed job's persisted candidates through the FIVE-step pipeline
 * enrich → comps → BRF → vision → brief, then writes the annotated results
 * back in ONE UPDATE.
 *
 * Pipeline order (Phase 14, D-14-08): comps run BEFORE BRF deliberately —
 * comps are per-area/amortized and cheap, and every candidate needs them for
 * the holistic-brief fallback, whereas BRF only ever covers the D-14-01
 * top-N. Vision runs last of the three spend sources so it sees whatever
 * budget comps+BRF leave behind. `comps`/`brfSummary`/`holisticBrief` ride in
 * the JSONB `results` column as additive-nullable candidate fields — the
 * same established pattern as `vision`/`visionSkippedReason` — for Phase 15
 * to render.
 *
 * This is intentionally NOT called from inside `runSlice` — it is invoked by
 * the caller (`tickDiscovery`/`sweep/route.ts`) ONLY once a job's scrape
 * phase has reached a terminal state (`status === "done"`), so `runSlice`'s
 * own incremental cap/kill-switch/persist behavior (and its existing tests)
 * are completely unaffected by Phase 11.
 *
 * `CAP_VISION_SEK_MAX` is tracked ENTIRELY separately from `cost_sek_total`
 * (the scrape cap) — this pass never reads or writes `cost_sek_total`, so a
 * job that hit its scrape cap can still receive vision, and a job that hits
 * its OWN vision cap simply stops running vision (never fails the job).
 * Comps + BRF + vision all share this ONE `CAP_VISION_SEK_MAX` pool
 * (D-14-08) — an intended, expected consequence is that a job with a large
 * candidate set now hits `"cost_cap"` MORE often than pre-Phase-14, since
 * less of the shared pool remains for Sonnet calls once comps/BRF have
 * already spent their share.
 *
 * CR-02 (11-REVIEW.md): `runVisionPass` already catches per-candidate errors
 * internally (a single failing candidate degrades to
 * `visionSkippedReason: "vision_error"` and the pass continues), so this
 * function should never see a throw from it under normal operation. The
 * try/catch below is defense-in-depth ONLY — this function must NEVER
 * rethrow to its caller (`tickDiscovery`/`sweep/route.ts`), since neither
 * call site wraps it: an uncaught throw here would propagate out of the
 * Server Action / route handler entirely, leaving the job's already-"done"
 * scrape results with no further recovery path (the job can never be
 * re-claimed once terminal).
 *
 * WR-04 (11-REVIEW.md): by the time `updateJob` runs here, Anthropic has
 * ALREADY been billed for every candidate's Haiku/Sonnet calls inside
 * `runVisionPass` — a swallowed persist failure would silently lose that
 * spend with no signal beyond `updateJob`'s own generic log line. This
 * function now checks `updateJob`'s return value and logs a distinguishable
 * "vision computed but not persisted" message (GDPR-safe: `{ jobId, code:
 * "VISION_PERSIST_FAILED" }` only — never candidate data or claim text) so
 * an operator can tell "vision spend was lost" apart from an ordinary
 * transient write-log line.
 *
 * CR-04 (11-REVIEW.md): the caller must have already won `claimVisionSlice`'s
 * atomic `"done"` → `"vision_processing"` CAS transition before invoking this
 * function — this function's OWN final write always restores `status` to
 * `"done"` (both on success AND on the defense-in-depth catch branch), so the
 * row never wedges at `"vision_processing"` forever. A wedged row would be
 * unrecoverable: `claimVisionSlice` only transitions FROM `"done"`, and
 * `claim_discovery_slice`'s RPC only claims `('pending','processing')`, so
 * neither the vision claim nor the scrape claim could ever reclaim a row
 * stuck at `"vision_processing"`.
 *
 * @param supabase - a Supabase client scoped to write `discovery_jobs`
 * @param jobId - the job whose `results` should be vision-annotated
 * @param results - the job's current persisted candidates (read-only input —
 *   the caller passes `claimedRow.results`/the just-persisted results, never
 *   a fresh re-SELECT, mirroring `runSlice`'s Pitfall 4 discipline)
 */
/**
 * Max DETAIL-page fetches per vision pass. Area-search entities carry no
 * images, so the shortlist must be detail-fetched to feed vision — but each
 * fetch is a paid Apify render, so this is a hard bound on that spend (the top
 * `VISION_ENRICH_LIMIT` candidates, in RENO-POTENTIAL order — see
 * `enrichmentVisitOrder`). NOTE: these enrichment renders are not yet folded
 * into the persisted cost ledger — that joins the existing deferred
 * cost-fidelity follow-up; the count bound keeps worst-case spend small and
 * fixed regardless.
 */
const VISION_ENRICH_LIMIT = 8;

/**
 * Reno-potential enrichment pre-rank (SPEC §2.1, fixes defect D1).
 *
 * The enrichment budget (`VISION_ENRICH_LIMIT`) is smaller than the candidate
 * set, so the ORDER in which we spend detail-fetches decides which candidates
 * ever reach vision. Booli's own relevance order buried dated/below-market
 * flats (the Ringvägen 122 miss) below the cut. For a renovation search the
 * priority is inverted: a flat that is CHEAP per m² for its area and sits in
 * OLDER stock is exactly the renovation target we must analyze — so it should
 * win the fetch, not get truncated away.
 *
 * Signal (both available pre-vision, no extra network cost):
 *  - below-market: kr/m² below the candidate-set median → primary weight.
 *  - aged stock:   older `constructionYear` → secondary tiebreaker.
 * Missing data contributes 0 (never negative-by-omission), so a candidate is
 * never penalised for a null we simply don't have.
 */
const RENO_AGE_PIVOT = 1975; // at/newer than this → no age bonus (modern stock)
const RENO_AGE_FLOOR = 1900; // at/older than this → full age bonus
const RENO_AGE_WEIGHT = 0.25; // age is a tiebreaker, not a co-equal of below-market

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * The candidate-set median kr/m² over every candidate with a computable
 * `pricePerSqm` (the market reference for "below-market"). Returns null when no
 * candidate has one, in which case the below-market signal is simply absent.
 */
export function candidateMedianPricePerSqm(candidates: DiscoveryCandidate[]): number | null {
  const ppsqm = candidates
    .map((c) => pricePerSqm(c))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (ppsqm.length === 0) return null;
  const mid = Math.floor(ppsqm.length / 2);
  return ppsqm.length % 2 === 0 ? (ppsqm[mid - 1] + ppsqm[mid]) / 2 : ppsqm[mid];
}

/** Pure reno-potential priority for one candidate (higher = enrich sooner). */
export function enrichmentPriority(
  candidate: DiscoveryCandidate,
  medianPricePerSqm: number | null,
): number {
  const ppsqm = pricePerSqm(candidate);
  const belowMarket =
    medianPricePerSqm && medianPricePerSqm > 0 && ppsqm !== null
      ? clamp((medianPricePerSqm - ppsqm) / medianPricePerSqm, -1, 1)
      : 0;
  const year = candidate.constructionYear;
  const agedBonus =
    year !== null ? clamp((RENO_AGE_PIVOT - year) / (RENO_AGE_PIVOT - RENO_AGE_FLOOR), 0, 1) : 0;
  return belowMarket + RENO_AGE_WEIGHT * agedBonus;
}

/**
 * The order in which `enrichCandidateImages` should VISIT candidate indices —
 * highest reno-potential first. Returns ALL indices (the enrich loop still
 * filters to image-less ones and stops at `limit`); we only change the visit
 * order, never the array itself, so `out[i]`/broker-map indices stay aligned
 * with the input. Stable: equal-priority candidates keep Booli's original
 * order as the tiebreak.
 */
export function enrichmentVisitOrder(candidates: DiscoveryCandidate[]): number[] {
  const median = candidateMedianPricePerSqm(candidates);
  const priorities = candidates.map((c) => enrichmentPriority(c, median));
  return candidates
    .map((_, i) => i)
    .sort((a, b) => priorities[b] - priorities[a] || a - b);
}

/** Max broker-gallery images fetched (as bytes) per candidate — bounds bandwidth. */
const BROKER_IMAGES_PER_CANDIDATE = 4;

/** Result of enrichment: the (image-populated) candidates + per-index broker bytes. */
export interface EnrichmentResult {
  candidates: DiscoveryCandidate[];
  /** candidate array index → broker-gallery bytes (analyze-only, transient — never persisted). */
  brokerImages: Map<number, BrokerImageBytes[]>;
}

/**
 * Detail-fetches up to `limit` candidates that lack images, populating
 * `imageUrls` (from the bcdn.se detail gallery) and backfilling
 * floor/constructionYear/orientation/balcony from the richer detail entity.
 * ALSO fetches that listing's BROKER gallery images as bytes (through the SSRF
 * guard, analyze-only) — e.g. bathroom photos Booli lacks — returned in a
 * per-index map for the vision pass, NEVER persisted (GDPR: no stored broker
 * imagery). Returns NEW data; the input is never mutated. Never throws — a
 * failed/image-less detail or broker fetch just leaves that candidate as-is
 * (vision then skips or analyzes whatever it has), so enrichment can only ADD
 * coverage, never break a job.
 */
export async function enrichCandidateImages(
  candidates: DiscoveryCandidate[],
  limit: number,
): Promise<EnrichmentResult> {
  const out = [...candidates];
  const brokerImages = new Map<number, BrokerImageBytes[]>();
  let fetched = 0;
  // Visit in reno-potential order (below-market + aged first), NOT Booli's
  // relevance order, so the limited enrichment budget lands on the actual
  // renovation targets rather than getting truncated away (SPEC §2.1, D1).
  // `out` stays in input order — only the visit sequence changes — so `out[i]`
  // and the broker-image map indices remain aligned with the caller's array.
  for (const i of enrichmentVisitOrder(out)) {
    if (fetched >= limit) break;
    const c = out[i];
    if (c.imageUrls && c.imageUrls.length > 0) continue; // already has images
    if (!c.sourceListingUrl) continue; // nothing to fetch
    fetched += 1;
    try {
      // 13-04 Task 3 (GAP-2): bounded opts — a blocked/slow detail page
      // cannot burn the unbounded 240s/3-retry x 2-rung default here. Never
      // affects fetchListing's other call site (analyze.ts:70, no opts).
      const raw = await fetchListing(c.sourceListingUrl, {
        waitSecs: DETAIL_ENRICH_WAIT_SECS,
        maxRequestRetries: DETAIL_ENRICH_MAX_RETRIES,
      });
      const detail = toCandidate(raw);
      out[i] = {
        ...c,
        imageUrls: detail.imageUrls,
        floor: c.floor ?? detail.floor,
        constructionYear: c.constructionYear ?? detail.constructionYear,
        orientation: c.orientation ?? detail.orientation,
        balcony: c.balcony ?? detail.balcony,
      };

      // Broker gallery (analyze-only): the detail entity carries the broker
      // listing URL; fetch its gallery through the SSRF guard as bytes so
      // vision sees photos (e.g. bathroom) Booli often omits. Fully best-effort.
      const brokerUrl = typeof raw.agencyListingUrl === "string" ? raw.agencyListingUrl : null;
      if (brokerUrl) {
        try {
          const broker = await fetchBrokerListingPage(brokerUrl);
          if (broker) {
            // Orientation v2: the broker description is often richer than
            // Booli's ("vardagsrum i söderläge med kvällssol"). If we still
            // have no orientation (Booli's description/detail yielded no
            // väderstreck), derive it from the broker description — same
            // deterministic extractor, better source.
            if (!out[i].orientation && broker.description) {
              const derived = extractOrientationFromDescription(broker.description);
              if (derived) out[i] = { ...out[i], orientation: derived };
            }
            if (broker.images.length > 0) {
              const bytes = await fetchBrokerImageBytes(broker.images, BROKER_IMAGES_PER_CANDIDATE);
              if (bytes.length > 0) brokerImages.set(i, bytes);
            }
          }
        } catch {
          // Broker enrichment is a pure bonus — never let it affect the job.
        }
      }
    } catch (error) {
      console.error("[discovery-job] detail enrichment failed (non-fatal)", {
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }
  return { candidates: out, brokerImages };
}

/**
 * Builds the synthesized `SoldSourceQuery` `fetchSoldComps` needs from a
 * resolved `areaId` alone. `lat`/`lng`/`booliId` are declared-but-unread by
 * `fetchSoldComps`'s body (it only calls `resolveAreaId(query)` and
 * `buildSlutpriserUrl(...)`), and with exactly ONE id in the `breadcrumbs`
 * array every tier branch of `resolveAreaId` degenerates to `ids[0]` — so a
 * single-crumb, zero-valued query is a valid, verified way to force a
 * specific areaId through the existing tier-ladder resolver without a real
 * breadcrumb ladder. `objectType: null` is an accepted limitation:
 * `runVisionForJob` has no `filters` in scope and D-14-11 forbids a
 * signature change to get one, and `computeAreaComps`'s own objectType
 * clause only narrows "when both sides known" — a `null` here simply never
 * narrows, it never fabricates a wrong filter.
 */
function buildCompsQuery(areaId: string): SoldSourceQuery {
  return {
    lat: 0,
    lng: 0,
    booliId: null,
    breadcrumbs: [{ url: `https://www.booli.se/x?areaIds=${areaId}` }],
    tier: "building",
    objectType: null,
  };
}

/** The result of `resolveCompsForCandidates` — one `AreaCompsSummary` per
 * candidate index that got a resolvable area + comps, plus the spend/skip
 * bookkeeping `runVisionForJob` folds into its shared budget pool. */
export interface CompsResolution {
  byIndex: Map<number, AreaCompsSummary>;
  spentSek: number;
  areasFetched: number;
  areasSkippedForBudget: number;
}

/**
 * `resolveCompsForCandidates` — ANL-02: wires real renovated-vs-unrenovated
 * area comps into every enriched discovery candidate, resolved from that
 * candidate's OWN `areaLabel` (Booli's own `descriptiveAreaName`, already
 * carried on every candidate — no `runVisionForJob` signature change per
 * D-14-11).
 *
 * Comps are fetched ONCE PER DISTINCT resolved areaId, never once per
 * candidate — double-counting them per candidate would be real money.
 * Two different area LABELS can resolve to the same areaId (a Booli quirk),
 * so the fetch set is de-duped by areaId, not by label. Both the area
 * RESOLUTION step and the comps FETCH step run concurrently
 * (`Promise.allSettled`), so wall clock is max(area times), not
 * sum(area times) — the same discipline `runSlice`'s own area loop already
 * uses one level up.
 *
 * Budget is a pre-gate (check-before-spend, mirroring `runVisionPass`'s own
 * discipline): the allowed area count is computed from `opts.budgetSek`
 * BEFORE any network call, never after. Every failure path (an unresolvable
 * label, a throwing comps fetch, a thin comp segment, budget exhaustion)
 * degrades this candidate's `areaComps` to absent — this function NEVER
 * throws and NEVER fails the tick.
 *
 * Only the pre-AGGREGATED `AreaCompsSummary` is ever stored — the raw
 * `SoldComp[]` fetched per area lives in an in-memory `Map` local to this
 * call only, never reaching the returned `CompsResolution` or persistence
 * (14-RESEARCH.md Pitfall 5).
 *
 * @param supabase - a Supabase client scoped to the shared area-resolution cache
 * @param candidates - the job's enriched candidate set (read-only input)
 * @param opts.jobId - for GDPR-safe, coded non-fatal logging only
 * @param opts.budgetSek - the SEK budget available for comps fetches THIS call
 * @param opts.asOf - ISO "YYYY-MM-DD" reference date for the comps recency
 *   filter (defaults to today)
 */
export async function resolveCompsForCandidates(
  supabase: DiscoveryJobsWriter,
  candidates: DiscoveryCandidate[],
  opts: { jobId: string; budgetSek: number; asOf?: string },
): Promise<CompsResolution> {
  const { jobId } = opts;
  // Mutable accumulators declared OUTSIDE the try block so the catch below
  // can return whatever partial progress was made before an unexpected
  // error, rather than discarding it (item f: never throw, never lose
  // already-computed work).
  const byIndex = new Map<number, AreaCompsSummary>();
  let spentSek = 0;
  let areasFetched = 0;
  let areasSkippedForBudget = 0;

  try {
    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

    // (a) Group candidate indices by areaLabel — a candidate without one is
    // skipped honestly (no comps, no fabricated area). First
    // MAX_AREAS_PER_SEARCH distinct labels, first-seen order, hard-bounding
    // the number of resolutions/fetches exactly like runSlice's own area
    // handling.
    const labelToIndices = new Map<string, number[]>();
    for (let i = 0; i < candidates.length; i++) {
      const label = candidates[i].areaLabel;
      if (!label || !label.trim()) continue;
      const indices = labelToIndices.get(label) ?? [];
      indices.push(i);
      labelToIndices.set(label, indices);
    }
    const allLabels = [...labelToIndices.keys()].slice(0, MAX_AREAS_PER_SEARCH);

    // (b) Budget pre-gate BEFORE any network work.
    const allowedAreas = Math.max(0, Math.floor(opts.budgetSek / estimateCompsFetchSek()));
    const labels = allLabels.slice(0, allowedAreas);
    areasSkippedForBudget = allLabels.length - labels.length;

    if (labels.length === 0) {
      return { byIndex, spentSek, areasFetched, areasSkippedForBudget };
    }

    // (c) Resolve the allowed labels CONCURRENTLY. A null resolution is
    // logged identically to a throw (the Phase 08-02 fallback-walker
    // precedent) — the failure trail is equally visible either way.
    const resolutions = await Promise.allSettled(labels.map((label) => resolveArea(label, supabase)));
    const areaIdByLabel = new Map<string, string>();
    for (let i = 0; i < resolutions.length; i++) {
      const outcome = resolutions[i];
      const label = labels[i];
      if (outcome.status === "rejected") {
        console.error("[discovery-job] area resolution for comps degraded (non-fatal)", {
          jobId,
          areaLabel: label,
          code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
        });
        continue;
      }
      const resolution = outcome.value;
      // `== null` (not `=== null`): resolveArea's real contract returns
      // `AreaResolution | null`, but a test double or a future caller
      // returning `undefined` must degrade identically — never crash into
      // the whole-body catch over a loose-vs-strict nullish distinction.
      if (resolution == null) {
        console.error("[discovery-job] area resolution for comps degraded (non-fatal)", {
          jobId,
          areaLabel: label,
          code: "AREA_UNRESOLVED",
        });
        continue;
      }
      areaIdByLabel.set(label, resolution.areaId);
      // A live probe is a real Apify render.
      if (resolution.source === "probe") {
        spentSek += renderSek(1);
      }
    }

    // Build the per-candidate-index areaId map, then de-dupe the fetch set
    // BY areaId — two labels resolving to the same id must produce ONE fetch.
    const areaIdByIndex = new Map<number, string>();
    for (const label of labels) {
      const areaId = areaIdByLabel.get(label);
      if (!areaId) continue;
      for (const idx of labelToIndices.get(label) ?? []) {
        areaIdByIndex.set(idx, areaId);
      }
    }
    const areaIds = [...new Set(areaIdByIndex.values())];

    if (areaIds.length === 0) {
      return { byIndex, spentSek, areasFetched, areasSkippedForBudget };
    }

    // (d) Fetch comps CONCURRENTLY, once per distinct areaId. `fetchSoldComps`
    // THROWS on an unresolvable area and on transport failure — neither may
    // fail the tick.
    const fetches = await Promise.allSettled(
      areaIds.map((areaId) => fetchSoldComps(buildCompsQuery(areaId))),
    );
    const compsByAreaId = new Map<string, SoldComp[]>();
    for (let i = 0; i < fetches.length; i++) {
      const outcome = fetches[i];
      const areaId = areaIds[i];
      if (outcome.status === "rejected") {
        console.error("[discovery-job] comps fetch degraded (non-fatal)", {
          jobId,
          areaId,
          code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
        });
        continue;
      }
      spentSek += renderSek(outcome.value.rendersUsed);
      compsByAreaId.set(areaId, normalizeSoldOutput(outcome.value.data));
      areasFetched += 1;
    }

    // (e) Per candidate: aggregate over the shared per-area comps array —
    // pure array math, costs nothing extra, deliberately per-candidate
    // (SPEC §2.6's widen-or-downgrade rule). NEVER store the raw SoldComp[]
    // anywhere on the candidate (14-RESEARCH.md Pitfall 5) — only the
    // AreaCompsSummary aggregate is kept.
    for (const [idx, areaId] of areaIdByIndex.entries()) {
      const comps = compsByAreaId.get(areaId);
      if (!comps) continue;
      const candidate = candidates[idx];
      const tight = computeAreaComps(comps, {
        rooms: candidate.rooms,
        livingArea: candidate.livingArea,
        asOf,
        objectType: null,
      });

      let final = tight;
      let widenedBand = false;
      if (tight.sampleSize < MIN_COMPS_FOR_CONFIDENCE) {
        const widened = computeAreaComps(comps, {
          rooms: candidate.rooms,
          livingArea: candidate.livingArea,
          asOf,
          objectType: null,
          sizeBandPct: WIDENED_SIZE_BAND_PCT,
          maxAgeMonths: WIDENED_MAX_AGE_MONTHS,
        });
        if (widened.sampleSize > tight.sampleSize) {
          final = widened;
          widenedBand = true;
        }
      }

      byIndex.set(idx, {
        areaId,
        renovatedMedianPerSqm: final.renovatedMedianPerSqm,
        unrenovatedMedianPerSqm: final.unrenovatedMedianPerSqm,
        overallMedianPerSqm: final.overallMedianPerSqm,
        renovatedCapPerSqm: final.renovatedCapPerSqm,
        sampleSize: final.sampleSize,
        confident: final.confident,
        asOf,
        widenedBand,
      });
    }

    return { byIndex, spentSek, areasFetched, areasSkippedForBudget };
  } catch (error) {
    // (f) Never throw — return whatever partial progress the mutable
    // accumulators above already captured.
    console.error("[discovery-job] resolveCompsForCandidates failed (non-fatal)", {
      jobId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return { byIndex, spentSek, areasFetched, areasSkippedForBudget };
  }
}

/** The result of `lookupBrfForTopCandidates` — one `BrfSummary` per candidate
 * index that reached `"ok"`, plus the spend/attempt/skip bookkeeping
 * `runVisionForJob` folds into its shared budget pool. */
export interface BrfResolution {
  byIndex: Map<number, BrfSummary>;
  spentSek: number;
  attemptedIndices: number[];
  skippedForBudget: number;
}

/**
 * `lookupBrfForTopCandidates` — ANL-03: fetches a BRF summary for the top
 * `BRF_TOP_N` prelim-ranked candidates CONCURRENTLY, mirroring `runSlice`'s
 * own `Promise.allSettled` aggregation shape one level up.
 *
 * Selection — REUSE the already-merged prelim rank, never a new one. D-14-01:
 * the BRF chain is network+LLM expensive and per-candidate, so it runs ONLY
 * for the top-N by `enrichmentPriority` (below-market + aged-stock), which is
 * available before comps so there is no circular dependency; a candidate with
 * `brfName === null` has nothing to search and is skipped honestly.
 *
 * Budget is a pre-gate (check-before-spend, mirroring `runVisionPass`'s own
 * discipline and `resolveCompsForCandidates`'s comps gate): the allowed
 * lookup count is computed from `opts.budgetSek` BEFORE any network call. An
 * exhausted budget returns immediately with an empty map and `spentSek: 0` —
 * never calls out, never fails (D-14-08 "degrade gracefully").
 *
 * Concurrency: a sequential `for...await` here is FORBIDDEN — it is the
 * Phase 13 WR-02 trap (sum of times, not max) stacked on an already-loaded
 * tick (2 Allabrf fetches + 1 Haiku call per candidate). Every failure mode —
 * a rejected promise or a non-`"ok"` `BrfLookupOutcome` — degrades that
 * candidate to comps + hedonic only (D-14-10) and never fails the tick; this
 * function itself never throws.
 *
 * Does NOT take a `supabase` parameter and reads/writes no table — the
 * D-14-12 boundary is that the discovery BRF path is pure network + LLM
 * composition.
 *
 * @param candidates - the job's candidate set (read-only input)
 * @param opts.jobId - for GDPR-safe, coded non-fatal logging only
 * @param opts.budgetSek - the SEK budget available for BRF lookups THIS call
 */
export async function lookupBrfForTopCandidates(
  candidates: DiscoveryCandidate[],
  opts: { jobId: string; budgetSek: number },
): Promise<BrfResolution> {
  const { jobId } = opts;
  // Mutable accumulators declared OUTSIDE the try block so the catch below
  // can return whatever partial progress was made before an unexpected
  // error, rather than discarding it (mirrors resolveCompsForCandidates's
  // own never-throw discipline).
  const byIndex = new Map<number, BrfSummary>();
  let spentSek = 0;
  let attemptedIndices: number[] = [];
  let skippedForBudget = 0;

  try {
    // Selection: the top BRF_TOP_N by the existing enrichmentPriority rank,
    // restricted to candidates with a brfName. Never a new priority function.
    const eligible = enrichmentVisitOrder(candidates)
      .filter((i) => candidates[i].brfName !== null)
      .slice(0, BRF_TOP_N);

    // Budget pre-gate BEFORE any network work. WR-01 (14-REVIEW.md): priced at
    // the worst case ONE lookup can charge (`MAX_BILLED_CALLS_PER_LOOKUP` ×
    // one extraction call), not one call — a CLAUDE_MAX_TOKENS failure, and a
    // success after a truncation retry, both bill twice, so dividing by a
    // single call authorised attempts that could overshoot the remaining pool
    // by ~90%.
    const worstCasePerLookup = estimateBrfLookupSek() * MAX_BILLED_CALLS_PER_LOOKUP;
    const allowed = Math.max(0, Math.floor(opts.budgetSek / worstCasePerLookup));
    const attempted = eligible.slice(0, allowed);
    skippedForBudget = eligible.length - attempted.length;
    attemptedIndices = attempted;

    if (attempted.length === 0) {
      return { byIndex, spentSek, attemptedIndices, skippedForBudget };
    }

    // Bounded concurrent batch — copies runSlice's Promise.allSettled block
    // shape verbatim (by-index fulfilled/rejected split, error-context log).
    const settled = await Promise.allSettled(
      attempted.map(async (index) => ({
        index,
        result: await lookupBrfSummary({
          brfName: candidates[index].brfName,
          kommun: candidates[index].kommun,
          tenureForm: candidates[index].tenureForm,
        }),
      })),
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        console.error("[discovery-job] brf lookup degraded (non-fatal)", {
          jobId,
          candidateIndex: attempted[i],
          code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
        });
        continue;
      }
      const { index, result } = outcome.value;
      // result.costSek INCLUDES the estimated spend of a billed-then-failed
      // extraction (BILLED_CALLS_BY_EXTRACTION_CODE, CR-04) — a code Anthropic
      // already billed 1-2 calls for before extract.ts threw. Accumulating it
      // unconditionally is what keeps the shared CAP_VISION_SEK_MAX pool honest
      // when it is seeded into runVisionPass via initialSpentSek (D-14-08).
      //
      // WR-06 (14-REVIEW.md): "always a finite non-negative number" was a HOPE,
      // not an invariant — a drifted/NaN costSek would poison `spentSek`, and
      // runVisionPass's own Number.isFinite guard would then reset the shared
      // pool to 0, silently discarding the comps spend as well. Clamp here so
      // the invariant is enforced rather than asserted.
      spentSek += Number.isFinite(result.costSek) ? Math.max(0, result.costSek) : 0;
      if (result.summary !== null) {
        byIndex.set(index, result.summary);
      }
      if (result.outcome !== "ok") {
        // Diagnostic: a run that never reaches "high" confidence must be
        // visibly diagnosable rather than silently empty (14-RESEARCH.md
        // Pitfall 2's warning sign).
        console.error("[discovery-job] brf lookup outcome", {
          jobId,
          candidateIndex: index,
          outcome: result.outcome,
        });
      }
    }

    return { byIndex, spentSek, attemptedIndices, skippedForBudget };
  } catch (error) {
    console.error("[discovery-job] lookupBrfForTopCandidates failed (non-fatal)", {
      jobId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return { byIndex, spentSek, attemptedIndices, skippedForBudget };
  }
}

/**
 * De-dupes candidates merged from multiple area searches. Keyed by
 * `sourceListingUrl` (the stable per-listing id); a candidate lacking one
 * falls back to address+price and, failing that, is always kept (never dropped
 * on absent data). First occurrence wins, preserving order.
 */
export function dedupeCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveryCandidate[] = [];
  for (const c of candidates) {
    const key = c.sourceListingUrl ?? (c.address !== null ? `${c.address}|${c.price}` : null);
    if (key === null) {
      out.push(c);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export async function runVisionForJob(
  supabase: DiscoveryJobsWriter,
  jobId: string,
  results: DiscoveryCandidate[],
): Promise<void> {
  try {
    // Enrich the top-N candidates with their DETAIL-page images before vision.
    // Area-search entities carry no images (bcdn.se gallery lives on the detail
    // page), so without this every candidate skips vision as "no_images". This
    // also backfills floor/constructionYear/orientation/balcony from the detail
    // entity (better ranking data). Bounded to VISION_ENRICH_LIMIT detail
    // fetches per job to cap Apify spend.
    const { candidates: enriched, brokerImages } = await enrichCandidateImages(
      results,
      VISION_ENRICH_LIMIT,
    );

    // Pipeline order (Phase 14, ANL-01/02/03/D-14-08): enrich → comps → BRF →
    // vision → brief → persist. Comps run BEFORE BRF deliberately: comps are
    // per-area/amortized and cheaper, and the buildHolisticBrief fallback
    // below needs them for EVERY candidate, whereas BRF only ever covers the
    // top-N (D-14-08's front-load-the-cheap-structurally-necessary-spend
    // ordering). All three spend sources (comps, BRF, vision) share the SAME
    // CAP_VISION_SEK_MAX pool via initialSpentSek — never three separate
    // budgets that could jointly overspend.
    const comps = await resolveCompsForCandidates(supabase, enriched, {
      jobId,
      budgetSek: CAP_VISION_SEK_MAX,
    });
    const withComps = enriched.map((c, i) => ({
      ...c,
      areaComps: comps.byIndex.get(i) ?? null,
    }));

    const brf = await lookupBrfForTopCandidates(withComps, {
      jobId,
      budgetSek: Math.max(0, CAP_VISION_SEK_MAX - comps.spentSek),
    });
    const withHolisticInputs = withComps.map((c, i) => ({
      ...c,
      brfSummary: brf.byIndex.get(i) ?? null,
    }));

    const withVision = await runVisionPass(withHolisticInputs, {
      brokerImagesOf: (_candidate, index) => brokerImages.get(index) ?? [],
      initialSpentSek: comps.spentSek + brf.spentSek,
    });

    // Brief attachment (ANL-01, D-14-03/D-14-04): attached for ALL FOUR
    // no-image-claims states — a `visionSkippedReason` of "no_images",
    // "cost_cap" or "vision_error", PLUS a non-null `vision` whose `claims`
    // array is empty (either the Haiku `worthDeepPass: false` path or the
    // confidence/imageIndex filter path in vision.ts). In every one of those
    // states there are zero image-derived conclusions while comps + hedonic
    // remain available — exactly ANL-01's "every surfaced candidate leaves
    // analysis with ≥1 actionable item". A candidate WITH a surviving claim
    // never gets a brief (holisticBrief stays null). NOT changed by this
    // step: `VisionResult.claims` stays `[]` and `visionResultSchema` is
    // untouched (vision.ts is not edited by this plan), so
    // `condition-score.ts`'s `claims.length === 0 → 0` behaviour is
    // preserved — a data-only brief correctly contributes ZERO
    // vision-derived condition signal.
    const hasNoImageClaims = (c: DiscoveryCandidate) =>
      c.vision === null || c.vision.claims.length === 0;
    const withBriefs = withVision.map((c, index) => {
      if (!hasNoImageClaims(c)) {
        return { ...c, holisticBrief: null };
      }
      // Both normalizeForConfounders and buildHolisticBrief are pure, so
      // this try/catch is defence-in-depth only — mirroring runVisionPass's
      // per-candidate try/catch discipline one level up.
      try {
        const guard = normalizeForConfounders({
          pricePerSqm: pricePerSqm(c),
          livingArea: c.livingArea,
          floor: c.floor,
          balcony: c.balcony,
          tenureForm: c.tenureForm,
          comps: c.areaComps,
          brf: c.brfSummary,
        });
        const holisticBrief = buildHolisticBrief({
          guard,
          comps: c.areaComps,
          brf: c.brfSummary,
          pricePerSqm: pricePerSqm(c),
          livingArea: c.livingArea,
        });
        return { ...c, holisticBrief };
      } catch (error) {
        console.error("[discovery-job] holistic brief build failed (non-fatal)", {
          jobId,
          candidateIndex: index,
          code: error instanceof Error ? error.message : "UNKNOWN",
        });
        return { ...c, holisticBrief: null };
      }
    });

    const persisted = await updateJob(supabase, jobId, {
      results: withBriefs,
      status: "done",
    });
    if (!persisted) {
      // WR-04: the vision spend was already incurred — this is a distinct,
      // more urgent signal than updateJob's own generic "update failed" log.
      console.error("[discovery-vision-job] vision computed but not persisted — spend lost", {
        jobId,
        code: "VISION_PERSIST_FAILED",
      });
    }
  } catch (error) {
    // Defense-in-depth (see doc comment above) — restore "done" so the job
    // never wedges at "vision_processing" with no recovery path; its
    // pre-vision scrape results are untouched since we never overwrite
    // `results` on this branch. Never re-throw here.
    console.error("[discovery-vision-job] pass failed", {
      jobId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    // The recovery write itself must never throw past this function either —
    // an unexpected failure severe enough to reach this catch (e.g. the
    // Supabase client itself throwing synchronously, as opposed to
    // returning a normal `{ error }` result) could in principle also break
    // this write. Swallow it defensively; the row may stay at
    // "vision_processing" in that narrow case, but the caller is never
    // stranded by an uncaught throw either way.
    try {
      await updateJob(supabase, jobId, { status: "done" });
    } catch (recoveryError) {
      console.error("[discovery-vision-job] recovery status write failed", {
        jobId,
        code: recoveryError instanceof Error ? recoveryError.message : "UNKNOWN",
      });
    }
  }
}

/**
 * `claimAndRunVisionForJob` — CR-04 (11-REVIEW.md) — composes
 * `claimVisionSlice` (atomic CAS) with `runVisionForJob` (run + persist) into
 * ONE call, so every caller gets the race-safe behavior by construction
 * rather than having to remember to claim before running. Only the
 * invocation that wins the CAS transition ever calls `runVisionForJob`; a
 * lost/no-op claim is a benign no-op here too, exactly mirroring
 * `claim_discovery_slice`'s "zero rows IS the outcome" contract.
 *
 * @param supabase - a Supabase client scoped to write `discovery_jobs`
 * @param jobId - the job to attempt the vision pass for
 */
export async function claimAndRunVisionForJob(
  supabase: DiscoveryJobsWriter,
  jobId: string,
): Promise<void> {
  const claimedResults = await claimVisionSlice(supabase, jobId);
  if (claimedResults === null) {
    // Another invocation already claimed it, or the job is not in "done"
    // status — benign no-op, mirrors claim_discovery_slice's own contract.
    return;
  }
  await runVisionForJob(supabase, jobId, claimedResults);
}
