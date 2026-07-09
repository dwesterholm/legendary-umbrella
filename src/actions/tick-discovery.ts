"use server";

import { createClient } from "@/lib/supabase/server";
import { runSlice, claimAndRunVisionForJob, type ClaimedDiscoveryJob } from "@/lib/discovery/job";

/**
 * `tickDiscovery` — the client-tick-drives-the-queue Server Action
 * (09-RESEARCH.md Pattern 1/2). Each client poll round-trip both reads job
 * status AND invokes this action to claim-and-execute exactly ONE bounded
 * slice of server-side work.
 *
 * Pitfall 2 (Vercel Function timeout): `runPlaywrightRender` has up to a
 * 240s wait ceiling per rung, and `fetchAreaListings` may attempt two rungs.
 * The original plan called for `export const maxDuration = 300` directly in
 * this file, but Next.js's Server Actions bundler only permits ASYNC
 * FUNCTION exports from a `"use server"` file — a plain constant export
 * fails the production build with "Only async functions are allowed to be
 * exported in a 'use server' file" (a real compiler constraint invisible to
 * vitest's mocked unit tests; only `npm run build` surfaces it, since
 * `maxDuration`/`runtime` are Route Handler/Page special exports, not
 * Server Action ones). `TICK_DISCOVERY_MAX_DURATION_SEC` in
 * `@/lib/discovery/tick-config` documents the same 300s ceiling — which
 * already matches the Vercel platform DEFAULT on both Hobby/Pro
 * (09-RESEARCH.md line 447), so no runtime behavior changes; only the
 * declaration moved to a module that isn't bundler-constrained.
 */

/**
 * Runs exactly one bounded slice of `jobId`'s discovery job, if claimable.
 *
 * Order: auth → ownership pre-check (IDOR guard, defense-in-depth behind
 * RLS) → atomic claim via `claim_discovery_slice` (the REAL `FOR UPDATE SKIP
 * LOCKED` RPC — never reimplemented as a PostgREST check-then-act) → run one
 * slice using the RETURNED row.
 *
 * Per 09-RESEARCH.md Pitfall 5, `tickDiscovery` does NOT re-check
 * `DISCOVERY_ENABLED` — a job can only exist if it was created while the flag
 * was on (`startDiscovery`'s first-line gate). The ownership + RPC claim are
 * the mandatory checks here.
 *
 * @param jobId - the discovery_jobs row to advance (must belong to the caller)
 */
export async function tickDiscovery(jobId: string): Promise<void> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  // IDOR guard (T-09-06): defense-in-depth behind RLS — a user cannot drive
  // another user's job even if RLS were ever misconfigured.
  const { data: row, error: rowError } = await supabase
    .from("discovery_jobs")
    .select("user_id")
    .eq("id", jobId)
    .single();
  if (rowError || !row || row.user_id !== user.id) return;

  // The atomic claim — the ONE genuinely-new mechanism this phase requires.
  // A zero-row result IS the CAS outcome (another tick owns it, or the job is
  // terminal) — a benign no-op, never an error.
  const { data: claimed, error } = await supabase
    .rpc("claim_discovery_slice", { p_job_id: jobId })
    .maybeSingle();

  if (error) {
    // Fail closed: never proceed to spend on a scrape if the claim errored.
    console.error("[tickDiscovery] claim failed", { jobId, code: error.code });
    return;
  }
  if (!claimed) {
    // Another tick already owns this slice, or the job is terminal.
    return;
  }

  const claimedRow = claimed as unknown as ClaimedDiscoveryJob;
  await runSlice(supabase, claimedRow);

  // Phase 11 (DISC-04) — a SEPARATE, additive post-scrape pass, ALWAYS
  // attempted after a slice runs; a job that is still "processing" gets
  // vision on a LATER tick once scraping finishes.
  //
  // CR-04 (11-REVIEW.md): `claimAndRunVisionForJob` performs its OWN atomic
  // `"done"` → `"vision_processing"` CAS transition internally — it is safe
  // to call unconditionally here (never gated on a separate, unlocked
  // check-then-act `SELECT status`, which is exactly the TOCTOU window that
  // let two concurrent "job done" invocations both run a full, uncoordinated
  // `runVisionPass` over the same results, doubling real Anthropic spend).
  // A job not currently in "done" status is a benign no-op.
  await claimAndRunVisionForJob(supabase, jobId);
}
