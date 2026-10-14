// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { bcdnImageUrl, isAllowedImageHost } from "@/lib/booli/image-host";
import { SOLD_DETAIL_VERSION, stratifiedHashSample, type SoldRow } from "@/lib/booli/slutpriser";
import { INNERSTAN_DISTRICTS } from "@/lib/discovery/hedonic-model";
import {
  SOLD_CONDITION_CACHE_PATH,
  SOLD_CONDITION_CAP_SEK,
  SOLD_CONDITION_EST_SEK_PER_FLAT,
  SOLD_CONDITION_LOGIC_REVISION,
  SOLD_CONDITION_MAX_IMAGES,
  SOLD_CONDITION_MIN_ELIGIBLE,
  SOLD_CONDITION_MODEL,
  SOLD_CONDITION_SAMPLE_N,
  SOLD_CONDITION_SAMPLE_SEED,
  SOLD_CONDITION_SMOKE_MIN_READ,
  SOLD_CONDITION_SYSTEM_PROMPT,
  SOLD_CONDITION_USER_INSTRUCTION,
  SOLD_CONDITION_VERSION,
  SoldConditionCallError,
  allRefusedByCap,
  conditionIndexOfRead,
  loadSoldConditionCache,
  runCapSek,
  runSoldConditionReads,
  saveSoldConditionCache,
  selectConditionSample,
  soldConditionBranch,
  soldConditionEntryId,
  soldConditionImagesOf,
  soldConditionSchema,
  soldConditionSpentSek,
  soldConditionVersion,
  type SoldConditionCache,
  type SoldConditionCallFn,
  type SoldConditionRead,
} from "@/lib/discovery/sold-condition";
import { VISION_HAIKU_MODEL } from "@/lib/discovery/vision-prompt";

const read = (over: Partial<SoldConditionRead> = {}): SoldConditionRead => ({ condition: "ok", confidence: 0.9, ...over });
const emptyCache = (): SoldConditionCache => ({ version: 1, entries: {} });
const ids = (n: number, from = 100): string[] => Array.from({ length: n }, (_, i) => String(from + i));
const urlOf = (id: string) => `https://bcdn.se/images/cache/${id}_1440x0.webp`;

function fakeCall(cost = 0.09, result: SoldConditionRead = read()) {
  const seen: number[] = [];
  const call: SoldConditionCallFn = async (blocks) => {
    seen.push(blocks.length);
    return { result, costSek: cost };
  };
  return { call, seen };
}

describe("bcdnImageUrl (T-14.4-33)", () => {
  it("builds the bcdn.se URL from a digits-only id and the URL passes the host allowlist", () => {
    expect(bcdnImageUrl("52555065")).toBe("https://bcdn.se/images/cache/52555065_1440x0.webp");
    expect(isAllowedImageHost(bcdnImageUrl("52555065"))).toBe(true);
  });

  it("refuses an id that is not digits only", () => {
    for (const bad of ["../x", "", "12a", "1/2", "https://evil.example/x", "12 34", "-1", "1.5"]) {
      expect(() => bcdnImageUrl(bad), bad).toThrow("Ogiltigt bild-id");
    }
  });
});

describe("soldConditionSchema (strict-output limits)", () => {
  const json = z.toJSONSchema(soldConditionSchema, { unrepresentable: "any" }) as {
    properties: Record<string, { enum?: string[] }>;
    required: string[];
  };

  it("has exactly condition (dated/ok/fresh) and confidence, both required", () => {
    expect(Object.keys(json.properties).sort()).toEqual(["condition", "confidence"]);
    expect([...json.required].sort()).toEqual(["condition", "confidence"]);
    expect(json.properties.condition.enum).toEqual(["dated", "ok", "fresh"]);
  });

  it("has no null type, no union and no numeric constraint anywhere", () => {
    const text = JSON.stringify(json);
    for (const bad of ["anyOf", "oneOf", "allOf", '"null"', "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      expect(text, bad).not.toContain(bad);
    }
  });
});

describe("the prompt, the version and the constants", () => {
  it("is Swedish, skips floor plans and tells the model not to guess", () => {
    expect(SOLD_CONDITION_SYSTEM_PROMPT).toMatch(/såld lägenhets/);
    expect(SOLD_CONDITION_SYSTEM_PROMPT).toMatch(/planritningar/);
    expect(SOLD_CONDITION_SYSTEM_PROMPT).toMatch(/Gissa inte/);
  });

  it("uses Haiku", () => {
    expect(SOLD_CONDITION_MODEL).toBe(VISION_HAIKU_MODEL);
  });

  it("the version changes with the prompt, the model id, the schema and the revision", () => {
    const parts = {
      prompt: SOLD_CONDITION_SYSTEM_PROMPT,
      model: SOLD_CONDITION_MODEL,
      schema: z.toJSONSchema(soldConditionSchema, { unrepresentable: "any" }),
      revision: SOLD_CONDITION_LOGIC_REVISION,
    };
    const base = soldConditionVersion(parts);
    expect(soldConditionVersion({ ...parts, prompt: `${parts.prompt} x` })).not.toBe(base);
    expect(soldConditionVersion({ ...parts, model: "claude-other" })).not.toBe(base);
    expect(soldConditionVersion({ ...parts, schema: { type: "object" } })).not.toBe(base);
    expect(soldConditionVersion({ ...parts, revision: parts.revision + 1 })).not.toBe(base);
    expect(soldConditionVersion(parts)).toBe(base);
    expect(SOLD_CONDITION_VERSION).toMatch(/^[0-9a-f]{16}$/);
    expect(SOLD_CONDITION_USER_INSTRUCTION.length).toBeGreaterThan(0);
  });

  it("D-12: 0,1 kr per flat estimated, 30 kr lifetime, 5 images, 300-row sample, 200 eligible rows for the fit branch", () => {
    expect(SOLD_CONDITION_EST_SEK_PER_FLAT).toBe(0.1);
    expect(SOLD_CONDITION_CAP_SEK).toBe(30);
    expect(SOLD_CONDITION_MAX_IMAGES).toBe(5);
    expect(SOLD_CONDITION_SAMPLE_N).toBe(300);
    expect(SOLD_CONDITION_MIN_ELIGIBLE).toBe(200);
    expect(SOLD_CONDITION_CACHE_PATH).toBe(".planning/calibration/data/sold-condition-cache.json");
  });
});

describe("soldConditionImagesOf (T-14.4-33)", () => {
  it("gives at most 5 URL blocks, in page order", () => {
    const out = soldConditionImagesOf(["1", "2", "3", "4", "5", "6"]);
    expect(out).toHaveLength(5);
    expect(out.map((b) => (b.source.type === "url" ? b.source.url : ""))).toEqual(["1", "2", "3", "4", "5"].map(urlOf));
  });

  it("gives none for ids that are not digits only, and skips a bad id among good ones", () => {
    expect(soldConditionImagesOf(["abc"])).toEqual([]);
    expect(soldConditionImagesOf(["../x", "https://evil.example/a"])).toEqual([]);
    expect(soldConditionImagesOf(["1", "bad", "3"]).map((b) => (b.source.type === "url" ? b.source.url : ""))).toEqual([urlOf("1"), urlOf("3")]);
    expect(soldConditionImagesOf(null)).toEqual([]);
    expect(soldConditionImagesOf([])).toEqual([]);
  });

  it("every URL it makes is on the allowlist", () => {
    for (const b of soldConditionImagesOf(ids(8))) expect(b.source.type === "url" && isAllowedImageHost(b.source.url)).toBe(true);
  });
});

describe("runSoldConditionReads", () => {
  it("a flat without a usable id is no_images and never reaches the call", async () => {
    const { call, seen } = fakeCall();
    const out = await runSoldConditionReads(
      [{ booliId: "1", imageIds: [] }, { booliId: "2", imageIds: ["x"] }, { booliId: "3", imageIds: undefined }],
      { call, cache: emptyCache(), capSek: 30, today: "2026-10-14" },
    );
    expect(seen).toEqual([]);
    expect(out.reads.map((r) => r.status)).toEqual(["no_images", "no_images", "no_images"]);
    expect(out.spentSek).toBe(0);
  });

  it("sends at most 5 pictures per flat", async () => {
    const { call, seen } = fakeCall();
    await runSoldConditionReads([{ booliId: "1", imageIds: ids(8) }], { call, cache: emptyCache(), capSek: 30, today: "2026-10-14" });
    expect(seen).toEqual([5]);
  });

  it("a cache hit on the same booli id, the same sorted ids and the same version makes no call; two runs make 1 call", async () => {
    const { call, seen } = fakeCall();
    const item = { booliId: "7", imageIds: ["11", "12", "13"] };
    const first = await runSoldConditionReads([item], { call, cache: emptyCache(), capSek: 30, today: "2026-10-14" });
    expect(first.calls).toBe(1);
    const reordered = { booliId: "7", imageIds: ["13", "11", "12"] };
    const second = await runSoldConditionReads([reordered], { call, cache: first.cacheNext, capSek: 30, today: "2026-10-15" });
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.reads[0]).toMatchObject({ status: "cache", costSek: 0, result: read() });
    expect(seen).toHaveLength(1);
    expect(second.totalSpentSek).toBeCloseTo(first.totalSpentSek, 12);
  });

  it("a different id set or a different listing misses the cache", async () => {
    const { call, seen } = fakeCall();
    const first = await runSoldConditionReads([{ booliId: "7", imageIds: ["11", "12"] }], { call, cache: emptyCache(), capSek: 30, today: "d" });
    await runSoldConditionReads(
      [{ booliId: "7", imageIds: ["11", "99"] }, { booliId: "8", imageIds: ["11", "12"] }],
      { call, cache: first.cacheNext, capSek: 30, today: "d" },
    );
    expect(seen).toHaveLength(3);
  });

  it("the LIFETIME cap blocks a call that would pass 30 kr: 29,95 already paid + the 0,1 estimate", async () => {
    const { call, seen } = fakeCall();
    const cache: SoldConditionCache = { version: 1, entries: {}, spentSekTotal: 29.95 };
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }], { call, cache, capSek: SOLD_CONDITION_CAP_SEK, today: "d" });
    expect(seen).toEqual([]);
    expect(out.reads[0].status).toBe("cost_cap");
    expect(out.totalSpentSek).toBeCloseTo(29.95, 12);
  });

  it("equal to the cap is allowed (29,9 + 0,1 = 30) and the next one is blocked", async () => {
    const { call, seen } = fakeCall(0.1);
    const cache: SoldConditionCache = { version: 1, entries: {}, spentSekTotal: 29.9 };
    const out = await runSoldConditionReads(
      [{ booliId: "1", imageIds: ["1"] }, { booliId: "2", imageIds: ["2"] }],
      { call, cache, capSek: 30, today: "d" },
    );
    expect(out.reads.map((r) => r.status)).toEqual(["read", "cost_cap"]);
    expect(seen).toHaveLength(1);
  });

  it("the ledger is the larger of the recorded total and the stored reads, so a lost total cannot reopen the budget", async () => {
    const { call } = fakeCall(0.09);
    const first = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }, { booliId: "2", imageIds: ["2"] }], { call, cache: emptyCache(), capSek: 30, today: "d" });
    const lost: SoldConditionCache = { ...first.cacheNext, spentSekTotal: undefined };
    expect(soldConditionSpentSek(lost)).toBeCloseTo(0.18, 12);
  });

  it("a billed failure is counted in the spend and the run goes on", async () => {
    let n = 0;
    const call: SoldConditionCallFn = async () => {
      n += 1;
      if (n === 1) throw new SoldConditionCallError("CLAUDE_REFUSAL", 0.07);
      return { result: read({ condition: "dated" }), costSek: 0.09 };
    };
    const out = await runSoldConditionReads(
      [{ booliId: "1", imageIds: ["1"] }, { booliId: "2", imageIds: ["2"] }],
      { call, cache: emptyCache(), capSek: 30, today: "d" },
    );
    expect(out.reads[0]).toMatchObject({ status: "failed", costSek: 0.07, errorCode: "CLAUDE_REFUSAL", result: null });
    expect(out.reads[1].status).toBe("read");
    expect(out.spentSek).toBeCloseTo(0.16, 12);
    expect(out.totalSpentSek).toBeCloseTo(0.16, 12);
    expect(out.calls).toBe(1);
    expect(out.cacheNext.spentSekTotal).toBeCloseTo(0.16, 12);
  });

  it("an error that is not billed counts nothing, and only its class name is kept", async () => {
    const call: SoldConditionCallFn = async () => {
      throw new TypeError("secret https://example.test/x?key=abc");
    };
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }], { call, cache: emptyCache(), capSek: 30, today: "d" });
    expect(out.reads[0]).toMatchObject({ status: "failed", costSek: 0, errorCode: "TypeError" });
    expect(JSON.stringify(out.reads)).not.toContain("secret");
  });

  it("a cost that is not a positive number is counted at the estimate", async () => {
    const call: SoldConditionCallFn = async () => ({ result: read(), costSek: Number.NaN });
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }], { call, cache: emptyCache(), capSek: 30, today: "d" });
    expect(out.spentSek).toBeCloseTo(SOLD_CONDITION_EST_SEK_PER_FLAT, 12);
  });

  it("entries of another version are dropped from cacheNext", async () => {
    const { call } = fakeCall();
    const old: SoldConditionCache = {
      version: 1,
      entries: {
        "booli:9|abc": { id: "booli:9|abc", promptVersion: "stale-version", storedAt: "2026-01-01", costSek: 0.05, result: read() },
      },
    };
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }], { call, cache: old, capSek: 30, today: "d" });
    expect(Object.keys(out.cacheNext.entries)).toEqual([soldConditionEntryId("1", ["1"])]);
    // The money of the dropped entry stays in the ledger.
    expect(out.totalSpentSek).toBeCloseTo(0.05 + 0.09, 12);
  });

  it("the cache key is booli:<id>|<16 hex of the sorted ids>", () => {
    const id = soldConditionEntryId("6277037", ["3", "1", "2"]);
    expect(id).toMatch(/^booli:6277037\|[0-9a-f]{16}$/);
    expect(id).toBe(soldConditionEntryId("6277037", ["1", "2", "3"]));
  });
});

describe("per-run allowance on top of the lifetime ledger (WR-01)", () => {
  it("a 1 kr smoke allowance on a 26,12 kr ledger still lets a call through (it used to be refused as cost_cap)", async () => {
    const { call, seen } = fakeCall(0.09);
    const cache: SoldConditionCache = { version: 1, entries: {}, spentSekTotal: 26.12 };
    const capSek = runCapSek(soldConditionSpentSek(cache), 1);
    expect(capSek).toBeCloseTo(27.12, 12);
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }, { booliId: "2", imageIds: ["2"] }], { call, cache, capSek, today: "d" });
    expect(seen).toHaveLength(2);
    expect(out.reads.map((r) => r.status)).toEqual(["read", "read"]);
    expect(out.spentSek).toBeCloseTo(0.18, 12);
    expect(allRefusedByCap(out.reads)).toBe(false);
  });

  it("the run allowance is spent in this run only: 1 kr stops after ten 0,1 kr estimates, whatever the ledger holds", async () => {
    const { call, seen } = fakeCall(0.1);
    const cache: SoldConditionCache = { version: 1, entries: {}, spentSekTotal: 12 };
    const items = Array.from({ length: 12 }, (_, i) => ({ booliId: String(i + 1), imageIds: [String(i + 1)] }));
    const out = await runSoldConditionReads(items, { call, cache, capSek: runCapSek(12, 1), today: "d" });
    expect(seen).toHaveLength(10);
    expect(out.reads.filter((r) => r.status === "cost_cap")).toHaveLength(2);
  });

  it("the allowance is cut to what is left of the lifetime budget", () => {
    expect(runCapSek(29.5, 1)).toBeCloseTo(30, 12);
    expect(runCapSek(30, 1)).toBeCloseTo(30, 12);
    expect(runCapSek(31, 1)).toBeCloseTo(31, 12);
    expect(runCapSek(Number.NaN, 1)).toBeCloseTo(1, 12);
  });

  it("a run where the cap refused every flat is flagged so the smoke leaves the evidence file alone", async () => {
    const { call, seen } = fakeCall();
    const cache: SoldConditionCache = { version: 1, entries: {}, spentSekTotal: 30 };
    const out = await runSoldConditionReads([{ booliId: "1", imageIds: ["1"] }], { call, cache, capSek: runCapSek(30, 1), today: "d" });
    expect(seen).toEqual([]);
    expect(allRefusedByCap(out.reads)).toBe(true);
    expect(allRefusedByCap([])).toBe(false);
    expect(allRefusedByCap([{ status: "cost_cap" }, { status: "cache" }])).toBe(false);
  });
});

describe("the cache file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sold-condition-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and keeps the ledger", () => {
    const path = join(dir, "c.json");
    const cache: SoldConditionCache = {
      version: 1,
      entries: { a: { id: "a", promptVersion: SOLD_CONDITION_VERSION, storedAt: "2026-10-14", costSek: 0.08, result: read() } },
      spentSekTotal: 0.12,
    };
    saveSoldConditionCache(path, cache, { dir });
    expect(loadSoldConditionCache(path)).toEqual({ cache, warning: null });
  });

  it("a missing file is empty; a bad file is empty with a warning and is moved aside", () => {
    expect(loadSoldConditionCache(join(dir, "none.json"))).toEqual({ cache: emptyCache(), warning: null });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    const out = loadSoldConditionCache(bad, { now: () => 0 });
    expect(out.cache).toEqual(emptyCache());
    expect(out.warning).toContain("kunde inte läsas");
    expect(existsSync(bad)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("bad.json.bak-"))).toBe(true);
  });

  it("refuses to write outside the data directory", () => {
    expect(() => saveSoldConditionCache("/tmp/elsewhere.json", emptyCache(), { dir })).toThrow();
    expect(() => saveSoldConditionCache(join(dir, "c.txt"), emptyCache(), { dir })).toThrow();
  });
});

describe("conditionIndexOfRead (BID-01)", () => {
  it("dated -1, fresh +1, ok 0 at or above the confidence bar", () => {
    expect(conditionIndexOfRead({ condition: "dated", confidence: 0.8 })).toBe(-1);
    expect(conditionIndexOfRead({ condition: "fresh", confidence: 0.6 })).toBe(1);
    expect(conditionIndexOfRead({ condition: "ok", confidence: 0.9 })).toBe(0);
  });

  it("a read below 0,6 or with a non-finite confidence is excluded (null), never coded 0", () => {
    expect(conditionIndexOfRead({ condition: "dated", confidence: 0.59 })).toBeNull();
    expect(conditionIndexOfRead({ condition: "fresh", confidence: 0 })).toBeNull();
    expect(conditionIndexOfRead({ condition: "ok", confidence: Number.NaN })).toBeNull();
  });
});

describe("selectConditionSample (D-12)", () => {
  function sold(i: number, over: Partial<SoldRow> = {}): SoldRow {
    const district = INNERSTAN_DISTRICTS[i % INNERSTAN_DISTRICTS.length];
    return {
      booliId: String(1000 + i),
      url: null,
      address: null,
      district,
      soldDate: "2026-09-01",
      soldPrice: 4_000_000,
      soldVsAskPct: 3,
      askingPrice: 3_900_000,
      livingArea: 25 + (i % 7) * 12,
      rooms: 2,
      floor: 2,
      krPerSqm: 100_000,
      lat: 59.3,
      lng: 18.0,
      sliceKey: "s",
      enriched: { buildYear: null, balcony: null, listPrice: null, detailVersion: SOLD_DETAIL_VERSION, imageIds: ["1", "2"] },
      ...over,
    };
  }
  const rows = Array.from({ length: 400 }, (_, i) => sold(i));

  it("keeps only v2 rows with at least one image id and an asking price", () => {
    const mixed = [
      sold(1),
      sold(2, { enriched: { buildYear: null, balcony: null, listPrice: null, detailVersion: SOLD_DETAIL_VERSION, imageIds: [] } }),
      sold(3, { enriched: { buildYear: null, balcony: null, listPrice: null, detailVersion: SOLD_DETAIL_VERSION } }),
      sold(4, { enriched: { buildYear: null, balcony: null, listPrice: null } }),
      sold(5, { enriched: null }),
      sold(6, { askingPrice: null }),
      sold(7),
    ];
    expect(selectConditionSample(mixed, 300).map((r) => r.booliId).sort()).toEqual(["1001", "1007"]);
  });

  it("is deterministic, independent of input order, and returns n rows from a larger pool", () => {
    const a = selectConditionSample(rows, 300);
    const b = selectConditionSample([...rows].reverse(), 300);
    expect(a).toHaveLength(300);
    expect(b.map((r) => r.booliId)).toEqual(a.map((r) => r.booliId));
    expect(new Set(a.map((r) => r.booliId)).size).toBe(300);
  });

  it("is the stratified hash sample with the seed 14.4-skick", () => {
    expect(SOLD_CONDITION_SAMPLE_SEED).toBe("14.4-skick");
    expect(selectConditionSample(rows, 50)).toEqual(stratifiedHashSample(rows, 50, "14.4-skick"));
  });

  it("with fewer eligible rows than n it returns them all", () => {
    expect(selectConditionSample(rows.slice(0, 40), 300)).toHaveLength(40);
  });

  it("the default n is 300", () => {
    expect(selectConditionSample(rows)).toHaveLength(300);
  });
});

describe("soldConditionBranch (R-08, measured not assumed)", () => {
  it("fit needs at least 200 eligible rows AND 4 of 5 smoke reads", () => {
    expect(SOLD_CONDITION_SMOKE_MIN_READ).toBe(4);
    expect(soldConditionBranch({ eligible: 200, smoke: { attempted: 5, read: 4 } })).toEqual({ branch: "fit", reason: "" });
    expect(soldConditionBranch({ eligible: 324, smoke: { attempted: 5, read: 5 } }).branch).toBe("fit");
  });

  it("prior when the smoke read 3 of 5, or when there are 199 eligible rows, or when no smoke has run", () => {
    expect(soldConditionBranch({ eligible: 324, smoke: { attempted: 5, read: 3 } }).branch).toBe("prior");
    expect(soldConditionBranch({ eligible: 199, smoke: { attempted: 5, read: 5 } }).branch).toBe("prior");
    expect(soldConditionBranch({ eligible: 324, smoke: null })).toEqual({ branch: "prior", reason: "smoketestet är inte körd" });
  });

  it("no eligible rows at all is 'inga säljfoton'", () => {
    expect(soldConditionBranch({ eligible: 0, smoke: null })).toEqual({ branch: "prior", reason: "inga säljfoton" });
  });
});
