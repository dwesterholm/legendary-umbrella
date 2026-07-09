import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * start-discovery.test.ts — proves the flag-first fail-closed discipline
 * (DISC-07/T-09-08), the auth gate, the per-user-per-day job cap (T-09-09,
 * now enforced atomically via `insert_discovery_job_if_under_cap` — WR-01),
 * the low-confidence confirmation branch (no job inserted), and that an
 * explicit `areaQuery` FormData override wins over the Haiku-inferred area
 * (CR-03). Mirrors the mocking shape established in generate-report.test.ts
 * / analyze-brf's Supabase mocks — no live Anthropic key, no real Supabase.
 */

const parseIntent = vi.fn();
vi.mock("@/lib/discovery/parse-intent", () => ({
  parseIntent: (...args: unknown[]) => parseIntent(...args),
}));

let mockUser: { id: string } | null;
/** Captures every `insert_discovery_job_if_under_cap` RPC call's args. */
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
/** Controls the RPC's returned row. */
let rpcResult: { data: unknown; error: { code: string } | null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));

import { startDiscovery } from "@/actions/start-discovery";

function formData(freeText: string, extra?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("free_text", freeText);
  for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: "user-1" };
  rpcCalls = [];
  rpcResult = { data: [{ id: "job-1", capped: false }], error: null };
  parseIntent.mockResolvedValue({
    ok: true,
    filter: {
      areaQuery: "Södermalm",
      priceMax: 4_000_000,
      roomsMin: 3,
      sizeMin: null,
      objectType: "Lägenhet",
      confidence: 0.8,
    },
    confidence: 0.8,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
});

describe("startDiscovery — feature flag (DISC-07 / T-09-08 fail-closed)", () => {
  it("refuses immediately when DISCOVERY_ENABLED is unset, WITHOUT calling auth/parse/insert", async () => {
    delete process.env.DISCOVERY_ENABLED;

    const result = await startDiscovery(formData("3:a på Södermalm"));

    expect(result.ok).toBe(false);
    expect(parseIntent).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses immediately when DISCOVERY_ENABLED is any value other than 'true'", async () => {
    process.env.DISCOVERY_ENABLED = "false";

    const result = await startDiscovery(formData("3:a på Södermalm"));

    expect(result.ok).toBe(false);
    expect(parseIntent).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);

    delete process.env.DISCOVERY_ENABLED;
  });
});

describe("startDiscovery — flag on", () => {
  beforeEach(() => {
    process.env.DISCOVERY_ENABLED = "true";
  });

  it("refuses when no user is authenticated", async () => {
    mockUser = null;

    const result = await startDiscovery(formData("3:a på Södermalm"));

    expect(result.ok).toBe(false);
    expect(parseIntent).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses when the per-user-per-day job cap RPC reports capped, before any job exists", async () => {
    rpcResult = { data: [{ id: null, capped: true }], error: null };

    const result = await startDiscovery(formData("3:a på Södermalm"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("insert_discovery_job_if_under_cap");
  });

  it("fails closed when the cap RPC itself errors", async () => {
    rpcResult = { data: null, error: { code: "42501" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await startDiscovery(formData("3:a på Södermalm"));

    expect(result.ok).toBe(false);
    errorSpy.mockRestore();
  });

  it("returns needsConfirmation and calls NO insert RPC on a low-confidence parse", async () => {
    parseIntent.mockResolvedValue({
      ok: false,
      needsConfirmation: true,
      filter: {
        areaQuery: "nånstans",
        priceMax: null,
        roomsMin: null,
        sizeMin: null,
        objectType: "Alla",
        confidence: 0.3,
      },
      confidence: 0.3,
    });

    const result = await startDiscovery(formData("nånstans billigt"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { needsConfirmation?: boolean }).needsConfirmation).toBe(true);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("inserts a pending discovery_jobs row via the atomic RPC and returns the jobId on a confident parse under cap", async () => {
    const result = await startDiscovery(formData("3:a på Södermalm under 4 miljoner"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jobId).toBe("job-1");
    }
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("insert_discovery_job_if_under_cap");
    const args = rpcCalls[0].args;
    expect(args.p_free_text).toBe("3:a på Södermalm under 4 miljoner");
    const filters = args.p_filters as Record<string, unknown>;
    expect(filters).toMatchObject({ areaQuery: "Södermalm" });
    expect(typeof args.p_cap_candidates).toBe("number");
    expect(typeof args.p_cap_sek).toBe("number");
    expect(typeof args.p_jobs_per_day_cap).toBe("number");
  });

  it("refuses when free_text is empty", async () => {
    const result = await startDiscovery(formData(""));

    expect(result.ok).toBe(false);
    expect(parseIntent).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("prefers the explicit areaQuery FormData override over the Haiku-inferred area (CR-03)", async () => {
    // Haiku infers "Södermalm" (per the shared beforeEach mock), but the user
    // explicitly picked "nacka" from the seeded dropdown — the explicit,
    // guaranteed-resolvable signal must win.
    const result = await startDiscovery(
      formData("3:a nära vattnet, max 4 miljoner", { areaQuery: "nacka" }),
    );

    expect(result.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    const filters = rpcCalls[0].args.p_filters as Record<string, unknown>;
    expect(filters.areaQuery).toBe("nacka");
  });

  it("falls back to the Haiku-inferred area when no areaQuery override is provided", async () => {
    const result = await startDiscovery(formData("3:a på Södermalm under 4 miljoner"));

    expect(result.ok).toBe(true);
    const filters = rpcCalls[0].args.p_filters as Record<string, unknown>;
    expect(filters.areaQuery).toBe("Södermalm");
  });

  it("validates the objectType override through the Zod enum, ignoring an invalid value (WR-02)", async () => {
    const result = await startDiscovery(
      formData("3:a på Södermalm", { objectType: "NotARealType" }),
    );

    expect(result.ok).toBe(true);
    const filters = rpcCalls[0].args.p_filters as Record<string, unknown>;
    // Falls back to the Haiku-parsed value rather than persisting garbage.
    expect(filters.objectType).toBe("Lägenhet");
  });

  it("accepts a valid objectType override", async () => {
    const result = await startDiscovery(
      formData("3:a på Södermalm", { objectType: "Villa" }),
    );

    expect(result.ok).toBe(true);
    const filters = rpcCalls[0].args.p_filters as Record<string, unknown>;
    expect(filters.objectType).toBe("Villa");
  });
});
