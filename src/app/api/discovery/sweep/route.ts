import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { runSlice, claimAndRunVisionForJob, type ClaimedDiscoveryJob } from "@/lib/discovery/job";

/**
 * `/api/discovery/sweep` — the once-daily Vercel Cron ORPHAN-RESUME SAFETY
 * NET (09-RESEARCH.md Pattern 1 caveat), not the primary slice driver. The
 * client tick (`tickDiscovery`) is the primary driver; this route only
 * resumes jobs whose tab closed mid-run and are stuck `processing` with a
 * stale `claimed_at` past the RPC's own stale-reclaim window.
 *
 * `maxDuration` IS a valid Route Handler special export (unlike Server
 * Actions, where a plain constant export fails the "use server" bundler —
 * see tick-discovery.ts's doc comment for that distinct constraint). 300s
 * matches the Vercel platform default on both Hobby/Pro (09-RESEARCH.md
 * line 447); declared explicitly per Pitfall 2 for clarity and to survive a
 * future default change.
 *
 * CR-02 (09-REVIEW.md): this route is publicly reachable at a fixed,
 * unauthenticated URL unless it verifies the caller itself — `vercel.json`
 * scheduling it does not stop an external party from calling it directly
 * and repeatedly. The `CRON_SECRET` check below is the LITERAL FIRST
 * ACTION, mirroring the `DISCOVERY_ENABLED` fail-closed discipline used
 * elsewhere in this phase, and gates the ONLY place in the codebase a
 * service-role (RLS-bypassing) Supabase client is constructed — the sweep
 * must see and reclaim OTHER users' orphaned jobs, which the ordinary
 * cookie-bound anon-key client (scoped to `auth.uid()` via RLS) cannot do.
 * `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` must both be set in the
 * deployment environment (Vercel project env vars) for the sweep to
 * function; neither is ever read client-side.
 */
export const maxDuration = 300;

/** Mirrors claim_discovery_slice's own p_stale_ms default (5 minutes). */
const STALE_MS = 5 * 60 * 1000;

/**
 * Cap the number of jobs reclaimed per invocation so a single once-daily run
 * (which may find multiple stuck jobs across all users) stays comfortably
 * under `maxDuration` — each reclaimed job runs one bounded `runSlice` call,
 * the same per-slice cost bounded by the SAME incremental caps `job.ts`
 * already enforces.
 */
const MAX_JOBS_PER_SWEEP = 10;

export async function GET(request: Request) {
  // LITERAL FIRST ACTION — fail closed before any DB client (service-role
  // or otherwise) is constructed. A missing CRON_SECRET fails closed too
  // (never treats an unset secret as "no check required").
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const staleCutoffIso = new Date(Date.now() - STALE_MS).toISOString();

  // PostgREST NULL-filter trap (memory: postgrest-eq-null.md) — `.lt()` is a
  // safe range comparison against a non-null `claimed_at`, but a stuck job
  // with a NULL `claimed_at` (claimed in the same instant the RPC atomically
  // set it, then crashed before returning) would silently be excluded by a
  // bare `.lt()` alone; `.or(...)` with an explicit `.is.null` clause covers
  // both cases in one query, never `.eq(col, null)`.
  const { data: stuckJobs, error } = await supabase
    .from("discovery_jobs")
    .select("id")
    .eq("status", "processing")
    .or(`claimed_at.is.null,claimed_at.lt.${staleCutoffIso}`)
    .limit(MAX_JOBS_PER_SWEEP);

  if (error) {
    console.error("[discovery-sweep] query failed", { code: error.code });
    return NextResponse.json({ swept: 0, error: "query_failed" }, { status: 500 });
  }

  let swept = 0;
  for (const job of stuckJobs ?? []) {
    // Reclaim via the SAME atomic RPC's stale branch — never a hand-rolled
    // check-then-act UPDATE (the exact TOCTOU bug this RPC exists to avoid).
    const { data: claimed, error: claimError } = await supabase
      .rpc("claim_discovery_slice", { p_job_id: job.id as string, p_stale_ms: STALE_MS })
      .maybeSingle();

    if (claimError) {
      console.error("[discovery-sweep] claim failed", {
        jobId: job.id,
        code: claimError.code,
      });
      continue;
    }
    if (!claimed) {
      // Another tick/sweep already reclaimed it, or it's now terminal —
      // benign no-op.
      continue;
    }

    await runSlice(supabase, claimed as unknown as ClaimedDiscoveryJob);

    // Phase 11 (DISC-04) — the same separate, additive post-scrape pass as
    // tickDiscovery, ALWAYS attempted after a slice runs. CR-04
    // (11-REVIEW.md): `claimAndRunVisionForJob` performs its own atomic
    // "done" -> "vision_processing" CAS transition internally, so a client
    // tab racing this sweep's reclaim of the same job can never both run a
    // full, uncoordinated vision pass over the same results — only the
    // invocation that wins the CAS proceeds. A job not currently "done" is a
    // benign no-op.
    await claimAndRunVisionForJob(supabase, job.id as string);

    swept += 1;
  }

  // WR-04 (shard-1 review): recover rows wedged at "vision_processing". This
  // status is only reachable if the defense-in-depth recovery write inside
  // runVisionForJob ITSELF threw — no claim RPC, CAS, or the "processing"
  // sweep above matches it, so the row is otherwise permanently stuck with
  // its scrape results but no vision and no escape hatch. The vision pass runs
  // synchronously within a single request, so a row still in this state at a
  // once-daily sweep is genuinely wedged: reset it to "done" (surfacing its
  // scrape results) and re-attempt the pass. The reset's conditional
  // `.eq("status","vision_processing")` + the CAS inside claimAndRunVisionForJob
  // keep the retry race-safe against any concurrent tick.
  const { data: wedged, error: wedgedError } = await supabase
    .from("discovery_jobs")
    .select("id")
    .eq("status", "vision_processing")
    .limit(MAX_JOBS_PER_SWEEP);

  if (wedgedError) {
    console.error("[discovery-sweep] vision-wedged query failed", { code: wedgedError.code });
  } else {
    for (const job of wedged ?? []) {
      const { error: resetError } = await supabase
        .from("discovery_jobs")
        .update({ status: "done" })
        .eq("id", job.id as string)
        .eq("status", "vision_processing");
      if (resetError) {
        console.error("[discovery-sweep] vision reset failed", {
          jobId: job.id,
          code: resetError.code,
        });
        continue;
      }
      await claimAndRunVisionForJob(supabase, job.id as string);
      swept += 1;
    }
  }

  return NextResponse.json({ swept });
}
