import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * route.test.ts (CR-02, 09-REVIEW.md) — proves the `/api/discovery/sweep`
 * Vercel Cron endpoint fails closed on a missing/wrong `CRON_SECRET` BEFORE
 * any DB client is constructed or any query runs, and that a correctly
 * authenticated call uses the service-role client (never the cookie-bound
 * anon client) to reclaim stuck jobs across all users.
 */

const runSlice = vi.fn();
const claimAndRunVisionForJob = vi.fn();
vi.mock("@/lib/discovery/job", () => ({
  runSlice: (...args: unknown[]) => runSlice(...args),
  claimAndRunVisionForJob: (...args: unknown[]) => claimAndRunVisionForJob(...args),
}));

let selectCalls: number;
let rpcCalls: Array<{ fn: string; args: unknown }>;
let stuckJobs: Array<{ id: string }>;
let wedgedJobs: Array<{ id: string }>;
let visionResetCalls: number;
let claimResult: { data: unknown; error: { code: string } | null };
const createServiceRoleClient = vi.fn(() => {
  return {
    from: () => ({
      select: () => {
        selectCalls += 1;
        return {
          // .eq() feeds BOTH query shapes: the "processing" sweep uses
          // .eq().or().limit(); the "vision_processing" recovery (WR-04) uses
          // .eq().limit().
          eq: () => ({
            or: () => ({
              limit: async () => ({ data: stuckJobs, error: null }),
            }),
            limit: async () => ({ data: wedgedJobs, error: null }),
          }),
        };
      },
      // WR-04 recovery reset: .update({status:"done"}).eq("id").eq("status").
      update: () => ({
        eq: () => ({
          eq: async () => {
            visionResetCalls += 1;
            return { error: null };
          },
        }),
      }),
    }),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { maybeSingle: async () => claimResult };
    },
  };
});

vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { GET } from "@/app/api/discovery/sweep/route";

function req(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("https://example.com/api/discovery/sweep", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls = 0;
  rpcCalls = [];
  stuckJobs = [];
  wedgedJobs = [];
  visionResetCalls = 0;
  claimResult = { data: null, error: null };
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("GET /api/discovery/sweep — CRON_SECRET gate (CR-02)", () => {
  it("returns 401 and does NO DB work when the authorization header is missing", async () => {
    const response = await GET(req());

    expect(response.status).toBe(401);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(selectCalls).toBe(0);
    expect(runSlice).not.toHaveBeenCalled();
  });

  it("returns 401 and does NO DB work when the authorization header is wrong", async () => {
    const response = await GET(req("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(selectCalls).toBe(0);
    expect(runSlice).not.toHaveBeenCalled();
  });

  it("returns 401 and does NO DB work when CRON_SECRET is unset server-side", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(req("Bearer test-secret"));

    expect(response.status).toBe(401);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(selectCalls).toBe(0);
  });

  it("proceeds using the service-role client when the secret matches", async () => {
    stuckJobs = [{ id: "job-1" }];
    claimResult = { data: { id: "job-1", status: "processing" }, error: null };

    const response = await GET(req("Bearer test-secret"));

    expect(response.status).toBe(200);
    expect(createServiceRoleClient).toHaveBeenCalledTimes(1);
    // Two selects now: the "processing" sweep + the "vision_processing" recovery (WR-04).
    expect(selectCalls).toBe(2);
    expect(rpcCalls[0]?.fn).toBe("claim_discovery_slice");
    expect(runSlice).toHaveBeenCalledTimes(1);

    const body = await response.json();
    expect(body).toEqual({ swept: 1 });
  });

  it("recovers a wedged 'vision_processing' row: resets it to 'done' and re-attempts the vision pass (WR-04)", async () => {
    // No stuck 'processing' jobs, but one row wedged at 'vision_processing'.
    stuckJobs = [];
    wedgedJobs = [{ id: "job-wedged" }];

    const response = await GET(req("Bearer test-secret"));

    expect(response.status).toBe(200);
    expect(runSlice).not.toHaveBeenCalled();
    expect(visionResetCalls).toBe(1); // conditional reset to "done"
    expect(claimAndRunVisionForJob).toHaveBeenCalledTimes(1);
    expect(claimAndRunVisionForJob.mock.calls[0][1]).toBe("job-wedged");

    const body = await response.json();
    expect(body).toEqual({ swept: 1 });
  });

  it("always delegates to claimAndRunVisionForJob after a slice runs (CR-04: the CAS decides internally whether the job is actually 'done')", async () => {
    stuckJobs = [{ id: "job-1" }];
    claimResult = { data: { id: "job-1", status: "processing" }, error: null };

    const response = await GET(req("Bearer test-secret"));

    expect(response.status).toBe(200);
    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(claimAndRunVisionForJob).toHaveBeenCalledTimes(1);
    expect(claimAndRunVisionForJob.mock.calls[0][1]).toBe("job-1");
  });
});
