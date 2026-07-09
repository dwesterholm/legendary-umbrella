import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * tick-discovery.test.ts — proves the atomic-claim caller contract (RESEARCH
 * Pattern 2): empty RPC result is a benign no-op, an RPC error fails closed,
 * and a successful claim invokes `runSlice` with the RETURNED row (never a
 * fresh SELECT). Also asserts the IDOR ownership pre-check and the
 * `TICK_DISCOVERY_MAX_DURATION_SEC` constant (RESEARCH Pitfall 2).
 *
 * [09-04 build-fix]: `maxDuration` is NOT exported from `tick-discovery.ts`
 * itself — Next.js's Server Actions bundler only permits async function
 * exports from a `"use server"` file, so the 300s ceiling this constant
 * documents now lives in `@/lib/discovery/tick-config` (a plain module, not
 * bundler-constrained). See that file's doc comment for the full "why."
 */

const runSlice = vi.fn();
const claimAndRunVisionForJob = vi.fn();
vi.mock("@/lib/discovery/job", () => ({
  runSlice: (...args: unknown[]) => runSlice(...args),
  claimAndRunVisionForJob: (...args: unknown[]) => claimAndRunVisionForJob(...args),
}));

let mockUser: { id: string } | null;
let mockJobRow: { user_id: string } | null;
let rpcResult: { data: unknown; error: { code: string } | null };
let rpcCalls: Array<{ fn: string; args: unknown }>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            mockJobRow ? { data: mockJobRow, error: null } : { data: null, error: { code: "PGRST116" } },
        }),
      }),
    }),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return {
        maybeSingle: async () => rpcResult,
      };
    },
  }),
}));

import { tickDiscovery } from "@/actions/tick-discovery";
import { TICK_DISCOVERY_MAX_DURATION_SEC } from "@/lib/discovery/tick-config";

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls = [];
  mockUser = { id: "user-1" };
  mockJobRow = { user_id: "user-1" };
  rpcResult = { data: null, error: null };
});

describe("tickDiscovery", () => {
  it("declares TICK_DISCOVERY_MAX_DURATION_SEC = 300 (Pitfall 2)", () => {
    expect(TICK_DISCOVERY_MAX_DURATION_SEC).toBe(300);
  });

  it("is a benign no-op when the RPC returns no claimable row", async () => {
    rpcResult = { data: null, error: null };

    await tickDiscovery("job-1");

    expect(runSlice).not.toHaveBeenCalled();
  });

  it("fails closed (no scrape) when the RPC errors", async () => {
    rpcResult = { data: null, error: { code: "42501" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tickDiscovery("job-1");

    expect(runSlice).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("calls claim_discovery_slice and invokes runSlice with the claimed row on success", async () => {
    const claimedRow = { id: "job-1", status: "processing", candidate_count: 0 };
    rpcResult = { data: claimedRow, error: null };

    await tickDiscovery("job-1");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("claim_discovery_slice");
    expect(rpcCalls[0].args).toMatchObject({ p_job_id: "job-1" });
    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(runSlice.mock.calls[0][1]).toEqual(claimedRow);
  });

  it("returns without claiming when there is no authenticated user", async () => {
    mockUser = null;

    await tickDiscovery("job-1");

    expect(rpcCalls).toHaveLength(0);
    expect(runSlice).not.toHaveBeenCalled();
  });

  it("returns without claiming when the caller does not own the job (IDOR guard)", async () => {
    mockJobRow = { user_id: "someone-else" };

    await tickDiscovery("job-1");

    expect(rpcCalls).toHaveLength(0);
    expect(runSlice).not.toHaveBeenCalled();
  });

  describe("Phase 11 (DISC-04) — separate post-scrape vision pass", () => {
    // CR-04 (11-REVIEW.md): tickDiscovery no longer does its own unlocked
    // check-then-act SELECT before deciding whether to run vision — it
    // unconditionally delegates to claimAndRunVisionForJob, which performs
    // its OWN atomic "done" -> "vision_processing" CAS internally and is a
    // benign no-op when the job is not in "done" status. These tests assert
    // the delegation itself, not a re-implementation of the CAS (that
    // atomicity is covered by job.test.ts's claimVisionSlice tests).
    it("always calls claimAndRunVisionForJob with the jobId after runSlice, regardless of the slice's resulting status", async () => {
      const claimedRow = { id: "job-1", status: "processing", candidate_count: 0 };
      rpcResult = { data: claimedRow, error: null };

      await tickDiscovery("job-1");

      expect(runSlice).toHaveBeenCalledTimes(1);
      expect(claimAndRunVisionForJob).toHaveBeenCalledTimes(1);
      expect(claimAndRunVisionForJob.mock.calls[0][1]).toBe("job-1");
    });

    it("does NOT call claimAndRunVisionForJob when the claim never succeeded (runSlice never ran)", async () => {
      rpcResult = { data: null, error: null };

      await tickDiscovery("job-1");

      expect(runSlice).not.toHaveBeenCalled();
      expect(claimAndRunVisionForJob).not.toHaveBeenCalled();
    });
  });
});
