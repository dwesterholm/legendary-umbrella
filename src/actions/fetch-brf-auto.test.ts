import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression suite for `fetch-brf-auto.ts` (08-03-PLAN.md Tasks 1-2). NO real
 * Supabase, NO live Allabrf/Claude network call: `@/lib/supabase/server`,
 * `@/lib/brf-source/allabrf`, `@/lib/brf-source/fetch-document`, and
 * `@/lib/brf/run-extraction` are all mocked, mirroring the mocking shape
 * established in `analyze-brf.test.ts`/`generate-report.test.ts`.
 *
 * Covers: auth/ownership gate (both actions), the confidence-driven
 * fall-through contract, the redundant-work guard, org.nr re-validation, and
 * the happy-path hand-off to the shared `runBrfExtraction` pipeline.
 */

let mockUser: { id: string } | null = null;
let mockRow: Record<string, unknown> | null = null;
let updateCalls: Array<Record<string, unknown>> = [];
/**
 * Forces the CAS acquire (`.or(...).select().maybeSingle()`) to behave as if
 * a concurrent request already holds the lock — `acquired` resolves to null,
 * simulating "the conditional UPDATE wrote zero rows" without needing a real
 * Postgres to evaluate the `.or()` predicate. Reset in `beforeEach`.
 */
let forceCasLost = false;
/** Forces the CAS acquire to return a DB error instead of a lost race. */
let forceCasError: { code: string } | null = null;

/**
 * A tiny chainable fake mirroring generate-report.test.ts's `updateChain`
 * shape (CR-01 fix made `confirmAndAnalyze`'s acquire/release an atomic CAS,
 * same family as `generateReport`'s lock). Supports three call shapes used by
 * the fixed `fetch-brf-auto.ts`:
 *   - `.update(payload).eq(id).or(...).select().maybeSingle()` — the CAS
 *     acquire; resolves `{ data: {id}, error }` or `{ data: null, error }`
 *     when `forceCasLost`/`forceCasError` is set (simulating a lost race).
 *   - `.update(payload).eq(id).eq("brf_status","auto_fetching")` — the WR-02
 *     conditional release; awaited directly (thenable), applies the payload
 *     to `mockRow` only when `mockRow.brf_status === "auto_fetching"`, mirroring
 *     Postgres's conditional-UPDATE semantics.
 */
function updateChain(payload: Record<string, unknown>) {
  updateCalls.push(payload);
  const chain: Record<string, unknown> = {
    eq: (col?: string, val?: unknown) => {
      // The WR-02 conditional release: `.eq("id", id).eq("brf_status", "auto_fetching")`.
      if (col === "brf_status") {
        return {
          then: (resolve: (v: { error: null }) => unknown) => {
            if (mockRow && mockRow.brf_status === val) {
              mockRow = { ...mockRow, ...payload };
            }
            return resolve({ error: null });
          },
        };
      }
      return chain;
    },
    or: () => chain,
    select: () => chain,
    maybeSingle: async () => {
      if (forceCasError) return { data: null, error: forceCasError };
      if (forceCasLost) return { data: null, error: null };
      // Acquire succeeds — apply the payload (mirrors a real conditional UPDATE
      // that matched the row) and hand back a non-null row.
      if (mockRow) {
        mockRow = { ...mockRow, ...payload };
      }
      return { data: { id: mockRow?.id ?? null }, error: null };
    },
    then: (resolve: (v: { error: null }) => unknown) => {
      // Legacy unconditional-await shape (kept for any remaining direct
      // `.update(...).eq(...)` awaits elsewhere in the module).
      if (mockRow) {
        mockRow = { ...mockRow, ...payload };
      }
      return resolve({ error: null });
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: mockRow,
            error: mockRow ? null : { message: "not found" },
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => updateChain(payload),
    }),
  }),
}));

const searchAllabrfByName = vi.fn();
const fetchAllabrfDocument = vi.fn();
vi.mock("@/lib/brf-source/allabrf", () => ({
  searchAllabrfByName: (...args: unknown[]) => searchAllabrfByName(...args),
  fetchAllabrfDocument: (...args: unknown[]) => fetchAllabrfDocument(...args),
}));

const fetchArsredovisning = vi.fn();
vi.mock("@/lib/brf-source/fetch-document", () => ({
  fetchArsredovisning: (...args: unknown[]) => fetchArsredovisning(...args),
}));

const runBrfExtraction = vi.fn();
vi.mock("@/lib/brf/run-extraction", () => ({
  runBrfExtraction: (...args: unknown[]) => runBrfExtraction(...args),
}));

import { resolveOrgNrAction, confirmAndAnalyze } from "@/actions/fetch-brf-auto";

const USER_ID = "user-1";
const ANALYSIS_ID = "analysis-1";
const VALID_ORG_NR = "5560360793";
const INVALID_ORG_NR = "5560360794";

function baseListingData(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://www.booli.se/bostad/1",
    address: "Testgatan 1",
    price: 3_000_000,
    livingArea: 50,
    rooms: 2,
    monthlyFee: 4000,
    buildYear: 1990,
    brfName: "Brf Björken",
    prisPerKvm: 60_000,
    latitude: null,
    longitude: null,
    booliId: null,
    breadcrumbs: [
      { label: "Stockholms län", url: "https://www.booli.se/sok?areaIds=2" },
      { label: "Stockholms kommun", url: "https://www.booli.se/sok?areaIds=1" },
      { label: "Södermalm", url: "https://www.booli.se/sok?areaIds=3" },
    ],
    floor: null,
    balcony: null,
    renovationStatus: null,
    description: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls = [];
  forceCasLost = false;
  forceCasError = null;
  mockUser = { id: USER_ID };
  mockRow = {
    id: ANALYSIS_ID,
    user_id: USER_ID,
    listing_data: baseListingData(),
    brf_status: null,
  };
});

describe("fetch-brf-auto — module surface", () => {
  it("exports resolveOrgNrAction and confirmAndAnalyze", () => {
    expect(typeof resolveOrgNrAction).toBe("function");
    expect(typeof confirmAndAnalyze).toBe("function");
  });
});

describe("resolveOrgNrAction — auth + ownership gate", () => {
  it("blocks unauthenticated callers before any Allabrf call", async () => {
    mockUser = null;

    const result = await resolveOrgNrAction(ANALYSIS_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Logga in för BRF-analys");
    expect(searchAllabrfByName).not.toHaveBeenCalled();
  });

  it("blocks a non-owner before any Allabrf call", async () => {
    mockRow = {
      id: ANALYSIS_ID,
      user_id: "someone-else",
      listing_data: baseListingData(),
      brf_status: null,
    };

    const result = await resolveOrgNrAction(ANALYSIS_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Analysen hittades inte.");
    expect(searchAllabrfByName).not.toHaveBeenCalled();
  });
});

describe("resolveOrgNrAction — confidence-gated resolution", () => {
  it("falls through with confidence 'none' when the listing has no brfName", async () => {
    mockRow = {
      id: ANALYSIS_ID,
      user_id: USER_ID,
      listing_data: baseListingData({ brfName: null }),
      brf_status: null,
    };

    const result = await resolveOrgNrAction(ANALYSIS_ID);

    expect(result.ok).toBe(true);
    if (result.ok && result.confidence !== "high") {
      expect(result.confidence).toBe("none");
      expect(result.fallThrough).toBe(true);
    }
    expect(searchAllabrfByName).not.toHaveBeenCalled();
  });

  it("falls through with confidence 'low' on an ambiguous (multi-candidate) match", async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken", kommun: "Stockholm" },
      { orgNr: "5560360017", name: "Brf Björken", kommun: "Göteborg" },
    ]);

    const result = await resolveOrgNrAction(ANALYSIS_ID);

    expect(result.ok).toBe(true);
    if (result.ok && result.confidence !== "high") {
      expect(result.confidence).toBe("low");
      expect(result.fallThrough).toBe(true);
    }
    expect(fetchAllabrfDocument).not.toHaveBeenCalled();
  });

  it("returns confidence 'high' with a fiscal-year preview on an exact, geo-corroborated match", async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken", kommun: "Stockholms" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "irrelevant preview text",
      fiscalYear: 2024,
      availableYears: [2024],
    });

    const result = await resolveOrgNrAction(ANALYSIS_ID);

    expect(result.ok).toBe(true);
    if (result.ok && result.confidence === "high") {
      expect(result.orgNr).toBe(VALID_ORG_NR);
      expect(result.matchedName).toBe("Brf Björken");
      expect(result.fiscalYear).toBe(2024);
      expect(result.brfName).toBe("Brf Björken");
    } else {
      throw new Error("expected high confidence");
    }
    expect(searchAllabrfByName).toHaveBeenCalledWith("Brf Björken");
  });

  it("never writes any status or analyzes anything", async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "irrelevant",
      fiscalYear: 2024,
      availableYears: [2024],
    });

    await resolveOrgNrAction(ANALYSIS_ID);

    expect(updateCalls).toHaveLength(0);
    expect(runBrfExtraction).not.toHaveBeenCalled();
  });
});

describe("confirmAndAnalyze — auth + ownership gate", () => {
  it("blocks unauthenticated callers before any fetch", async () => {
    mockUser = null;

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Logga in för BRF-analys");
    expect(fetchArsredovisning).not.toHaveBeenCalled();
  });

  it("blocks a non-owner before any fetch", async () => {
    mockRow = {
      id: ANALYSIS_ID,
      user_id: "someone-else",
      brf_status: null,
    };

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Analysen hittades inte.");
    expect(fetchArsredovisning).not.toHaveBeenCalled();
  });
});

describe("confirmAndAnalyze — org.nr re-validation (T-08-11)", () => {
  it("rejects an invalid org.nr without fetching anything", async () => {
    const result = await confirmAndAnalyze(ANALYSIS_ID, INVALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok && "fallThrough" in result) {
      expect(result.fallThrough).toBe(true);
    }
    expect(fetchArsredovisning).not.toHaveBeenCalled();
    expect(runBrfExtraction).not.toHaveBeenCalled();
  });
});

describe("confirmAndAnalyze — redundant-work guard (T-08-12)", () => {
  it("returns early without fetching when brf_status is already 'auto_fetching'", async () => {
    // In real Postgres, the CAS `.or("brf_status.is.null,and(...))` predicate
    // excludes a row already at `auto_fetching` — the conditional UPDATE
    // writes zero rows. The mock simulates that lost-race outcome directly
    // via `forceCasLost` rather than re-implementing PostgREST's `.or()`
    // predicate evaluation.
    mockRow = { id: ANALYSIS_ID, user_id: USER_ID, brf_status: "auto_fetching" };
    forceCasLost = true;

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok && "fallThrough" in result) {
      expect(result.fallThrough).toBe(true);
    }
    expect(fetchArsredovisning).not.toHaveBeenCalled();
  });

  it("returns early without fetching when brf_status is already 'done'", async () => {
    mockRow = { id: ANALYSIS_ID, user_id: USER_ID, brf_status: "done" };
    forceCasLost = true;

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok && "fallThrough" in result) {
      expect(result.fallThrough).toBe(true);
    }
    expect(fetchArsredovisning).not.toHaveBeenCalled();
  });

  it("CR-01: a concurrent double-trigger acquires the lock exactly once — the second caller aborts without a second scrape/bill", async () => {
    // Simulates two near-simultaneous confirmAndAnalyze calls for the SAME
    // analysisId (double-click / duplicated tab / retry-on-timeout). In real
    // Postgres, the DB serialises the two conditional UPDATEs so exactly one
    // caller's CAS acquire succeeds and the other observes zero rows written.
    // The mock cannot model true DB-level serialization of two in-flight
    // promises, so this test models the race as two SEQUENTIAL calls sharing
    // the SAME `mockRow` state (the property under test — CAS correctness —
    // does not depend on interleaving, only on "the second caller's acquire
    // must fail once the first has flipped brf_status to auto_fetching",
    // which is exactly what the real `.or(is.null, neq...)` predicate
    // guarantees against a row already at `auto_fetching`).
    fetchArsredovisning.mockResolvedValue({
      source: "auto_allabrf",
      text: "extracted plain text",
      orgNr: VALID_ORG_NR,
      fiscalYear: 2024,
      isMostRecent: true,
    });
    runBrfExtraction.mockResolvedValue({
      ok: true,
      data: { extraction: {}, normalized: {}, grade: {}, perFieldConfidence: {}, citations: [] },
      cached: false,
    });
    // Never resolves before the second call's CAS check runs — models the
    // first request's scrape/bill still being in flight when the second
    // request's acquire is attempted.
    let releaseFirst: () => void = () => {};
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fetchArsredovisning.mockImplementation(async () => {
      await firstFetchGate;
      return {
        source: "auto_allabrf" as const,
        text: "extracted plain text",
        orgNr: VALID_ORG_NR,
        fiscalYear: 2024,
        isMostRecent: true,
      };
    });

    const first = confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);
    // Wait until `first`'s CAS acquire has actually landed and flipped
    // mockRow to "auto_fetching" (rather than guessing a microtask count) —
    // `first` itself is still in flight, blocked on firstFetchGate inside
    // fetchArsredovisning.
    while (mockRow?.brf_status !== "auto_fetching") {
      await Promise.resolve();
    }

    // The second caller's CAS observes the row already at "auto_fetching" —
    // simulated directly since the mock doesn't evaluate the `.or()`
    // predicate against real row state for the acquire path.
    forceCasLost = true;
    const second = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);
    forceCasLost = false;

    releaseFirst();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok && "fallThrough" in second) {
      expect(second.fallThrough).toBe(true);
    }
    // The second (racing) call never scraped or billed Claude.
    expect(fetchArsredovisning).toHaveBeenCalledTimes(1);
    expect(runBrfExtraction).toHaveBeenCalledTimes(1);
  });
});

describe("confirmAndAnalyze — fetch failure falls through to manual (T-08-13)", () => {
  it("clears the transient status and returns fallThrough when fetchArsredovisning throws", async () => {
    fetchArsredovisning.mockRejectedValue(
      new Error("Alla årsredovisningskällor misslyckades: rung 1 failed"),
    );

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(result.ok).toBe(false);
    if (!result.ok && "fallThrough" in result) {
      expect(result.fallThrough).toBe(true);
    }
    expect(runBrfExtraction).not.toHaveBeenCalled();

    // Status was set to auto_fetching, then released (not left wedged).
    const finalStatusWrite = updateCalls[updateCalls.length - 1];
    expect(finalStatusWrite.brf_status).toBeNull();
  });

  it("WR-02: does NOT clobber a status a concurrent/retried request already advanced past auto_fetching", async () => {
    // Simulates: this invocation's fetch fails, but by the time its catch
    // block's release write runs, a concurrent/retried invocation has
    // already progressed the row to `done`. The release is a CONDITIONAL
    // update (`.eq("brf_status", "auto_fetching")`) — it must not fire when
    // the row has since moved on, so `done` must survive.
    fetchArsredovisning.mockRejectedValue(new Error("boom"));

    // Precondition: acquire succeeds, then simulate a concurrent winner
    // advancing the row past `auto_fetching` before the catch block's
    // release write executes. We simulate this by monkey-patching the
    // release call to observe a `mockRow.brf_status` that's no longer
    // `auto_fetching` — achieved by resolving `fetchArsredovisning` on a
    // microtask that first flips `mockRow.brf_status` to "done".
    fetchArsredovisning.mockImplementation(async () => {
      mockRow = { ...(mockRow as Record<string, unknown>), brf_status: "done" };
      throw new Error("boom");
    });

    await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    // The conditional release's .eq("brf_status","auto_fetching") should NOT
    // match (row is now "done"), so the final persisted status must remain
    // "done", never regressed to null.
    expect(mockRow?.brf_status).toBe("done");
  });
});

describe("confirmAndAnalyze — happy path hands off to runBrfExtraction", () => {
  it("writes auto_fetching, then calls runBrfExtraction with ixbrl-text + auto_allabrf", async () => {
    fetchArsredovisning.mockResolvedValue({
      source: "auto_allabrf",
      text: "extracted plain text",
      orgNr: VALID_ORG_NR,
      fiscalYear: 2024,
      isMostRecent: true,
    });
    runBrfExtraction.mockResolvedValue({
      ok: true,
      data: { extraction: {}, normalized: {}, grade: {}, perFieldConfidence: {}, citations: [] },
      cached: false,
    });

    const result = await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2024);

    expect(updateCalls[0]).toEqual({ brf_status: "auto_fetching" });
    expect(runBrfExtraction).toHaveBeenCalledWith(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "extracted plain text" },
      "auto_allabrf",
      { fiscalYear: 2024, isMostRecent: true },
    );
    expect(result.ok).toBe(true);
  });

  it("threads the FetchedDocument's fiscalYear/isMostRecent, not the client-supplied preview value (ROADMAP Success Criterion 4)", async () => {
    // The client passes a stale preview value (2023); fetchArsredovisning's
    // actual result (2024, isMostRecent:false) is the source of truth that
    // must reach runBrfExtraction's fetchMeta — never the preview argument.
    fetchArsredovisning.mockResolvedValue({
      source: "auto_allabrf",
      text: "extracted plain text",
      orgNr: VALID_ORG_NR,
      fiscalYear: 2024,
      isMostRecent: false,
    });
    runBrfExtraction.mockResolvedValue({
      ok: true,
      data: { extraction: {}, normalized: {}, grade: {}, perFieldConfidence: {}, citations: [] },
      cached: false,
    });

    await confirmAndAnalyze(ANALYSIS_ID, VALID_ORG_NR, 2023);

    expect(runBrfExtraction).toHaveBeenCalledWith(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "extracted plain text" },
      "auto_allabrf",
      { fiscalYear: 2024, isMostRecent: false },
    );
  });
});
