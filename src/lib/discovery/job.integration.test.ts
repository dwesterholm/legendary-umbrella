import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * job.integration.test.ts — DB-only guarantees that cannot be proven by a
 * pure Vitest unit test with a mocked Supabase client (09-RESEARCH.md lines
 * 508-529): that `claim_discovery_slice`'s `FOR UPDATE SKIP LOCKED`
 * genuinely serializes concurrent claims against a REAL Postgres instance —
 * a mock can only assert what we CODE it to return, not what the database
 * itself guarantees under a race — AND (CR-01, 09-REVIEW.md /
 * 011_claim_slice_ownership.sql) that the RPC's OWN ownership check, not
 * just the app-layer `tickDiscovery` pre-check, denies a non-owner
 * authenticated caller.
 *
 * GATED behind `RUN_DB_INTEGRATION=1` (mirrors `evals/extractor.eval.ts`'s
 * `RUN_LLM_EVALS=1` self-skip pattern) so the default `npm run test` / CI run
 * incurs ZERO cost and needs NO live database — this file adds at most one
 * skipped test to the suite. This is also a manual verification prerequisite
 * for `/gsd-verify-work` (09-03-PLAN.md Task 3 acceptance criteria).
 *
 * TO RUN LOCALLY:
 *   1. `supabase start` (applies migrations 001-011, including
 *      `claim_discovery_slice` from 010_discovery_jobs.sql /
 *      011_claim_slice_ownership.sql).
 *   2. Set `SUPABASE_SERVICE_ROLE_KEY` to the local service_role key
 *      `supabase start` prints (or `supabase status`).
 *   3. `RUN_DB_INTEGRATION=1 SUPABASE_SERVICE_ROLE_KEY=<key> npx vitest run
 *      src/lib/discovery/job.integration.test.ts`
 *
 * The service-role key is used deliberately for setup/teardown and the
 * concurrency proofs (bypasses RLS) — those tests prove the RPC's OWN
 * atomicity guarantee, not the RLS policy layer. The CR-01 ownership test
 * below is the one exception: it signs in as a SECOND, non-owner user via
 * the anon/publishable key specifically to prove the RPC denies a
 * non-owner authenticated caller — the RLS/ownership layer this file's
 * original doc comment explicitly flagged as "out of scope" for the
 * concurrency proofs is now in scope for this one dedicated test.
 */

const RUN_LIVE =
  process.env.RUN_DB_INTEGRATION === "1" && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe("claim_discovery_slice — RPC concurrency guarantee (DISC-02)", () => {
  if (!RUN_LIVE) {
    it.skip(
      "skipped — set RUN_DB_INTEGRATION=1 + SUPABASE_SERVICE_ROLE_KEY (supabase start) to run against a live local Supabase",
      () => {
        // intentionally empty — no DB connection, no spend in CI / `npm run test`.
      },
    );
    return;
  }

  // Only imported/executed inside the RUN_LIVE branch — no supabase-js
  // client is constructed (and no env var is read) in the default skip path.
  let supabaseUrl: string;
  let serviceRoleKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only dynamic client, avoids typing the full generated schema for one ad-hoc integration probe
  let supabase: any;
  let testUserId: string;

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
    serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    supabase = createClient(supabaseUrl, serviceRoleKey);

    // A discovery_jobs row needs a real auth.users row for the FK — create a
    // throwaway test user via the admin API (service-role only).
    const { data: userData, error: userError } = await supabase.auth.admin.createUser({
      email: `discovery-rpc-test-${Date.now()}@example.com`,
      password: "throwaway-password-not-reused",
      email_confirm: true,
    });
    if (userError || !userData.user) {
      throw new Error(`Failed to create test user: ${userError?.message}`);
    }
    testUserId = userData.user.id;
  });

  afterAll(async () => {
    if (supabase && testUserId) {
      await supabase.auth.admin.deleteUser(testUserId);
    }
  });

  async function insertPendingJob(): Promise<string> {
    const { data, error } = await supabase
      .from("discovery_jobs")
      .insert({
        user_id: testUserId,
        status: "pending",
        free_text: "concurrency test",
        filters: { areaQuery: "Test", priceMax: null, roomsMin: null, sizeMin: null, objectType: "Alla", confidence: 1 },
        cap_candidates: 25,
        cap_sek: 5,
        processed_count: 0,
        candidate_count: 0,
        cost_sek_total: 0,
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`Failed to insert test job: ${error?.message}`);
    }
    return data.id as string;
  }

  it("exactly one of two concurrent claims on the same pending job wins", async () => {
    const jobId = await insertPendingJob();

    const [first, second] = await Promise.all([
      supabase.rpc("claim_discovery_slice", { p_job_id: jobId }),
      supabase.rpc("claim_discovery_slice", { p_job_id: jobId }),
    ]);

    const firstRows: unknown[] = Array.isArray(first.data) ? first.data : first.data ? [first.data] : [];
    const secondRows: unknown[] = Array.isArray(second.data) ? second.data : second.data ? [second.data] : [];

    const totalClaimed = firstRows.length + secondRows.length;
    expect(totalClaimed).toBe(1);

    // Cleanup.
    await supabase.from("discovery_jobs").delete().eq("id", jobId);
  });

  it("a fresh claimed_at row is NOT reclaimable by a second concurrent claim", async () => {
    const jobId = await insertPendingJob();

    // First claim succeeds and sets a fresh claimed_at.
    const firstClaim = await supabase.rpc("claim_discovery_slice", { p_job_id: jobId });
    const firstRows: unknown[] = Array.isArray(firstClaim.data)
      ? firstClaim.data
      : firstClaim.data
        ? [firstClaim.data]
        : [];
    expect(firstRows).toHaveLength(1);

    // A second claim immediately after must NOT reclaim the fresh lock.
    const secondClaim = await supabase.rpc("claim_discovery_slice", { p_job_id: jobId });
    const secondRows: unknown[] = Array.isArray(secondClaim.data)
      ? secondClaim.data
      : secondClaim.data
        ? [secondClaim.data]
        : [];
    expect(secondRows).toHaveLength(0);

    await supabase.from("discovery_jobs").delete().eq("id", jobId);
  });

  it("a stale claimed_at row (older than the stale window) IS reclaimable", async () => {
    const jobId = await insertPendingJob();

    // Simulate a crashed tick: flip to processing with a claimed_at far in the
    // past (well beyond the default 300000ms / 5min stale window).
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase
      .from("discovery_jobs")
      .update({ status: "processing", claimed_at: staleTimestamp })
      .eq("id", jobId);

    const { data } = await supabase.rpc("claim_discovery_slice", { p_job_id: jobId });
    const rows: unknown[] = Array.isArray(data) ? data : data ? [data] : [];
    expect(rows).toHaveLength(1);

    await supabase.from("discovery_jobs").delete().eq("id", jobId);
  });

  it("denies a non-owner authenticated user's direct RPC claim (CR-01)", async () => {
    const jobId = await insertPendingJob();

    // A second, unrelated user — the "attacker" — signed in via the
    // anon/publishable key (a REAL authenticated session, not service-role).
    // Before 011_claim_slice_ownership.sql, this call would have succeeded:
    // the RPC filtered only on `id = p_job_id` and `status`, never
    // `user_id`, so any authenticated caller could claim ANY job by id.
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!anonKey) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set to run the CR-01 ownership test",
      );
    }

    const { createClient } = await import("@supabase/supabase-js");
    const attackerClient = createClient(supabaseUrl, anonKey);

    const attackerEmail = `discovery-rpc-attacker-${Date.now()}@example.com`;
    const attackerPassword = "throwaway-password-not-reused";
    const { data: attackerUser, error: attackerCreateError } =
      await supabase.auth.admin.createUser({
        email: attackerEmail,
        password: attackerPassword,
        email_confirm: true,
      });
    if (attackerCreateError || !attackerUser.user) {
      throw new Error(`Failed to create attacker user: ${attackerCreateError?.message}`);
    }

    try {
      const { error: signInError } = await attackerClient.auth.signInWithPassword({
        email: attackerEmail,
        password: attackerPassword,
      });
      if (signInError) {
        throw new Error(`Attacker sign-in failed: ${signInError.message}`);
      }

      // The attacker calls claim_discovery_slice directly against the
      // VICTIM's jobId — exactly the direct-RPC-call attack CR-01 describes
      // (bypassing tickDiscovery's app-level ownership pre-check entirely).
      const { data: claimData, error: claimError } = await attackerClient.rpc(
        "claim_discovery_slice",
        { p_job_id: jobId },
      );

      // No error is expected — a denied claim is a benign zero-row result
      // (the RPC's ownership filter simply excludes the row), mirroring the
      // "zero rows IS the outcome" contract the rest of this RPC already
      // uses for "another tick owns it" / "job is terminal".
      expect(claimError).toBeNull();
      const claimedRows: unknown[] = Array.isArray(claimData)
        ? claimData
        : claimData
          ? [claimData]
          : [];
      expect(claimedRows).toHaveLength(0);

      // Confirm the victim's job was NOT mutated (still pending, unclaimed).
      const { data: victimJob } = await supabase
        .from("discovery_jobs")
        .select("status, claimed_at")
        .eq("id", jobId)
        .single();
      expect(victimJob?.status).toBe("pending");
      expect(victimJob?.claimed_at).toBeNull();
    } finally {
      await supabase.auth.admin.deleteUser(attackerUser.user.id);
      await supabase.from("discovery_jobs").delete().eq("id", jobId);
    }
  });
});
