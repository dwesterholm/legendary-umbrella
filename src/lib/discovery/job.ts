import { fetchAreaListings, isAllowedImageHost } from "@/lib/booli/client";
import { resolveArea } from "@/lib/discovery/resolve-area";
import { toCandidate, filterCandidates, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { discoveryCostSek } from "@/lib/discovery/cost";
import { runVisionPass } from "@/lib/discovery/vision";
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
function estimatedSliceCostSek(): number {
  return discoveryCostSek({
    haikuUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    renders: 1,
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

  // (2) Resolve the area. A miss is an honest "we don't cover that area yet"
  // failure, never a fabricated areaId (resolveArea's own contract).
  const resolution = await resolveArea(filters.areaQuery, supabase);
  if (!resolution) {
    await updateJob(supabase, jobId, { status: "failed" });
    return;
  }

  // (3) COST PRE-CHECK — gates the SPEND, not just the already-recorded total.
  const projectedCost = cost_sek_total + estimatedSliceCostSek();
  if (projectedCost > cap_sek) {
    await updateJob(supabase, jobId, { status: "done", cap_reached: true });
    return;
  }

  // (4) KILL SWITCH — a thrown error from the owned Booli client IS the
  // CAPTCHA/blocking signal (transport.ts's HIGH-1 discipline: it never
  // returns [] to mean "dead", it throws). Degrade and halt; no retry.
  let raw: Record<string, unknown>[];
  try {
    raw = await fetchAreaListings(resolution.areaId, filters.objectType);
  } catch (error) {
    console.error("[discovery-job] kill-switch degraded", {
      jobId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    await updateJob(supabase, jobId, { status: "degraded" });
    return;
  }

  // (5) Map to the PII-safe allowlist shape, then deterministically filter —
  // NEVER Claude-driven, and capped to the remaining candidate budget so a
  // single slice cannot blow past cap_candidates.
  const candidates = raw.map(toCandidate);
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
    renders: 1,
  });
  const newCostSekTotal = cost_sek_total + sliceCostSek;
  const capReached = newCandidateCount >= cap_candidates;

  await updateJob(supabase, jobId, {
    results: [...claimedRow.results, ...shown],
    candidate_count: newCandidateCount,
    processed_count: newProcessedCount,
    cost_sek_total: newCostSekTotal,
    status: capReached ? "done" : "processing",
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
export async function runVisionForJob(
  supabase: DiscoveryJobsWriter,
  jobId: string,
  results: DiscoveryCandidate[],
): Promise<void> {
  try {
    const withVision = await runVisionPass(results);
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
