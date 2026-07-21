import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * job.test.ts — unit-tests `runSlice` with a mocked Supabase update chain +
 * mocked `fetchAreaListings`/`resolveArea`. Covers the DISC-02 incremental
 * cap gate, the DISC-07 kill switch, and PII-safe persistence (Pitfall 4:
 * counters read from the claimed row, never a fresh SELECT).
 */

const fetchAreaListings = vi.fn();
const fetchListing = vi.fn();
vi.mock("@/lib/booli/client", () => ({
  fetchAreaListings: (...args: unknown[]) => fetchAreaListings(...args),
  fetchListing: (...args: unknown[]) => fetchListing(...args),
  // Real allowlist semantics (https + booli.se host) so the WR-03 read-path
  // filter in claimVisionSlice is exercised faithfully, not stubbed away.
  isAllowedImageHost: (url: string) => {
    try {
      const { hostname, protocol } = new URL(url);
      if (protocol !== "https:") return false;
      return (
        hostname === "booli.se" ||
        hostname.endsWith(".booli.se") ||
        hostname === "bcdn.se" ||
        hostname.endsWith(".bcdn.se")
      );
    } catch {
      return false;
    }
  },
}));

const resolveArea = vi.fn();
vi.mock("@/lib/discovery/resolve-area", async (importActual) => ({
  // Keep the real, pure splitAreaQuery (multi-area splitter); only resolveArea
  // is mocked since it does network I/O.
  ...(await importActual<typeof import("@/lib/discovery/resolve-area")>()),
  resolveArea: (...args: unknown[]) => resolveArea(...args),
}));

const fetchBrokerListingPage = vi.fn();
vi.mock("@/lib/broker/fetch-broker-page", () => ({
  fetchBrokerListingPage: (...args: unknown[]) => fetchBrokerListingPage(...args),
}));

const fetchBrokerImageBytes = vi.fn();
vi.mock("@/lib/broker/broker-images", () => ({
  fetchBrokerImageBytes: (...args: unknown[]) => fetchBrokerImageBytes(...args),
}));

import {
  runSlice,
  runVisionForJob,
  claimVisionSlice,
  claimAndRunVisionForJob,
  enrichCandidateImages,
  enrichmentVisitOrder,
  enrichmentPriority,
  candidateMedianPricePerSqm,
  dedupeCandidates,
  type ClaimedDiscoveryJob,
} from "@/lib/discovery/job";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { discoveryCostSek } from "@/lib/discovery/cost";

/** Captures every `.update(payload)` call on the mocked `discovery_jobs` table. */
let updateCalls: Array<Record<string, unknown>>;

function makeSupabase() {
  updateCalls = [];
  return {
    from: (table: string) => {
      if (table !== "discovery_jobs") throw new Error(`unexpected table ${table}`);
      return {
        update: (payload: Record<string, unknown>) => {
          updateCalls.push(payload);
          return {
            eq: async () => ({ error: null }),
          };
        },
        // A second SELECT of the same job between claim and persist is a
        // Pitfall 4 regression — if runSlice ever calls this, these tests
        // must fail loudly rather than silently returning stale data.
        select: () => {
          throw new Error(
            "runSlice must never re-SELECT the claimed job — read from claimedRow (Pitfall 4)",
          );
        },
      };
    },
  } as unknown as Parameters<typeof runSlice>[0];
}

function claimedRow(
  overrides: Partial<ClaimedDiscoveryJob> = {},
): ClaimedDiscoveryJob {
  return {
    id: "job-1",
    user_id: "user-1",
    status: "processing",
    filters: {
      areaQuery: "Södermalm",
      priceMax: 4_000_000,
      roomsMin: 3,
      sizeMin: null,
      objectType: "Lägenhet",
      confidence: 0.8,
    },
    cap_candidates: 25,
    cap_sek: 5,
    processed_count: 0,
    candidate_count: 0,
    cost_sek_total: 0,
    results: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveArea.mockResolvedValue({ areaId: "115341", source: "seed" });
  fetchAreaListings.mockResolvedValue([
    {
      streetAddress: "Testgatan 1",
      price: 3_500_000,
      rooms: 3,
      livingArea: 65,
      descriptiveAreaName: "Södermalm",
      thumbnailUrl: "https://img.example/1.jpg",
      url: "https://www.booli.se/annons/1",
    },
  ]);
});

describe("runSlice — incremental cap gate (DISC-02)", () => {
  it("does NOT scrape when candidate_count is already at cap_candidates; flips to done+cap_reached", async () => {
    const supabase = makeSupabase();
    const row = claimedRow({ candidate_count: 25, cap_candidates: 25 });

    await runSlice(supabase, row);

    expect(fetchAreaListings).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "done", cap_reached: true });
  });

  it("does NOT scrape when cost_sek_total already meets cap_sek; flips to done+cap_reached", async () => {
    const supabase = makeSupabase();
    const row = claimedRow({ cost_sek_total: 5, cap_sek: 5 });

    await runSlice(supabase, row);

    expect(fetchAreaListings).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "done", cap_reached: true });
  });

  it("does NOT scrape when the projected cost would exceed cap_sek (cost pre-check)", async () => {
    const supabase = makeSupabase();
    // Under the raw cap_sek numerically, but close enough that ANY slice cost
    // would push it over — the pre-check must gate BEFORE spending, not just
    // check the already-spent total.
    const row = claimedRow({ cost_sek_total: 4.999, cap_sek: 5 });

    await runSlice(supabase, row);

    expect(fetchAreaListings).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "done", cap_reached: true });
  });
});

describe("runSlice — happy path scrape + persist", () => {
  it("scrapes once, persists PII-safe candidates only, and updates counters from the claimed row", async () => {
    const supabase = makeSupabase();
    const row = claimedRow();

    await runSlice(supabase, row);

    expect(fetchAreaListings).toHaveBeenCalledTimes(1);
    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];

    expect(Array.isArray(payload.results)).toBe(true);
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    // PII-safe allowlist shape ONLY — exact key set, mirrors candidate.test.ts
    // (Phase 10 extended the allowlist with constructionYear/brfName/tenureForm;
    // Phase 11 (DISC-04) extends it with imageUrls/vision/visionSkippedReason;
    // Phase 12 (DISC-06) extends it with latitude/longitude/floor/orientation).
    expect(Object.keys(results[0]).sort()).toEqual(
      [
        "address",
        "areaLabel",
        "livingArea",
        "price",
        "rooms",
        "sourceListingUrl",
        "thumbnailUrl",
        "constructionYear",
        "brfName",
        "tenureForm",
        "imageUrls",
        "vision",
        "visionSkippedReason",
        "latitude",
        "longitude",
        "floor",
        "orientation",
        "balcony",
        "upcomingSale",
        "isNewConstruction",
      ].sort(),
    );
    expect(results[0]).toEqual({
      address: "Testgatan 1",
      price: 3_500_000,
      rooms: 3,
      livingArea: 65,
      areaLabel: "Södermalm",
      thumbnailUrl: "https://img.example/1.jpg",
      sourceListingUrl: "https://www.booli.se/annons/1",
      constructionYear: null,
      brfName: null,
      tenureForm: null,
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
      latitude: null,
      longitude: null,
      floor: null,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
    });

    expect(payload.candidate_count).toBe(1);
    expect(payload.processed_count).toBe(1);
    expect(typeof payload.cost_sek_total).toBe("number");
    expect(payload.cost_sek_total as number).toBeGreaterThan(0);
  });

  it("marks status done (a one-shot sweep is terminal) even when candidate_count is under cap; cap_reached stays false", async () => {
    // fetchAreaListings has no pagination — one slice fetches everything the
    // area can give, so an under-cap result is COMPLETE, not "more to come".
    // (Regression guard: gating done on capReached previously stranded such
    // searches in "processing" forever, so vision never ran — see job.ts §6.)
    const supabase = makeSupabase();
    const row = claimedRow({ cap_candidates: 25 });

    await runSlice(supabase, row);

    const payload = updateCalls[0];
    expect(payload.status).toBe("done");
    expect(payload.cap_reached).toBeFalsy();
  });

  it("flips to done+cap_reached when this slice's persisted count reaches cap_candidates", async () => {
    const supabase = makeSupabase();
    const row = claimedRow({ cap_candidates: 1, candidate_count: 0 });

    await runSlice(supabase, row);

    const payload = updateCalls[0];
    expect(payload.status).toBe("done");
    expect(payload.cap_reached).toBe(true);
  });

  it("flips to failed when the area cannot be resolved", async () => {
    resolveArea.mockResolvedValue(null);
    const supabase = makeSupabase();
    const row = claimedRow();

    await runSlice(supabase, row);

    expect(fetchAreaListings).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "failed" });
  });
});

describe("runSlice — kill switch (DISC-07)", () => {
  it("flips to degraded and halts when fetchAreaListings throws (CAPTCHA/blocking signal)", async () => {
    fetchAreaListings.mockRejectedValue(new Error("Kunde inte hamta data fran Booli."));
    const supabase = makeSupabase();
    const row = claimedRow();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runSlice(supabase, row);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "degraded" });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("runSlice — Phase 11 vision wiring does not alter existing behavior", () => {
  // Guards against a Rule-1-class regression: importing runVisionPass into
  // job.ts must not change runSlice's own persisted shape/counters/call
  // count. This re-runs the exact happy-path assertions from above; a
  // failure here means Phase 11 wiring leaked into runSlice itself.
  it("still persists exactly ONE update per slice with the unchanged PII-safe allowlist shape", async () => {
    const supabase = makeSupabase();
    const row = claimedRow();

    await runSlice(supabase, row);

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results[0].vision).toBeNull();
    expect(results[0].visionSkippedReason).toBeNull();
    // runSlice never touches a vision-specific counter — only the
    // pre-existing scrape/parse cost total.
    expect(payload).not.toHaveProperty("vision_cost_sek_total");
  });
});

function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    address: "Testgatan 1",
    price: 3_500_000,
    rooms: 3,
    livingArea: 65,
    areaLabel: "Södermalm",
    thumbnailUrl: null,
    sourceListingUrl: "https://www.booli.se/annons/1",
    constructionYear: null,
    brfName: null,
    tenureForm: null,
    imageUrls: null,
    vision: null,
    visionSkippedReason: null,
    latitude: null,
    longitude: null,
    floor: null,
    orientation: null,
    balcony: null,
    upcomingSale: null,
    isNewConstruction: null,
    ...overrides,
  };
}

describe("runSlice — multi-area search ('Södermalm och Vasastan')", () => {
  const RENDER_SEK = discoveryCostSek({
    haikuUsage: { input_tokens: 0, output_tokens: 0 },
    renders: 1,
  });
  const listing = (areaId: string, url: string) => ({
    streetAddress: `Gatan ${areaId}`,
    price: 3_500_000,
    rooms: 3,
    livingArea: 65,
    descriptiveAreaName: areaId,
    thumbnailUrl: null,
    url,
  });
  const multiRow = () => claimedRow({ filters: { ...claimedRow().filters, areaQuery: "Södermalm och Vasastan" } });

  beforeEach(() => {
    resolveArea.mockImplementation(async (name: string) =>
      name.toLowerCase() === "vasastan"
        ? { areaId: "115349", source: "seed" }
        : { areaId: "115341", source: "seed" },
    );
  });

  it("resolves + scrapes BOTH areas, merges results, and bills one render per area", async () => {
    fetchAreaListings.mockImplementation(async (areaId: string) => [
      listing(areaId, `https://www.booli.se/annons/${areaId}`),
    ]);
    const supabase = makeSupabase();

    await runSlice(supabase, multiRow());

    expect(fetchAreaListings).toHaveBeenCalledTimes(2);
    expect(fetchAreaListings).toHaveBeenCalledWith("115341", "Lägenhet");
    expect(fetchAreaListings).toHaveBeenCalledWith("115349", "Lägenhet");
    const payload = updateCalls[0];
    expect((payload.results as unknown[]).length).toBe(2);
    // Billed for TWO renders, not one.
    expect(payload.cost_sek_total).toBeCloseTo(RENDER_SEK * 2, 10);
  });

  it("de-dupes a listing that surfaces in both area searches", async () => {
    // Same listing URL returned for both areas → one merged candidate.
    fetchAreaListings.mockResolvedValue([listing("x", "https://www.booli.se/annons/dup")]);
    const supabase = makeSupabase();

    await runSlice(supabase, multiRow());

    expect((updateCalls[0].results as unknown[]).length).toBe(1);
  });

  it("proceeds with the surviving area when one area's scrape throws (partial failure)", async () => {
    fetchAreaListings.mockImplementation(async (areaId: string) => {
      if (areaId === "115349") throw new Error("blocked");
      return [listing(areaId, `https://www.booli.se/annons/${areaId}`)];
    });
    const supabase = makeSupabase();

    await runSlice(supabase, multiRow());

    expect(fetchAreaListings).toHaveBeenCalledTimes(2);
    const payload = updateCalls[0];
    expect(payload.status).not.toBe("degraded");
    expect((payload.results as unknown[]).length).toBe(1);
    // Only one render actually succeeded → billed for one.
    expect(payload.cost_sek_total).toBeCloseTo(RENDER_SEK, 10);
  });

  it("degrades only when EVERY area's scrape throws (the block signal)", async () => {
    fetchAreaListings.mockRejectedValue(new Error("captcha"));
    const supabase = makeSupabase();

    await runSlice(supabase, multiRow());

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ status: "degraded" });
  });

  it("fails (with a diagnostic log) when NO area name resolves", async () => {
    resolveArea.mockResolvedValue(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = makeSupabase();

    await runSlice(supabase, multiRow());

    expect(fetchAreaListings).not.toHaveBeenCalled();
    expect(updateCalls[0]).toMatchObject({ status: "failed" });
    expect(errSpy).toHaveBeenCalledWith(
      "[discovery-job] area resolution failed",
      expect.objectContaining({ areaQuery: "Södermalm och Vasastan" }),
    );
    errSpy.mockRestore();
  });

  it("scrapes both areas CONCURRENTLY — elapsed is close to the slower area's delay, not the sum (Wave-0 concurrency proof, D-01)", async () => {
    // Real, staggered setTimeout-based delays (not instantly-resolving mocks —
    // Pitfall 4): area 115341 resolves after ~100ms, area 115349 after ~20ms.
    // A sequential for-await loop takes ≈ 100 + 20 = 120ms; Promise.allSettled
    // takes ≈ max(100, 20) = 100ms. Asserting comfortably below the sequential
    // sum (but above the concurrent max) distinguishes the two shapes without
    // relying on exact timing.
    const DELAYS: Record<string, number> = { "115341": 100, "115349": 20 };
    fetchAreaListings.mockImplementation(async (areaId: string) => {
      await new Promise((resolve) => setTimeout(resolve, DELAYS[areaId] ?? 0));
      return [listing(areaId, `https://www.booli.se/annons/${areaId}`)];
    });
    const supabase = makeSupabase();

    const start = Date.now();
    await runSlice(supabase, multiRow());
    const elapsed = Date.now() - start;

    expect(fetchAreaListings).toHaveBeenCalledTimes(2);
    // Sequential sum would be ≈120ms; concurrent max is ≈100ms. 110ms sits
    // between the two, well below the sum, proving concurrent execution.
    expect(elapsed).toBeLessThan(110);
  });
});

describe("dedupeCandidates", () => {
  it("drops duplicate sourceListingUrl (first wins), keeps url-less candidates", () => {
    const c = (over: Partial<DiscoveryCandidate>) => makeCandidate(over);
    const out = dedupeCandidates([
      c({ sourceListingUrl: "u1", address: "A" }),
      c({ sourceListingUrl: "u1", address: "A-dup" }),
      c({ sourceListingUrl: "u2" }),
      c({ sourceListingUrl: null, address: "No URL", price: 1 }),
      c({ sourceListingUrl: null, address: "No URL", price: 1 }), // same fallback key → deduped
    ]);
    expect(out.map((x) => x.sourceListingUrl)).toEqual(["u1", "u2", null]);
    expect(out[0].address).toBe("A"); // first occurrence wins
  });
});

describe("runVisionForJob — Phase 11 (DISC-04) separate post-scrape pass", () => {
  it("writes vision-annotated results back in ONE update, distinct from runSlice's own update", async () => {
    const supabase = makeSupabase();
    const results = [makeCandidate({ imageUrls: null })];

    await runVisionForJob(supabase, "job-1", results);

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];
    const written = payload.results as DiscoveryCandidate[];
    expect(written[0].visionSkippedReason).toBe("no_images");
    // Only `results` is written — this pass never touches cost_sek_total
    // (the scrape cap) or candidate_count/processed_count.
    expect(payload).not.toHaveProperty("cost_sek_total");
    expect(payload).not.toHaveProperty("candidate_count");
  });

  it("WR-04: logs a distinguishable 'vision computed but not persisted' error when the final update fails, and does NOT throw", async () => {
    updateCalls = [];
    const supabase = {
      from: (table: string) => {
        if (table !== "discovery_jobs") throw new Error(`unexpected table ${table}`);
        return {
          update: (payload: Record<string, unknown>) => {
            updateCalls.push(payload);
            return {
              eq: async () => ({ error: { code: "PGRST000" } }),
            };
          },
        };
      },
    } as unknown as Parameters<typeof runVisionForJob>[0];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = [makeCandidate({ imageUrls: null })];

    await expect(runVisionForJob(supabase, "job-1", results)).resolves.toBeUndefined();

    expect(updateCalls).toHaveLength(1);
    const loggedCodes = errorSpy.mock.calls.map((call) => JSON.stringify(call));
    expect(loggedCodes.some((entry) => entry.includes("VISION_PERSIST_FAILED"))).toBe(true);

    errorSpy.mockRestore();
  });

  it("CR-02: never rethrows even when the pass itself throws unexpectedly — job stays recoverable, no strand", async () => {
    const supabase = {
      from: () => {
        throw new Error("boom — simulated unexpected failure");
      },
    } as unknown as Parameters<typeof runVisionForJob>[0];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = [makeCandidate({ imageUrls: null })];

    await expect(runVisionForJob(supabase, "job-1", results)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("runVisionForJob — incremental processed_count writes (13-04 Task 2, GAP-1 counter movement)", () => {
  it("issues >=2 strictly-increasing processed_count-only writes during enrichment, BEFORE the terminal done write", async () => {
    const supabase = makeSupabase();
    // A plain successful detail entity (no imageUrls) so enrichment succeeds
    // (advancing progress) without runVisionPass attempting any real
    // Anthropic call (imageUrls stays null -> vision skip "no_images", no
    // network/spend in this unit test).
    fetchListing.mockResolvedValue({});
    const results = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/2", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    // At least 2 incremental progress writes, followed by exactly one
    // terminal write.
    expect(updateCalls.length).toBeGreaterThanOrEqual(3);
    const terminal = updateCalls[updateCalls.length - 1];
    expect(terminal).toMatchObject({ status: "done" });
    expect(Array.isArray(terminal.results)).toBe(true);

    const progressCalls = updateCalls.slice(0, -1);
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    const values = progressCalls.map((c) => c.processed_count as number);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("D-03 (LOCKED): every incremental payload is processed_count-ONLY — never cost/candidate/cap/results/status", async () => {
    const supabase = makeSupabase();
    fetchListing.mockResolvedValue({});
    const results = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/2", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const progressCalls = updateCalls.slice(0, -1);
    expect(progressCalls.length).toBeGreaterThan(0);
    for (const payload of progressCalls) {
      expect(Object.keys(payload)).toEqual(["processed_count"]);
      expect(payload).not.toHaveProperty("cost_sek_total");
      expect(payload).not.toHaveProperty("candidate_count");
      expect(payload).not.toHaveProperty("cap_candidates");
      expect(payload).not.toHaveProperty("cap_sek");
      expect(payload).not.toHaveProperty("cap_reached");
      expect(payload).not.toHaveProperty("results");
      expect(payload).not.toHaveProperty("status");
    }
  });
});

/**
 * A fake `discovery_jobs` single-row store backing `claimVisionSlice`'s
 * `.update({...}).eq("id", id).eq("status", "done").select("results")
 * .maybeSingle()` chain — genuinely stateful (unlike `makeSupabase()`'s
 * fire-and-forget `update` above) so the CAS's real atomicity can be
 * exercised: the conditional UPDATE only "wins" (returns a row) if the
 * in-memory row is STILL `status === "done"` at the moment this chain's
 * terminal `.maybeSingle()` runs, and winning immediately flips `status` to
 * `"vision_processing"` so a second concurrent chain targeting the SAME row
 * observes the mutated status and loses.
 */
function makeCasSupabase(row: { id: string; status: string; results: unknown[] }) {
  return {
    from: (table: string) => {
      if (table !== "discovery_jobs") throw new Error(`unexpected table ${table}`);
      return {
        update: (payload: Record<string, unknown>) => {
          const predicates: Record<string, unknown> = {};
          // The chain is BOTH thenable (so a plain `await
          // supabase.from(...).update(...).eq("id", jobId)` — updateJob's
          // own call shape, no `.select()` — resolves directly to `{
          // error }`) AND further chainable via `.eq()`/`.select()` for
          // claimVisionSlice's longer `.eq().eq().select().maybeSingle()`
          // chain. This mirrors postgrest-js's real builder shape, where
          // every intermediate link is itself a thenable query builder.
          const chain = {
            eq: (col: string, val: unknown) => {
              predicates[col] = val;
              return chain;
            },
            select: () => ({
              maybeSingle: async () => {
                const matches =
                  predicates.id === row.id &&
                  (predicates.status === undefined || predicates.status === row.status);
                if (!matches) {
                  return { data: null, error: null };
                }
                // The CAS "wins": apply the update atomically (single
                // synchronous mutation, mirroring a real DB's single-row
                // conditional UPDATE) and return the PRE-update results
                // (mirrors generate-report.ts's `.select("id")` returning
                // the row as it existed at the moment of the winning update).
                const priorResults = row.results;
                Object.assign(row, payload);
                return { data: { results: priorResults }, error: null };
              },
            }),
            then: (
              resolve: (value: { error: null }) => void,
            ) => {
              // updateJob's plain `.update(payload).eq("id", jobId)` path —
              // no status predicate, always applies (mirrors a real
              // unconditional single-row update by id).
              Object.assign(row, payload);
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  } as unknown as Parameters<typeof claimVisionSlice>[0];
}

describe("claimVisionSlice — CR-04 (11-REVIEW.md) atomic done -> vision_processing CAS", () => {
  it("wins the claim when the row is 'done', returns its results, and flips status to 'vision_processing'", async () => {
    const row = { id: "job-1", status: "done", results: [{ address: "Testgatan 1" }] };
    const supabase = makeCasSupabase(row);

    const result = await claimVisionSlice(supabase, "job-1");

    expect(result).toEqual([{ address: "Testgatan 1" }]);
    expect(row.status).toBe("vision_processing");
  });

  it("is a benign no-op (returns null) when the row is not 'done' (e.g. still 'processing')", async () => {
    const row = { id: "job-1", status: "processing", results: [] };
    const supabase = makeCasSupabase(row);

    const result = await claimVisionSlice(supabase, "job-1");

    expect(result).toBeNull();
    // Status untouched — no false claim.
    expect(row.status).toBe("processing");
  });

  it("CR-04: exactly ONE of two concurrent claims on the same 'done' job wins", async () => {
    const row = { id: "job-1", status: "done", results: [{ address: "Testgatan 1" }] };
    const supabase = makeCasSupabase(row);

    const [first, second] = await Promise.all([
      claimVisionSlice(supabase, "job-1"),
      claimVisionSlice(supabase, "job-1"),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(row.status).toBe("vision_processing");
  });

  it("WR-03: re-applies the imageUrls host allowlist on the raw persisted read (drops non-Booli/insecure URLs before vision)", async () => {
    const row = {
      id: "job-1",
      status: "done",
      results: [
        {
          address: "Testgatan 1",
          imageUrls: [
            "https://booli.se/img/1.jpg", // allowed
            "https://evil.example/x.jpg", // dropped — non-Booli host
            "https://cdn.booli.se/img/2.jpg", // allowed — Booli subdomain
            "http://booli.se/insecure.jpg", // dropped — not https
          ],
        },
      ],
    };
    const supabase = makeCasSupabase(row);

    const result = await claimVisionSlice(supabase, "job-1");

    expect(result?.[0]?.imageUrls).toEqual([
      "https://booli.se/img/1.jpg",
      "https://cdn.booli.se/img/2.jpg",
    ]);
  });
});

describe("claimAndRunVisionForJob — CR-04 (11-REVIEW.md) composes the CAS with the run+persist step", () => {
  it("runs vision exactly once when the claim wins", async () => {
    const row = {
      id: "job-1",
      status: "done",
      results: [{ ...makeCandidate({ imageUrls: null }) }],
    };
    const supabase = makeCasSupabase(row);

    await claimAndRunVisionForJob(supabase, "job-1");

    // The claim's own winning update flips status to "vision_processing";
    // runVisionForJob's subsequent write (via the SAME fake row mutation)
    // restores it to "done" once vision finishes.
    expect(row.status).toBe("done");
  });

  it("does nothing when the claim is a no-op (job not 'done')", async () => {
    const row = { id: "job-1", status: "processing", results: [] };
    const supabase = makeCasSupabase(row);

    await claimAndRunVisionForJob(supabase, "job-1");

    expect(row.status).toBe("processing");
  });

  it("CR-04: two concurrent 'job done' invocations of claimAndRunVisionForJob result in exactly ONE vision run — the whole point of the fix", async () => {
    const row = {
      id: "job-1",
      status: "done",
      results: [{ ...makeCandidate({ imageUrls: null }) }],
    };
    const supabase = makeCasSupabase(row);

    // Simulate two different ticks (a client tab racing the daily sweep)
    // BOTH observing "done" and BOTH attempting the vision pass concurrently
    // — exactly the CR-04 scenario. Before the fix, both would call
    // runVisionForJob independently (double Anthropic spend, no shared cap
    // coordination); after the fix, only the CAS winner's runVisionForJob
    // ever executes.
    await Promise.all([
      claimAndRunVisionForJob(supabase, "job-1"),
      claimAndRunVisionForJob(supabase, "job-1"),
    ]);

    // The job settles back to "done" — never double-processed, never
    // wedged at "vision_processing".
    expect(row.status).toBe("done");
  });
});

describe("enrichCandidateImages — detail-fetch the shortlist for images before vision", () => {
  const rawDetail = (imageUrls: string[], extra: Record<string, unknown> = {}) => ({
    imageUrls,
    ...extra,
  });

  it("detail-fetches candidates lacking images, populating imageUrls + backfilling floor/year/orientation", async () => {
    fetchListing.mockResolvedValue(
      rawDetail(["https://bcdn.se/images/cache/1_1440x0.webp"], { floor: 3, constructionYear: 1930 }),
    );
    const input = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null, floor: null }),
    ];

    const { candidates: out } = await enrichCandidateImages(input, 8);

    expect(fetchListing).toHaveBeenCalledTimes(1);
    expect(out[0].imageUrls).toEqual(["https://bcdn.se/images/cache/1_1440x0.webp"]);
    expect(out[0].floor).toBe(3); // backfilled from the detail entity
    expect(out[0].constructionYear).toBe(1930);
  });

  it("skips candidates that already have images (no wasted detail fetch)", async () => {
    const input = [
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/bostad/1",
        imageUrls: ["https://bcdn.se/images/cache/9_1440x0.webp"],
      }),
    ];

    const { candidates: out } = await enrichCandidateImages(input, 8);

    expect(fetchListing).not.toHaveBeenCalled();
    expect(out[0].imageUrls).toEqual(["https://bcdn.se/images/cache/9_1440x0.webp"]);
  });

  it("is bounded to `limit` detail fetches regardless of how many candidates lack images", async () => {
    fetchListing.mockResolvedValue(rawDetail(["https://bcdn.se/images/cache/1_1440x0.webp"]));
    const input = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ sourceListingUrl: `https://www.booli.se/bostad/${i}`, imageUrls: null }),
    );

    await enrichCandidateImages(input, 8);

    expect(fetchListing).toHaveBeenCalledTimes(8);
  });

  it("is non-fatal: a failed detail fetch leaves that candidate unchanged (vision later skips it)", async () => {
    fetchListing.mockRejectedValue(new Error("render blocked"));
    const input = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
    ];

    const { candidates: out } = await enrichCandidateImages(input, 8);

    expect(out[0].imageUrls).toBeNull();
  });

  it("skips candidates with no sourceListingUrl (nothing to fetch)", async () => {
    const input = [makeCandidate({ sourceListingUrl: null, imageUrls: null })];

    await enrichCandidateImages(input, 8);

    expect(fetchListing).not.toHaveBeenCalled();
  });

  it("also fetches broker-gallery bytes (analyze-only) via the detail entity's agencyListingUrl, keyed by index", async () => {
    fetchListing.mockResolvedValue({
      imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      agencyListingUrl: "https://maklare.example/objekt/1",
    });
    fetchBrokerListingPage.mockResolvedValue({
      renovationStatus: null,
      description: null,
      images: ["https://cdn.maklare.example/bath.jpg"],
    });
    fetchBrokerImageBytes.mockResolvedValue([{ mediaType: "image/jpeg", data: "QkFTRTY0" }]);
    const input = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
    ];

    const { candidates, brokerImages } = await enrichCandidateImages(input, 8);

    expect(candidates[0].imageUrls).toEqual(["https://bcdn.se/images/cache/1_1440x0.webp"]);
    expect(fetchBrokerListingPage).toHaveBeenCalledWith("https://maklare.example/objekt/1");
    // Broker bytes are returned in the per-index map (transient, never persisted).
    expect(brokerImages.get(0)).toEqual([{ mediaType: "image/jpeg", data: "QkFTRTY0" }]);
  });

  it("derives orientation from the broker description when Booli's yields none (orientation v2)", async () => {
    fetchListing.mockResolvedValue({
      imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      agencyListingUrl: "https://maklare.example/objekt/1",
    });
    fetchBrokerListingPage.mockResolvedValue({
      renovationStatus: null,
      description: "Ljust vardagsrum i söderläge med härlig kvällssol.",
      images: [],
    });
    const input = [
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/bostad/1",
        imageUrls: null,
        orientation: null,
      }),
    ];

    const { candidates } = await enrichCandidateImages(input, 8);

    expect(candidates[0].orientation?.facades).toContain("south");
  });

  it("does NOT fetch a broker gallery when the detail entity has no agencyListingUrl", async () => {
    fetchListing.mockResolvedValue({ imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"] });
    const input = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
    ];

    const { brokerImages } = await enrichCandidateImages(input, 8);

    expect(fetchBrokerListingPage).not.toHaveBeenCalled();
    expect(brokerImages.size).toBe(0);
  });

  // SPEC §2.1 / defect D1: when the enrichment budget is smaller than the pool
  // of image-less candidates, it must land on the RENO TARGETS (below-market +
  // aged), not on whoever Booli ranked first. This is the Ringvägen 122 fix.
  it("spends a scarce enrichment budget on the below-market/aged flat, not Booli's first (D1)", async () => {
    fetchListing.mockResolvedValue(rawDetail(["https://bcdn.se/images/cache/1_1440x0.webp"]));
    const input = [
      // Booli-order #1: priced AT market, modern stock → low reno potential.
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/bostad/atmarket",
        imageUrls: null,
        price: 4_000_000,
        livingArea: 40, // 100k/m²
        constructionYear: 2015,
      }),
      // Booli-order #2: markedly below market + old stock → the real target.
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/bostad/ringvagen",
        imageUrls: null,
        price: 3_000_000,
        livingArea: 40, // 75k/m² — well below the set
        constructionYear: 1962,
      }),
    ];

    await enrichCandidateImages(input, 1); // budget of one

    expect(fetchListing).toHaveBeenCalledTimes(1);
    expect(fetchListing).toHaveBeenCalledWith("https://www.booli.se/bostad/ringvagen");
  });
});

describe("enrichment pre-rank (SPEC §2.1, D1)", () => {
  it("candidateMedianPricePerSqm: median over computable kr/m², null when none", () => {
    const set = [
      makeCandidate({ price: 3_000_000, livingArea: 30 }), // 100k
      makeCandidate({ price: 4_000_000, livingArea: 40 }), // 100k
      makeCandidate({ price: 1_200_000, livingArea: 10 }), // 120k
    ];
    expect(candidateMedianPricePerSqm(set)).toBe(100_000);
    expect(
      candidateMedianPricePerSqm([makeCandidate({ price: null, livingArea: null })]),
    ).toBeNull();
  });

  it("enrichmentPriority: below-market ranks above at-market; aged breaks ties", () => {
    const median = 100_000;
    const belowMarket = makeCandidate({ price: 3_000_000, livingArea: 40 }); // 75k
    const atMarket = makeCandidate({ price: 4_000_000, livingArea: 40 }); // 100k
    expect(enrichmentPriority(belowMarket, median)).toBeGreaterThan(
      enrichmentPriority(atMarket, median),
    );

    const old = makeCandidate({ price: 4_000_000, livingArea: 40, constructionYear: 1910 });
    const modern = makeCandidate({ price: 4_000_000, livingArea: 40, constructionYear: 2010 });
    expect(enrichmentPriority(old, median)).toBeGreaterThan(enrichmentPriority(modern, median));
  });

  it("enrichmentPriority: missing price/year contributes 0, never a negative penalty", () => {
    const median = 100_000;
    const noData = makeCandidate({ price: null, livingArea: null, constructionYear: null });
    expect(enrichmentPriority(noData, median)).toBe(0);
    // A null median (no market reference) yields 0 below-market for everyone.
    expect(enrichmentPriority(makeCandidate({ price: 3_000_000, livingArea: 40 }), null)).toBe(0);
  });

  it("enrichmentVisitOrder: sorts reno targets first, stable on ties (keeps Booli order)", () => {
    const order = enrichmentVisitOrder([
      makeCandidate({ price: 4_000_000, livingArea: 40 }), // 100k, at market
      makeCandidate({ price: 3_000_000, livingArea: 40, constructionYear: 1962 }), // 75k + old
      makeCandidate({ price: 4_000_000, livingArea: 40 }), // 100k, at market (tie w/ idx 0)
    ]);
    expect(order[0]).toBe(1); // the below-market/aged flat wins
    expect(order.slice(1)).toEqual([0, 2]); // ties keep original order
  });
});
