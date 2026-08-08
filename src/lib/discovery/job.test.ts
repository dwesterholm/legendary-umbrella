import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * job.test.ts — unit-tests `runSlice` with a mocked Supabase update chain +
 * mocked `fetchAreaListings`/`resolveArea`. Covers the DISC-02 incremental
 * cap gate, the DISC-07 kill switch, and PII-safe persistence (Pitfall 4:
 * counters read from the claimed row, never a fresh SELECT).
 */

const fetchAreaListings = vi.fn();
const fetchListing = vi.fn();
const fetchSoldComps = vi.fn();
vi.mock("@/lib/booli/client", () => ({
  fetchAreaListings: (...args: unknown[]) => fetchAreaListings(...args),
  fetchListing: (...args: unknown[]) => fetchListing(...args),
  fetchSoldComps: (...args: unknown[]) => fetchSoldComps(...args),
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
  // 13-04 Task 3 (GAP-2) — the bounded detail-enrichment render envelope.
  // This whole module is wholesale-mocked here (unlike client.test.ts, which
  // imports the real constant directly) — kept numerically in sync with
  // client.ts's real exported values.
  DETAIL_ENRICH_WAIT_SECS: 90,
  DETAIL_ENRICH_MAX_RETRIES: 2,
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

// ANL-03 (14-06 Task 3): only lookupBrfSummary is mocked (network + LLM
// edge) — BRF_TOP_N is preserved via importActual so tests assert against
// the real exported constant, not a stubbed one.
const lookupBrfSummary = vi.fn();
vi.mock("@/lib/discovery/brf-lookup", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/discovery/brf-lookup")>()),
  lookupBrfSummary: (...args: unknown[]) => lookupBrfSummary(...args),
}));

// ANL-01 (14-06 Task 3): mocks the Anthropic SDK directly (mirrors
// vision.test.ts's shape) ONLY to drive the "vision_error" and
// non-empty-claims:[] states through the REAL vision.ts/runVisionPass code
// path — no vision.ts logic is stubbed, only the underlying LLM call.
// Every pre-existing test in this file uses `imageUrls: null`, so `parse` is
// never invoked by them and this mock is a no-op for the rest of the suite.
const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        parse: (...args: unknown[]) => parse(...args),
      },
    };
  },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: (schema: unknown) => ({ __mockFormat: true, schema }),
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
  resolveCompsForCandidates,
  lookupBrfForTopCandidates,
  type ClaimedDiscoveryJob,
} from "@/lib/discovery/job";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { discoveryCostSek, renderSek, estimateBrfLookupSek } from "@/lib/discovery/cost";
import {
  DETAIL_ENRICH_WAIT_SECS,
  DETAIL_ENRICH_MAX_RETRIES,
  type SoldSourceQuery,
} from "@/lib/booli/client";
import { BRF_TOP_N } from "@/lib/discovery/brf-lookup";
import { HOLISTIC_DATA_ONLY_MARKER, type BrfSummary } from "@/lib/discovery/holistic-schema";

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
    // Phase 12 (DISC-06) extends it with latitude/longitude/floor/orientation;
    // Phase 14 (ANL-01/02/03) extends it with kommun/areaComps/brfSummary/
    // holisticBrief).
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
        "kommun",
        "areaComps",
        "brfSummary",
        "holisticBrief",
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
      kommun: null,
      areaComps: null,
      brfSummary: null,
      holisticBrief: null,
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
    kommun: null,
    areaComps: null,
    brfSummary: null,
    holisticBrief: null,
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
  beforeEach(() => {
    // Phase 14 (14-05): these tests only exercise the vision pass itself —
    // area resolution for comps (resolveCompsForCandidates) is configured to
    // cleanly miss so comps are skipped without any network call, keeping
    // the pre-existing assertions about `updateJob`'s payload shape intact
    // (fix by configuration, never by weakening an assertion).
    resolveArea.mockResolvedValue(undefined);
  });

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

describe("runVisionForJob — no processed_count write during vision (13-05 revert)", () => {
  beforeEach(() => {
    // Phase 14 (14-05): comps resolution cleanly misses (see the sibling
    // describe block's comment above) so this test's payload-shape
    // assertion is unaffected by the new comps-wiring step.
    resolveArea.mockResolvedValue(undefined);
  });

  it("issues EXACTLY ONE updateJob write (the terminal results+status write) and never writes processed_count, even across multiple successfully-enriched candidates", async () => {
    const supabase = makeSupabase();
    // Plain successful detail entities (no imageUrls) so enrichment succeeds
    // for both candidates without runVisionPass attempting any real
    // Anthropic call (imageUrls stays null -> vision skip "no_images", no
    // network/spend in this unit test).
    fetchListing.mockResolvedValue({});
    const results = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/2", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    // 13-05 revert: the 13-04 Task 2 onProgress callback (which issued
    // incremental processed_count-only writes) is removed — this is now the
    // ONLY updateJob call runVisionForJob ever makes.
    expect(updateCalls).toHaveLength(1);
    expect(Object.keys(updateCalls[0]).sort()).toEqual(["results", "status"]);

    // No updateJob payload at any point contains a processed_count key —
    // processed_count keeps its scanned-listings scrape/cost meaning
    // (written only by runSlice) and is never overwritten by the vision pass.
    for (const payload of updateCalls) {
      expect(payload).not.toHaveProperty("processed_count");
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

/**
 * Builds a single `SoldProperty:<id>` Apollo-shaped entry `normalizeSoldOutput`
 * can parse for real (this module is deliberately NOT mocked — the plan
 * requires `@/lib/market/sold-schema`/`@/lib/discovery/area-comps` to run for
 * real, pure logic). Only `prisPerKvm` + `soldDate` are populated; `rooms`/
 * `livingArea` are left absent so `computeAreaComps`'s size/room filter (which
 * only narrows "when both sides known") never discriminates against these
 * fixtures based on the candidate's own rooms/livingArea.
 */
function soldPropertyEntry(prisPerKvm: number, soldDate: string) {
  return {
    'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
      dataPoints: [{ value: { plainText: `${prisPerKvm} kr/m²` } }],
    },
    soldDate,
  };
}

/** A bare Apollo-state-shaped map of `SoldProperty:<n>` entries — the shape
 * `normalizeSoldOutput` accepts directly (no `__APOLLO_STATE__` wrapper
 * needed; it falls back to the root object). */
function apolloCompsPayload(prisPerKvmValues: number[], soldDate = "2026-07-01") {
  const state: Record<string, unknown> = {};
  prisPerKvmValues.forEach((v, i) => {
    state[`SoldProperty:${i}`] = soldPropertyEntry(v, soldDate);
  });
  return state;
}

describe("resolveCompsForCandidates — ANL-02 amortized per-area comps", () => {
  it("(a) two candidates sharing one areaLabel: resolveArea called ONCE, fetchSoldComps called EXACTLY ONCE, both get the same areaId", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-SAME-LABEL", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    const candidates = [
      makeCandidate({ areaLabel: "Södermalm" }),
      makeCandidate({ areaLabel: "Södermalm" }),
    ];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(resolveArea).toHaveBeenCalledTimes(1);
    expect(fetchSoldComps).toHaveBeenCalledTimes(1);
    expect(result.byIndex.get(0)?.areaId).toBe("AREA-SAME-LABEL");
    expect(result.byIndex.get(1)?.areaId).toBe("AREA-SAME-LABEL");
  });

  it("(b) two DIFFERENT labels resolving to the SAME areaId still produce exactly ONE fetchSoldComps call", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-SHARED", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    const candidates = [
      makeCandidate({ areaLabel: "Södermalm" }),
      makeCandidate({ areaLabel: "Vasastan" }),
    ];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    // Two distinct LABELS both get resolved...
    expect(resolveArea).toHaveBeenCalledTimes(2);
    // ...but the fetch set is de-duped BY areaId, not by label.
    expect(fetchSoldComps).toHaveBeenCalledTimes(1);
    expect(result.byIndex.get(0)?.areaId).toBe("AREA-SHARED");
    expect(result.byIndex.get(1)?.areaId).toBe("AREA-SHARED");
  });

  it("(c) three distinct areas are fetched CONCURRENTLY — all three invoked before any resolves (sum-vs-max proof)", async () => {
    resolveArea.mockImplementation(async (label: string) => ({
      areaId: `AREA-${label}`,
      source: "seed" as const,
    }));
    const deferredResolvers: Array<(value: { data: unknown; rendersUsed: number }) => void> = [];
    fetchSoldComps.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferredResolvers.push(resolve);
        }),
    );
    const candidates = [
      makeCandidate({ areaLabel: "A" }),
      makeCandidate({ areaLabel: "B" }),
      makeCandidate({ areaLabel: "C" }),
    ];
    const supabase = makeSupabase();

    const resultPromise = resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    // Poll until all three fetches have been ISSUED — proves they were
    // invoked concurrently (never awaited one-at-a-time in a loop), since
    // none of the three deferred promises has been resolved yet.
    await vi.waitFor(() => {
      expect(fetchSoldComps).toHaveBeenCalledTimes(3);
    });
    expect(deferredResolvers).toHaveLength(3);

    for (const resolveFetch of deferredResolvers) {
      resolveFetch({ data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]), rendersUsed: 1 });
    }

    await resultPromise;
  });

  it("(d) a candidate with areaLabel:null gets no resolve call and its areaComps stays absent", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-NULL-LABEL", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    const candidates = [
      makeCandidate({ areaLabel: null }),
      makeCandidate({ areaLabel: "Södermalm" }),
    ];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(resolveArea).toHaveBeenCalledTimes(1);
    expect(resolveArea).toHaveBeenCalledWith("Södermalm", supabase);
    expect(result.byIndex.has(0)).toBe(false);
    expect(result.byIndex.get(1)?.areaId).toBe("AREA-NULL-LABEL");
  });

  it("(e) resolveArea resolving null logs a non-fatal degrade; areaComps stays absent, no fetch is attempted", async () => {
    resolveArea.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const candidates = [makeCandidate({ areaLabel: "Ökänt område" })];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(fetchSoldComps).not.toHaveBeenCalled();
    expect(result.byIndex.has(0)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[discovery-job] area resolution for comps degraded (non-fatal)",
      expect.objectContaining({ areaLabel: "Ökänt område" }),
    );

    errorSpy.mockRestore();
  });

  it("(f) a rejecting fetchSoldComps degrades ONLY that area; the function still RESOLVES (never rejects) and other areas still succeed", async () => {
    resolveArea.mockImplementation(async (label: string) => ({
      areaId: `AREA-${label}`,
      source: "seed" as const,
    }));
    fetchSoldComps.mockImplementation(async (query: SoldSourceQuery) => {
      if ((query.breadcrumbs?.[0]?.url ?? "").includes("AREA-FAIL")) {
        throw new Error("Kunde inte hamta saljdata fran Booli.");
      }
      return { data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]), rendersUsed: 1 };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const candidates = [
      makeCandidate({ areaLabel: "FAIL" }),
      makeCandidate({ areaLabel: "OK" }),
    ];
    const supabase = makeSupabase();

    const resultPromise = resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });
    await expect(resultPromise).resolves.toBeTruthy();
    const result = await resultPromise;

    expect(result.byIndex.has(0)).toBe(false);
    expect(result.byIndex.get(1)?.areaId).toBe("AREA-OK");
    expect(errorSpy).toHaveBeenCalledWith(
      "[discovery-job] comps fetch degraded (non-fatal)",
      expect.objectContaining({ areaId: "AREA-FAIL" }),
    );

    errorSpy.mockRestore();
  });

  it("(g) budgetSek:0 performs ZERO resolve/fetch calls and reports areasSkippedForBudget > 0", async () => {
    const candidates = [makeCandidate({ areaLabel: "Södermalm" })];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 0,
    });

    expect(resolveArea).not.toHaveBeenCalled();
    expect(fetchSoldComps).not.toHaveBeenCalled();
    expect(result.areasSkippedForBudget).toBeGreaterThan(0);
    expect(result.spentSek).toBe(0);
  });

  it("(h) spentSek equals renderSek(sum of rendersUsed) plus renderSek(1) per source:'probe' resolution", async () => {
    resolveArea.mockImplementation(async (label: string) =>
      label === "Probed"
        ? { areaId: "AREA-PROBED", source: "probe" as const }
        : { areaId: "AREA-SEEDED", source: "seed" as const },
    );
    fetchSoldComps.mockImplementation(async (query: SoldSourceQuery) => {
      const isProbedArea = (query.breadcrumbs?.[0]?.url ?? "").includes("AREA-PROBED");
      return {
        data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
        rendersUsed: isProbedArea ? 2 : 1,
      };
    });
    const candidates = [
      makeCandidate({ areaLabel: "Probed" }),
      makeCandidate({ areaLabel: "Seeded" }),
    ];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    // rendersUsed sum (2 + 1) priced via renderSek, PLUS one renderSek(1) for
    // the single "probe" resolution (the "seed" resolution costs nothing).
    const expected = renderSek(2) + renderSek(1) + renderSek(1);
    expect(result.spentSek).toBeCloseTo(expected, 10);
  });

  it("(i) a thin tight segment widens when the widened window admits more comps; confidence stays false while still under MIN_COMPS_FOR_CONFIDENCE", async () => {
    // Rule 1 reconciliation: the plan's own action text asks for BOTH a
    // "4-comp" thin tight segment AND `confident:false` surviving the widen.
    // Since MIN_COMPS_FOR_CONFIDENCE=5 and a widen is only kept when it is
    // STRICTLY larger than the tight count, a tight count of exactly 4 can
    // only widen to >=5 — which flips `confident` to true by construction.
    // This fixture starts the tight segment at 3 comps (still "thin", still
    // < MIN_COMPS_FOR_CONFIDENCE) and widens to 4 — demonstrating the SAME
    // widen-or-downgrade mechanics while satisfying "confident: false either
    // way" literally, rather than the mathematically-impossible literal
    // "4 comps" starting count.
    resolveArea.mockResolvedValue({ areaId: "AREA-THIN", source: "seed" });
    const recentComps: Record<string, unknown> = {
      "SoldProperty:0": soldPropertyEntry(50000, "2026-07-01"),
      "SoldProperty:1": soldPropertyEntry(55000, "2026-06-01"),
      "SoldProperty:2": soldPropertyEntry(60000, "2026-05-01"),
    };
    // ~17-18 months before asOf (2026-08-06): excluded by the tight 12mo
    // window, included by the widened 24mo window (WIDENED_MAX_AGE_MONTHS).
    const olderComp = { "SoldProperty:3": soldPropertyEntry(65000, "2025-03-01") };
    fetchSoldComps.mockResolvedValue({
      data: { ...recentComps, ...olderComp },
      rendersUsed: 1,
    });
    const candidates = [makeCandidate({ areaLabel: "Tunn", rooms: 3, livingArea: 65 })];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
      asOf: "2026-08-06",
    });

    const summary = result.byIndex.get(0);
    expect(summary?.sampleSize).toBe(4);
    expect(summary?.widenedBand).toBe(true);
    expect(summary?.confident).toBe(false);
  });

  it("(j) the persisted areaComps object's keys exactly match the AreaCompsSummary field list — no raw comp rows", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-KEYS", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    const candidates = [makeCandidate({ areaLabel: "Keys" })];
    const supabase = makeSupabase();

    const result = await resolveCompsForCandidates(supabase, candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    const summary = result.byIndex.get(0);
    expect(summary).toBeDefined();
    expect(Object.keys(summary as object).sort()).toEqual(
      [
        "areaId",
        "renovatedMedianPerSqm",
        "unrenovatedMedianPerSqm",
        "overallMedianPerSqm",
        "renovatedCapPerSqm",
        "sampleSize",
        "confident",
        "asOf",
        "widenedBand",
      ].sort(),
    );
  });
});

describe("runVisionForJob — comps wiring (14-05, D-14-08)", () => {
  it("attaches comps to payload.results[i].areaComps in the single terminal update; keys stay exactly ['results','status']", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-WIRED", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    const supabase = makeSupabase();
    const results = [makeCandidate({ areaLabel: "Södermalm", imageUrls: null })];

    await runVisionForJob(supabase, "job-1", results);

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];
    expect(Object.keys(payload).sort()).toEqual(["results", "status"]);
    const written = payload.results as DiscoveryCandidate[];
    expect(written[0].areaComps).not.toBeNull();
    expect(written[0].areaComps?.areaId).toBe("AREA-WIRED");
  });

  it("runVisionPass receives initialSpentSek equal to comps.spentSek — proven via an exhausted-budget outcome (no Anthropic call attempted), keeping this file's Anthropic-free unit-test posture", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-EXHAUST", source: "seed" });
    // An artificially large rendersUsed proves the WIRING arithmetic
    // (rendersUsed -> renderSek -> spentSek -> initialSpentSek) — never a
    // realistic fetchSoldComps return (real calls cap at
    // COMPS_MAX_RENDERS_PER_AREA=2 own-render rungs). Chosen so comps.spentSek
    // alone exceeds CAP_VISION_SEK_MAX, forcing the very first image-bearing
    // candidate straight to "cost_cap" with ZERO Anthropic calls attempted —
    // so this test needs no `@anthropic-ai/sdk` mock at all.
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 2000,
    });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({
        areaLabel: "Södermalm",
        imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const payload = updateCalls[0];
    const written = payload.results as DiscoveryCandidate[];
    expect(written[0].vision).toBeNull();
    expect(written[0].visionSkippedReason).toBe("cost_cap");
  });
});

/** A minimal, valid `BrfSummary` fixture — the "ok" outcome shape lookupBrfSummary returns. */
function makeBrfSummary(overrides: Partial<BrfSummary> = {}): BrfSummary {
  return {
    skuldPerKvm: 5000,
    avgiftsniva: 3000,
    kassaflode: 100000,
    stambytePlanerat: null,
    tomtratt: null,
    fiscalYear: 2024,
    source: "allabrf",
    fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 },
    ...overrides,
  };
}

/** Mirrors vision.test.ts's baseUsage() — a minimal Claude usage fixture. */
function baseUsage() {
  return {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** A deep-pass attribute fixture — mirrors vision.test.ts's attr() helper. */
function attr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    claim: null,
    imageIndex: 0,
    whatWasSeen: "",
    confidence: 0,
    ...overrides,
  };
}

describe("lookupBrfForTopCandidates — ANL-03 top-N concurrent BRF fetch", () => {
  it("selects the top BRF_TOP_N by enrichmentVisitOrder, restricted to brfName-bearing candidates, in that order", async () => {
    lookupBrfSummary.mockResolvedValue({ summary: null, costSek: 0, outcome: "no_document" });
    const candidates = [
      makeCandidate({ brfName: "Brf A", price: 4_000_000, livingArea: 40, constructionYear: 2015 }),
      makeCandidate({ brfName: "Brf B", price: 3_000_000, livingArea: 40, constructionYear: 1962 }),
      makeCandidate({ brfName: null, price: 3_500_000, livingArea: 50, constructionYear: 1930 }),
      makeCandidate({ brfName: "Brf D", price: 4_500_000, livingArea: 45, constructionYear: 2020 }),
      makeCandidate({ brfName: "Brf E", price: 2_800_000, livingArea: 40, constructionYear: 1905 }),
      makeCandidate({ brfName: "Brf F", price: 3_900_000, livingArea: 60, constructionYear: 1975 }),
      makeCandidate({ brfName: null, price: 4_200_000, livingArea: 42, constructionYear: 2018 }),
      makeCandidate({ brfName: "Brf H", price: 3_100_000, livingArea: 62, constructionYear: 1900 }),
    ];
    // Assert against enrichmentVisitOrder's OWN output, never a hardcoded
    // order — this tracks the real prelim rank.
    const order = enrichmentVisitOrder(candidates);
    const expectedIndices = order.filter((i) => candidates[i].brfName !== null).slice(0, BRF_TOP_N);
    expect(expectedIndices.length).toBe(BRF_TOP_N); // 6 brfName-bearing candidates, BRF_TOP_N=4 < 6

    await lookupBrfForTopCandidates(candidates, { jobId: "job-1", budgetSek: 10 });

    expect(lookupBrfSummary).toHaveBeenCalledTimes(BRF_TOP_N);
    expect(
      lookupBrfSummary.mock.calls.map((call) => (call[0] as { brfName: string | null }).brfName),
    ).toEqual(expectedIndices.map((idx) => candidates[idx].brfName));
  });

  it("a candidate with brfName: null is never attempted, even when it ranks first", async () => {
    lookupBrfSummary.mockResolvedValue({ summary: null, costSek: 0, outcome: "no_document" });
    const candidates = [
      // Deep below-market + oldest stock -> ranks #1 by enrichmentPriority,
      // but has no brfName -> nothing to search.
      makeCandidate({ brfName: null, price: 2_000_000, livingArea: 40, constructionYear: 1900 }),
      makeCandidate({ brfName: "Brf X", price: 4_000_000, livingArea: 40, constructionYear: 2015 }),
    ];

    await lookupBrfForTopCandidates(candidates, { jobId: "job-1", budgetSek: 10 });

    expect(lookupBrfSummary).toHaveBeenCalledTimes(1);
    expect(lookupBrfSummary).toHaveBeenCalledWith(
      expect.objectContaining({ brfName: "Brf X" }),
    );
  });

  it("each call receives that candidate's own kommun and tenureForm (D-14-09 payoff)", async () => {
    lookupBrfSummary.mockResolvedValue({ summary: null, costSek: 0, outcome: "no_document" });
    const candidates = [
      makeCandidate({ brfName: "Brf X", kommun: "Stockholm", tenureForm: "Bostadsrätt" }),
    ];

    await lookupBrfForTopCandidates(candidates, { jobId: "job-1", budgetSek: 10 });

    expect(lookupBrfSummary).toHaveBeenCalledWith({
      brfName: "Brf X",
      kommun: "Stockholm",
      tenureForm: "Bostadsrätt",
    });
  });

  it("CONCURRENCY: all BRF_TOP_N invocations happen before any resolves (max-vs-sum proof, Phase 13 WR-02)", async () => {
    const deferredResolvers: Array<
      (value: { summary: null; costSek: number; outcome: "no_document" }) => void
    > = [];
    lookupBrfSummary.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferredResolvers.push(resolve);
        }),
    );
    const candidates = Array.from({ length: BRF_TOP_N }, (_, i) =>
      makeCandidate({
        brfName: `Brf ${i}`,
        sourceListingUrl: `https://www.booli.se/annons/${i}`,
      }),
    );

    const resultPromise = lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    await vi.waitFor(() => {
      expect(lookupBrfSummary).toHaveBeenCalledTimes(BRF_TOP_N);
    });
    expect(deferredResolvers).toHaveLength(BRF_TOP_N);

    for (const resolve of deferredResolvers) {
      resolve({ summary: null, costSek: 0.1, outcome: "no_document" });
    }

    await resultPromise;
  });

  it("a REJECTING lookupBrfSummary for one index leaves that candidate's brfSummary absent, logs the non-fatal line; the function resolves and other indices still succeed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    lookupBrfSummary.mockImplementation(async (input: { brfName: string | null }) => {
      if (input.brfName === "Brf FAIL") throw new Error("ALLABRF_TIMEOUT");
      return { summary: makeBrfSummary(), costSek: 0.5, outcome: "ok" };
    });
    const candidates = [
      makeCandidate({ brfName: "Brf FAIL" }),
      makeCandidate({ brfName: "Brf OK" }),
    ];

    const resultPromise = lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });
    await expect(resultPromise).resolves.toBeTruthy();
    const result = await resultPromise;

    expect(result.byIndex.has(0)).toBe(false);
    expect(result.byIndex.get(1)).toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[discovery-job] brf lookup degraded (non-fatal)",
      expect.objectContaining({ candidateIndex: 0 }),
    );

    errorSpy.mockRestore();
  });

  it("a non-'ok' outcome (e.g. 'low_confidence') contributes no byIndex entry and logs a diagnostic naming the outcome", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    lookupBrfSummary.mockResolvedValue({ summary: null, costSek: 0, outcome: "low_confidence" });
    const candidates = [makeCandidate({ brfName: "Brf X" })];

    const result = await lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(result.byIndex.has(0)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[discovery-job] brf lookup outcome",
      expect.objectContaining({ candidateIndex: 0, outcome: "low_confidence" }),
    );

    errorSpy.mockRestore();
  });

  it("spentSek equals the sum of every fulfilled costSek, including from non-'ok' outcomes", async () => {
    lookupBrfSummary.mockImplementation(async (input: { brfName: string | null }) => {
      if (input.brfName === "Brf A") {
        return { summary: makeBrfSummary(), costSek: 0.8, outcome: "ok" };
      }
      return { summary: null, costSek: 0.3, outcome: "low_confidence" };
    });
    const candidates = [
      makeCandidate({ brfName: "Brf A" }),
      makeCandidate({ brfName: "Brf B" }),
    ];

    const result = await lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(result.spentSek).toBeCloseTo(1.1, 10);
  });

  it("a billed-then-failed extraction's non-zero costSek is no longer invisible to the shared pool (CR-04)", async () => {
    lookupBrfSummary.mockResolvedValue({
      summary: null,
      costSek: 1.23,
      outcome: "extract_failed",
    });
    const candidates = Array.from({ length: BRF_TOP_N }, (_, i) =>
      makeCandidate({ brfName: `Brf ${i}` }),
    );

    const result = await lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 10,
    });

    expect(result.attemptedIndices.length).toBe(BRF_TOP_N);
    expect(result.spentSek).toBeCloseTo(1.23 * result.attemptedIndices.length, 10);
  });

  it("budgetSek: 0 performs ZERO lookupBrfSummary calls and reports skippedForBudget > 0", async () => {
    const candidates = [makeCandidate({ brfName: "Brf X" })];

    const result = await lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek: 0,
    });

    expect(lookupBrfSummary).not.toHaveBeenCalled();
    expect(result.skippedForBudget).toBeGreaterThan(0);
    expect(result.spentSek).toBe(0);
  });

  it("a partial budget allowing exactly 2 lookups attempts exactly 2 and reports skippedForBudget for the rest", async () => {
    lookupBrfSummary.mockResolvedValue({ summary: null, costSek: 0, outcome: "no_document" });
    const candidates = Array.from({ length: BRF_TOP_N }, (_, i) =>
      makeCandidate({ brfName: `Brf ${i}` }),
    );
    const budgetSek = estimateBrfLookupSek() * 2;

    const result = await lookupBrfForTopCandidates(candidates, {
      jobId: "job-1",
      budgetSek,
    });

    expect(lookupBrfSummary).toHaveBeenCalledTimes(2);
    expect(result.skippedForBudget).toBe(BRF_TOP_N - 2);
  });
});

describe("runVisionForJob — ANL-01 non-empty guarantee across all four no-claims states", () => {
  it("visionSkippedReason: 'no_images' yields a non-null holisticBrief with >=1 item and the D-14-04 marker", async () => {
    resolveArea.mockResolvedValue(undefined); // comps cleanly miss
    const supabase = makeSupabase();
    const results = [makeCandidate({ imageUrls: null, brfName: null })];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].visionSkippedReason).toBe("no_images");
    expect(written[0].holisticBrief).not.toBeNull();
    expect(written[0].holisticBrief?.items.length).toBeGreaterThanOrEqual(1);
    expect(written[0].holisticBrief?.marker).toBe(HOLISTIC_DATA_ONLY_MARKER);
  });

  it("visionSkippedReason: 'cost_cap' yields a non-null holisticBrief with >=1 item and the D-14-04 marker", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-CAP", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 2000, // exhausts the shared pool before vision runs
    });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({
        areaLabel: "Södermalm",
        brfName: null,
        imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].visionSkippedReason).toBe("cost_cap");
    expect(written[0].holisticBrief).not.toBeNull();
    expect(written[0].holisticBrief?.items.length).toBeGreaterThanOrEqual(1);
    expect(written[0].holisticBrief?.marker).toBe(HOLISTIC_DATA_ONLY_MARKER);
  });

  it("visionSkippedReason: 'vision_error' yields a non-null holisticBrief with >=1 item and the D-14-04 marker", async () => {
    resolveArea.mockResolvedValue(undefined);
    parse.mockRejectedValueOnce(new Error("transient failure"));
    const supabase = makeSupabase();
    const results = [
      makeCandidate({
        brfName: null,
        imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].visionSkippedReason).toBe("vision_error");
    expect(written[0].holisticBrief).not.toBeNull();
    expect(written[0].holisticBrief?.items.length).toBeGreaterThanOrEqual(1);
    expect(written[0].holisticBrief?.marker).toBe(HOLISTIC_DATA_ONLY_MARKER);
  });

  it("a non-null vision whose claims is [] (Haiku worthDeepPass:false) yields a non-null holisticBrief with >=1 item and the D-14-04 marker", async () => {
    resolveArea.mockResolvedValue(undefined);
    parse.mockResolvedValueOnce({
      parsed_output: { worthDeepPass: false },
      usage: baseUsage(),
      stop_reason: "end_turn",
    });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({
        brfName: null,
        imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].vision).not.toBeNull();
    expect(written[0].vision?.claims).toEqual([]);
    expect(written[0].holisticBrief).not.toBeNull();
    expect(written[0].holisticBrief?.items.length).toBeGreaterThanOrEqual(1);
    expect(written[0].holisticBrief?.marker).toBe(HOLISTIC_DATA_ONLY_MARKER);
  });

  it("a candidate WITH a surviving claim has holisticBrief === null", async () => {
    resolveArea.mockResolvedValue(undefined);
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: {
          kitchen: attr({ claim: "Köket verkar renoverat", imageIndex: 1, confidence: 0.9 }),
          bathroom: attr(),
          overall: attr(),
          remodelPotential: attr(),
        },
        usage: baseUsage(),
        stop_reason: "end_turn",
      });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({
        brfName: null,
        imageUrls: ["https://bcdn.se/images/cache/1_1440x0.webp"],
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].vision?.claims.length).toBeGreaterThan(0);
    expect(written[0].holisticBrief).toBeNull();
  });

  it("zero holistic data (no comps, no BRF) still yields exactly one 'insufficient-data' item — the guarantee holds even with nothing to say", async () => {
    resolveArea.mockResolvedValue(undefined);
    const supabase = makeSupabase();
    const results = [
      makeCandidate({ imageUrls: null, brfName: null, areaLabel: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].holisticBrief?.items).toHaveLength(1);
    expect(written[0].holisticBrief?.items[0].kind).toBe("insufficient-data");
  });

  it("a candidate with both comps AND a BRF summary produces a brief whose dataSources contains 'comps' and 'brf'", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-BOTH", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    lookupBrfSummary.mockResolvedValue({ summary: makeBrfSummary(), costSek: 0.5, outcome: "ok" });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({ areaLabel: "Södermalm", brfName: "Brf X", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].holisticBrief?.dataSources).toEqual(
      expect.arrayContaining(["comps", "brf"]),
    );
  });

  it("the persisted brief's text never contains 'renoveringsobjekt' (end-to-end counterpart to 14-02/14-04's unit assertions)", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-RENO", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([100000, 105000, 110000, 115000, 120000]),
      rendersUsed: 1,
    });
    lookupBrfSummary.mockResolvedValue({ summary: makeBrfSummary(), costSek: 0.5, outcome: "ok" });
    const supabase = makeSupabase();
    // Deep-discount pricing (well below the comps median) exercises the
    // guard's discount-attribution path, the exact branch the banned-phrase
    // guard exists for.
    const results = [
      makeCandidate({
        areaLabel: "Södermalm",
        brfName: "Brf X",
        imageUrls: null,
        price: 3_000_000,
        livingArea: 50,
      }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    const written = updateCalls[0].results as DiscoveryCandidate[];
    const allText = written[0].holisticBrief?.items.map((i) => i.text).join(" ") ?? "";
    expect(allText).not.toContain("renoveringsobjekt");
  });

  it("keeps the terminal update payload keys exactly ['results','status'] even with BRF+brief attached", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-KEYS2", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 1,
    });
    lookupBrfSummary.mockResolvedValue({ summary: makeBrfSummary(), costSek: 0.5, outcome: "ok" });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({ areaLabel: "Södermalm", brfName: "Brf X", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    expect(Object.keys(updateCalls[0]).sort()).toEqual(["results", "status"]);
    expect(updateCalls[0]).not.toHaveProperty("processed_count");
    expect(updateCalls[0]).not.toHaveProperty("cost_sek_total");
    expect(updateCalls[0]).not.toHaveProperty("candidate_count");
  });

  it("shared budget: an exhausted comps spend skips BRF entirely while the candidate still gets a holistic brief", async () => {
    resolveArea.mockResolvedValue({ areaId: "AREA-EXHAUST3", source: "seed" });
    fetchSoldComps.mockResolvedValue({
      data: apolloCompsPayload([50000, 55000, 60000, 65000, 70000]),
      rendersUsed: 2000,
    });
    const supabase = makeSupabase();
    const results = [
      makeCandidate({ areaLabel: "Södermalm", brfName: "Brf X", imageUrls: null }),
    ];

    await runVisionForJob(supabase, "job-1", results);

    expect(lookupBrfSummary).not.toHaveBeenCalled();
    const written = updateCalls[0].results as DiscoveryCandidate[];
    expect(written[0].holisticBrief).not.toBeNull();
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
    // 13-04 Task 3 (GAP-2): every enrichCandidateImages fetchListing call now
    // also carries the bounded opts — updated alongside the new opts-forwarding
    // behavior below, not a pre-existing assertion this task regresses.
    expect(fetchListing).toHaveBeenCalledWith("https://www.booli.se/bostad/ringvagen", {
      waitSecs: DETAIL_ENRICH_WAIT_SECS,
      maxRequestRetries: DETAIL_ENRICH_MAX_RETRIES,
    });
  });

  it("13-04 Task 3 (GAP-2): passes the bounded DETAIL_ENRICH opts to fetchListing so one blocked detail page cannot burn the 240s/3-retry default", async () => {
    fetchListing.mockResolvedValue({});
    const input = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/bostad/1", imageUrls: null }),
    ];

    await enrichCandidateImages(input, 8);

    expect(fetchListing).toHaveBeenCalledWith("https://www.booli.se/bostad/1", {
      waitSecs: DETAIL_ENRICH_WAIT_SECS,
      maxRequestRetries: DETAIL_ENRICH_MAX_RETRIES,
    });
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
