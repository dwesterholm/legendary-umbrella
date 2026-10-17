// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import { believedLayout, layoutFactSchema, type LayoutGatePolicy } from "@/lib/discovery/layout-fact";
import {
  LAYOUT_ROUND_CAP_SEK,
  LAYOUT_SMOKE_CAP_SEK,
  LAYOUT_VARIANTS,
  factFromVariantRead,
  layoutVariantCachePath,
  loadVariantCache,
  runVariantReads,
  saveVariantCache,
  variantReadId,
  variantVersion,
  type LayoutVariantSpec,
  type VariantCache,
  type VariantCallFn,
  type VariantReadItem,
} from "@/lib/discovery/layout-experiment";
import {
  LAYOUT_CACHE_PATH,
  LAYOUT_MAX_BOOLI_PHOTOS,
  LAYOUT_MAX_TOKENS,
  LAYOUT_MODEL,
  LAYOUT_READ_VERSION,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_USER_INSTRUCTION,
  layoutReadSchema,
  type LayoutImageBlock,
  type LayoutRead,
} from "@/lib/discovery/layout-read";
import { FloorPlanCallError } from "@/lib/discovery/sun-floorplan";

const spec = LAYOUT_VARIANTS.a;

const read = (over: Partial<LayoutRead> = {}): LayoutRead => ({
  balconySide: "street",
  livingOnBalconySide: true,
  kitchenOnBalconySide: false,
  bedroomOnBalconySide: false,
  windowSides: "one",
  bedroomSide: "street",
  streetEvidence: "cars",
  confidence: 0.9,
  ...over,
});

const url = (id: number) => `https://bcdn.se/images/cache/${id}_1440x0.webp`;
const item = (id: number, over: Partial<VariantReadItem> = {}): VariantReadItem => ({
  booliId: id,
  listingPath: `/bostad/${id}`,
  imageUrls: [url(id * 10), url(id * 10 + 1), url(id * 10 + 2), url(id * 10 + 3)],
  ...over,
});
const emptyCache = (s: LayoutVariantSpec = spec): VariantCache => ({
  version: 1,
  variantId: s.id,
  variantVersion: variantVersion(s),
  entries: {},
  spentSekTotal: 0,
});

/** A fake call: records every block list, costs `cost` per call. */
function fakeCall(cost = 0.2, result: unknown = read()) {
  const seen: LayoutImageBlock[][] = [];
  const call: VariantCallFn = async (blocks) => {
    seen.push(blocks);
    return { result, costSek: cost };
  };
  return { call, seen };
}

const sha = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

describe("variant a is the production read", () => {
  it("is built from the production constants (invariant)", () => {
    expect(spec.model).toBe(LAYOUT_MODEL);
    expect(spec.systemPrompt).toBe(LAYOUT_SYSTEM_PROMPT);
    expect(spec.userInstruction).toBe(LAYOUT_USER_INSTRUCTION);
    expect(spec.schema).toBe(layoutReadSchema);
    expect(spec.temperature).toBe(0);
    expect(spec.effort).toBeNull();
    expect(spec.maxTokens).toBe(LAYOUT_MAX_TOKENS);
    expect(spec.steps).toBe(1);
    expect(spec.images).toEqual({ maxBooliPhotos: LAYOUT_MAX_BOOLI_PHOTOS, maxBrokerPhotos: 0 });
    expect(spec.estSekPerFlat).toBe(0.35);
  });

  it("has a 16-hex version that differs from the production version, because the image policy is part of it", () => {
    const v = variantVersion(spec);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(v).not.toBe(LAYOUT_READ_VERSION);
  });

  it("moves the version when the image policy, the temperature, the max tokens or the model changes", () => {
    const v = variantVersion(spec);
    expect(variantVersion({ ...spec, images: { maxBooliPhotos: 2, maxBrokerPhotos: 0 } })).not.toBe(v);
    expect(variantVersion({ ...spec, temperature: 0.5 })).not.toBe(v);
    expect(variantVersion({ ...spec, maxTokens: 999 })).not.toBe(v);
    expect(variantVersion({ ...spec, model: "claude-opus-5-5" })).not.toBe(v);
    expect(variantVersion({ ...spec, effort: "low" })).not.toBe(v);
    expect(variantVersion({ ...spec })).toBe(v);
  });

  it("states the caps", () => {
    expect(LAYOUT_ROUND_CAP_SEK).toBe(40);
    expect(LAYOUT_SMOKE_CAP_SEK).toBe(1);
  });
});

describe("one cache file per variant", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "layout-exp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the file layout-exp-<id>.json under the data directory", () => {
    expect(layoutVariantCachePath("a")).toBe(".planning/calibration/data/layout-exp-a.json");
    expect(layoutVariantCachePath("d-opus")).toBe(".planning/calibration/data/layout-exp-d-opus.json");
    expect(() => layoutVariantCachePath("../x")).toThrow();
  });

  it("refuses the production cache, a path outside the directory and a file that is not layout-exp-<id>.json", () => {
    const cache = emptyCache();
    expect(() => saveVariantCache(LAYOUT_CACHE_PATH, cache)).toThrow();
    expect(() => saveVariantCache(LAYOUT_CACHE_PATH, cache, { dir: ".planning/calibration/data" })).toThrow();
    expect(() => saveVariantCache(join(dir, "layout-exp-a.json"), cache)).toThrow();
    expect(() => saveVariantCache(join(dir, "layout-cache.json"), cache, { dir })).toThrow();
    expect(() => saveVariantCache(join(dir, "slutpriser-cache.json"), cache, { dir })).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("round-trips a saved cache", () => {
    const path = join(dir, "layout-exp-a.json");
    const cache: VariantCache = { ...emptyCache(), spentSekTotal: 1.5, entries: { "booli:1|x": { id: "booli:1|x", storedAt: "2026-10-17", costSek: 0.2, result: read() } } };
    saveVariantCache(path, cache, { dir });
    const loaded = loadVariantCache(path, spec);
    expect(loaded.unreadable).toBe(false);
    expect(loaded.dropped).toBe(0);
    expect(loaded.cache).toEqual(cache);
  });

  it("reads a missing file as empty", () => {
    const loaded = loadVariantCache(join(dir, "layout-exp-a.json"), spec);
    expect(loaded.cache.entries).toEqual({});
    expect(loaded.unreadable).toBe(false);
    expect(loaded.warning).toBeNull();
  });

  it("drops and counts an entry whose answer fails the schema, and never renames the file", () => {
    const path = join(dir, "layout-exp-a.json");
    const cache: VariantCache = {
      ...emptyCache(),
      entries: {
        good: { id: "good", storedAt: "2026-10-17", costSek: 0.2, result: read() },
        bad: { id: "bad", storedAt: "2026-10-17", costSek: 0.2, result: { balconySide: "moon" } },
      },
    };
    saveVariantCache(path, cache, { dir });
    const loaded = loadVariantCache(path, spec);
    expect(Object.keys(loaded.cache.entries)).toEqual(["good"]);
    expect(loaded.dropped).toBe(1);
    expect(loaded.warning).not.toBeNull();
    expect(readdirSync(dir)).toEqual(["layout-exp-a.json"]);
  });

  it("keeps the ledger but no entries when the file was written for another version", () => {
    const path = join(dir, "layout-exp-a.json");
    saveVariantCache(path, { ...emptyCache(), variantVersion: "0000000000000000", spentSekTotal: 3, entries: { x: { id: "x", storedAt: "d", costSek: 1, result: read() } } }, { dir });
    const loaded = loadVariantCache(path, spec);
    expect(loaded.cache.entries).toEqual({});
    expect(loaded.cache.spentSekTotal).toBe(3);
    expect(loaded.cache.variantVersion).toBe(variantVersion(spec));
    expect(loaded.dropped).toBe(1);
  });

  it("flags an unreadable file and leaves it in place", () => {
    const path = join(dir, "layout-exp-a.json");
    writeFileSync(path, "{ not json");
    const loaded = loadVariantCache(path, spec);
    expect(loaded.unreadable).toBe(true);
    expect(loaded.cache.entries).toEqual({});
    expect(readdirSync(dir)).toEqual(["layout-exp-a.json"]);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("runVariantReads", () => {
  it("reads a new flat once, caches it, and a second run is a free cache hit", async () => {
    const { call, seen } = fakeCall(0.2);
    const first = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "2026-10-17" });
    expect(first.calls).toBe(1);
    expect(first.reads[0].status).toBe("read");
    expect(first.spentSek).toBeCloseTo(0.2, 10);
    expect(first.totalSpentSek).toBeCloseTo(0.2, 10);
    expect(Object.keys(first.cacheNext.entries)).toHaveLength(1);

    const second = await runVariantReads([item(1)], { variant: spec, call, cache: first.cacheNext, runCapSek: 5, today: "2026-10-18" });
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.spentSek).toBe(0);
    expect(second.reads[0].status).toBe("cache");
    expect(second.totalSpentSek).toBeCloseTo(0.2, 10);
    expect(seen).toHaveLength(1);
  });

  it("sends the plan and three Booli photos and never a broker picture", async () => {
    const { call, seen } = fakeCall();
    // Even if a caller smuggled a broker field onto the item, the runner has no way to send it.
    const smuggled = { ...item(1), brokerImages: [{ mediaType: "image/jpeg", data: "bytes" } satisfies BrokerImageBytes] } as VariantReadItem;
    const out = await runVariantReads([smuggled, item(2, { imageUrls: [url(1), url(2), url(3), url(4), url(5), url(6)] })], {
      variant: spec,
      call,
      cache: emptyCache(),
      runCapSek: 5,
      today: "2026-10-17",
    });
    expect(seen).toHaveLength(2);
    for (const blocks of seen) {
      expect(blocks).toHaveLength(4);
      expect(blocks.every((b) => b.source.type === "url")).toBe(true);
    }
    expect(out.reads.every((r) => r.images.broker === 0 && r.images.booli === 4)).toBe(true);
  });

  it("applies the cap strictly greater, with equal allowed", async () => {
    const eq = fakeCall(0.35);
    // estimate 0,35 each: two reads exactly fill 0,70; the cap 0,70 allows both, a third would exceed it.
    const out = await runVariantReads([item(1), item(2), item(3)], { variant: spec, call: eq.call, cache: emptyCache(), runCapSek: 0.7, today: "d" });
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read", "cost_cap"]);
    expect(eq.seen).toHaveLength(2);
    const justUnder = await runVariantReads([item(4), item(5)], { variant: spec, call: eq.call, cache: emptyCache(), runCapSek: 0.69, today: "d" });
    expect(justUnder.reads.map((r) => r.status)).toEqual(["read", "cost_cap"]);
  });

  it("counts the money a failing call billed and goes on", async () => {
    let n = 0;
    const call: VariantCallFn = async () => {
      n += 1;
      if (n === 1) throw new FloorPlanCallError("CLAUDE_MAX_TOKENS", 0.3);
      return { result: read(), costSek: 0.2 };
    };
    const out = await runVariantReads([item(1), item(2)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
    expect(out.reads.map((r) => r.status)).toEqual(["failed", "read"]);
    expect(out.reads[0].errorCode).toBe("CLAUDE_MAX_TOKENS");
    expect(out.spentSek).toBeCloseTo(0.5, 10);
    expect(out.calls).toBe(1);
    expect(Object.keys(out.cacheNext.entries)).toHaveLength(1);
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(0.5, 10);
  });

  it("names a thrown error by its class, never its message", async () => {
    const call: VariantCallFn = async () => {
      throw new Error("https://secret.example/x?key=abc");
    };
    const out = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
    expect(out.reads[0].status).toBe("failed");
    expect(out.reads[0].errorCode).toBe("Error");
    expect(JSON.stringify(out)).not.toContain("secret.example");
  });

  it("marks an answer that does not fit the schema as failed and still counts its money", async () => {
    const { call } = fakeCall(0.25, { balconySide: "moon" });
    const out = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
    expect(out.reads[0].status).toBe("failed");
    expect(out.reads[0].errorCode).toBe("BAD_ANSWER");
    expect(out.spentSek).toBeCloseTo(0.25, 10);
    expect(out.calls).toBe(0);
    expect(out.cacheNext.entries).toEqual({});
  });

  it("counts a non-finite cost at the estimate", async () => {
    const { call } = fakeCall(Number.NaN);
    const out = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
    expect(out.spentSek).toBe(spec.estSekPerFlat);
  });

  it("never sends image 1 off the host allowlist and reports a missing plan", async () => {
    const { call, seen } = fakeCall();
    const out = await runVariantReads(
      [item(1, { imageUrls: ["https://evil.example/plan.png", url(2)] }), item(2, { imageUrls: [] }), item(3, { imageUrls: null })],
      { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" },
    );
    expect(out.reads.map((r) => r.status)).toEqual(["host", "no_plan", "no_plan"]);
    expect(seen).toHaveLength(0);
    expect(variantReadId(spec, item(1, { imageUrls: ["https://evil.example/plan.png"] }))).toBeNull();
  });

  it("keeps the ledger of earlier runs without letting it block a run", async () => {
    const { call } = fakeCall(0.2);
    const cache: VariantCache = { ...emptyCache(), spentSekTotal: 100 };
    const out = await runVariantReads([item(1)], { variant: spec, call, cache, runCapSek: 1, today: "d" });
    expect(out.reads[0].status).toBe("read");
    expect(out.totalSpentSek).toBeCloseTo(100.2, 10);
  });

  it("never touches the production cache", async () => {
    const before = sha(LAYOUT_CACHE_PATH);
    const production = Object.freeze({ version: 1, entries: Object.freeze({}) });
    const dir = mkdtempSync(join(tmpdir(), "layout-exp-"));
    try {
      const { call } = fakeCall();
      const out = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
      saveVariantCache(join(dir, "layout-exp-a.json"), out.cacheNext, { dir });
      expect(() => saveVariantCache(LAYOUT_CACHE_PATH, out.cacheNext)).toThrow();
      expect(production.entries).toEqual({});
      expect(sha(LAYOUT_CACHE_PATH)).toBe(before);
      expect(Object.keys(out.cacheNext.entries).every((id) => id.startsWith("booli:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("factFromVariantRead", () => {
  const policy: LayoutGatePolicy = {
    balconyGate: 0.6,
    windowsGate: 0.6,
    bedroomGate: 0.6,
    negativeGate: 0.6,
    sideEvidence: ["cars", "courtyardGreenery"],
    trustedVersion: null,
  };

  it("maps a variant a answer to a fact with the variant version and four Booli pictures", () => {
    const fact = factFromVariantRead(spec, read({ confidence: 1.4 }), { booli: 4 });
    expect(fact.version).toBe(variantVersion(spec));
    expect(fact.images).toEqual({ booli: 4, broker: 0 });
    expect(fact.confidence).toBe(1);
    expect(fact.source).toBe("planritning+foto");
    expect(layoutFactSchema.safeParse(fact).success).toBe(true);
  });

  it("gives a fact that believedLayout can judge", () => {
    const fact = factFromVariantRead(spec, read(), { booli: 4 });
    expect(believedLayout(fact, policy)).toEqual({ balconySide: "street", noBalcony: false, korsdrag: false, bedroomSide: "street" });
  });

  it("round-trips every variant through the runner into a fact the schema and the gate accept", async () => {
    for (const variant of Object.values(LAYOUT_VARIANTS)) {
      if (variant.steps !== 1) continue;
      const { call } = fakeCall(0.2, read());
      const out = await runVariantReads([item(1)], { variant, call, cache: emptyCache(variant), runCapSek: 5, today: "d" });
      const fact = out.reads[0].fact;
      expect(fact, variant.id).not.toBeNull();
      expect(layoutFactSchema.safeParse(fact).success).toBe(true);
      expect(() => believedLayout(fact, policy)).not.toThrow();
    }
  });
});
