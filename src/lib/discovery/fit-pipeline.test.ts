// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { AREA_MAX_RENDERS_PER_AREA, OBSERVED_USD_PER_TIMED_OUT_RENDER } from "@/lib/discovery/cost";
import {
  FIT_ENRICH_CONCURRENCY,
  FIT_ENRICH_DEADLINE_MS,
  FIT_PRICE_MAX,
  FIT_RENDERS_PER_WINDOW_ROW_MAX,
  FIT_SIZE_MIN,
  FIT_TABLE_MAX_ROWS,
  checkApifyHeadroom,
  estimateFitRunUsd,
  fitRowKey,
  renderFitTable,
  runFitPipeline,
  toFitTableRows,
  type EnrichmentLike,
  type FitPipelineDeps,
  type ScrapedRow,
} from "@/lib/discovery/fit-pipeline";
import {
  FIT_VISION_WINDOW,
  booliIdOf,
  parseFitSnapshot,
  preRank,
  rankFit,
  type FitScoreResult,
} from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import type { SunPhrases } from "@/lib/discovery/sun-path";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";

/**
 * fit-pipeline.test.ts - proves the run order of paid calls with plain fake
 * dependencies (no module mocks): the window, the empty case, the filters, the
 * snapshot round-trip, integer table money, and the Apify headroom check. The
 * model is the SYNTHETIC fixture, so these tests prove mechanics, not prices.
 */

const model = parseHedonicModel(modelJson);
const snapshot = parseFitSnapshot(snapshotJson);
const AS_OF = "2026-10-13";
const CARD_IMAGE = "https://bcdn.se/images/cache/card.webp";
const DETAIL_IMAGE = "https://bcdn.se/images/cache/detail.webp";

/** The fixture's real-shaped rows as scraped rows (district kept). */
const fixtureScraped: ScrapedRow[] = snapshot.rows.map((r) => ({
  district: r.district,
  candidate: { ...r.candidate, imageUrls: [CARD_IMAGE], vision: null, visionSkippedReason: null, orientation: null },
}));

function scrapedWith(base: ScrapedRow, id: number, patch: Partial<DiscoveryCandidate> = {}): ScrapedRow {
  return {
    district: base.district,
    candidate: {
      ...base.candidate,
      sourceListingUrl: `https://www.booli.se/bostad/${id}`,
      address: `Testgatan ${id}`,
      ...patch,
    },
  };
}

function claim(attribute: VisionConditionClaim["attribute"], text: string): VisionConditionClaim {
  return { attribute, claim: text, imageIndex: 1, whatWasSeen: text, confidence: 0.8 };
}
function visionOf(kitchen: string, bathroom: string, overall: string, costSek = 1.5): VisionResult {
  return {
    claims: [claim("kitchen", kitchen), claim("bathroom", bathroom), claim("overall", overall)],
    imageUrlsUsed: [],
    model: "test",
    costSek,
    ranAt: "2026-10-13T00:00:00Z",
  };
}
const ALL_FRESH = visionOf("Köket är nyrenoverat", "Badrummet är helrenoverat", "Helhetsintryck fräscht");
const ALL_DATED = visionOf("Köket är ursprungligt", "Badrummet har äldre standard", "Slitna golv");

interface FakeOptions {
  /** Window indices whose detail fetch "fails" (the fake returns the same object). */
  failIndexes?: number[];
  sunPhrases?: Map<number, SunPhrases>;
  /** Vision result per listing URL. */
  visionByUrl?: Map<string, VisionResult>;
}

/** Fake deps. enrich replaces every entry except the failing ones; vision attaches a canned result. */
function fakeDeps(rows: ScrapedRow[], options: FakeOptions = {}) {
  const failIndexes = new Set(options.failIndexes ?? []);
  const scrape = vi.fn(async () => ({ rows, areas: [] }));
  const enrich = vi.fn(
    async (candidates: DiscoveryCandidate[]): Promise<EnrichmentLike> => ({
      candidates: candidates.map((c, i) => (failIndexes.has(i) ? c : { ...c, imageUrls: [DETAIL_IMAGE] })),
      brokerImages: new Map(),
      sunPhrases: options.sunPhrases ?? new Map(),
    }),
  );
  const vision = vi.fn(async (candidates: DiscoveryCandidate[]): Promise<DiscoveryCandidate[]> =>
    candidates.map((c) => ({
      ...c,
      vision: options.visionByUrl?.get(c.sourceListingUrl ?? "") ?? null,
      visionSkippedReason: options.visionByUrl?.has(c.sourceListingUrl ?? "") ? null : ("no_images" as const),
    })),
  );
  const deps: FitPipelineDeps = { scrape, enrich, vision };
  return { deps, scrape, enrich, vision };
}

const run = (deps: FitPipelineDeps, window?: number) => runFitPipeline(deps, { model, asOf: AS_OF, window });

describe("empty input (FIT-05 probe)", () => {
  it("scrape returns nothing: no enrichment, no vision, empty ranking, header and '0 kandidater'", async () => {
    const { deps, enrich, vision } = fakeDeps([]);
    const result = await run(deps);

    expect(enrich).not.toHaveBeenCalled();
    expect(vision).not.toHaveBeenCalled();
    expect(result.ranking.ranked).toEqual([]);
    expect(result.window.size).toBe(0);
    expect(result.visionSek).toBe(0);
    const text = renderFitTable(toFitTableRows(result.ranking, result.preRankPositions));
    expect(text.split("\n")[0]).toContain("Förrank");
    expect(text).toContain("0 kandidater");
  });

  it("everything filtered away: still no paid call after the scrape", async () => {
    const tooExpensive = scrapedWith(fixtureScraped[0], 900001, { price: FIT_PRICE_MAX + 1 });
    const { deps, enrich, vision } = fakeDeps([tooExpensive]);
    const result = await run(deps);

    expect(enrich).not.toHaveBeenCalled();
    expect(vision).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ scraped: 1, deduped: 1, filtered: 0 });
  });
});

describe("hard filters (D-08)", () => {
  const base = fixtureScraped[0];

  it("keeps asking 4 000 000 and 35.0 m2, drops 4 000 001 and 34.9 m2", async () => {
    const rows = [
      scrapedWith(base, 900001, { price: 4_000_000, livingArea: 40 }),
      scrapedWith(base, 900002, { price: 4_000_001, livingArea: 40 }),
      scrapedWith(base, 900003, { price: 3_000_000, livingArea: 35.0 }),
      scrapedWith(base, 900004, { price: 3_000_000, livingArea: 34.9 }),
    ];
    const result = await run(fakeDeps(rows).deps);
    const kept = result.snapshot.rows.map((r) => booliIdOf(r.candidate)).sort();

    expect(FIT_PRICE_MAX).toBe(4_000_000);
    expect(FIT_SIZE_MIN).toBe(35);
    expect(kept).toEqual([900001, 900003]);
    expect(result.counts.filtered).toBe(2);
  });

  it("drops kommande and nyproduktion rows, keeps floor 0 and floor null", async () => {
    const rows = [
      scrapedWith(base, 900001, { upcomingSale: true }),
      scrapedWith(base, 900002, { isNewConstruction: true }),
      scrapedWith(base, 900003, { floor: 0 }),
      scrapedWith(base, 900004, { floor: null }),
    ];
    const result = await run(fakeDeps(rows).deps);

    expect(result.snapshot.rows.map((r) => booliIdOf(r.candidate)).sort()).toEqual([900003, 900004]);
  });

  it("the same listing URL from two districts appears once", async () => {
    const a = scrapedWith(base, 900001);
    const b: ScrapedRow = { district: "Vasastan", candidate: { ...a.candidate } };
    const result = await run(fakeDeps([a, b]).deps);

    expect(result.counts).toEqual({ scraped: 2, deduped: 1, filtered: 1 });
  });
});

describe("the vision window (D-10, R-03)", () => {
  // The first 26 fixture rows; at least 25 are comparable on the fixture model.
  const rows26 = fixtureScraped.slice(0, 26);
  const comparableCount = preRank(
    rows26.map((r) => ({ district: r.district, detailFetched: false, inVisionWindow: false, sunPhrases: null, candidate: r.candidate })),
    model,
  ).ranked.length;

  it("enrich gets exactly the first 20 pre-ranked candidates with images cleared, and vision gets those 20", async () => {
    expect(comparableCount).toBeGreaterThan(FIT_VISION_WINDOW);
    const { deps, enrich, vision } = fakeDeps(rows26);
    const result = await run(deps);

    expect(enrich).toHaveBeenCalledTimes(1);
    const [enrichArg, limit, optsArg] = enrich.mock.calls[0] as unknown as [DiscoveryCandidate[], number, unknown];
    expect(enrichArg).toHaveLength(FIT_VISION_WINDOW);
    expect(enrichArg.every((c) => c.imageUrls === null)).toBe(true);
    expect(limit).toBe(FIT_VISION_WINDOW);
    expect(optsArg).toEqual({ deadlineMs: FIT_ENRICH_DEADLINE_MS, concurrency: FIT_ENRICH_CONCURRENCY });
    expect(FIT_ENRICH_DEADLINE_MS).toBe(15 * 60_000);
    expect(FIT_ENRICH_CONCURRENCY).toBe(4);

    // They are the first 20 of the free pre-rank.
    const expected = [...result.preRankPositions.entries()]
      .filter(([, pos]) => pos <= FIT_VISION_WINDOW)
      .map(([key]) => key)
      .sort();
    expect(enrichArg.map(fitRowKey).sort()).toEqual(expected);

    expect(vision).toHaveBeenCalledTimes(1);
    expect(vision.mock.calls[0][0]).toHaveLength(FIT_VISION_WINDOW);

    // Rows outside the window carry ejBildtolkad and inVisionWindow false.
    const outside = result.snapshot.rows.filter((r) => !r.inVisionWindow);
    expect(result.snapshot.rows.filter((r) => r.inVisionWindow)).toHaveLength(FIT_VISION_WINDOW);
    expect(outside.length).toBeGreaterThan(0);
    const outsideIds = new Set(outside.map((r) => booliIdOf(r.candidate)));
    for (const r of [...result.ranking.ranked, ...result.ranking.notComparable]) {
      if (outsideIds.has(r.booliId) && r.comparable) expect(r.flags).toContain("ejBildtolkad");
    }
    expect(result.window.size).toBe(FIT_VISION_WINDOW);
    expect(result.window.detailFetched).toBe(FIT_VISION_WINDOW);
  });

  it("a smaller window option is honoured", async () => {
    const { deps, enrich } = fakeDeps(rows26);
    await run(deps, 5);
    expect((enrich.mock.calls[0] as unknown as [DiscoveryCandidate[]])[0]).toHaveLength(5);
  });

  it("a failed detail fetch keeps the card's images for vision and is marked detailFetched false", async () => {
    const { deps, vision } = fakeDeps(rows26, { failIndexes: [0] });
    const result = await run(deps);

    const sentToVision = vision.mock.calls[0][0] as DiscoveryCandidate[];
    expect(sentToVision[0].imageUrls).toEqual([CARD_IMAGE]);
    expect(sentToVision[1].imageUrls).toEqual([DETAIL_IMAGE]);
    const windowRows = result.snapshot.rows.filter((r) => r.inVisionWindow);
    expect(windowRows.filter((r) => !r.detailFetched)).toHaveLength(1);
    expect(result.window.detailFetched).toBe(FIT_VISION_WINDOW - 1);
  });

  it("broker sun phrases reach the taste bonus even without a stated orientation", async () => {
    const withoutPhrases = await run(fakeDeps(rows26).deps);
    // Window index 0 is the first pre-ranked candidate.
    const firstKey = [...withoutPhrases.preRankPositions.entries()].find(([, pos]) => pos === 1)![0];
    const phrases = new Map<number, SunPhrases>([[0, { allDaySun: true, throughFlat: false }]]);
    const withPhrases = await run(fakeDeps(rows26, { sunPhrases: phrases }).deps);

    const before = withoutPhrases.ranking.ranked.find((r) => (r.sourceListingUrl ?? "") === firstKey)!;
    const after = withPhrases.ranking.ranked.find((r) => (r.sourceListingUrl ?? "") === firstKey)!;
    expect(before.tasteSunPct).toBe(0);
    expect(after.tasteSunPct).toBeGreaterThan(0);
    expect(withPhrases.window.sunPhrases).toBe(1);
    expect(withPhrases.snapshot.rows.filter((r) => r.sunPhrases !== null)).toHaveLength(1);
  });

  it("the picture read can reorder: an all-fresh flat outranks an otherwise equal all-dated one", async () => {
    const base = fixtureScraped[0];
    const dated = scrapedWith(base, 900001);
    const fresh = scrapedWith(base, 900002);
    const visionByUrl = new Map<string, VisionResult>([
      [dated.candidate.sourceListingUrl as string, ALL_DATED],
      [fresh.candidate.sourceListingUrl as string, ALL_FRESH],
    ]);
    const result = await run(fakeDeps([dated, fresh], { visionByUrl }).deps);

    expect(result.ranking.ranked.map((r) => r.booliId)).toEqual([900002, 900001]);
    expect(result.window.visionWithClaims).toBe(2);
  });

  it("visionSek is the sum of the window rows' vision cost, and skipped reasons are tallied", async () => {
    const base = fixtureScraped[0];
    const a = scrapedWith(base, 900001);
    const b = scrapedWith(base, 900002);
    const c = scrapedWith(base, 900003);
    const visionByUrl = new Map<string, VisionResult>([
      [a.candidate.sourceListingUrl as string, visionOf("Köket är nyrenoverat", "Badrummet är helrenoverat", "fräscht", 1.25)],
      [b.candidate.sourceListingUrl as string, visionOf("Köket är ursprungligt", "Badrummet har äldre standard", "Slitna golv", 2.5)],
    ]);
    const result = await run(fakeDeps([a, b, c], { visionByUrl }).deps);

    expect(result.visionSek).toBeCloseTo(3.75, 9);
    expect(result.window.visionSkipped).toEqual({ no_images: 1 });
  });
});

describe("snapshot round-trip (FIT-06)", () => {
  it("a live-run snapshot survives JSON and replays to the same order", async () => {
    const base = fixtureScraped[0];
    const visionByUrl = new Map<string, VisionResult>();
    const rows = fixtureScraped.slice(0, 24);
    visionByUrl.set(rows[3].candidate.sourceListingUrl as string, ALL_DATED);
    visionByUrl.set(rows[5].candidate.sourceListingUrl as string, ALL_FRESH);
    expect(base).toBeDefined();
    const result = await run(fakeDeps(rows, { visionByUrl }).deps);

    const reparsed = parseFitSnapshot(JSON.parse(JSON.stringify(result.snapshot)));
    const replayed = rankFit(reparsed.rows, model);

    expect(result.ranking.ranked.length).toBeGreaterThan(0);
    expect(replayed.ranked.map((r) => r.booliId)).toEqual(result.ranking.ranked.map((r) => r.booliId));
    expect(reparsed.asOf).toBe(AS_OF);
    expect(reparsed.source).toBe(`live run ${AS_OF}`);
  });
});

describe("table rows and rendering (FIT-03)", () => {
  const sample = rankFit(snapshot.rows, model).ranked;

  it("every money value of every row is a whole number of kronor", () => {
    const rows = toFitTableRows({ ranked: sample }, new Map());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const v of [r.askingKr, r.expectedFinalKr, r.resaleKr, r.renoMidKr, r.renoLowKr, r.renoHighKr, r.profitKr, r.tasteKr]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("rounds half-way profits with Math.round: 1234.5 gives 1235, -1234.5 gives -1234", () => {
    const [a, b] = toFitTableRows(
      { ranked: [{ ...sample[0], profitSek: 1234.5 }, { ...sample[1], profitSek: -1234.5 }] },
      new Map(),
    );
    expect(a.profitKr).toBe(1235);
    expect(b.profitKr).toBe(-1234);
  });

  it("looks up the pre-rank position by listing URL", () => {
    const key = fitRowKey({ sourceListingUrl: sample[0].sourceListingUrl, address: sample[0].address, price: sample[0].askingSek });
    const [row] = toFitTableRows({ ranked: [sample[0]] }, new Map([[key, 7]]));
    expect(row.preRank).toBe(7);
  });

  it("prints at most maxRows rows and a line for the rest", () => {
    const seventy: FitScoreResult[] = Array.from({ length: 70 }, (_, i) => sample[i % sample.length]);
    const text = renderFitTable(toFitTableRows({ ranked: seventy }, new Map()), { maxRows: 60 });
    const lines = text.split("\n");

    expect(FIT_TABLE_MAX_ROWS).toBe(60);
    expect(lines.filter((l) => /^\d+ \| /.test(l))).toHaveLength(60);
    expect(lines[lines.length - 1]).toBe("+10 till (se snapshot)");
    expect(lines[0]).toContain("Förrank");
  });

  it("labels a row outside the fitted size range", () => {
    const flagged: FitScoreResult = { ...sample[0], flags: ["utanförModellensStorlek"] };
    const text = renderFitTable(toFitTableRows({ ranked: [flagged] }, new Map()));
    expect(text).toContain("storlek utanför modellen");
  });
});

describe("estimateFitRunUsd (R-13)", () => {
  it("is the priced worst case: (districts x area renders + window x 3) x timed-out rate", () => {
    const expected = (4 * AREA_MAX_RENDERS_PER_AREA + 20 * FIT_RENDERS_PER_WINDOW_ROW_MAX) * OBSERVED_USD_PER_TIMED_OUT_RENDER;
    expect(estimateFitRunUsd({ districts: 4, window: 20 })).toBeCloseTo(expected, 9);
    // Documentation of the number the plan quotes: about 5.90 USD.
    expect(estimateFitRunUsd({ districts: 4, window: 20 })).toBeCloseTo(5.9, 9);
    expect(FIT_RENDERS_PER_WINDOW_ROW_MAX).toBe(3);
  });

  it("window 0 leaves only the scrape part, and nothing is negative", () => {
    expect(estimateFitRunUsd({ districts: 4, window: 0 })).toBeCloseTo(4 * AREA_MAX_RENDERS_PER_AREA * OBSERVED_USD_PER_TIMED_OUT_RENDER, 9);
    expect(estimateFitRunUsd({ districts: 0, window: 0 })).toBe(0);
    expect(estimateFitRunUsd({ districts: -2, window: -5 })).toBe(0);
  });
});

describe("checkApifyHeadroom (R-13)", () => {
  it("stops when the known headroom is below the requirement, naming both numbers in Swedish and English", async () => {
    const provider = vi.fn(async () => 1.0);
    const check = await checkApifyHeadroom(provider, 5.9);

    expect(check.proceed).toBe(false);
    expect(check.headroomUsd).toBe(1);
    expect(check.requiredUsd).toBe(5.9);
    expect(check.message).toContain("1,00");
    expect(check.message).toContain("5,90");
    expect(check.message).toContain("räcker inte");
    expect(check.message).toContain("too low");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("proceeds when the headroom exactly equals the requirement", async () => {
    const check = await checkApifyHeadroom(async () => 5.9, 5.9);
    expect(check.proceed).toBe(true);
    expect(check.headroomUsd).toBe(5.9);
  });

  it("proceeds when there is plenty of headroom", async () => {
    const check = await checkApifyHeadroom(async () => 100, 5.9);
    expect(check.proceed).toBe(true);
  });

  it("an unknown headroom (null) proceeds with a warning", async () => {
    const provider = vi.fn(async () => null);
    const check = await checkApifyHeadroom(provider, 5.9);

    expect(check.proceed).toBe(true);
    expect(check.headroomUsd).toBeNull();
    expect(check.message).toContain("okänt");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("a provider that rejects counts as unknown and never throws", async () => {
    const provider = vi.fn(async (): Promise<number | null> => {
      throw new Error("network down");
    });
    const check = await checkApifyHeadroom(provider, 5.9);

    expect(check.proceed).toBe(true);
    expect(check.headroomUsd).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("module hygiene", () => {
  it("fit-pipeline.ts takes only types from the Booli, job and vision modules", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/discovery/fit-pipeline.ts"), "utf-8");
    const runtimeImports = source
      .split("\n")
      .filter((l) => /^import [^t].*from "@\/lib\/(booli\/|discovery\/job"|discovery\/vision")/.test(l));
    expect(runtimeImports).toEqual([]);
  });
});
