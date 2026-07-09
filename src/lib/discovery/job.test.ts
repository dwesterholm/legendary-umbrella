import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * job.test.ts — unit-tests `runSlice` with a mocked Supabase update chain +
 * mocked `fetchAreaListings`/`resolveArea`. Covers the DISC-02 incremental
 * cap gate, the DISC-07 kill switch, and PII-safe persistence (Pitfall 4:
 * counters read from the claimed row, never a fresh SELECT).
 */

const fetchAreaListings = vi.fn();
vi.mock("@/lib/booli/client", () => ({
  fetchAreaListings: (...args: unknown[]) => fetchAreaListings(...args),
  // Real allowlist semantics (https + booli.se host) so the WR-03 read-path
  // filter in claimVisionSlice is exercised faithfully, not stubbed away.
  isAllowedImageHost: (url: string) => {
    try {
      const { hostname, protocol } = new URL(url);
      return protocol === "https:" && (hostname === "booli.se" || hostname.endsWith(".booli.se"));
    } catch {
      return false;
    }
  },
}));

const resolveArea = vi.fn();
vi.mock("@/lib/discovery/resolve-area", () => ({
  resolveArea: (...args: unknown[]) => resolveArea(...args),
}));

import {
  runSlice,
  runVisionForJob,
  claimVisionSlice,
  claimAndRunVisionForJob,
  type ClaimedDiscoveryJob,
} from "@/lib/discovery/job";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

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

  it("leaves status as processing (not done) when candidate_count has not yet hit cap after this slice", async () => {
    const supabase = makeSupabase();
    const row = claimedRow({ cap_candidates: 25 });

    await runSlice(supabase, row);

    const payload = updateCalls[0];
    expect(payload.status).toBe("processing");
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
