import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  FLOORPLAN_CACHE_PATH,
  FLOORPLAN_EST_SEK_PER_CALL,
  FLOORPLAN_MODEL,
  FLOORPLAN_PROBE_SUMMARY,
  FLOORPLAN_PROBE_VERSION,
  FLOORPLAN_ROUTE_ENABLED,
  FLOORPLAN_SYSTEM_PROMPT,
  FloorPlanCallError,
  addFloorPlanSpend,
  asBilledFailure,
  canAffordFloorPlanCall,
  floorPlanCompassSchema,
  floorPlanImageId,
  floorPlanProbeVersion,
  floorPlanSpentSek,
  loadFloorPlanCache,
  pickProbeSample,
  planBearingOf,
  probeVerdict,
  runFloorPlanProbe,
  saveFloorPlanCache,
  summariseReads,
  type FloorPlanCache,
  type FloorPlanCallFn,
  type FloorPlanRead,
} from "@/lib/discovery/sun-floorplan";
import { VISION_HAIKU_MODEL } from "@/lib/discovery/vision-prompt";

const read = (over: Partial<FloorPlanRead> = {}): FloorPlanRead => ({
  isFloorPlan: true,
  northArrowPresent: false,
  northBearingDeg: 0,
  balconySide: "ingen",
  confidence: 0.9,
  ...over,
});

const url = (id: number) => `https://bcdn.se/images/cache/${id}_1440x0.webp`;
const emptyCache = (): FloorPlanCache => ({ version: 1, entries: {} });

/** A fake model call: records every image block it is given, costs `cost` per call. */
function fakeCall(cost = 0.05, result: FloorPlanRead = read()) {
  const seen: string[] = [];
  const call: FloorPlanCallFn = async (image) => {
    seen.push(image.source.type === "url" ? image.source.url : "(bytes)");
    return { result, costSek: cost };
  };
  return { call, seen };
}

describe("floorPlanCompassSchema (strict-output limits)", () => {
  const json = z.toJSONSchema(floorPlanCompassSchema, { unrepresentable: "any" }) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  const text = JSON.stringify(json);

  it("has exactly the five flat fields, all required", () => {
    expect(Object.keys(json.properties).sort()).toEqual(["balconySide", "confidence", "isFloorPlan", "northArrowPresent", "northBearingDeg"]);
    expect([...json.required].sort()).toEqual(["balconySide", "confidence", "isFloorPlan", "northArrowPresent", "northBearingDeg"]);
  });

  it("has no union, no null type and no numeric constraint anywhere", () => {
    for (const bad of ["anyOf", "oneOf", "allOf", '"null"', "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it("balconySide is the four sides plus ingen", () => {
    expect(floorPlanCompassSchema.shape.balconySide.options).toEqual(["upp", "höger", "ned", "vänster", "ingen"]);
  });
});

describe("the entrance-arrow warning", () => {
  it("is in the system prompt", () => {
    expect(FLOORPLAN_SYSTEM_PROMPT).toContain("ytterdörr");
    expect(FLOORPLAN_SYSTEM_PROMPT).toMatch(/inte en norrpil|INTE en norrpil/);
  });
  it("is in the northArrowPresent description", () => {
    const d = floorPlanCompassSchema.shape.northArrowPresent.description ?? "";
    expect(d).toContain("ytterdörr");
    expect(d).toMatch(/INTE en norrpil/);
  });
});

describe("floorPlanProbeVersion", () => {
  const parts = {
    prompt: FLOORPLAN_SYSTEM_PROMPT,
    model: FLOORPLAN_MODEL,
    schema: z.toJSONSchema(floorPlanCompassSchema, { unrepresentable: "any" }),
    revision: 1,
  };
  it("is what the module exports for the real parts", () => {
    expect(floorPlanProbeVersion(parts)).toBe(FLOORPLAN_PROBE_VERSION);
  });
  it("changes with the prompt text, the model id, the schema and the revision", () => {
    const base = floorPlanProbeVersion(parts);
    expect(floorPlanProbeVersion({ ...parts, prompt: `${parts.prompt} ` })).not.toBe(base);
    expect(floorPlanProbeVersion({ ...parts, model: "claude-sonnet-4-6" })).not.toBe(base);
    expect(floorPlanProbeVersion({ ...parts, schema: { type: "object" } })).not.toBe(base);
    expect(floorPlanProbeVersion({ ...parts, revision: 2 })).not.toBe(base);
  });
  it("uses the Haiku model constant of the vision module", () => {
    expect(FLOORPLAN_MODEL).toBe(VISION_HAIKU_MODEL);
  });
});

describe("floorPlanImageId", () => {
  it("takes the number in front of the size suffix", () => {
    expect(floorPlanImageId("https://bcdn.se/images/cache/49231065_1440x0.webp")).toBe("49231065");
  });
  it("falls back to the sha256 hex of the URL", () => {
    const u = "https://bcdn.se/other/thing.png";
    expect(floorPlanImageId(u)).toBe(createHash("sha256").update(u).digest("hex"));
  });
});

describe("runFloorPlanProbe", () => {
  it("stops before a call that would pass the cap (equal is allowed) and calls twice for 3 items at 0,10", async () => {
    const { call, seen } = fakeCall(0.05);
    const out = await runFloorPlanProbe(
      [1, 2, 3].map((n) => ({ booliId: String(n), imageUrl: url(n) })),
      { call, cache: emptyCache(), capSek: 0.1, today: "2026-10-13" },
    );
    expect(out.calls).toBe(2);
    expect(seen).toHaveLength(2);
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read", "cost_cap"]);
    expect(out.reads[2].result).toBeNull();
    expect(out.spentSek).toBeCloseTo(0.1, 10);
  });

  it("serves a cached item for free with no call", async () => {
    const cache = emptyCache();
    cache.entries["11"] = { imageId: "11", promptVersion: FLOORPLAN_PROBE_VERSION, storedAt: "2026-10-01", costSek: 0.04, result: read({ northArrowPresent: true }) };
    const { call, seen } = fakeCall();
    const out = await runFloorPlanProbe(
      [{ booliId: "a", imageUrl: url(11) }, { booliId: "b", imageUrl: url(12) }],
      { call, cache, capSek: 2, today: "2026-10-13" },
    );
    expect(out.cacheHits).toBe(1);
    expect(out.calls).toBe(1);
    expect(seen).toEqual([url(12)]);
    expect(out.reads[0]).toMatchObject({ booliId: "a", status: "cache", costSek: 0 });
    expect(out.reads[0].result?.northArrowPresent).toBe(true);
    expect(out.spentSek).toBeCloseTo(0.05, 10);
  });

  it("serves a cached item even when the cap is already spent", async () => {
    const cache = emptyCache();
    cache.entries["11"] = { imageId: "11", promptVersion: FLOORPLAN_PROBE_VERSION, storedAt: "2026-10-01", costSek: 0.04, result: read() };
    const { call } = fakeCall();
    const out = await runFloorPlanProbe([{ booliId: "a", imageUrl: url(11) }], { call, cache, capSek: 0, today: "2026-10-13" });
    expect(out.reads[0].status).toBe("cache");
    expect(out.calls).toBe(0);
  });

  it("never treats an entry of another prompt version as a hit", async () => {
    const cache = emptyCache();
    cache.entries["11"] = { imageId: "11", promptVersion: "old-version", storedAt: "2026-10-01", costSek: 0.04, result: read() };
    const { call, seen } = fakeCall();
    const out = await runFloorPlanProbe([{ booliId: "a", imageUrl: url(11) }], { call, cache, capSek: 2, today: "2026-10-13" });
    expect(out.cacheHits).toBe(0);
    expect(seen).toHaveLength(1);
    expect(out.cacheNext.entries["11"].promptVersion).toBe(FLOORPLAN_PROBE_VERSION);
  });

  it("skips a non-allowlisted URL as 'host' and never hands it to the call", async () => {
    const { call, seen } = fakeCall();
    const out = await runFloorPlanProbe(
      [{ booliId: "a", imageUrl: "https://evil.example/plan.png" }, { booliId: "b", imageUrl: "http://bcdn.se/images/cache/9_1.webp" }],
      { call, cache: emptyCache(), capSek: 2, today: "2026-10-13" },
    );
    expect(seen).toEqual([]);
    expect(out.reads.map((r) => r.status)).toEqual(["host", "host"]);
    expect(out.calls).toBe(0);
    expect(out.spentSek).toBe(0);
  });

  it("counts a throwing call as failed with the error name only and goes on", async () => {
    let n = 0;
    const call: FloorPlanCallFn = async () => {
      n += 1;
      if (n === 1) throw new TypeError("secret detail https://bcdn.se/images/cache/1_1.webp");
      return { result: read(), costSek: 0.05 };
    };
    const out = await runFloorPlanProbe(
      [1, 2].map((i) => ({ booliId: String(i), imageUrl: url(i) })),
      { call, cache: emptyCache(), capSek: 2, today: "2026-10-13" },
    );
    expect(out.reads[0]).toMatchObject({ status: "failed", error: "TypeError", result: null });
    expect(JSON.stringify(out.reads[0])).not.toContain("secret");
    expect(out.reads[1].status).toBe("read");
    expect(out.calls).toBe(1);
  });

  it("bills the money of a call that was answered and then failed (refusal)", async () => {
    const call: FloorPlanCallFn = async () => {
      throw new FloorPlanCallError("CLAUDE_REFUSAL", 0.03);
    };
    const out = await runFloorPlanProbe([{ booliId: "a", imageUrl: url(1) }], { call, cache: emptyCache(), capSek: 2, today: "2026-10-13" });
    expect(out.reads[0]).toMatchObject({ status: "failed", error: "CLAUDE_REFUSAL" });
    expect(out.spentSek).toBeCloseTo(0.03, 10);
    // a failed read is never cached
    expect(Object.keys(out.cacheNext.entries)).toEqual([]);
  });

  it("writes new reads into the next cache and keeps valid old entries", async () => {
    const cache = emptyCache();
    cache.entries["99"] = { imageId: "99", promptVersion: FLOORPLAN_PROBE_VERSION, storedAt: "2026-10-01", costSek: 0.04, result: read() };
    cache.entries["98"] = { imageId: "98", promptVersion: "stale", storedAt: "2026-10-01", costSek: 0.04, result: read() };
    const { call } = fakeCall(0.04, read({ northArrowPresent: true, confidence: 0.8 }));
    const out = await runFloorPlanProbe([{ booliId: "a", imageUrl: url(5) }], { call, cache, capSek: 2, today: "2026-10-13" });
    expect(Object.keys(out.cacheNext.entries).sort()).toEqual(["5", "99"]);
    expect(out.cacheNext.entries["5"]).toMatchObject({ imageId: "5", storedAt: "2026-10-13", costSek: 0.04 });
  });

  it("uses the per-call estimate constant 0,05 by default", () => {
    expect(FLOORPLAN_EST_SEK_PER_CALL).toBe(0.05);
  });
});

describe("the 2 kr cap is cumulative and cannot be defeated (14.3 review WR-04)", () => {
  const entry = (id: string, costSek: number, promptVersion = FLOORPLAN_PROBE_VERSION) => ({
    imageId: id,
    promptVersion,
    storedAt: "2026-10-01",
    costSek,
    result: read(),
  });
  const two = [1, 2].map((n) => ({ booliId: String(n), imageUrl: url(n) }));

  it("counts what earlier runs paid: a recorded total of 1,98 kr leaves room for no 0,05 kr call under a 2 kr cap", async () => {
    const { call, seen } = fakeCall();
    const out = await runFloorPlanProbe(two, { call, cache: { ...emptyCache(), spentSekTotal: 1.98 }, capSek: 2, today: "2026-10-13" });
    expect(seen).toEqual([]);
    expect(out.reads.map((r) => r.status)).toEqual(["cost_cap", "cost_cap"]);
    expect(out.spentSek).toBe(0);
    expect(out.totalSpentSek).toBeCloseTo(1.98, 10);
  });

  it("lets a rerun spend only what is left: the second run on the first run's cache stops after one more call", async () => {
    const first = fakeCall(0.05);
    const run1 = await runFloorPlanProbe(two, { call: first.call, cache: emptyCache(), capSek: 0.15, today: "2026-10-13" });
    expect(run1.calls).toBe(2);
    expect(run1.cacheNext.spentSekTotal).toBeCloseTo(0.1, 10);
    const second = fakeCall(0.05);
    const more = [3, 4].map((n) => ({ booliId: String(n), imageUrl: url(n) }));
    const run2 = await runFloorPlanProbe(more, { call: second.call, cache: run1.cacheNext, capSek: 0.15, today: "2026-10-14" });
    expect(run2.reads.map((r) => r.status)).toEqual(["read", "cost_cap"]);
    expect(run2.totalSpentSek).toBeCloseTo(0.15, 10);
    expect(run2.cacheNext.spentSekTotal).toBeCloseTo(0.15, 10);
  });

  it("reads a cache file from before the total existed as the sum of its stored reads", async () => {
    const cache = emptyCache();
    for (let i = 100; i < 140; i++) cache.entries[String(i)] = entry(String(i), 0.05);
    expect(floorPlanSpentSek(cache)).toBeCloseTo(2, 10);
    const { call, seen } = fakeCall();
    const out = await runFloorPlanProbe(two, { call, cache, capSek: 2, today: "2026-10-13" });
    expect(seen).toEqual([]);
    expect(out.reads[0].status).toBe("cost_cap");
  });

  it("keeps the money of reads that are dropped from the next cache (another prompt version) in the total", async () => {
    const cache = { ...emptyCache(), entries: { "98": entry("98", 0.4, "stale") } };
    const { call } = fakeCall(0.05);
    const out = await runFloorPlanProbe([{ booliId: "a", imageUrl: url(5) }], { call, cache, capSek: 2, today: "2026-10-13" });
    expect(Object.keys(out.cacheNext.entries)).toEqual(["5"]);
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(0.45, 10);
  });

  it("counts a call that returns a NaN cost at the estimate, so the cap still trips (old code: spent became NaN and the cap never tripped again)", async () => {
    const { call, seen } = fakeCall(Number.NaN);
    const items = [1, 2, 3].map((n) => ({ booliId: String(n), imageUrl: url(n) }));
    const out = await runFloorPlanProbe(items, { call, cache: emptyCache(), capSek: 0.1, today: "2026-10-13" });
    expect(seen).toHaveLength(2);
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read", "cost_cap"]);
    expect(Number.isFinite(out.spentSek)).toBe(true);
    expect(out.spentSek).toBeCloseTo(0.1, 10);
    expect(out.cacheNext.entries["1"].costSek).toBeCloseTo(0.05, 10);
    expect(Number.isFinite(out.cacheNext.spentSekTotal)).toBe(true);
  });

  it.each([
    ["a negative cost", -1],
    ["a zero cost", 0],
    ["an infinite cost", Number.POSITIVE_INFINITY],
  ])("counts %s at the estimate instead of letting it lower or break the total", async (_name, cost) => {
    const { call } = fakeCall(cost);
    const out = await runFloorPlanProbe(two, { call, cache: emptyCache(), capSek: 2, today: "2026-10-13" });
    expect(out.spentSek).toBeCloseTo(0.1, 10);
    expect(out.reads[0].costSek).toBeCloseTo(0.05, 10);
  });

  it("makes no call at all under a NaN or infinite-negative cap", async () => {
    for (const capSek of [Number.NaN, Number.NEGATIVE_INFINITY, -1]) {
      const { call, seen } = fakeCall();
      const out = await runFloorPlanProbe(two, { call, cache: emptyCache(), capSek, today: "2026-10-13" });
      expect(seen).toEqual([]);
      expect(out.reads.map((r) => r.status)).toEqual(["cost_cap", "cost_cap"]);
    }
  });

  it("counts a parse failure (answer arrived, output unusable) as billed at the estimate", async () => {
    const call: FloorPlanCallFn = async () => {
      throw asBilledFailure(new SyntaxError("Unexpected token"), () => false);
    };
    const out = await runFloorPlanProbe(two, { call, cache: emptyCache(), capSek: 0.05, today: "2026-10-13" });
    expect(out.reads[0]).toMatchObject({ status: "failed", error: "CLAUDE_PARSE_FAILED", costSek: 0.05 });
    expect(out.spentSek).toBeCloseTo(0.05, 10);
    // the 0,05 kr already billed uses up the cap, so the second picture is not even tried
    expect(out.reads[1].status).toBe("cost_cap");
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(0.05, 10);
  });

  describe("asBilledFailure", () => {
    const transport = (e: unknown) => e instanceof RangeError;
    it("bills a ZodError or a SyntaxError (the SDK threw after the answer arrived)", () => {
      const billed = asBilledFailure(new z.ZodError([]), transport);
      expect(billed).toBeInstanceOf(FloorPlanCallError);
      expect(billed).toMatchObject({ code: "CLAUDE_PARSE_FAILED", billedSek: FLOORPLAN_EST_SEK_PER_CALL });
      expect(asBilledFailure(new SyntaxError("x"), transport, 0.07)).toMatchObject({ billedSek: 0.07 });
    });
    it("passes a transport error (no answer, no bill) and an error that already carries its bill through unchanged", () => {
      const http = new RangeError("HTTP 400");
      expect(asBilledFailure(http, transport)).toBe(http);
      const own = new FloorPlanCallError("CLAUDE_REFUSAL", 0.03);
      expect(asBilledFailure(own, () => false)).toBe(own);
    });
  });

  describe("floorPlanSpentSek, addFloorPlanSpend, canAffordFloorPlanCall", () => {
    it("takes the larger of the recorded total and the stored reads, and ignores non-finite numbers", () => {
      const cache = { ...emptyCache(), entries: { a: entry("a", 0.3) }, spentSekTotal: 0.1 };
      expect(floorPlanSpentSek(cache)).toBeCloseTo(0.3, 10);
      expect(floorPlanSpentSek({ ...cache, spentSekTotal: 0.9 })).toBeCloseTo(0.9, 10);
      expect(floorPlanSpentSek({ ...emptyCache(), entries: { a: entry("a", Number.NaN) }, spentSekTotal: Number.NaN })).toBe(0);
    });
    it("adds only a finite positive amount", () => {
      expect(addFloorPlanSpend(emptyCache(), 0.2).spentSekTotal).toBeCloseTo(0.2, 10);
      expect(addFloorPlanSpend(emptyCache(), Number.NaN).spentSekTotal).toBe(0);
      expect(addFloorPlanSpend(emptyCache(), -5).spentSekTotal).toBe(0);
    });
    it("allows a call that ends exactly on the cap and refuses one past it or under a non-finite cap", () => {
      expect(canAffordFloorPlanCall({ ...emptyCache(), spentSekTotal: 1.95 }, 2)).toBe(true);
      expect(canAffordFloorPlanCall({ ...emptyCache(), spentSekTotal: 1.96 }, 2)).toBe(false);
      expect(canAffordFloorPlanCall(emptyCache(), Number.NaN)).toBe(false);
    });
  });
});

describe("probeVerdict (R-01, boundary inclusive)", () => {
  it("1 of 10 -> go", () => expect(probeVerdict({ floorPlans: 10, withCompass: 1 })).toBe("go"));
  it("1 of 11 -> dropped", () => expect(probeVerdict({ floorPlans: 11, withCompass: 1 })).toBe("dropped"));
  it("0 floor plans -> dropped", () => expect(probeVerdict({ floorPlans: 0, withCompass: 0 })).toBe("dropped"));
  it("0 of 12 -> dropped", () => expect(probeVerdict({ floorPlans: 12, withCompass: 0 })).toBe("dropped"));
  it("2 of 12 -> go", () => expect(probeVerdict({ floorPlans: 12, withCompass: 2 })).toBe("go"));
});

describe("summariseReads", () => {
  it("counts floor plans and compasses at confidence >= 0,6 only", () => {
    const reads = [
      read({ northArrowPresent: true, confidence: 0.6 }),
      read({ northArrowPresent: true, confidence: 0.59 }),
      read({ isFloorPlan: false, northArrowPresent: true, confidence: 0.9 }),
      read(),
    ];
    expect(summariseReads(reads)).toEqual({ floorPlans: 3, withCompass: 1 });
  });
});

describe("planBearingOf", () => {
  const arrow = (over: Partial<FloorPlanRead>) => read({ northArrowPresent: true, confidence: 0.9, balconySide: "upp", ...over });
  it("north up + balcony ned -> 180 (south)", () => expect(planBearingOf(arrow({ northBearingDeg: 0, balconySide: "ned" }))).toBe(180));
  it("north 90 + balcony upp -> 270 (west)", () => expect(planBearingOf(arrow({ northBearingDeg: 90, balconySide: "upp" }))).toBe(270));
  it("north -90 + balcony höger -> 180", () => expect(planBearingOf(arrow({ northBearingDeg: -90, balconySide: "höger" }))).toBe(180));
  it("north 450 + balcony upp -> 270", () => expect(planBearingOf(arrow({ northBearingDeg: 450, balconySide: "upp" }))).toBe(270));
  it("north 0 + balcony upp -> 0, not 360", () => expect(planBearingOf(arrow({ northBearingDeg: 0, balconySide: "upp" }))).toBe(0));
  it("balcony vänster, north 0 -> 270", () => expect(planBearingOf(arrow({ northBearingDeg: 0, balconySide: "vänster" }))).toBe(270));
  it("rounds to one decimal", () => expect(planBearingOf(arrow({ northBearingDeg: 12.34, balconySide: "upp" }))).toBe(347.7));
  it("confidence 0,59 -> null; 0,6 -> value", () => {
    expect(planBearingOf(arrow({ confidence: 0.59 }))).toBeNull();
    expect(planBearingOf(arrow({ confidence: 0.6 }))).toBe(0);
  });
  it("not a floor plan -> null", () => expect(planBearingOf(arrow({ isFloorPlan: false }))).toBeNull());
  it("no north arrow -> null", () => expect(planBearingOf(arrow({ northArrowPresent: false }))).toBeNull());
  it("balcony ingen -> null", () => expect(planBearingOf(arrow({ balconySide: "ingen" }))).toBeNull());
  it("NaN or infinite bearing -> null", () => {
    expect(planBearingOf(arrow({ northBearingDeg: Number.NaN }))).toBeNull();
    expect(planBearingOf(arrow({ northBearingDeg: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(planBearingOf(arrow({ confidence: Number.NaN }))).toBeNull();
  });
});

describe("pickProbeSample", () => {
  const row = (id: number | null, urls: string[] | null) => ({
    sourceListingUrl: id === null ? null : `https://www.booli.se/bostad/${id}`,
    imageUrls: urls,
  });
  it("sorts by Booli id ascending, takes the first allowlisted image, skips rows without one", () => {
    const rows = [
      row(30, [url(3)]),
      row(10, ["https://evil.example/x.png", url(1)]),
      row(20, []),
      row(null, [url(9)]),
      row(15, null),
      row(25, [url(2)]),
    ];
    expect(pickProbeSample(rows, 2)).toEqual([
      { booliId: "10", imageUrl: url(1) },
      { booliId: "25", imageUrl: url(2) },
    ]);
  });
  it("returns fewer than n when there are not enough rows and never repeats an id", () => {
    const rows = [row(1, [url(1)]), row(1, [url(1)])];
    expect(pickProbeSample(rows, 5)).toHaveLength(1);
  });
});

describe("the module's own flags", () => {
  it("the path sits under the data dir", () => {
    expect(FLOORPLAN_CACHE_PATH).toBe(".planning/calibration/data/floorplan-cache.json");
  });
  it("records the 2026-10-13 decision: route closed, numbers in the summary", () => {
    // 6 of 11 plans read as compass, all 6 were door-entrance arrows on inspection: no real compass, route closed.
    expect(FLOORPLAN_ROUTE_ENABLED).toBe(false);
    expect(FLOORPLAN_PROBE_SUMMARY).toContain("väg stängd");
    expect(FLOORPLAN_PROBE_SUMMARY).toContain("6 av 11");
    expect(FLOORPLAN_PROBE_SUMMARY).not.toBe("ej mätt ännu");
  });
});

describe("loadFloorPlanCache / saveFloorPlanCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "floorplan-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing file is an empty cache with no warning", () => {
    const out = loadFloorPlanCache(join(dir, "none.json"));
    expect(out.cache).toEqual(emptyCache());
    expect(out.warning).toBeNull();
  });

  it("an invalid file is read as empty, warns and is moved aside", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    const out = loadFloorPlanCache(p, { now: () => Date.UTC(2026, 9, 13) });
    expect(out.cache).toEqual(emptyCache());
    expect(out.warning).toMatch(/Planritningscachen/);
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("bad.json.bak-"))).toBe(true);
  });

  it("a file with the wrong shape is read as empty too", () => {
    const p = join(dir, "shape.json");
    writeFileSync(p, JSON.stringify({ version: 1, entries: { a: { imageId: 5 } } }));
    expect(loadFloorPlanCache(p).warning).not.toBeNull();
  });

  it("saves atomically inside the dir and loads the same cache back", () => {
    const p = join(dir, "ok.json");
    const cache = emptyCache();
    cache.entries["7"] = { imageId: "7", promptVersion: FLOORPLAN_PROBE_VERSION, storedAt: "2026-10-13", costSek: 0.04, result: read() };
    saveFloorPlanCache(p, cache, { dir });
    expect(loadFloorPlanCache(p).cache).toEqual(cache);
  });

  it("keeps the recorded total through a save and a load, and reads a file without it", () => {
    const p = join(dir, "total.json");
    saveFloorPlanCache(p, { version: 1, entries: {}, spentSekTotal: 0.37 }, { dir });
    expect(loadFloorPlanCache(p).cache.spentSekTotal).toBeCloseTo(0.37, 10);
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ version: 1, entries: {} }));
    expect(loadFloorPlanCache(old)).toEqual({ cache: { version: 1, entries: {} }, warning: null });
  });

  it("refuses to save outside .planning/calibration/data/", () => {
    expect(() => saveFloorPlanCache(join(dir, "x.json"), emptyCache())).toThrow(/får bara skrivas/);
    expect(() => saveFloorPlanCache("/tmp/floorplan-cache.json", emptyCache())).toThrow();
  });
});
