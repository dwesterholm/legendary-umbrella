import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMacroSnapshot } from "@/lib/market/macro";

/**
 * Mocked Supabase client + mocked global.fetch (mirrors scb.test.ts's
 * fetch-mocking style and generate-report.test.ts's chainable Supabase fake).
 * No live network/DB calls.
 */

function makeMockSupabase(row: Record<string, unknown> | null) {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle,
        }),
      }),
    }),
    upsert,
  }));
  return { from, __upsert: upsert, __maybeSingle: maybeSingle };
}

const freshFetchedAt = new Date().toISOString();
const staleFetchedAt = new Date(
  Date.now() - 48 * 3_600_000, // 48h ago — well past a 24h TTL
).toISOString();

const cachedPayload = {
  policyRate: { value: 1.5, date: "2026-06-01", source: "Riksbank" },
  inflation: {
    value: 1.2,
    period: "2026M04",
    source: "SCB",
    measure: "KPIF" as const,
  },
  regionalPrice: {
    value: 3300,
    year: "2024",
    preliminary: false,
    regionCode: "01",
    source: "SCB",
  },
};

const riksbankResponse = { date: "2026-07-06", value: 1.75 };
const cpifResponse = {
  class: "dataset",
  id: ["ContentsCode", "Tid"],
  size: [1, 1],
  dimension: {
    Tid: { category: { index: { "2026M05": 0 } } },
  },
  value: [1.4],
};
const regionalPriceResponse = {
  class: "dataset",
  id: ["Region", "ContentsCode", "Tid"],
  size: [1, 1, 1],
  dimension: {
    Tid: { category: { index: { "2025": 0 } } },
  },
  value: [3500],
  note: ["Most recent year's figures are preliminary."],
};

function mockFetchOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("fetchMacroSnapshot — cache hit/miss/stale (read-through TTL cache)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("cache hit: a FRESH row is returned WITHOUT calling fetch", async () => {
    const supabase = makeMockSupabase({
      payload: cachedPayload,
      fetched_at: freshFetchedAt,
    });
    const result = await fetchMacroSnapshot(supabase as never, "01");
    expect(result).toEqual(cachedPayload);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabase.__upsert).not.toHaveBeenCalled();
  });

  it("cache miss: NO row present calls live fetchers and upserts with onConflict scope,region_code", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeMockSupabase(null);
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.policyRate?.value).toBe(1.75);
    expect(result?.inflation?.value).toBe(1.4);
    expect(result?.regionalPrice?.value).toBe(3500);
    expect(supabase.__upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: expect.any(String) }),
      expect.objectContaining({ onConflict: "scope,region_code" }),
    );
  });

  it("selects the most-recent SCB period via PxWeb `top`, never a hardcoded date literal (BL-3)", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    await fetchMacroSnapshot(makeMockSupabase(null) as never, "01");

    const calls = fetchSpy.mock.calls as unknown as Array<[unknown, { body?: string }]>;
    const bodyFor = (needle: string) => {
      const call = calls.find((c) => String(c[0]).includes(needle));
      if (!call) throw new Error(`no fetch for ${needle}`);
      return JSON.parse(call[1]?.body ?? "{}") as {
        query: Array<{ code: string; selection: { filter: string; values: string[] } }>;
      };
    };
    const tidSel = (needle: string) =>
      bodyFor(needle).query.find((q) => q.code === "Tid")?.selection;

    // Inflation → the single most-recent published month; regional → the two
    // most-recent years (latest + prior for the lastNonNull fallback).
    expect(tidSel("KPIF")).toEqual({ filter: "top", values: ["1"] });
    expect(tidSel("BO0501C")).toEqual({ filter: "top", values: ["2"] });
    // No stale calendar literal survives in the outgoing query.
    expect(JSON.stringify(bodyFor("KPIF"))).not.toContain("2026M05");
    expect(JSON.stringify(bodyFor("BO0501C"))).not.toContain("2024");
  });

  it("stale row (fetched_at older than TTL) re-fetches live and upserts", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeMockSupabase({
      payload: cachedPayload,
      fetched_at: staleFetchedAt,
    });
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(fetchSpy).toHaveBeenCalled();
    expect(supabase.__upsert).toHaveBeenCalled();
    expect(result?.policyRate?.value).toBe(1.75);
  });
});

describe("fetchMacroSnapshot — independent per-indicator degradation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("when the policy-rate fetch rejects, policyRate is null but inflation + regionalPrice populate", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) {
        throw new Error("Riksbank API down");
      }
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeMockSupabase(null);
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(result?.policyRate).toBeNull();
    expect(result?.inflation?.value).toBe(1.4);
    expect(result?.regionalPrice?.value).toBe(3500);
  });

  it("when the SCB inflation fetch fails (non-ok), inflation is null but policyRate + regionalPrice populate", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeMockSupabase(null);
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(result?.policyRate?.value).toBe(1.75);
    expect(result?.inflation).toBeNull();
    expect(result?.regionalPrice?.value).toBe(3500);
  });

  it("an invalid län code never reaches the SCB regional-price query body (SSRF allowlist) — regionalPrice degrades to null", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) {
        throw new Error(
          "regional price fetch must not be called for an invalid region code",
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeMockSupabase(null);
    const result = await fetchMacroSnapshot(supabase as never, "not-a-lan");

    expect(result?.policyRate?.value).toBe(1.75);
    expect(result?.inflation?.value).toBe(1.4);
    expect(result?.regionalPrice).toBeNull();
  });
});

describe("fetchMacroSnapshot — WR-01: national indicators cached once system-wide, not per-län", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /**
   * A stateful mock keyed by (scope, region_code) so national vs regional
   * cache reads/writes can be asserted independently — the flat single-row
   * mock used above is too coarse to prove the WR-01 split (it returns the
   * same row regardless of scope).
   */
  function makeScopedMockSupabase() {
    const rows = new Map<string, { payload: unknown; fetched_at: string }>();
    const upsertCalls: Array<{ scope: string; region_code: string }> = [];
    const from = vi.fn(() => {
      let scope = "";
      let regionCode = "";
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            if (col === "scope") scope = val;
            return {
              eq: (col2: string, val2: string) => {
                if (col2 === "region_code") regionCode = val2;
                return {
                  maybeSingle: async () => ({
                    data: rows.get(`${scope}:${regionCode}`) ?? null,
                    error: null,
                  }),
                };
              },
            };
          },
        }),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          const s = row.scope as string;
          const r = row.region_code as string;
          upsertCalls.push({ scope: s, region_code: r });
          rows.set(`${s}:${r}`, {
            payload: row.payload,
            fetched_at: row.fetched_at as string,
          });
          return { data: null, error: null };
        }),
      };
    });
    return { from, __upsertCalls: upsertCalls };
  }

  it("two distinct län codes share ONE national cache fetch — the national fetchers run exactly once, not once per län", async () => {
    let riksbankCalls = 0;
    let cpifCalls = 0;
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) {
        riksbankCalls += 1;
        return mockFetchOk(riksbankResponse);
      }
      if (url.includes("KPIF")) {
        cpifCalls += 1;
        return mockFetchOk(cpifResponse);
      }
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeScopedMockSupabase();

    const first = await fetchMacroSnapshot(supabase as never, "01");
    const second = await fetchMacroSnapshot(supabase as never, "03");

    // National indicators are identical across both calls (single system-wide
    // cache scope) — the live fetchers ran exactly ONCE across BOTH calls.
    expect(riksbankCalls).toBe(1);
    expect(cpifCalls).toBe(1);
    expect(first.policyRate?.value).toBe(1.75);
    expect(second.policyRate?.value).toBe(1.75);
    expect(first.inflation?.value).toBe(1.4);
    expect(second.inflation?.value).toBe(1.4);

    // Regional price is still independently keyed per län (both cached rows exist).
    expect(
      supabase.__upsertCalls.filter((c) => c.scope === "national"),
    ).toHaveLength(1);
    expect(
      supabase.__upsertCalls.filter((c) => c.scope === "regional"),
    ).toHaveLength(2);
  });

  it("a national-cache-scope failure never blanks the regional price, and vice versa", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) throw new Error("Riksbank down");
      if (url.includes("KPIF")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const supabase = makeScopedMockSupabase();
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(result.policyRate).toBeNull();
    expect(result.inflation).toBeNull();
    expect(result.regionalPrice?.value).toBe(3500);
  });
});

describe("fetchMacroSnapshot — CR-01: cached rows are re-validated on read (cache-poisoning defense)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("a poisoned/malformed FRESH cached row is treated as a cache MISS — re-fetches live instead of returning the garbage payload", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    // Arbitrary JSON an authenticated user could have upserted directly
    // against PostgREST — wrong shape entirely (a string field where an
    // object is expected), NOT the schema-validated MacroData shape.
    const poisonedPayload = {
      policyRate: "999% GUARANTEED PRICE CRASH — SELL NOW",
      inflation: null,
      regionalPrice: null,
    };
    const supabase = makeMockSupabase({
      payload: poisonedPayload,
      fetched_at: freshFetchedAt,
    });
    const result = await fetchMacroSnapshot(supabase as never, "01");

    // The poisoned row must NEVER be returned as-is.
    expect(result.policyRate).not.toBe(poisonedPayload.policyRate);
    // The NATIONAL scope's malformed row fails schema validation and falls
    // through to a live re-fetch instead of surfacing the poisoned string.
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.policyRate?.value).toBe(1.75);
    expect(result.inflation?.value).toBe(1.4);
    // The REGIONAL scope's row (`regionalPrice: null`) is independently
    // schema-VALID (a null regional price is a legitimate degraded state),
    // so it is honored as a genuine cache hit — proving the two scopes'
    // validation is independent, not an all-or-nothing gate.
    expect(result.regionalPrice).toBeNull();
  });

  it("a structurally-valid but wrong-scope row (e.g. a regional payload with no policyRate/inflation keys) parsed against the NATIONAL schema is rejected and re-fetched", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("riksbank")) return mockFetchOk(riksbankResponse);
      if (url.includes("KPIF")) return mockFetchOk(cpifResponse);
      if (url.includes("BO0501C")) return mockFetchOk(regionalPriceResponse);
      throw new Error(`unexpected fetch url: ${url}`);
    });
    // Missing the required (nullable-but-present) policyRate/inflation keys.
    const wrongShapePayload = { regionalPrice: null };
    const supabase = makeMockSupabase({
      payload: wrongShapePayload,
      fetched_at: freshFetchedAt,
    });
    const result = await fetchMacroSnapshot(supabase as never, "01");

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.policyRate?.value).toBe(1.75);
  });
});
