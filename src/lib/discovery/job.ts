import { fetchAreaListings, fetchListing, isAllowedImageHost } from "@/lib/booli/client";
import { fetchBrokerListingPage } from "@/lib/broker/fetch-broker-page";
import { fetchBrokerImageBytes, type BrokerImageBytes } from "@/lib/broker/broker-images";
import { resolveArea, splitAreaQuery, type AreaResolution } from "@/lib/discovery/resolve-area";
import {
  toCandidate,
  filterCandidates,
  pricePerSqm,
  type DiscoveryCandidate,
} from "@/lib/discovery/candidate";
import { discoveryCostSek } from "@/lib/discovery/cost";
import { runVisionPass } from "@/lib/discovery/vision";
import { extractOrientationFromDescription } from "@/lib/discovery/sun-path";
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
 * A conservative per-slice cost estimate used ONLY for the pre-spend gate
 * (step 3) — the real persisted cost is computed post-scrape from actual
 * usage via `discoveryCostSek`. This estimate assumes one render (the
 * `fetchAreaListings` call this slice is about to make) at the per-render USD
 * rate, converted to SEK — it deliberately ignores the (comparatively tiny)
 * Haiku parse cost already spent in `startDiscovery`, so it is a conservative
 * (never-under-count) pre-check.
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
  // just the already-recorded total (one render per resolved area).
  const projectedCost = cost_sek_total + estimatedSliceCostSek(areaIds.length);
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
      rendersUsed += 1;
      raw.push(...outcome.value);
    } else {
      anyThrew = true;
      console.error("[discovery-job] kill-switch degraded", {
        jobId,
        areaId: areaIds[i],
        code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
      });
    }
  }
  if (raw.length === 0) {
    await updateJob(supabase, jobId, { status: anyThrew ? "degraded" : "done" });
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

  // A successful sweep is TERMINAL. `fetchAreaListings` is one-shot (no
  // pagination — it renders a single till-salu page), so once a slice returns
  // there is no further page to fetch: the job is done whether or not it hit
  // `cap_candidates`. Gating `done` on `capReached` left any UNDER-cap search
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
 * `runVisionForJob` — Phase 11 (DISC-04) — a SEPARATE, additive post-scrape
 * pass that runs `runVisionPass` over a completed job's persisted candidates
 * and writes the vision-annotated results back in ONE UPDATE.
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
      const raw = await fetchListing(c.sourceListingUrl);
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
    const withVision = await runVisionPass(enriched, {
      brokerImagesOf: (_candidate, index) => brokerImages.get(index) ?? [],
    });
    const persisted = await updateJob(supabase, jobId, {
      results: withVision,
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
