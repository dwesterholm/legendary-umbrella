// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import { believedLayout, layoutFactSchema, type LayoutGatePolicy } from "@/lib/discovery/layout-fact";
import type { AccuracyReport, FieldReport, Precision } from "@/lib/discovery/layout-accuracy";
import { wilson } from "@/lib/discovery/layout-accuracy";
import Anthropic from "@anthropic-ai/sdk";
import { makeTwoStepLayoutCall } from "@/lib/discovery/layout-call";
import { layoutCallCostSek } from "@/lib/discovery/layout-cost";
import {
  LAYOUT_ROUND_CAP_SEK,
  LAYOUT_SMOKE_CAP_SEK,
  LAYOUT_VARIANTS,
  combineTwoStep,
  decideRounds,
  factFromVariantRead,
  layoutVariantCachePath,
  loadVariantCache,
  pickTwoStepTier,
  renderRoundsMd,
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
  LAYOUT_OPUS_MODEL,
  LAYOUT_READ_VERSION,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_STEP_A_SYSTEM_PROMPT,
  LAYOUT_STEP_B_SYSTEM_PROMPT,
  LAYOUT_SYSTEM_PROMPT_V2,
  LAYOUT_USER_INSTRUCTION,
  LAYOUT_USER_INSTRUCTION_V2,
  LayoutCallError,
  layoutReadSchema,
  layoutReadSchemaV2,
  layoutStepASchema,
  layoutStepBSchema,
  type LayoutStepA,
  type LayoutStepB,
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
      const { call } = fakeCall(0.2, variant.schema === layoutReadSchema ? read() : readV2());
      const out = await runVariantReads([item(1)], { variant, call, cache: emptyCache(variant), runCapSek: 5, today: "d" });
      const fact = out.reads[0].fact;
      expect(fact, variant.id).not.toBeNull();
      expect(layoutFactSchema.safeParse(fact).success).toBe(true);
      expect(() => believedLayout(fact, policy)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Variants b and c (Phase 14.5 plan 05 task 2)
// ---------------------------------------------------------------------------

const readV2 = (over: Record<string, unknown> = {}) => ({
  ...read(),
  planPresent: true,
  balconyConfidence: 0.8,
  windowsConfidence: 0.9,
  bedroomConfidence: 0.5,
  ...over,
});

describe("variants b and c", () => {
  const b = LAYOUT_VARIANTS.b;
  const c = LAYOUT_VARIANTS.c;

  it("b is the reworked prompt on Sonnet with per-field certainty", () => {
    expect(b.model).toBe(LAYOUT_MODEL);
    expect(b.systemPrompt).toBe(LAYOUT_SYSTEM_PROMPT_V2);
    expect(b.userInstruction).toBe(LAYOUT_USER_INSTRUCTION_V2);
    expect(b.schema).toBe(layoutReadSchemaV2);
    expect(b.temperature).toBe(0);
    expect(b.effort).toBeNull();
    expect(b.maxTokens).toBe(600);
    expect(b.steps).toBe(1);
    expect(b.estSekPerFlat).toBe(0.4);
  });

  it("c is the same prompt and schema on the Opus tier: no temperature, effort low, 4000 tokens", () => {
    expect(c.model).toBe(LAYOUT_OPUS_MODEL);
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.systemPrompt).toBe(b.systemPrompt);
    expect(c.userInstruction).toBe(b.userInstruction);
    expect(c.schema).toBe(b.schema);
    expect(c.temperature).toBeNull();
    expect(c.effort).toBe("low");
    expect(c.maxTokens).toBe(4000);
    expect(c.estSekPerFlat).toBe(1.0);
  });

  it("the versions of a, b and c are pairwise different", () => {
    const [va, vb, vc] = [LAYOUT_VARIANTS.a, b, c].map(variantVersion);
    expect(new Set([va, vb, vc]).size).toBe(3);
  });

  it("every variant uses the Booli pictures only", () => {
    for (const v of Object.values(LAYOUT_VARIANTS)) expect(v.images.maxBrokerPhotos).toBe(0);
  });

  it("factFromVariantRead fills fieldConfidence (clamped) and planPresent from a V2 answer", () => {
    const fact = factFromVariantRead(b, readV2({ balconyConfidence: 1.7, windowsConfidence: -0.2, bedroomConfidence: 0.4, planPresent: false }), { booli: 4 });
    expect(fact.fieldConfidence).toEqual({ balcony: 1, windows: 0, bedroom: 0.4 });
    expect(fact.planPresent).toBe(false);
    expect(fact.version).toBe(variantVersion(b));
    expect(layoutFactSchema.safeParse(fact).success).toBe(true);
  });

  it("a V2 fact with planPresent false is not believed by believedLayout", () => {
    const policy: LayoutGatePolicy = { balconyGate: 0, windowsGate: 0, bedroomGate: 0, negativeGate: 0, sideEvidence: ["cars"], trustedVersion: null };
    const fact = factFromVariantRead(b, readV2({ planPresent: false }), { booli: 4 });
    expect(believedLayout(fact, policy)).toEqual({ balconySide: null, noBalcony: false, korsdrag: null, bedroomSide: null });
  });

  it("a V2 answer missing its certainties does not fit variant b's schema", () => {
    expect(() => factFromVariantRead(b, read(), { booli: 4 })).toThrow();
  });

  it("a variant a answer carries neither fieldConfidence nor planPresent", () => {
    const fact = factFromVariantRead(LAYOUT_VARIANTS.a, read(), { booli: 4 });
    expect(fact.fieldConfidence).toBeUndefined();
    expect(fact.planPresent).toBeUndefined();
  });

  it("b and c run through the runner on their own caches and cost what their call says", async () => {
    for (const variant of [b, c]) {
      const { call } = fakeCall(variant.estSekPerFlat, readV2());
      const out = await runVariantReads([item(1)], { variant, call, cache: emptyCache(variant), runCapSek: 5, today: "d" });
      expect(out.reads[0].status).toBe("read");
      expect(out.reads[0].fact?.fieldConfidence).toEqual({ balcony: 0.8, windows: 0.9, bedroom: 0.5 });
      expect(out.cacheNext.variantId).toBe(variant.id);
      expect(out.cacheNext.variantVersion).toBe(variantVersion(variant));
    }
  });

  it("a cache of variant b never answers for variant c: the ids carry the variant version", () => {
    expect(variantReadId(b, item(1))).not.toBe(variantReadId(c, item(1)));
  });
});

// ---------------------------------------------------------------------------
// The rounds
// ---------------------------------------------------------------------------

const precision = (k: number, n: number): Precision => ({ k, n, precision: n === 0 ? null : k / n, ...wilson(k, n) });

/** A hand-written report: each field has a dev precision, a holdout precision and a verdict. */
function fakeReport(
  source: string,
  fields: { balcony: [number, number, number, number, boolean]; korsdrag: [number, number, number, number, boolean]; bedroom: [number, number, number, number, boolean] },
  measurable = true,
): AccuracyReport {
  const fieldReport = ([devK, devN, holdK, holdN, pass]: [number, number, number, number, boolean]): FieldReport => ({
    measurable,
    decidedRows: measurable ? 20 : 5,
    curveDev: [],
    gate: devN > 0 ? 0.7 : null,
    dev: devN > 0 ? precision(devK, devN) : null,
    holdout: holdN > 0 ? precision(holdK, holdN) : null,
    pooled: null,
    allCalls: null,
    pass,
    reason: pass ? null : `holdout-precisionen ${holdK} av ${holdN} är under 75 %`,
  });
  const f = { balcony: fieldReport(fields.balcony), korsdrag: fieldReport(fields.korsdrag), bedroom: fieldReport(fields.bedroom) };
  const m = { measurable, decided: measurable ? 20 : 5, reason: measurable ? null : "ej mätbart (n = 5)" };
  return {
    source,
    version: "0123456789abcdef",
    truthLocked: true,
    lockedAt: "2026-10-19T00:00:00Z",
    rows: 30,
    noRead: 0,
    raw: {} as AccuracyReport["raw"],
    measurability: { balcony: m, korsdrag: m, bedroom: m },
    sideEvidence: ["cars", "courtyardGreenery"],
    byEvidence: { dev: [], holdout: [] },
    fields: f,
    livingOnBalconySide: { decided: 0, read: 0, correct: 0 },
    pass: f.balcony.pass && f.korsdrag.pass && f.bedroom.pass,
  };
}

const failing = (devRate: number) =>
  fakeReport("variant:x", {
    balcony: [Math.round(devRate * 10), 10, 4, 10, false],
    korsdrag: [Math.round(devRate * 10), 10, 4, 10, false],
    bedroom: [Math.round(devRate * 10), 10, 4, 10, false],
  });
const passing = () =>
  fakeReport("variant:x", { balcony: [9, 10, 9, 10, true], korsdrag: [9, 10, 8, 10, true], bedroom: [9, 10, 9, 10, true] });

describe("pickTwoStepTier", () => {
  it("picks Opus only when the Opus variant has the higher mean dev precision", () => {
    expect(pickTwoStepTier(failing(0.5), failing(0.8))).toBe("opus");
    expect(pickTwoStepTier(failing(0.8), failing(0.5))).toBe("sonnet");
  });

  it("picks Sonnet, the cheaper, on a tie or on missing data", () => {
    expect(pickTwoStepTier(failing(0.6), failing(0.6))).toBe("sonnet");
    expect(pickTwoStepTier(undefined, failing(0.9))).toBe("sonnet");
    expect(pickTwoStepTier(failing(0.4), undefined)).toBe("sonnet");
    expect(pickTwoStepTier(null, null)).toBe("sonnet");
  });

  it("counts a field with no believed dev answer as 0 and ignores a field that is not measurable", () => {
    const noGate = fakeReport("variant:c", { balcony: [0, 0, 0, 0, false], korsdrag: [9, 10, 4, 10, false], bedroom: [9, 10, 4, 10, false] });
    expect(pickTwoStepTier(failing(0.7), noGate)).toBe("sonnet");
    const unmeasurable = fakeReport("variant:c", { balcony: [9, 10, 4, 10, false], korsdrag: [9, 10, 4, 10, false], bedroom: [9, 10, 4, 10, false] }, false);
    expect(pickTwoStepTier(failing(0.7), unmeasurable)).toBe("sonnet");
  });
});

describe("decideRounds (D-10)", () => {
  it("with no report yet, names a as next and stops nothing", () => {
    const d = decideRounds({}, {});
    expect(d.winner).toBeNull();
    expect(d.stop).toBe(false);
    expect(d.next).toBe("a");
    expect(d.rounds.map((r) => [r.slot, r.variant, r.status])).toEqual([
      ["a", "a", "not_run"],
      ["b", "b", "not_run"],
      ["c", "c", "not_run"],
      ["d", "d-sonnet", "not_run"],
    ]);
    expect(d.totalSpentSek).toBe(0);
  });

  it("a failing a leaves b as next", () => {
    const d = decideRounds({ a: failing(0.5) }, { a: 7 });
    expect(d.winner).toBeNull();
    expect(d.next).toBe("b");
    expect(d.rounds[0].status).toBe("run");
    expect(d.rounds[0].pass).toBe(false);
    expect(d.rounds[0].spentSek).toBe(7);
  });

  it("stops at the first passing variant and skips the rest", () => {
    const d = decideRounds({ a: failing(0.5), b: passing() }, { a: 6, b: 8.5 });
    expect(d.winner).toBe("b");
    expect(d.stop).toBe(true);
    expect(d.next).toBeNull();
    expect(d.rounds.map((r) => r.status)).toEqual(["run", "run", "skipped", "skipped"]);
    expect(d.totalSpentSek).toBeCloseTo(14.5, 10);
  });

  it("the first passing variant in the fixed order wins even when a later one also passes", () => {
    const d = decideRounds({ c: passing(), b: passing(), a: failing(0.4) }, {});
    expect(d.winner).toBe("b");
  });

  it("never chooses a failing variant: a field that fails makes the whole variant fail", () => {
    const partly = fakeReport("variant:b", { balcony: [9, 10, 9, 10, true], korsdrag: [9, 10, 9, 10, true], bedroom: [9, 10, 5, 10, false] });
    const d = decideRounds({ a: failing(0.5), b: partly, c: failing(0.6) }, {});
    expect(d.winner).toBeNull();
    expect(d.next).toBe("d-sonnet");
    expect(d.tierForD).toBe("sonnet");
  });

  it("slot d is the two-step variant that has a report, and its tier follows the rule when none has", () => {
    const d1 = decideRounds({ a: failing(0.4), b: failing(0.5), c: failing(0.8) }, {});
    expect(d1.tierForD).toBe("opus");
    expect(d1.next).toBe("d-opus");
    const d2 = decideRounds({ a: failing(0.4), b: failing(0.5), c: failing(0.8), "d-sonnet": passing() }, { "d-sonnet": 9 });
    expect(d2.winner).toBe("d-sonnet");
    expect(d2.rounds[3].variant).toBe("d-sonnet");
    expect(d2.rounds[3].spentSek).toBe(9);
    expect(d2.next).toBeNull();
  });

  it("totals the spend of all variants, smokes included, ignoring a bad number", () => {
    const d = decideRounds({}, { a: 1.5, b: 2, "d-opus": 3, c: Number.NaN, x: -4 });
    expect(d.totalSpentSek).toBeCloseTo(6.5, 10);
  });

  it("records the best holdout precision per field with its variant and the reason it failed", () => {
    const a = fakeReport("variant:a", { balcony: [6, 10, 4, 10, false], korsdrag: [7, 10, 6, 10, false], bedroom: [0, 0, 0, 0, false] });
    const b = fakeReport("variant:b", { balcony: [8, 10, 7, 10, false], korsdrag: [7, 10, 6, 8, false], bedroom: [0, 0, 0, 0, false] });
    const d = decideRounds({ a, b }, {});
    expect(d.bestByField.balcony?.variant).toBe("b");
    expect(d.bestByField.balcony?.holdout.k).toBe(7);
    expect(d.bestByField.korsdrag?.variant).toBe("b");
    expect(d.bestByField.bedroom).toBeNull();
    expect(d.bestByField.balcony?.reason).toMatch(/under 75 %/);
  });
});

describe("renderRoundsMd", () => {
  it("writes one row per variant in the fixed order and a Swedish verdict with the winner", () => {
    const md = renderRoundsMd(decideRounds({ a: failing(0.5), b: passing() }, { a: 6, b: 8.5 }));
    const rows = md.split("\n").filter((l) => /^\| (a|b|c|d-sonnet|d-opus) \|/.test(l));
    expect(rows.map((l) => l.split(" | ")[0].replace("| ", ""))).toEqual(["a", "b", "c", "d-sonnet"]);
    expect(rows[2]).toContain("hoppas över: stoppregeln, vinnare b");
    expect(md).toContain("Vinnare: b");
    expect(md).toContain("Total kostnad för alla varianter: 14,50 kr.");
  });

  it("says Vinnare: ingen, names the best holdout per field with its interval and count, and the failed rule", () => {
    const a = fakeReport("variant:a", { balcony: [6, 10, 6, 10, false], korsdrag: [7, 10, 6, 10, false], bedroom: [0, 0, 0, 0, false] });
    const md = renderRoundsMd(decideRounds({ a }, { a: 5 }));
    expect(md).toContain("Vinnare: ingen");
    expect(md).toMatch(/Balkongsida: bästa holdout-precision 6 av 10 \(60 %, 95 %: \d+–\d+ %\) med 10 trodda svar, variant a; regeln som brast: holdout-precisionen 6 av 10/);
    expect(md).toMatch(/Korsdrag: bästa holdout-precision 6 av 10/);
    expect(md).toMatch(/Sovrumssida: ingen variant gav någon holdout-precision/);
    expect(md).toContain("nästa att köra");
  });

  it("is plain Swedish with no model-tuning words, and ends with a newline", () => {
    const md = renderRoundsMd(decideRounds({}, {}));
    expect(md.endsWith("\n")).toBe(true);
    expect(md).toContain("Vinnare: ingen");
    expect(md).toContain("inte körd ännu");
  });
});

describe("runVariantReads: checkpoint and the smoke estimate", () => {
  it("hands the cache so far to the checkpoint after every paid call, so nothing already paid for is lost", async () => {
    const snapshots: VariantCache[] = [];
    let n = 0;
    const call: VariantCallFn = async () => {
      n += 1;
      if (n === 2) throw new FloorPlanCallError("CLAUDE_REFUSAL", 0.3);
      return { result: read(), costSek: 0.2 };
    };
    const out = await runVariantReads([item(1), item(2), item(3)], {
      variant: spec,
      call,
      cache: emptyCache(),
      runCapSek: 5,
      today: "d",
      checkpoint: (c) => snapshots.push(JSON.parse(JSON.stringify(c)) as VariantCache),
    });
    expect(snapshots).toHaveLength(3);
    expect(Object.keys(snapshots[0].entries)).toHaveLength(1);
    expect(snapshots[0].spentSekTotal).toBeCloseTo(0.2, 10);
    expect(Object.keys(snapshots[1].entries)).toHaveLength(1);
    expect(snapshots[1].spentSekTotal).toBeCloseTo(0.5, 10);
    expect(snapshots[2]).toEqual(out.cacheNext);
  });

  it("does not checkpoint a cache hit or a skipped item", async () => {
    const { call } = fakeCall();
    const first = await runVariantReads([item(1)], { variant: spec, call, cache: emptyCache(), runCapSek: 5, today: "d" });
    let checkpoints = 0;
    await runVariantReads([item(1), item(2, { imageUrls: [] })], {
      variant: spec,
      call,
      cache: first.cacheNext,
      runCapSek: 5,
      today: "d",
      checkpoint: () => {
        checkpoints += 1;
      },
    });
    expect(checkpoints).toBe(0);
  });

  it("uses an estimate passed in for the cap test instead of the spec's", async () => {
    const { call } = fakeCall(0.3, readV2());
    const c = LAYOUT_VARIANTS.c;
    const strict = await runVariantReads([item(1), item(2)], { variant: c, call, cache: emptyCache(c), runCapSek: 1, today: "d" });
    expect(strict.reads.map((r) => r.status)).toEqual(["read", "cost_cap"]);
    const lowered = await runVariantReads([item(1), item(2)], { variant: c, call, cache: emptyCache(c), runCapSek: 1, today: "d", estSekPerFlat: 0.45 });
    expect(lowered.reads.map((r) => r.status)).toEqual(["read", "read"]);
  });
});

// ---------------------------------------------------------------------------
// Variant d: the two-step combination, one test per row of the truth table
// ---------------------------------------------------------------------------

type Pic = LayoutStepB["pictures"][number];
const stepA = (over: Partial<LayoutStepA> = {}): LayoutStepA => ({
  planPresent: true,
  balconyWall: "unknown",
  livingWall: "unknown",
  bedroomWall: "unknown",
  windowTop: false,
  windowBottom: false,
  windowLeft: false,
  windowRight: false,
  confidence: 0.9,
  ...over,
});
const pic = (over: Partial<Pic> = {}): Pic => ({ index: 1, takenFrom: "other", outside: "unknown", evidence: "none", ...over });
const stepB = (pictures: Pic[], confidence = 0.8): LayoutStepB => ({ pictures, confidence });

describe("combineTwoStep: balconySide", () => {
  it("balconyWall none gives balconySide none, whatever the photos say", () => {
    const out = combineTwoStep(stepA({ balconyWall: "none" }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })]));
    expect(out.balconySide).toBe("none");
    expect(out.livingOnBalconySide).toBe(false);
  });

  it("the first balcony photo with a known outside decides", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "top" }),
      stepB([
        pic({ index: 1, takenFrom: "balcony", outside: "unknown" }),
        pic({ index: 2, takenFrom: "balcony", outside: "courtyard", evidence: "courtyardGreenery" }),
        pic({ index: 3, takenFrom: "balcony", outside: "street", evidence: "cars" }),
      ]),
    );
    expect(out.balconySide).toBe("courtyard");
    expect(out.streetEvidence).toBe("courtyardGreenery");
  });

  it("a balcony photo decides even when the plan names no balcony wall", () => {
    const out = combineTwoStep(stepA({ balconyWall: "unknown" }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })]));
    expect(out.balconySide).toBe("street");
  });

  it("a living-room photo decides when the living room is on the balcony wall", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "left", livingWall: "left" }),
      stepB([pic({ takenFrom: "living", outside: "street", evidence: "cars" })]),
    );
    expect(out.balconySide).toBe("street");
    expect(out.streetEvidence).toBe("cars");
  });

  it("a living-room photo is ignored when the living room is on another wall", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "left", livingWall: "right" }),
      stepB([pic({ takenFrom: "living", outside: "street", evidence: "cars" })]),
    );
    expect(out.balconySide).toBe("unknown");
    expect(out.streetEvidence).toBe("none");
  });

  it("a balcony photo wins over a living-room photo", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "left", livingWall: "left" }),
      stepB([pic({ takenFrom: "living", outside: "street", evidence: "cars" }), pic({ index: 2, takenFrom: "balcony", outside: "courtyard", evidence: "courtyardGreenery" })]),
    );
    expect(out.balconySide).toBe("courtyard");
  });

  it("is unknown when no photo settles it, and when there are no photos at all", () => {
    expect(combineTwoStep(stepA({ balconyWall: "top" }), stepB([pic({ takenFrom: "kitchen", outside: "street" })])).balconySide).toBe("unknown");
    expect(combineTwoStep(stepA({ balconyWall: "top" }), stepB([])).balconySide).toBe("unknown");
    expect(combineTwoStep(stepA({ balconyWall: "top", livingWall: "top" }), null).balconySide).toBe("unknown");
  });

  it("with no photos a plan that shows no balcony still says none", () => {
    expect(combineTwoStep(stepA({ balconyWall: "none" }), null).balconySide).toBe("none");
  });
});

describe("combineTwoStep: bedroomSide", () => {
  it("a bedroom photo with a known outside decides, even over the inference from the balcony", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "top", bedroomWall: "top" }),
      stepB([
        pic({ takenFrom: "balcony", outside: "street", evidence: "cars" }),
        pic({ index: 2, takenFrom: "bedroom", outside: "courtyard", evidence: "courtyardGreenery" }),
      ]),
    );
    expect(out.bedroomSide).toBe("courtyard");
  });

  it("a bedroom photo with an unknown outside does not decide", () => {
    const out = combineTwoStep(
      stepA({ balconyWall: "top", bedroomWall: "top" }),
      stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" }), pic({ index: 2, takenFrom: "bedroom", outside: "unknown" })]),
    );
    expect(out.bedroomSide).toBe("street");
  });

  it("with no bedroom photo the bedroom is on the balcony side when bedroomWall equals balconyWall", () => {
    const out = combineTwoStep(stepA({ balconyWall: "left", bedroomWall: "left" }), stepB([pic({ takenFrom: "balcony", outside: "courtyard", evidence: "courtyardGreenery" })]));
    expect(out.bedroomSide).toBe("courtyard");
    expect(out.bedroomOnBalconySide).toBe(true);
  });

  it("is the other side when bedroomWall is the wall opposite the balcony, top against bottom and left against right", () => {
    const street = pic({ takenFrom: "balcony", outside: "street", evidence: "cars" });
    const courtyard = pic({ takenFrom: "balcony", outside: "courtyard", evidence: "courtyardGreenery" });
    expect(combineTwoStep(stepA({ balconyWall: "top", bedroomWall: "bottom" }), stepB([street])).bedroomSide).toBe("courtyard");
    expect(combineTwoStep(stepA({ balconyWall: "bottom", bedroomWall: "top" }), stepB([courtyard])).bedroomSide).toBe("street");
    expect(combineTwoStep(stepA({ balconyWall: "left", bedroomWall: "right" }), stepB([street])).bedroomSide).toBe("courtyard");
    expect(combineTwoStep(stepA({ balconyWall: "right", bedroomWall: "left" }), stepB([courtyard])).bedroomSide).toBe("street");
    expect(combineTwoStep(stepA({ balconyWall: "top", bedroomWall: "bottom" }), stepB([street])).bedroomOnBalconySide).toBe(false);
  });

  it("is unknown when the bedroom wall is adjacent to the balcony wall", () => {
    const street = pic({ takenFrom: "balcony", outside: "street", evidence: "cars" });
    expect(combineTwoStep(stepA({ balconyWall: "top", bedroomWall: "left" }), stepB([street])).bedroomSide).toBe("unknown");
  });

  it("is unknown when the balcony side itself is not street or courtyard", () => {
    expect(combineTwoStep(stepA({ balconyWall: "top", bedroomWall: "top" }), stepB([])).bedroomSide).toBe("unknown");
    expect(combineTwoStep(stepA({ balconyWall: "none", bedroomWall: "top" }), stepB([])).bedroomSide).toBe("unknown");
    expect(combineTwoStep(stepA({ balconyWall: "top", bedroomWall: "unknown" }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })])).bedroomSide).toBe("unknown");
  });
});

describe("combineTwoStep: windowSides from the four booleans only", () => {
  const sides = (t: boolean, b: boolean, l: boolean, r: boolean) =>
    combineTwoStep(stepA({ windowTop: t, windowBottom: b, windowLeft: l, windowRight: r }), null).windowSides;

  it("an opposite pair is twoOpposite", () => {
    expect(sides(true, true, false, false)).toBe("twoOpposite");
    expect(sides(false, false, true, true)).toBe("twoOpposite");
  });

  it("two adjacent walls are a corner", () => {
    expect(sides(true, false, true, false)).toBe("corner");
    expect(sides(false, true, false, true)).toBe("corner");
  });

  it("one wall is one", () => {
    expect(sides(true, false, false, false)).toBe("one");
    expect(sides(false, false, false, true)).toBe("one");
  });

  it("no wall is unknown", () => {
    expect(sides(false, false, false, false)).toBe("unknown");
  });

  it("three walls with an opposite pair, and four walls, are twoOpposite", () => {
    expect(sides(true, true, true, false)).toBe("twoOpposite");
    expect(sides(true, true, true, true)).toBe("twoOpposite");
  });

  it("does not depend on the photos", () => {
    const withPhotos = combineTwoStep(stepA({ windowTop: true, windowBottom: true }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })]));
    expect(withPhotos.windowSides).toBe("twoOpposite");
  });
});

describe("combineTwoStep: the rest of the answer", () => {
  it("livingOnBalconySide is livingWall equal to balconyWall, and unknown walls never match each other", () => {
    expect(combineTwoStep(stepA({ balconyWall: "top", livingWall: "top" }), null).livingOnBalconySide).toBe(true);
    expect(combineTwoStep(stepA({ balconyWall: "top", livingWall: "bottom" }), null).livingOnBalconySide).toBe(false);
    expect(combineTwoStep(stepA({ balconyWall: "unknown", livingWall: "unknown" }), null).livingOnBalconySide).toBe(false);
    expect(combineTwoStep(stepA({ balconyWall: "none", livingWall: "none" }), null).livingOnBalconySide).toBe(false);
  });

  it("kitchenOnBalconySide is false because step A does not ask for the kitchen", () => {
    expect(combineTwoStep(stepA({ balconyWall: "top", livingWall: "top", bedroomWall: "top" }), null).kitchenOnBalconySide).toBe(false);
  });

  it("planPresent is step A's", () => {
    expect(combineTwoStep(stepA({ planPresent: false }), stepB([])).planPresent).toBe(false);
    expect(combineTwoStep(stepA({ planPresent: true }), stepB([])).planPresent).toBe(true);
  });

  it("windowsConfidence is step A's alone", () => {
    expect(combineTwoStep(stepA({ confidence: 0.9 }), stepB([], 0.3)).windowsConfidence).toBe(0.9);
  });

  it("a balcony decided by a photo uses step B's certainty, a plan-only 'none' uses step A's", () => {
    const photo = combineTwoStep(stepA({ balconyWall: "top", confidence: 0.9 }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })], 0.6));
    expect(photo.balconyConfidence).toBe(0.6);
    const none = combineTwoStep(stepA({ balconyWall: "none", confidence: 0.85 }), stepB([], 0.3));
    expect(none.balconyConfidence).toBe(0.85);
  });

  it("a balcony decided through the living room, and an inferred bedroom, use the minimum of both steps", () => {
    const living = combineTwoStep(
      stepA({ balconyWall: "left", livingWall: "left", confidence: 0.9 }),
      stepB([pic({ takenFrom: "living", outside: "street", evidence: "cars" })], 0.7),
    );
    expect(living.balconyConfidence).toBe(0.7);
    const inferred = combineTwoStep(
      stepA({ balconyWall: "top", bedroomWall: "bottom", confidence: 0.5 }),
      stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })], 0.9),
    );
    expect(inferred.bedroomConfidence).toBe(0.5);
    expect(inferred.confidence).toBe(0.5);
  });

  it("a bedroom decided by a bedroom photo uses step B's certainty", () => {
    const out = combineTwoStep(stepA({ confidence: 0.4 }), stepB([pic({ takenFrom: "bedroom", outside: "street", evidence: "cars" })], 0.8));
    expect(out.bedroomConfidence).toBe(0.8);
    expect(out.streetEvidence).toBe("cars");
  });

  it("an unknown answer carries the minimum of the steps that ran, and step A's alone without photos", () => {
    expect(combineTwoStep(stepA({ confidence: 0.9 }), stepB([], 0.4)).balconyConfidence).toBe(0.4);
    expect(combineTwoStep(stepA({ confidence: 0.9 }), null).balconyConfidence).toBe(0.9);
    expect(combineTwoStep(stepA({ confidence: 0.9 }), null).confidence).toBe(0.9);
  });

  it("a certainty that is not a number counts as 0, never NaN", () => {
    const out = combineTwoStep(stepA({ confidence: Number.NaN }), stepB([], 0.5));
    expect(out.confidence).toBe(0);
    expect(Number.isFinite(out.windowsConfidence)).toBe(true);
  });

  it("the output parses as layoutReadSchemaV2 in every case, so the fact and the gate work unchanged", () => {
    const policy: LayoutGatePolicy = { balconyGate: 0.5, windowsGate: 0.5, bedroomGate: 0.5, negativeGate: 0.5, sideEvidence: ["cars", "courtyardGreenery"], trustedVersion: null };
    const cases: [LayoutStepA, LayoutStepB | null][] = [
      [stepA(), null],
      [stepA({ balconyWall: "none" }), stepB([])],
      [stepA({ balconyWall: "top", bedroomWall: "bottom", windowTop: true, windowBottom: true }), stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })])],
    ];
    for (const [a, b] of cases) {
      const out = combineTwoStep(a, b);
      expect(layoutReadSchemaV2.safeParse(out).success).toBe(true);
      const fact = factFromVariantRead(LAYOUT_VARIANTS["d-sonnet"], { stepA: a, stepB: b }, { booli: 4 });
      expect(layoutFactSchema.safeParse(fact).success).toBe(true);
      expect(() => believedLayout(fact, policy)).not.toThrow();
    }
  });

  it("a believed two-step read: street balcony from a photo, courtyard bedroom by inference, korsdrag from the plan", () => {
    const policy: LayoutGatePolicy = { balconyGate: 0.5, windowsGate: 0.5, bedroomGate: 0.5, negativeGate: 0.5, sideEvidence: ["cars"], trustedVersion: null };
    const a = stepA({ balconyWall: "top", bedroomWall: "bottom", windowTop: true, windowBottom: true, confidence: 0.9 });
    const b = stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })], 0.8);
    const fact = factFromVariantRead(LAYOUT_VARIANTS["d-sonnet"], { stepA: a, stepB: b }, { booli: 4 });
    expect(believedLayout(fact, policy)).toEqual({ balconySide: "street", noBalcony: false, korsdrag: true, bedroomSide: "courtyard" });
  });
});

// ---------------------------------------------------------------------------
// Variant d: specs and plumbing
// ---------------------------------------------------------------------------

describe("variants d-sonnet and d-opus", () => {
  const dS = LAYOUT_VARIANTS["d-sonnet"];
  const dO = LAYOUT_VARIANTS["d-opus"];

  it("have two steps and the call shapes of b and c", () => {
    expect(dS.steps).toBe(2);
    expect(dO.steps).toBe(2);
    expect(dS.model).toBe(LAYOUT_VARIANTS.b.model);
    expect(dS.temperature).toBe(0);
    expect(dS.effort).toBeNull();
    expect(dS.maxTokens).toBe(LAYOUT_VARIANTS.b.maxTokens);
    expect(dS.estSekPerFlat).toBe(0.5);
    expect(dO.model).toBe(LAYOUT_OPUS_MODEL);
    expect(dO.temperature).toBeNull();
    expect(dO.effort).toBe("low");
    expect(dO.maxTokens).toBe(LAYOUT_VARIANTS.c.maxTokens);
    expect(dO.estSekPerFlat).toBe(1.2);
    expect(dS.schema).toBe(layoutReadSchemaV2);
    expect(dS.twoStep?.stepA.schema).toBe(layoutStepASchema);
    expect(dS.twoStep?.stepB.schema).toBe(layoutStepBSchema);
    expect(dS.twoStep?.stepA.systemPrompt).toBe(LAYOUT_STEP_A_SYSTEM_PROMPT);
    expect(dS.twoStep?.stepB.systemPrompt).toBe(LAYOUT_STEP_B_SYSTEM_PROMPT);
  });

  it("all five versions are pairwise different", () => {
    const versions = Object.values(LAYOUT_VARIANTS).map(variantVersion);
    expect(Object.keys(LAYOUT_VARIANTS)).toEqual(["a", "b", "c", "d-sonnet", "d-opus"]);
    expect(new Set(versions).size).toBe(5);
  });

  it("their cache holds both step answers and refuses a single-step answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "layout-exp-"));
    try {
      const path = join(dir, "layout-exp-d-sonnet.json");
      const good = { stepA: stepA(), stepB: stepB([pic()]) };
      saveVariantCache(path, {
        ...emptyCache(dS),
        entries: {
          good: { id: "good", storedAt: "d", costSek: 0.4, result: good },
          noPhotos: { id: "noPhotos", storedAt: "d", costSek: 0.2, result: { stepA: stepA(), stepB: null } },
          single: { id: "single", storedAt: "d", costSek: 0.4, result: readV2() },
        },
      }, { dir });
      const loaded = loadVariantCache(path, dS);
      expect(Object.keys(loaded.cache.entries).sort()).toEqual(["good", "noPhotos"]);
      expect(loaded.dropped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A client whose parse() answers step A or step B by its system prompt, recording what each request carried. */
function twoStepClient(opts: { stepBFails?: "max_tokens" | "http400" | "http500"; usage?: { input_tokens: number; output_tokens: number } } = {}) {
  const requests: { system: string; images: number; effort?: unknown; temperature?: unknown; model: string }[] = [];
  const usage = opts.usage ?? { input_tokens: 2000, output_tokens: 300 };
  const client = {
    beta: {
      messages: {
        parse: async (request: { system: string; model: string; temperature?: number; output_config: { effort?: string }; messages: { content: { type: string }[] }[] }) => {
          const isA = request.system === LAYOUT_STEP_A_SYSTEM_PROMPT;
          requests.push({
            system: request.system,
            model: request.model,
            images: request.messages[0].content.filter((b) => b.type === "image").length,
            effort: request.output_config.effort,
            temperature: request.temperature,
          });
          // Real SDK errors, so the call's "transport error: not billed" test sees what it sees in production.
          if (!isA && opts.stepBFails === "http400") throw Anthropic.APIError.generate(400, undefined, "bad request", new Headers());
          if (!isA && opts.stepBFails === "http500") throw Anthropic.APIError.generate(500, undefined, "server", new Headers());
          return {
            usage,
            stop_reason: !isA && opts.stepBFails === "max_tokens" ? "max_tokens" : "end_turn",
            parsed_output: isA
              ? stepA({ balconyWall: "top", bedroomWall: "bottom", windowTop: true, windowBottom: true })
              : stepB([pic({ takenFrom: "balcony", outside: "street", evidence: "cars" })]),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("runVariantReads with a two-step variant", () => {
  const dS = LAYOUT_VARIANTS["d-sonnet"];
  const dO = LAYOUT_VARIANTS["d-opus"];

  it("sends picture 1 to step A alone and pictures 2 to 4 to step B alone", async () => {
    const { client, requests } = twoStepClient();
    const out = await runVariantReads([item(1)], { variant: dS, call: makeTwoStepLayoutCall(client, dS), cache: emptyCache(dS), runCapSek: 5, today: "d" });
    expect(requests.map((r) => [r.system === LAYOUT_STEP_A_SYSTEM_PROMPT ? "A" : "B", r.images])).toEqual([
      ["A", 1],
      ["B", 3],
    ]);
    expect(out.reads[0].status).toBe("read");
  });

  it("sums both costs and caches both step answers", async () => {
    const usage = { input_tokens: 2000, output_tokens: 300 };
    const { client } = twoStepClient({ usage });
    const out = await runVariantReads([item(1)], { variant: dS, call: makeTwoStepLayoutCall(client, dS), cache: emptyCache(dS), runCapSek: 5, today: "d" });
    expect(out.reads[0].costSek).toBeCloseTo(2 * layoutCallCostSek(LAYOUT_MODEL, usage), 10);
    const [entry] = Object.values(out.cacheNext.entries);
    expect(entry.result).toHaveProperty("stepA");
    expect(entry.result).toHaveProperty("stepB");
    expect(out.reads[0].fact?.balconySide).toBe("street");
    expect(out.reads[0].fact?.bedroomSide).toBe("courtyard");
    expect(out.reads[0].fact?.windowSides).toBe("twoOpposite");
  });

  it("skips step B when there are no photos and records stepB null, all photo fields unknown", async () => {
    const { client, requests } = twoStepClient();
    const out = await runVariantReads([item(1, { imageUrls: [url(1)] })], { variant: dS, call: makeTwoStepLayoutCall(client, dS), cache: emptyCache(dS), runCapSek: 5, today: "d" });
    expect(requests).toHaveLength(1);
    expect(requests[0].system).toBe(LAYOUT_STEP_A_SYSTEM_PROMPT);
    expect(out.reads[0].status).toBe("read");
    expect(Object.values(out.cacheNext.entries)[0].result).toMatchObject({ stepB: null });
    expect(out.reads[0].fact?.balconySide).toBe("unknown");
    expect(out.reads[0].fact?.bedroomSide).toBe("unknown");
    expect(out.reads[0].fact?.windowSides).toBe("twoOpposite");
  });

  it("uses the spec's call shape in both steps: no temperature and effort low on Opus", async () => {
    const { client, requests } = twoStepClient();
    await runVariantReads([item(1)], { variant: dO, call: makeTwoStepLayoutCall(client, dO), cache: emptyCache(dO), runCapSek: 5, today: "d" });
    expect(requests.map((r) => r.model)).toEqual([LAYOUT_OPUS_MODEL, LAYOUT_OPUS_MODEL]);
    expect(requests.map((r) => r.effort)).toEqual(["low", "low"]);
    expect(requests.every((r) => r.temperature === undefined)).toBe(true);
  });

  it("counts step A's money when step B fails, as a failed read", async () => {
    const usage = { input_tokens: 2000, output_tokens: 300 };
    const { client } = twoStepClient({ stepBFails: "max_tokens", usage });
    const one = layoutCallCostSek(LAYOUT_MODEL, usage);
    const out = await runVariantReads([item(1)], { variant: dS, call: makeTwoStepLayoutCall(client, dS), cache: emptyCache(dS), runCapSek: 5, today: "d" });
    expect(out.reads[0].status).toBe("failed");
    expect(out.reads[0].errorCode).toBe("STEP_B_CLAUDE_MAX_TOKENS");
    expect(out.spentSek).toBeCloseTo(2 * one, 10);
    expect(out.cacheNext.entries).toEqual({});
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(2 * one, 10);
  });

  it("counts step A's money and keeps the HTTP status when step B is rejected", async () => {
    const usage = { input_tokens: 2000, output_tokens: 300 };
    for (const [mode, status] of [
      ["http400", 400],
      ["http500", 500],
    ] as const) {
      const { client } = twoStepClient({ stepBFails: mode, usage });
      const call = makeTwoStepLayoutCall(client, dS);
      const error = await call([
        { type: "image", source: { type: "url", url: url(1) } },
        { type: "image", source: { type: "url", url: url(2) } },
      ]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LayoutCallError);
      expect((error as LayoutCallError).billedSek).toBeCloseTo(layoutCallCostSek(LAYOUT_MODEL, usage), 10);
      expect((error as { status?: number }).status).toBe(status);
    }
  });

  it("refuses to build a two-step call for a one-step spec", () => {
    const { client } = twoStepClient();
    expect(() => makeTwoStepLayoutCall(client, LAYOUT_VARIANTS.b)).toThrow();
  });
});
