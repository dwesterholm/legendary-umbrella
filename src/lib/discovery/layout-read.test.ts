// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import { layoutFactSchema } from "@/lib/discovery/layout-fact";
import {
  LAYOUT_CACHE_PATH,
  LAYOUT_EST_SEK_PER_FLAT,
  LAYOUT_LOGIC_REVISION,
  LAYOUT_MODEL,
  LAYOUT_READ_VERSION,
  LAYOUT_RUN_CAP_SEK,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_USER_INSTRUCTION,
  LayoutCallError,
  asBilledFailure,
  layoutFactFromRead,
  layoutImagesOf,
  layoutReadSchema,
  layoutReadVersion,
  layoutSpentSek,
  loadLayoutCache,
  runLayoutReads,
  saveLayoutCache,
  type LayoutCache,
  type LayoutCallFn,
  type LayoutRead,
  type LayoutReadItem,
} from "@/lib/discovery/layout-read";
import { VISION_SONNET_MODEL } from "@/lib/discovery/vision-prompt";

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
const broker = (n: number): BrokerImageBytes[] =>
  Array.from({ length: n }, (_, i) => ({ mediaType: "image/jpeg" as const, data: `bytes-${i}` }));
const emptyCache = (): LayoutCache => ({ version: 1, entries: {} });
const item = (id: number, over: Partial<LayoutReadItem> = {}): LayoutReadItem => ({
  listingPath: `/bostad/${id}`,
  imageUrls: [url(id * 10), url(id * 10 + 1), url(id * 10 + 2), url(id * 10 + 3)],
  brokerImages: [],
  ...over,
});

/** A fake model call: records every block list it is given, costs `cost` per call. */
function fakeCall(cost = 0.5, result: LayoutRead = read()) {
  const seen: number[] = [];
  const call: LayoutCallFn = async (blocks) => {
    seen.push(blocks.length);
    return { result, costSek: cost };
  };
  return { call, seen };
}

describe("layoutReadSchema (D-08, strict-output limits)", () => {
  const json = z.toJSONSchema(layoutReadSchema, { unrepresentable: "any" }) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  const FIELDS = [
    "balconySide",
    "bedroomOnBalconySide",
    "bedroomSide",
    "confidence",
    "kitchenOnBalconySide",
    "livingOnBalconySide",
    "streetEvidence",
    "windowSides",
  ];

  it("has exactly the eight D-08 fields, all required", () => {
    expect(Object.keys(json.properties).sort()).toEqual(FIELDS);
    expect([...json.required].sort()).toEqual(FIELDS);
  });

  it("has no union, no null type and no numeric constraint anywhere", () => {
    const text = JSON.stringify(json);
    for (const bad of ["anyOf", "oneOf", "allOf", '"null"', "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it("the enums are the D-08 value lists", () => {
    expect(layoutReadSchema.shape.balconySide.options).toEqual(["street", "courtyard", "none", "unknown"]);
    expect(layoutReadSchema.shape.windowSides.options).toEqual(["one", "twoOpposite", "corner", "unknown"]);
    expect(layoutReadSchema.shape.bedroomSide.options).toEqual(["street", "courtyard", "unknown"]);
    expect(layoutReadSchema.shape.streetEvidence.options).toEqual(["cars", "oppositeFacade", "courtyardGreenery", "none"]);
  });
});

describe("the prompt", () => {
  const texts = [LAYOUT_SYSTEM_PROMPT, LAYOUT_USER_INSTRUCTION, JSON.stringify(z.toJSONSchema(layoutReadSchema, { unrepresentable: "any" }))];

  it("never asks for a compass, a bearing, north or people (14.3: the door-arrow lesson, D-08)", () => {
    for (const t of texts) expect(t).not.toMatch(/kompass|väderstreck|norr|bäring|person|människ/i);
  });

  it("is Swedish, says the photos settle street versus courtyard, and tells the model not to guess", () => {
    expect(LAYOUT_SYSTEM_PROMPT).toMatch(/FOTONA/);
    expect(LAYOUT_SYSTEM_PROMPT).toMatch(/Gissa inte/);
    expect(LAYOUT_SYSTEM_PROMPT).toMatch(/Bild 1/);
  });

  it("uses the Sonnet deep-pass model of the vision module (D-07)", () => {
    expect(LAYOUT_MODEL).toBe(VISION_SONNET_MODEL);
  });
});

describe("layoutReadVersion", () => {
  const parts = {
    prompt: LAYOUT_SYSTEM_PROMPT,
    model: LAYOUT_MODEL,
    schema: z.toJSONSchema(layoutReadSchema, { unrepresentable: "any" }),
    revision: LAYOUT_LOGIC_REVISION,
  };

  it("changes with the prompt text, the model id, the schema and the revision", () => {
    const base = layoutReadVersion(parts);
    expect(layoutReadVersion({ ...parts, prompt: `${parts.prompt} x` })).not.toBe(base);
    expect(layoutReadVersion({ ...parts, model: "claude-other" })).not.toBe(base);
    expect(layoutReadVersion({ ...parts, schema: { type: "object" } })).not.toBe(base);
    expect(layoutReadVersion({ ...parts, revision: parts.revision + 1 })).not.toBe(base);
    expect(layoutReadVersion(parts)).toBe(base);
  });

  it("is 16 hex characters and the module exports one for its real parts", () => {
    expect(LAYOUT_READ_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the constants of R-07", () => {
  it("0,6 kr per flat estimated, 40 kr per run, the cache under the data dir", () => {
    expect(LAYOUT_EST_SEK_PER_FLAT).toBe(0.6);
    expect(LAYOUT_RUN_CAP_SEK).toBe(40);
    expect(LAYOUT_CACHE_PATH).toBe(".planning/calibration/data/layout-cache.json");
  });
});

describe("layoutImagesOf (R-07, T-14.4-22)", () => {
  const five = [1, 2, 3, 4, 5].map(url);

  it("sends the plan first, then 3 more Booli photos, then 3 broker photos: 7 blocks at most", () => {
    const out = layoutImagesOf(five, broker(4));
    expect(out.status).toBe("ok");
    expect(out.blocks).toHaveLength(7);
    expect(out.blocks.slice(0, 4).map((b) => (b.source.type === "url" ? b.source.url : "bytes"))).toEqual(five.slice(0, 4));
    expect(out.blocks.slice(4).every((b) => b.source.type === "base64")).toBe(true);
    expect(out.booli).toBe(4);
    expect(out.broker).toBe(3);
  });

  it("a flat with only the plan makes a one-image read", () => {
    const out = layoutImagesOf([url(1)], []);
    expect(out).toMatchObject({ status: "ok", booli: 1, broker: 0 });
    expect(out.blocks).toHaveLength(1);
  });

  it("a disallowed host as image 1 is no read at all", () => {
    const out = layoutImagesOf(["https://evil.example/plan.png", url(2)], broker(1));
    expect(out).toEqual({ blocks: [], status: "host", booli: 0, broker: 0 });
  });

  it("a disallowed later photo is skipped and the next allowed one takes its place", () => {
    const out = layoutImagesOf([url(1), "https://evil.example/x.png", url(3)], []);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks.map((b) => (b.source.type === "url" ? b.source.url : ""))).toEqual([url(1), url(3)]);
  });

  it("no URLs is no plan", () => {
    expect(layoutImagesOf([], broker(2))).toEqual({ blocks: [], status: "no_plan", booli: 0, broker: 0 });
    expect(layoutImagesOf(null, null).status).toBe("no_plan");
  });

  it("a plan given as bytes goes first and every URL is a photo", () => {
    const plan: BrokerImageBytes = { mediaType: "image/png", data: "plan" };
    const out = layoutImagesOf([], [], { planImage: plan });
    expect(out.status).toBe("ok");
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].source).toEqual({ type: "base64", media_type: "image/png", data: "plan" });
  });
});

describe("runLayoutReads: the cache", () => {
  it("a cache hit makes no call and costs nothing; two runs with the same inputs make 1 call in total", async () => {
    const { call, seen } = fakeCall();
    const first = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "2026-10-13" });
    expect(first.calls).toBe(1);
    expect(first.reads[0].status).toBe("read");
    const second = await runLayoutReads([item(1)], { call, cache: first.cacheNext, runCapSek: 40, today: "2026-10-20" });
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.spentSek).toBe(0);
    expect(second.reads[0]).toMatchObject({ status: "cache", costSek: 0 });
    expect(second.reads[0].result).toEqual(read());
    expect(seen).toHaveLength(1);
  });

  it("the broker photos are keyed by count: a swapped photo with the same count is a hit, one more photo is a miss", async () => {
    const { call, seen } = fakeCall();
    const a = await runLayoutReads([item(1, { brokerImages: broker(2) })], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const swapped = [{ mediaType: "image/jpeg" as const, data: "other-0" }, { mediaType: "image/jpeg" as const, data: "other-1" }];
    const b = await runLayoutReads([item(1, { brokerImages: swapped })], { call, cache: a.cacheNext, runCapSek: 40, today: "d" });
    expect(b.cacheHits).toBe(1);
    const c = await runLayoutReads([item(1, { brokerImages: broker(3) })], { call, cache: a.cacheNext, runCapSek: 40, today: "d" });
    expect(c.calls).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it("the Booli URL forms /annons/<n> and /bostad/<n> share one entry", async () => {
    const { call, seen } = fakeCall();
    const a = await runLayoutReads([item(7, { listingPath: "/annons/7" })], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const b = await runLayoutReads([item(7, { listingPath: "/bostad/7" })], { call, cache: a.cacheNext, runCapSek: 40, today: "d" });
    expect(b.cacheHits).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("never treats an entry of another version as a hit, and drops it from the next cache", async () => {
    const { call } = fakeCall();
    const a = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const aged: LayoutCache = {
      ...a.cacheNext,
      entries: Object.fromEntries(Object.entries(a.cacheNext.entries).map(([k, e]) => [k, { ...e, promptVersion: "old-version" }])),
    };
    const b = await runLayoutReads([item(2)], { call, cache: aged, runCapSek: 40, today: "d" });
    expect(b.cacheHits).toBe(0);
    expect(Object.values(b.cacheNext.entries).every((e) => e.promptVersion === LAYOUT_READ_VERSION)).toBe(true);
    expect(Object.keys(b.cacheNext.entries)).toHaveLength(1);
    const c = await runLayoutReads([item(1)], { call, cache: aged, runCapSek: 40, today: "d" });
    expect(c.calls).toBe(1);
  });

  it("stores only the eight read fields, never a picture", async () => {
    const { call } = fakeCall();
    const out = await runLayoutReads([item(1, { brokerImages: broker(2) })], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const text = JSON.stringify(out.cacheNext);
    expect(text).not.toContain("bytes-0");
    expect(text).not.toContain("https://");
  });
});

describe("runLayoutReads: the per-run cap and the lifetime ledger (R-07)", () => {
  it("stops before a call that would pass the run cap (equal is allowed)", async () => {
    const { call, seen } = fakeCall(0.5);
    // cap 1,2 with estimate 0,6: two calls fit (1,2 is allowed), a third would pass
    const out = await runLayoutReads([item(1), item(2), item(3)], {
      call,
      cache: emptyCache(),
      runCapSek: 1.2,
      today: "d",
      estSekPerFlat: 0.6,
    });
    // real cost 0,5 per call: after two calls spent = 1.0, 1.0 + 0.6 > 1.2 -> third is cost_cap
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read", "cost_cap"]);
    expect(seen).toHaveLength(2);
    expect(out.spentSek).toBeCloseTo(1.0, 10);
  });

  it("lets a run reach exactly the cap", async () => {
    const { call } = fakeCall(0.6);
    const out = await runLayoutReads([item(1), item(2), item(3)], { call, cache: emptyCache(), runCapSek: 1.2, today: "d" });
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read", "cost_cap"]);
  });

  it("the default per-run cap is 40 kr: 66 flats at 0,6 fit, the 67th does not", async () => {
    const { call } = fakeCall(0.6);
    const items = Array.from({ length: 70 }, (_, i) => item(i + 1));
    const out = await runLayoutReads(items, { call, cache: emptyCache(), runCapSek: LAYOUT_RUN_CAP_SEK, today: "d" });
    expect(out.calls).toBe(66);
    expect(out.reads.filter((r) => r.status === "cost_cap")).toHaveLength(4);
    expect(out.spentSek).toBeLessThanOrEqual(40 + 1e-9);
  });

  it("the lifetime ledger grows across runs but never blocks a new run", async () => {
    const { call } = fakeCall(0.6);
    const heavy: LayoutCache = { version: 1, entries: {}, spentSekTotal: 500 };
    const out = await runLayoutReads([item(1)], { call, cache: heavy, runCapSek: 40, today: "d" });
    expect(out.reads[0].status).toBe("read");
    expect(out.totalSpentSek).toBeCloseTo(500.6, 10);
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(500.6, 10);
    const again = await runLayoutReads([item(2)], { call, cache: out.cacheNext, runCapSek: 40, today: "d" });
    expect(again.reads[0].status).toBe("read");
    expect(again.totalSpentSek).toBeCloseTo(501.2, 10);
  });

  it("reads a cache without the total as the sum of its stored reads", async () => {
    const { call } = fakeCall(0.5);
    const a = await runLayoutReads([item(1), item(2)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const withoutTotal: LayoutCache = { version: 1, entries: a.cacheNext.entries };
    expect(layoutSpentSek(withoutTotal)).toBeCloseTo(1.0, 10);
  });

  it("keeps the money of dropped reads (another version) in the total", async () => {
    const { call } = fakeCall(0.5);
    const a = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const aged: LayoutCache = {
      ...a.cacheNext,
      entries: Object.fromEntries(Object.entries(a.cacheNext.entries).map(([k, e]) => [k, { ...e, promptVersion: "old" }])),
    };
    const b = await runLayoutReads([], { call, cache: aged, runCapSek: 40, today: "d" });
    expect(Object.keys(b.cacheNext.entries)).toHaveLength(0);
    expect(b.cacheNext.spentSekTotal).toBeCloseTo(0.5, 10);
  });

  it("makes no call under a NaN cap", async () => {
    const { call, seen } = fakeCall();
    const out = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: Number.NaN, today: "d" });
    expect(out.reads[0].status).toBe("cost_cap");
    expect(seen).toHaveLength(0);
  });

  it("serves a cached flat even when the cap is zero", async () => {
    const { call } = fakeCall();
    const a = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    const b = await runLayoutReads([item(1)], { call, cache: a.cacheNext, runCapSek: 0, today: "d" });
    expect(b.reads[0].status).toBe("cache");
  });
});

describe("runLayoutReads: failures, hosts and the cost of a bad answer", () => {
  it("a LayoutCallError bills what Anthropic charged and marks the flat failed with the code only", async () => {
    const call: LayoutCallFn = async () => {
      throw new LayoutCallError("CLAUDE_MAX_TOKENS", 0.31);
    };
    const out = await runLayoutReads([item(1), item(2)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    expect(out.reads.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(out.reads[0]).toMatchObject({ costSek: 0.31, errorCode: "CLAUDE_MAX_TOKENS" });
    expect(out.spentSek).toBeCloseTo(0.62, 10);
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(0.62, 10);
    expect(Object.keys(out.cacheNext.entries)).toHaveLength(0);
  });

  it("a plain throw is failed with the error name only and the run goes on", async () => {
    let n = 0;
    const call: LayoutCallFn = async () => {
      n += 1;
      if (n === 1) throw new TypeError("secret detail https://x");
      return { result: read(), costSek: 0.4 };
    };
    const out = await runLayoutReads([item(1), item(2)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    expect(out.reads[0]).toMatchObject({ status: "failed", errorCode: "TypeError", costSek: 0 });
    expect(JSON.stringify(out.reads[0])).not.toContain("secret");
    expect(out.reads[1].status).toBe("read");
  });

  it("a non-finite or zero cost is counted at the estimate, never as free or NaN", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const { call } = fakeCall(bad);
      const out = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
      expect(out.spentSek).toBeCloseTo(LAYOUT_EST_SEK_PER_FLAT, 10);
      expect(out.totalSpentSek).toBeCloseTo(LAYOUT_EST_SEK_PER_FLAT, 10);
    }
  });

  it("a parse failure (answer arrived, output unusable) is billed at the estimate through asBilledFailure", async () => {
    const call: LayoutCallFn = async () => {
      throw asBilledFailure(new SyntaxError("bad json"), () => false, LAYOUT_EST_SEK_PER_FLAT);
    };
    const out = await runLayoutReads([item(1)], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    expect(out.reads[0]).toMatchObject({ status: "failed", errorCode: "CLAUDE_PARSE_FAILED" });
    expect(out.spentSek).toBeCloseTo(0.6, 10);
  });

  it("asBilledFailure passes a LayoutCallError through unchanged", () => {
    const e = new LayoutCallError("CLAUDE_REFUSAL", 0.2);
    expect(asBilledFailure(e, () => false)).toBe(e);
    expect(e.name).toBe("LayoutCallError");
  });

  it("skips a disallowed image 1 as 'host' and never hands it to the call; no URL is 'no_plan'", async () => {
    const { call, seen } = fakeCall();
    const out = await runLayoutReads(
      [item(1, { imageUrls: ["https://evil.example/plan.png"] }), item(2, { imageUrls: [] })],
      { call, cache: emptyCache(), runCapSek: 40, today: "d" },
    );
    expect(out.reads.map((r) => r.status)).toEqual(["host", "no_plan"]);
    expect(seen).toHaveLength(0);
    expect(out.spentSek).toBe(0);
  });

  it("hands the call the plan first and at most 7 blocks", async () => {
    const { call, seen } = fakeCall();
    await runLayoutReads(
      [item(1, { imageUrls: [1, 2, 3, 4, 5, 6].map(url), brokerImages: broker(5) })],
      { call, cache: emptyCache(), runCapSek: 40, today: "d" },
    );
    expect(seen).toEqual([7]);
  });

  it("reports how many pictures each read saw", async () => {
    const { call } = fakeCall();
    const out = await runLayoutReads([item(1, { brokerImages: broker(2) })], { call, cache: emptyCache(), runCapSek: 40, today: "d" });
    expect(out.reads[0].images).toEqual({ booli: 4, broker: 2 });
  });
});

describe("layoutFactFromRead", () => {
  it("returns a value layoutFactSchema accepts, with the meta and the display source", () => {
    const fact = layoutFactFromRead(read(), { version: LAYOUT_READ_VERSION, booli: 4, broker: 3 });
    expect(layoutFactSchema.safeParse(fact).success).toBe(true);
    expect(fact).toMatchObject({ source: "planritning+foto", version: LAYOUT_READ_VERSION, images: { booli: 4, broker: 3 }, balconySide: "street" });
  });

  it("clamps the confidence to [0, 1] for storage and stores a non-finite one as 0", () => {
    const meta = { version: "v", booli: 1, broker: 0 };
    expect(layoutFactFromRead(read({ confidence: 1.7 }), meta).confidence).toBe(1);
    expect(layoutFactFromRead(read({ confidence: -0.2 }), meta).confidence).toBe(0);
    expect(layoutFactFromRead(read({ confidence: Number.NaN }), meta).confidence).toBe(0);
    for (const c of [1.7, -0.2, Number.NaN]) {
      expect(layoutFactSchema.safeParse(layoutFactFromRead(read({ confidence: c }), meta)).success).toBe(true);
    }
  });
});

describe("loadLayoutCache / saveLayoutCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "layout-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing file is an empty cache with no warning", () => {
    const out = loadLayoutCache(join(dir, "none.json"));
    expect(out.cache).toEqual(emptyCache());
    expect(out.warning).toBeNull();
  });

  it("an unreadable file is read as empty, warns and is renamed to <path>.bak-<stamp>", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    const out = loadLayoutCache(p, { now: () => Date.UTC(2026, 9, 13) });
    expect(out.cache).toEqual(emptyCache());
    expect(out.warning).toMatch(/Layoutcachen/);
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("bad.json.bak-"))).toBe(true);
    expect(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("bad.json.bak-")) as string), "utf-8")).toBe("{ not json");
  });

  it("a file with the wrong shape is read as empty too", () => {
    const p = join(dir, "shape.json");
    writeFileSync(p, JSON.stringify({ version: 1, entries: { a: { id: 5 } } }));
    expect(loadLayoutCache(p).warning).not.toBeNull();
  });

  it("saves atomically inside the dir and loads the same cache back, ledger included", () => {
    const p = join(dir, "ok.json");
    const cache: LayoutCache = {
      version: 1,
      entries: { k: { id: "k", promptVersion: LAYOUT_READ_VERSION, storedAt: "2026-10-13", costSek: 0.4, result: read() } },
      spentSekTotal: 0.37,
    };
    saveLayoutCache(p, cache, { dir });
    expect(loadLayoutCache(p).cache).toEqual(cache);
  });

  it("refuses to save outside .planning/calibration/data/", () => {
    expect(() => saveLayoutCache(join(dir, "x.json"), emptyCache())).toThrow(/får bara skrivas/);
    expect(() => saveLayoutCache("/tmp/layout-cache.json", emptyCache())).toThrow();
  });
});

describe("structural separation", () => {
  it("layout-read.ts imports no SDK and no scoring module", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/discovery/layout-read.ts"), "utf-8");
    expect(source).not.toMatch(/from "@anthropic-ai\/sdk/);
    expect(source).not.toMatch(/from "@\/lib\/discovery\/(niche-score|fit-score|taste)"/);
    expect(source).not.toMatch(/process\.env/);
  });
});
