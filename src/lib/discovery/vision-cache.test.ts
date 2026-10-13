import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtureModel from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import fixtureSnapshot from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { parseFitSnapshot, rankFit } from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import {
  HEADLESS_VISION_CAP_SEK,
  HEADLESS_VISION_CHUNKS,
  VISION_CACHE_PATH,
  VISION_PROMPT_VERSION,
  imageSetKey,
  loadVisionCache,
  renderVisionLine,
  runVisionChunks,
  saveVisionCache,
  visionCacheId,
  visionListingKey,
  type VisionCache,
  type VisionPassFn,
} from "@/lib/discovery/vision-cache";
import type { VisionResult } from "@/lib/discovery/vision-schema";

function cand(i: number, overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    address: `Testgatan ${i}`,
    price: 3_000_000 + i,
    rooms: 2,
    livingArea: 40,
    areaLabel: "Södermalm",
    thumbnailUrl: null,
    sourceListingUrl: `https://www.booli.se/annons/${1000 + i}`,
    constructionYear: null,
    brfName: null,
    tenureForm: null,
    imageUrls: [`https://bcdn.example/${i}-a.jpg`, `https://bcdn.example/${i}-b.jpg`],
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

function visionResult(costSek: number, claim = "Köket verkar renoverat"): VisionResult {
  return {
    claims: [{ attribute: "kitchen", claim, imageIndex: 1, whatWasSeen: "nya vitvaror", confidence: 0.9 }],
    imageUrlsUsed: [],
    model: "fake",
    costSek,
    ranAt: "2026-10-13T10:00:00.000Z",
  };
}

const listingKeyOf = (c: DiscoveryCandidate) => (c.sourceListingUrl ? new URL(c.sourceListingUrl).pathname : null);
const noBroker = () => [] as BrokerImageBytes[];
const emptyCache = (): VisionCache => ({ version: 1, entries: {} });

/** A fake pass that attaches a result per candidate and records what it was called with. */
function fakePass(opts: { cost?: number; delayMs?: (laneFirstAddress: string) => number } = {}) {
  const calls: { addresses: string[]; capSek: number }[] = [];
  const runPass: VisionPassFn = async (candidates, o) => {
    candidates.forEach((c, local) => o.brokerImagesOf(c, local));
    calls.push({ addresses: candidates.map((c) => c.address ?? ""), capSek: o.capSek });
    const wait = opts.delayMs?.(candidates[0]?.address ?? "") ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return candidates.map((c) => ({ ...c, vision: visionResult(opts.cost ?? 0.4, `claim ${c.address}`), visionSkippedReason: null }));
  };
  return { runPass, calls };
}

describe("imageSetKey", () => {
  it("same URLs in another order give the same key", () => {
    expect(imageSetKey(["b", "a", "c"], 0)).toBe(imageSetKey(["c", "a", "b"], 0));
  });
  it("one URL added gives a different key", () => {
    expect(imageSetKey(["a", "b"], 0)).not.toBe(imageSetKey(["a", "b", "c"], 0));
  });
  it("a different broker image count gives a different key", () => {
    expect(imageSetKey(["a"], 2)).not.toBe(imageSetKey(["a"], 3));
  });
  it("null and empty URL lists agree", () => {
    expect(imageSetKey(null, 0)).toBe(imageSetKey([], 0));
  });
});

describe("cache key: model, prompt, schema and photo content (WR-05)", () => {
  it("the prompt version is a stable 16-character hex id", () => {
    expect(VISION_PROMPT_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it("another prompt version gives another image key (so an old read is never served for new rules)", () => {
    expect(imageSetKey(["a"], 0, "v1")).not.toBe(imageSetKey(["a"], 0, "v2"));
    expect(imageSetKey(["a"], 0)).toBe(imageSetKey(["a"], 0, VISION_PROMPT_VERSION));
  });

  it.each([
    ["the deep-pass prompt", { VISION_DEEPPASS_SYSTEM_PROMPT: "ändrad prompt" }],
    ["the pre-filter prompt", { VISION_PREFILTER_SYSTEM_PROMPT: "ändrad prompt" }],
    ["the deep-pass model id", { VISION_SONNET_MODEL: "claude-sonnet-9-9" }],
    ["the triage model id", { VISION_HAIKU_MODEL: "claude-haiku-9-9" }],
    ["the logic revision", { VISION_LOGIC_REVISION: 2 }],
  ])("the derived version changes when %s changes", async (_label, change) => {
    vi.resetModules();
    vi.doMock("@/lib/discovery/vision-prompt", async (importOriginal) => ({ ...(await importOriginal<object>()), ...change }));
    try {
      const changed = await import("@/lib/discovery/vision-cache");
      expect(changed.VISION_PROMPT_VERSION).not.toBe(VISION_PROMPT_VERSION);
    } finally {
      vi.doUnmock("@/lib/discovery/vision-prompt");
      vi.resetModules();
    }
  });

  it("a swapped broker photo with the same count gives another key; identical bytes give the same key", () => {
    const a = [{ mediaType: "image/jpeg", data: "AAAA" }] as BrokerImageBytes[];
    const b = [{ mediaType: "image/jpeg", data: "BBBB" }] as BrokerImageBytes[];
    expect(imageSetKey(["u"], a)).not.toBe(imageSetKey(["u"], b));
    expect(imageSetKey(["u"], a)).toBe(imageSetKey(["u"], [{ mediaType: "image/jpeg", data: "AAAA" }] as BrokerImageBytes[]));
  });

  it("visionListingKey shares one key between /annons/ and /bostad/ and leaves other paths alone", () => {
    expect(visionListingKey("/annons/6305391")).toBe("booli:6305391");
    expect(visionListingKey("/bostad/6305391")).toBe("booli:6305391");
    expect(visionListingKey("/annons/6305391?x=1")).toBe("booli:6305391");
    expect(visionListingKey("/nagot/annat")).toBe("/nagot/annat");
  });

  it("a flat that switches from /annons/ to /bostad/ with the same pictures is a cache hit, not paid for again", async () => {
    const c = cand(0);
    const first = await runVisionChunks([c], { brokerImagesOf: noBroker, cache: emptyCache(), runPass: fakePass().runPass, keyOf: listingKeyOf, today: "2026-10-06" });
    const switched = { ...c, sourceListingUrl: "https://www.booli.se/bostad/1000" };
    const { runPass, calls } = fakePass();
    const second = await runVisionChunks([switched], { brokerImagesOf: noBroker, cache: first.cacheNext, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(second.cacheHits).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("a stored read from an older prompt version is not served, is read again, and is dropped on save", async () => {
    const c0 = cand(0);
    const oldKey = imageSetKey(c0.imageUrls, 0, "old-version");
    const cache: VisionCache = {
      version: 1,
      entries: {
        [visionCacheId("booli:1000", oldKey)]: { listingKey: "booli:1000", imageKey: oldKey, promptVersion: "old-version", storedAt: "2026-10-06", result: visionResult(0.5, "gammal läsning") },
        // an entry from before the version was stored, for a flat that is not in this run
        "/annons/9999#legacy": { listingKey: "/annons/9999", imageKey: "legacy", storedAt: "2026-09-01", result: visionResult(0.5) },
      },
    };
    const { runPass, calls } = fakePass();
    const r = await runVisionChunks([c0], { brokerImagesOf: noBroker, cache, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(r.cacheHits).toBe(0);
    expect(calls).toHaveLength(1);
    expect(Object.keys(r.cacheNext.entries)).toEqual([visionCacheId("booli:1000", imageSetKey(c0.imageUrls, 0))]);
    expect(Object.values(r.cacheNext.entries)[0].promptVersion).toBe(VISION_PROMPT_VERSION);
  });
});

describe("runVisionChunks", () => {
  it("7 candidates, 3 chunks, 60 SEK: three passes over {0,3,6} {1,4} {2,5}, 20 SEK each, output in input order", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => cand(i));
    const { runPass, calls } = fakePass();
    const r = await runVisionChunks(candidates, {
      brokerImagesOf: noBroker,
      cache: emptyCache(),
      runPass,
      capSekTotal: 60,
      chunks: 3,
      keyOf: listingKeyOf,
      today: "2026-10-13",
    });
    const sets = calls.map((c) => c.addresses.map((a) => Number(a.replace("Testgatan ", "")))).sort((a, b) => a[0] - b[0]);
    expect(sets).toEqual([[0, 3, 6], [1, 4], [2, 5]]);
    expect(calls.map((c) => c.capSek)).toEqual([20, 20, 20]);
    expect(r.chunkSizes).toEqual([3, 2, 2]);
    expect(r.candidates.map((c) => c.address)).toEqual(candidates.map((c) => c.address));
    expect(r.calls).toBe(7);
    expect(r.cacheHits).toBe(0);
    expect(r.spentSek).toBeCloseTo(2.8, 10);
  });

  it("brokerImagesOf receives the GLOBAL index, not the lane's own", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => cand(i));
    const seen: number[] = [];
    const runPass: VisionPassFn = async (cs, o) => {
      cs.forEach((c, local) => o.brokerImagesOf(c, local));
      return cs.map((c) => ({ ...c, vision: visionResult(0.1), visionSkippedReason: null }));
    };
    await runVisionChunks(candidates, {
      brokerImagesOf: (c, i) => {
        seen.push(i);
        expect(c.address).toBe(`Testgatan ${i}`);
        return [];
      },
      cache: emptyCache(),
      runPass,
      keyOf: listingKeyOf,
      today: "2026-10-13",
    });
    // Every global index 0..6 was asked for (twice: once for the cache key, once inside the lane).
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("output stays in input order even when the last lane finishes first", async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => cand(i));
    const { runPass } = fakePass({ delayMs: (first) => (first === "Testgatan 0" ? 30 : first === "Testgatan 1" ? 15 : 0) });
    const r = await runVisionChunks(candidates, { brokerImagesOf: noBroker, cache: emptyCache(), runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(r.candidates.map((c) => c.address)).toEqual(candidates.map((c) => c.address));
    expect(r.candidates.every((c) => c.vision !== null)).toBe(true);
  });

  it("a cache hit for candidate 4 never reaches the pass, is free, and counts as a hit", async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => cand(i));
    const cache: VisionCache = {
      version: 1,
      entries: {
        [visionCacheId("booli:1004", imageSetKey(candidates[4].imageUrls, 0))]: {
          listingKey: "booli:1004",
          promptVersion: VISION_PROMPT_VERSION,
          imageKey: imageSetKey(candidates[4].imageUrls, 0),
          storedAt: "2026-10-06",
          result: visionResult(0.77, "cached claim"),
        },
      },
    };
    const { runPass, calls } = fakePass();
    const r = await runVisionChunks(candidates, { brokerImagesOf: noBroker, cache, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(calls.flatMap((c) => c.addresses)).not.toContain("Testgatan 4");
    expect(r.cacheHits).toBe(1);
    expect(r.calls).toBe(6);
    expect(r.candidates[4].vision?.claims[0].claim).toBe("cached claim");
    expect(r.candidates[4].vision?.costSek).toBe(0);
    expect(r.candidates[4].visionSkippedReason).toBeNull();
    expect(r.spentSek).toBeCloseTo(6 * 0.4, 10);
    expect(r.chunkSizes).toEqual([3, 2, 2]);
    // The stored entry keeps its original cost.
    expect(r.cacheNext.entries[visionCacheId("booli:1004", imageSetKey(candidates[4].imageUrls, 0))].result.costSek).toBe(0.77);
  });

  it("a changed image set misses, is read again, and replaces the old entry of that listing", async () => {
    const c0 = cand(0);
    const oldKey = imageSetKey(c0.imageUrls, 0);
    const cache: VisionCache = {
      version: 1,
      entries: { [visionCacheId("booli:1000", oldKey)]: { listingKey: "booli:1000", imageKey: oldKey, promptVersion: VISION_PROMPT_VERSION, storedAt: "2026-10-06", result: visionResult(0.5) } },
    };
    const changed = { ...c0, imageUrls: [...(c0.imageUrls ?? []), "https://bcdn.example/0-c.jpg"] };
    const { runPass, calls } = fakePass();
    const r = await runVisionChunks([changed], { brokerImagesOf: noBroker, cache, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(calls).toHaveLength(1);
    expect(r.cacheHits).toBe(0);
    const keys = Object.keys(r.cacheNext.entries);
    expect(keys).toEqual([visionCacheId("booli:1000", imageSetKey(changed.imageUrls, 0))]);
  });

  it("a different broker photo count misses the cache", async () => {
    const c0 = cand(0);
    const key = imageSetKey(c0.imageUrls, 2);
    const cache: VisionCache = {
      version: 1,
      entries: { [visionCacheId("booli:1000", key)]: { listingKey: "booli:1000", imageKey: key, promptVersion: VISION_PROMPT_VERSION, storedAt: "2026-10-06", result: visionResult(0.5) } },
    };
    const { runPass } = fakePass();
    const hit = await runVisionChunks([c0], { brokerImagesOf: () => [{}, {}] as unknown as BrokerImageBytes[], cache, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(hit.cacheHits).toBe(1);
    const miss = await runVisionChunks([c0], { brokerImagesOf: () => [{}] as unknown as BrokerImageBytes[], cache, runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(miss.cacheHits).toBe(0);
  });

  it("results are cached by listing path and image set; a null result is not", async () => {
    const candidates = [cand(0), cand(1), cand(2)];
    const runPass: VisionPassFn = async (cs) =>
      cs.map((c) =>
        c.address === "Testgatan 1"
          ? { ...c, vision: null, visionSkippedReason: "cost_cap" as const }
          : { ...c, vision: visionResult(0.3), visionSkippedReason: null },
      );
    const r = await runVisionChunks(candidates, { brokerImagesOf: noBroker, cache: emptyCache(), runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(Object.keys(r.cacheNext.entries).sort()).toEqual([
      visionCacheId("booli:1000", imageSetKey(candidates[0].imageUrls, 0)),
      visionCacheId("booli:1002", imageSetKey(candidates[2].imageUrls, 0)),
    ]);
    expect(r.skipped).toEqual({ cost_cap: 1 });
    expect(r.calls).toBe(2);
    expect(r.cacheNext.entries[visionCacheId("booli:1000", imageSetKey(candidates[0].imageUrls, 0))].storedAt).toBe("2026-10-13");
  });

  it("a candidate with no listing key is read but never cached", async () => {
    const { runPass } = fakePass();
    const r = await runVisionChunks([cand(0, { sourceListingUrl: null })], { brokerImagesOf: noBroker, cache: emptyCache(), runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(r.calls).toBe(1);
    expect(Object.keys(r.cacheNext.entries)).toEqual([]);
  });

  it("zero candidates: the pass is never called, spend 0, chunk sizes 0/0/0", async () => {
    const { runPass, calls } = fakePass();
    const r = await runVisionChunks([], { brokerImagesOf: noBroker, cache: emptyCache(), runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(calls).toHaveLength(0);
    expect(r.spentSek).toBe(0);
    expect(r.chunkSizes).toEqual([0, 0, 0]);
    expect(renderVisionLine({ ...r, skipped: r.skipped })).toBe(
      "Bildtolkning: 0 anrop, 0 från cache, 0 hoppades över, 0,00 kr av tak 60 kr (delar: 0/0/0 kandidater)",
    );
  });

  it("a lane whose pass throws marks only its candidates vision_error; the other lanes still deliver", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const candidates = Array.from({ length: 6 }, (_, i) => cand(i));
    const runPass: VisionPassFn = async (cs) => {
      if (cs[0].address === "Testgatan 1") throw new Error("boom");
      return cs.map((c) => ({ ...c, vision: visionResult(0.2), visionSkippedReason: null }));
    };
    const r = await runVisionChunks(candidates, { brokerImagesOf: noBroker, cache: emptyCache(), runPass, keyOf: listingKeyOf, today: "2026-10-13" });
    expect(r.candidates.map((c) => c.visionSkippedReason)).toEqual([null, "vision_error", null, null, "vision_error", null]);
    expect(r.skipped).toEqual({ vision_error: 2 });
    expect(r.calls).toBe(4);
    err.mockRestore();
  });

  it("constants: 60 SEK in 3 lanes, the cache lives in the gitignored data dir", () => {
    expect(HEADLESS_VISION_CAP_SEK).toBe(60);
    expect(HEADLESS_VISION_CHUNKS).toBe(3);
    expect(VISION_CACHE_PATH).toBe(".planning/calibration/data/vision-cache.json");
  });

  it("ranking the chunked output equals ranking an unchunked pass with the same per-candidate results", async () => {
    const model = parseHedonicModel(fixtureModel);
    const snapshot = parseFitSnapshot(fixtureSnapshot);
    const rows = snapshot.rows.slice(0, 20);
    const resultFor = (c: DiscoveryCandidate): VisionResult => {
      const n = Number((c.sourceListingUrl ?? "").replace(/\D/g, "")) % 3;
      return {
        claims:
          n === 0
            ? []
            : [{ attribute: "kitchen", claim: n === 1 ? "Köket verkar nyrenoverat" : "Köket verkar slitet", imageIndex: 1, whatWasSeen: "x", confidence: 0.9 }],
        imageUrlsUsed: [],
        model: "fake",
        costSek: 0.4,
        ranAt: "2026-10-13T10:00:00.000Z",
      };
    };
    const runPass: VisionPassFn = async (cs) => {
      // The first lane is the slowest: completion order differs from input order.
      if (cs[0].sourceListingUrl === rows[0].candidate.sourceListingUrl) await new Promise((r) => setTimeout(r, 20));
      return cs.map((c) => ({ ...c, vision: resultFor(c), visionSkippedReason: null }));
    };
    const chunked = await runVisionChunks(rows.map((r) => r.candidate), {
      brokerImagesOf: noBroker,
      cache: emptyCache(),
      runPass,
      keyOf: listingKeyOf,
      today: "2026-10-13",
    });
    const withChunked = rows.map((r, i) => ({ ...r, candidate: chunked.candidates[i] }));
    const withPlain = rows.map((r) => ({ ...r, candidate: { ...r.candidate, vision: resultFor(r.candidate), visionSkippedReason: null } }));
    const order = (rs: typeof rows) => rankFit(rs, model).ranked.map((x) => x.booliId);
    expect(order(withChunked)).toEqual(order(withPlain));
    expect(order(withChunked).length).toBeGreaterThan(5);
  });
});

describe("renderVisionLine (pinned)", () => {
  it("renders the exact line for a normal run", () => {
    expect(renderVisionLine({ calls: 9, cacheHits: 1, skipped: 0, spentSek: 4.104, chunkSizes: [4, 3, 3] })).toBe(
      "Bildtolkning: 9 anrop, 1 från cache, 0 hoppades över, 4,10 kr av tak 60 kr (delar: 4/3/3 kandidater)",
    );
  });
  it("sums a per-reason record into hoppades över", () => {
    expect(renderVisionLine({ calls: 1, cacheHits: 0, skipped: { no_images: 2, cost_cap: 3 }, spentSek: 0.4, chunkSizes: [2, 2, 2] })).toBe(
      "Bildtolkning: 1 anrop, 0 från cache, 5 hoppades över, 0,40 kr av tak 60 kr (delar: 2/2/2 kandidater)",
    );
  });
  it("the zero case is exactly the pinned string", () => {
    expect(renderVisionLine({ calls: 0, cacheHits: 0, skipped: 0, spentSek: 0, chunkSizes: [0, 0, 0] })).toBe(
      "Bildtolkning: 0 anrop, 0 från cache, 0 hoppades över, 0,00 kr av tak 60 kr (delar: 0/0/0 kandidater)",
    );
  });
});

describe("loadVisionCache / saveVisionCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vision-cache-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing file is an empty cache without a warning", () => {
    expect(loadVisionCache(join(dir, "nope.json"))).toEqual({ cache: { version: 1, entries: {} }, warning: null });
  });

  it("round trips through saveVisionCache", () => {
    const path = join(dir, "vision-cache.json");
    const cache: VisionCache = {
      version: 1,
      entries: { "/annons/1#abc": { listingKey: "/annons/1", imageKey: "abc", storedAt: "2026-10-13", result: visionResult(0.4) } },
    };
    saveVisionCache(path, cache, { dir });
    const back = loadVisionCache(path);
    expect(back.warning).toBeNull();
    expect(back.cache.entries["/annons/1#abc"].result.claims[0].claim).toBe("Köket verkar renoverat");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("invalid JSON: empty cache, a warning, the file moved to .bak-<timestamp>", () => {
    const path = join(dir, "vision-cache.json");
    writeFileSync(path, "{not json", "utf8");
    const r = loadVisionCache(path, { now: () => Date.UTC(2026, 9, 13, 10, 0, 0) });
    expect(r.cache).toEqual({ version: 1, entries: {} });
    expect(r.warning).toContain("vision-cache.json");
    expect(existsSync(path)).toBe(false);
    const baks = readdirSync(dir).filter((f) => f.startsWith("vision-cache.json.bak-"));
    expect(baks).toEqual(["vision-cache.json.bak-2026-10-13T10-00-00-000Z"]);
    expect(readFileSync(join(dir, baks[0]), "utf8")).toBe("{not json");
  });

  it("valid JSON of the wrong shape is treated the same way", () => {
    const path = join(dir, "vision-cache.json");
    writeFileSync(path, JSON.stringify({ version: 2, entries: [] }), "utf8");
    const r = loadVisionCache(path);
    expect(r.cache.entries).toEqual({});
    expect(r.warning).not.toBeNull();
    expect(readdirSync(dir).some((f) => f.includes(".bak-"))).toBe(true);
  });

  it("refuses to write outside the data directory or with the wrong extension", () => {
    const other = mkdtempSync(join(tmpdir(), "vision-cache-other-"));
    try {
      expect(() => saveVisionCache(join(other, "vision-cache.json"), { version: 1, entries: {} }, { dir })).toThrow();
      expect(() => saveVisionCache(join(dir, "vision-cache.txt"), { version: 1, entries: {} }, { dir })).toThrow();
      expect(() => saveVisionCache(`${dir}-evil/vision-cache.json`, { version: 1, entries: {} }, { dir })).toThrow();
      expect(existsSync(join(other, "vision-cache.json"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("with no dir option, the default is the data directory (a tmp path is refused)", () => {
    expect(() => saveVisionCache(join(dir, "vision-cache.json"), { version: 1, entries: {} })).toThrow();
  });
});
