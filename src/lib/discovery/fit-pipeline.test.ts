// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { resolveSunFact, unknownSunFact, type DateHours, type SunFact } from "@/lib/discovery/sun-fact";
import { AREA_MAX_RENDERS_PER_AREA, OBSERVED_USD_PER_TIMED_OUT_RENDER } from "@/lib/discovery/cost";
import {
  COVERAGE_LABELS,
  FIT_ENRICH_CONCURRENCY,
  FIT_ENRICH_CONCURRENCY_ALL,
  FIT_ENRICH_DEADLINE_ALL_MS,
  FIT_ENRICH_DEADLINE_MS,
  FIT_FLAG_LABELS,
  FIT_PRICE_MAX,
  FIT_PRICE_SECTION_SPLIT,
  FIT_RENDERS_PER_WINDOW_ROW_MAX,
  FIT_SECTION_TITLES,
  FIT_SIZE_MIN,
  FIT_TABLE_HEADER,
  FIT_TABLE_MAX_ROWS,
  budpremieCell,
  conditionLineOf,
  formatTakhojdCell,
  formatStambyteCell,
  formatByggarendenCell,
  formatAreaCell,
  checkApifyHeadroom,
  computeCoverage,
  reasonsOnFlaggedOf,
  renderBrfLine,
  withReasonsOnFlagged,
  coverageOfRows,
  estimateFitRunUsd,
  fitRowKey,
  incompleteDistricts,
  renderAreaReport,
  renderCoverage,
  renderFitSections,
  renderFitTable,
  renderWindowReport,
  runFitPipeline,
  splitFitSections,
  toFitTableRows,
  type AreaReport,
  type EnrichmentLike,
  type FitPipelineDeps,
  type FitTableRow,
  type ScrapedRow,
} from "@/lib/discovery/fit-pipeline";
import {
  FIT_VISION_WINDOW,
  booliIdOf,
  parseFitSnapshot,
  preRank,
  rankFit,
  type FitInputRow,
  type FitScoreResult,
} from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import { candidateFactsSchema, type CandidateFacts } from "@/lib/discovery/listing-facts";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import type { SunPhrases } from "@/lib/discovery/sun-path";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";

// The 14.4 layout tests below exercise the layout WHEN IT INFLUENCES the score; the switch is off in production
// (LAYOUT_INFLUENCE_ENABLED, Daniel 2026-10-17), so this file runs the module with the switch on. The off
// behaviour is covered in layout-influence-off.test.ts and layout-fact.test.ts.
vi.mock("@/lib/discovery/layout-fact", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/discovery/layout-fact")>();
  return {
    ...orig,
    LAYOUT_INFLUENCE_ENABLED: true,
    usableSide: (f: Parameters<typeof orig.usableSide>[0], w: Parameters<typeof orig.usableSide>[1]) => orig.usableSideWhen(f, w, true),
    usablyNoBalcony: (f: Parameters<typeof orig.usablyNoBalcony>[0]) => orig.usablyNoBalconyWhen(f, true),
    korsdragOf: (f: Parameters<typeof orig.korsdragOf>[0]) => orig.korsdragWhen(f, true),
    quietBedroomOf: (f: Parameters<typeof orig.quietBedroomOf>[0]) => orig.quietBedroomWhen(f, true),
    formatSolCellWithLayout: (...a: [Parameters<typeof orig.formatSolCellWithLayout>[0], Parameters<typeof orig.formatSolCellWithLayout>[1], boolean]) =>
      orig.formatSolCellWithLayoutWhen(a[0], a[1], a[2], true),
  };
});

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
  /** Detail-side facts by window index (what watch-enrich returns). */
  facts?: Map<number, CandidateFacts>;
  /** Vision result per listing URL. */
  visionByUrl?: Map<string, VisionResult>;
  areas?: AreaReport[];
}

/** Fake deps. enrich replaces every entry except the failing ones; vision attaches a canned result. */
function fakeDeps(rows: ScrapedRow[], options: FakeOptions = {}) {
  const failIndexes = new Set(options.failIndexes ?? []);
  const scrape = vi.fn(async () => ({ rows, areas: options.areas ?? [] }));
  const enrich = vi.fn(
    async (candidates: DiscoveryCandidate[]): Promise<EnrichmentLike> => ({
      candidates: candidates.map((c, i) => (failIndexes.has(i) ? c : { ...c, imageUrls: [DETAIL_IMAGE] })),
      brokerImages: new Map(),
      sunPhrases: options.sunPhrases ?? new Map(),
      facts: options.facts,
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

const run = (deps: FitPipelineDeps, window?: number | "all") => runFitPipeline(deps, { model, asOf: AS_OF, window });

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

  it("WATCH-02 adjacency: the district that comes first in the scrape order keeps the listing", async () => {
    const a: ScrapedRow = { ...scrapedWith(base, 900001), district: "Södermalm" };
    const b: ScrapedRow = { district: "Vasastan", candidate: { ...a.candidate } };
    const forward = await run(fakeDeps([a, b]).deps);
    expect(forward.snapshot.rows.map((r) => r.district)).toEqual(["Södermalm"]);
    const reversed = await run(fakeDeps([b, a]).deps);
    expect(reversed.snapshot.rows.map((r) => r.district)).toEqual(["Vasastan"]);
  });
});

describe("the vision window (D-10, R-03)", () => {
  // The first 26 fixture rows; at least 25 are comparable on the fixture model.
  const rows26 = fixtureScraped.slice(0, 26);
  const comparableCount = preRank(
    rows26.map((r) => ({ district: r.district, detailFetched: false, inVisionWindow: false, sunPhrases: null, candidate: r.candidate, facts: null, sun: null, layout: null })),
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
      for (const v of [r.askingKr, r.expectedFinalKr, r.resaleKr, r.gapKr, r.renoMidKr, r.renoLowKr, r.renoHighKr, r.profitKr, r.tasteKr]) {
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

  it("the skillnad (value minus expected final) is whole kronor, equals the credit in the profit, and null stays null (D-05, 14.4)", () => {
    const wide: FitScoreResult = { ...sample[0], gapSek: 1_234_567.5, creditSek: 1_234_567.5 };
    const narrow: FitScoreResult = { ...sample[1], gapSek: 300_000.2, creditSek: 300_000.2 };
    const missing: FitScoreResult = { ...sample[2], gapSek: null, creditSek: null };
    const [a, b, c] = toFitTableRows({ ranked: [wide, narrow, missing] }, new Map());
    expect(a.gapKr).toBe(1_234_568);
    expect(b.gapKr).toBe(300_000);
    expect(c.gapKr).toBeNull();
    expect("creditKr" in a).toBe(false);
  });

  it("the header has one 'Skillnad' column right after 'Värde renoverad', and every row prints it once", () => {
    expect(FIT_TABLE_HEADER).toContain("Värde renoverad | Skillnad | Reno");
    expect(FIT_TABLE_HEADER.split(" | ").filter((h) => h === "Skillnad")).toHaveLength(1);
    const wide: FitScoreResult = { ...sample[0], gapSek: 1_234_567, creditSek: 1_234_567 };
    const text = renderFitTable(toFitTableRows({ ranked: [wide] }, new Map()));
    const cells = text.split("\n")[1].split(" | ");
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(cells).toHaveLength(headerCells.length);
    expect(cells[headerCells.indexOf("Skillnad")]).toBe((1_234_567).toLocaleString("sv-SE"));
  });

  it("budpremieCell shows the sign, one decimal with a decimal comma, and the makeup in brackets (VAL-03)", () => {
    const detail = (pct: number, label: string) => ({ ...sample[0].overbidDetail!, pct, label });
    expect(budpremieCell(null)).toBe("-");
    expect(budpremieCell(detail(0.0423, "distrikt+pris+dagar+skick"))).toBe("+4,2 % (distrikt+pris+dagar+skick)");
    expect(budpremieCell(detail(0.0423, "distrikt+pris+dagar, skick ej mätt"))).toBe("+4,2 % (distrikt+pris+dagar, skick ej mätt)");
    expect(budpremieCell(detail(-0.005, "distrikt"))).toBe("-0,5 % (distrikt)");
    expect(budpremieCell(detail(0, "distrikt"))).toBe("+0,0 % (distrikt)");
    expect(budpremieCell(detail(0.1049, "distrikt, dagar okända"))).toBe("+10,5 % (distrikt, dagar okända)");
  });

  it("conditionLineOf says whether condition was measured (BID-02, R-08)", () => {
    const withTerm = (term: unknown) => ({ bidPremium: { terms: { dom: null, condition: term } } }) as never;
    expect(conditionLineOf(withTerm(null))).toBe("Budpremie skick: ej mätt (prior 0): ingen skickterm i modellen");
    expect(conditionLineOf(withTerm({ beta: 0, source: "prior", kept: true, n: 0, cvRmse: null, note: "inga säljfoton" }))).toBe(
      "Budpremie skick: ej mätt (prior 0): inga säljfoton",
    );
    expect(conditionLineOf(withTerm({ beta: 0.021, source: "fit", kept: false, n: 220, cvRmse: null, note: "prövad, förkastad" }))).toBe(
      "Budpremie skick: ej mätt (prior 0): prövad, förkastad",
    );
    // The fitted model's own note starts with the phrase the line already says; it is not repeated.
    expect(
      conditionLineOf(withTerm({ beta: 0, source: "prior", kept: false, n: 5, cvRmse: null, note: "budpremie: skick ej mätt: för få märkta försäljningar (5 av minst 100)." })),
    ).toBe("Budpremie skick: ej mätt (prior 0): för få märkta försäljningar (5 av minst 100).");
    expect(conditionLineOf(withTerm({ beta: 0.0214, source: "fit", kept: true, n: 220, cvRmse: null, note: "med" }))).toBe(
      "Budpremie skick: mätt på 220 sålda (β 0,021)",
    );
  });

  it("the header puts 'Budpremie' between 'Utgångspris' and 'Förv. slutpris', and every row prints the cell at that index", () => {
    expect(FIT_TABLE_HEADER).toContain("| Utgångspris | Budpremie | Förv. slutpris |");
    const detail = { ...sample[0].overbidDetail!, pct: 0.0423, label: "distrikt+pris+dagar" };
    const text = renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], overbidDetail: detail }, { ...sample[1], overbidDetail: null }] }, new Map()));
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    const [first, second] = text.split("\n").slice(1).map((l) => l.split(" | "));
    expect(first).toHaveLength(headerCells.length);
    expect(first[headerCells.indexOf("Budpremie")]).toBe("+4,2 % (distrikt+pris+dagar)");
    expect(second[headerCells.indexOf("Budpremie")]).toBe("-");
  });

  it("the residual flag reads 'ovanligt långt under modellpris'; no flag label names a ceiling", () => {
    expect(FIT_FLAG_LABELS.residualFlag).toBe("ovanligt långt under modellpris");
    expect(Object.values(FIT_FLAG_LABELS).filter((l) => /tak/.test(l))).toEqual([]);
  });

  it("the header puts 'Varför här' right after 'Flaggor' and before 'Länk'; every row prints a cell for it", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(headerCells.indexOf("Varför här")).toBe(headerCells.indexOf("Flaggor") + 1);
    expect(headerCells.indexOf("Länk")).toBe(headerCells.indexOf("Varför här") + 1);
    const flagged: FitScoreResult = { ...sample[0], flags: ["residualFlag"] };
    const cells = renderFitTable(toFitTableRows({ ranked: [flagged] }, new Map(), { reasonsOf: () => ["tomträtt", "ute i 75 dagar"] }))
      .split("\n")[1]
      .split(" | ");
    expect(cells).toHaveLength(headerCells.length);
    expect(cells[headerCells.indexOf("Flaggor")]).toBe("ovanligt långt under modellpris");
    expect(cells[headerCells.indexOf("Varför här")]).toBe("tomträtt, ute i 75 dagar");
  });

  it("the header puts 'Sol' right after 'Smak'; a row prints '-' without a sun record and the formatted cell with one (D-02)", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(headerCells.indexOf("Sol")).toBe(headerCells.indexOf("Smak") + 1);
    expect(headerCells.indexOf("Flaggor")).toBe(headerCells.indexOf("Sol") + 9); // two hour columns (plan 07), Korsdrag, Sovrum (14.4 plan 08), Takhöjd (14.5 plan 01), Stambyte, Byggärenden and Area (14.6 plan 10) in between
    const none = renderFitTable(toFitTableRows({ ranked: [sample[0]] }, new Map())).split("\n")[1].split(" | ");
    expect(none).toHaveLength(headerCells.length);
    expect(none[headerCells.indexOf("Sol")]).toBe("-");
    const unknown = renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], sun: unknownSunFact("adress saknas") }] }, new Map()))
      .split("\n")[1]
      .split(" | ");
    expect(unknown[headerCells.indexOf("Sol")]).toBe("okänd");
  });

  it("the Sol cell shows the layout: applied picks the facade, otherwise a balcony word, and no layout leaves the 14.3 cell (14.4 LAY-02)", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    const solOf = (row: Partial<(typeof sample)[number]>): string =>
      renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], ...row }] }, new Map())).split("\n")[1].split(" | ")[headerCells.indexOf("Sol")];
    const sun: SunFact = {
      ...resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } }),
      source: "fastighet/gata",
      sides: [
        { side: "gata", facade: "south", bearingDeg: 170, share: 0.5, point: null, hours: null },
        { side: "gård", facade: "north", bearingDeg: 350, share: 0.5, point: null, hours: null },
      ],
    };
    const layout = {
      balconySide: "street", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
      windowSides: "one", bedroomSide: "street", streetEvidence: "cars", confidence: 0.9,
      source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
    } as const;
    expect(solOf({ sun, layout: null, layoutAppliedToSun: false })).toBe("S gata/N gård (fastighet/gata, 1,00)");
    expect(solOf({ sun, layout, layoutAppliedToSun: false })).toBe("S gata/N gård (fastighet/gata, 1,00), balkong gata");
    expect(solOf({ sun, layout, layoutAppliedToSun: true })).toBe("S gata (planritning+foto, 1,00), balkong gata");
  });

  it("the header ends the sun block with 'Korsdrag' and 'Sovrum' (LAY-03): unknown prints 'okänd', Folkungagatan 61's layout prints 'nej' and 'gata', a courtyard bedroom with two window sides 'ja' and 'gård'", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(FIT_TABLE_HEADER).toContain("| Soltim. med grannhus (mar/jun/dec) | Korsdrag | Sovrum | Takhöjd | Stambyte | Byggärenden | Area | Flaggor |");
    expect(headerCells.indexOf("Sovrum")).toBe(headerCells.indexOf("Korsdrag") + 1);
    const base: LayoutFact = {
      balconySide: "street", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
      windowSides: "one", bedroomSide: "street", streetEvidence: "oppositeFacade", confidence: 0.9,
      source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
    };
    const cellsOf = (layout: LayoutFact | null) => {
      const line = renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], layout }] }, new Map())).split("\n")[1].split(" | ");
      expect(line).toHaveLength(headerCells.length);
      return [line[headerCells.indexOf("Korsdrag")], line[headerCells.indexOf("Sovrum")]];
    };
    expect(cellsOf(null)).toEqual(["okänd", "okänd"]);
    expect(cellsOf(base)).toEqual(["nej", "gata"]);
    expect(cellsOf({ ...base, windowSides: "twoOpposite", bedroomSide: "courtyard" })).toEqual(["ja", "gård"]);
    const weak: LayoutFact = { ...base, windowSides: "twoOpposite", bedroomSide: "courtyard", confidence: 0.59 };
    expect(cellsOf(weak)).toEqual(["okänd", "okänd"]);
  });

  it("the header puts 'Takhöjd' right after 'Sovrum' (CEIL-01); a stored snapshot (no text) prints 'okänd' on every row", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(FIT_TABLE_HEADER).toContain("| Korsdrag | Sovrum | Takhöjd | Stambyte |");
    expect(headerCells.indexOf("Takhöjd")).toBe(headerCells.indexOf("Sovrum") + 1);
    expect(headerCells.indexOf("Stambyte")).toBe(headerCells.indexOf("Takhöjd") + 1);
    const rows = toFitTableRows({ ranked: sample }, new Map());
    expect(rows.every((r) => r.takhojd === "okänd")).toBe(true);
    const stated = candidateFactsSchema.parse({ ceilingHeightM: 3.2, ceilingSource: "angiven", tallCeilingPhrase: false });
    const flat = candidateFactsSchema.parse({ ceilingHeightM: null, tallCeilingPhrase: true });
    const cells = (facts: CandidateFacts | null) => {
      const line = renderFitTable(
        toFitTableRows({ ranked: [{ ...sample[0], ceilingHeightM: facts?.ceilingHeightM ?? null, tallCeilingPhrase: facts?.tallCeilingPhrase ?? null }] }, new Map()),
      )
        .split("\n")[1]
        .split(" | ");
      expect(line).toHaveLength(headerCells.length);
      return line[headerCells.indexOf("Takhöjd")];
    };
    expect(cells(stated)).toBe("3,2 m");
    expect(cells(flat)).toBe("högt i tak");
    expect(cells(null)).toBe("okänd");
  });

  it("formatTakhojdCell: one decimal and a decimal comma; a number beats the phrase; nothing stated is 'okänd'", () => {
    expect(formatTakhojdCell(3.2, false)).toBe("3,2 m");
    expect(formatTakhojdCell(3, false)).toBe("3,0 m");
    expect(formatTakhojdCell(3.4, true)).toBe("3,4 m");
    expect(formatTakhojdCell(null, true)).toBe("högt i tak");
    expect(formatTakhojdCell(null, false)).toBe("okänd");
    expect(formatTakhojdCell(null, null)).toBe("okänd");
  });

  it("formatStambyteCell: the completed year, 'genomfört' without a year, 'pågår', 'planerat 2027' / 'planerat', 'okänd' (STAM-03, D-07)", () => {
    const cell = (stambyteStatus: CandidateFacts["stambyteStatus"], lastStambyteYear: number | null = null, plannedStambyteYear: number | null = null) =>
      formatStambyteCell({ stambyteStatus, lastStambyteYear, plannedStambyteYear });
    expect(cell("genomfort", 2006)).toBe("2006");
    expect(cell("genomfort", 2019)).toBe("2019");
    expect(cell("pagar")).toBe("pågår");
    expect(cell("planerat", null, 2027)).toBe("planerat 2027");
    expect(cell("planerat")).toBe("planerat");
    expect(cell("genomfort")).toBe("genomfört");
    expect(cell(null)).toBe("okänd");
    // A year without a status is not shown: the status decides what the cell says.
    expect(cell(null, 2006, 2027)).toBe("okänd");
  });

  it("the header puts 'Stambyte', 'Byggärenden' and 'Area' between 'Takhöjd' and 'Flaggor'; a row without facts prints 'okänd' in all three, and the cells follow the result's facts", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(FIT_TABLE_HEADER).toBe(
      "# | Förrank | Adress | Område | kvm | vån | Utgångspris | Budpremie | Förv. slutpris | Värde renoverad | Skillnad | Reno (nivå, spann) | Vinst | Smak | Sol | Soltim. fri (mar/jun/dec) | Soltim. med grannhus (mar/jun/dec) | Korsdrag | Sovrum | Takhöjd | Stambyte | Byggärenden | Area | Flaggor | Varför här | Länk",
    );
    expect(headerCells.indexOf("Byggärenden")).toBe(headerCells.indexOf("Stambyte") + 1);
    expect(headerCells.indexOf("Area")).toBe(headerCells.indexOf("Byggärenden") + 1);
    expect(headerCells.indexOf("Flaggor")).toBe(headerCells.indexOf("Area") + 1);
    const printed = (r: FitScoreResult) => {
      const line = renderFitTable(toFitTableRows({ ranked: [r] }, new Map())).split("\n")[1].split(" | ");
      expect(line).toHaveLength(headerCells.length);
      return [line[headerCells.indexOf("Stambyte")], line[headerCells.indexOf("Byggärenden")], line[headerCells.indexOf("Area")]];
    };
    expect(printed(sample[0])).toEqual(["okänd", "okänd", "okänd"]);
    const known: FitScoreResult = {
      ...sample[0],
      stambyteStatus: "genomfort",
      lastStambyteYear: 2006,
      byggarenden: [
        { kind: "vind_inredning", month: "2023-10", decision: "slutbesked", slutbeskedMonth: "2024-02", diarie: null },
        { kind: "stambyte", month: "2006-05", decision: "slutbesked", slutbeskedMonth: null, diarie: null },
        { kind: "hiss", month: "2021-12", decision: "beviljad", slutbeskedMonth: null, diarie: null },
      ],
      areaSource: "uppmatt",
      areaMeasuredYear: 2019,
    };
    expect(printed(known)).toEqual(["2006", "vind 2023-10, hiss 2021-12", "uppmätt 2019"]);
  });

  it("formatByggarendenCell: '<kind> YYYY-MM' newest first, at most three, stambyte and relining left out, '-' for a read list with nothing, 'okänd' for an unknown building", () => {
    const item = (kind: NonNullable<CandidateFacts["byggarenden"]>[number]["kind"], month: string) => ({
      kind,
      month,
      decision: "beviljad" as const,
      slutbeskedMonth: null,
      diarie: null,
    });
    expect(formatByggarendenCell({ byggarenden: null })).toBe("okänd");
    expect(formatByggarendenCell({ byggarenden: [] })).toBe("-");
    expect(formatByggarendenCell({ byggarenden: [item("stambyte", "2024-01"), item("relining", "2023-05"), item("annat", "2023-01")] })).toBe("-");
    expect(
      formatByggarendenCell({
        byggarenden: [
          item("vind_inredning", "2024-09"),
          item("hiss", "2024-05"),
          item("tak", "2023-11"),
          item("fasad", "2023-02"),
          item("balkongdorr", "2022-08"),
        ],
      }),
    ).toBe("vind 2024-09, hiss 2024-05, tak 2023-11");
    // Stambyte items do not take one of the three places.
    expect(formatByggarendenCell({ byggarenden: [item("stambyte", "2024-09"), item("fasad", "2024-05")] })).toBe("fasad 2024-05");
  });

  it("formatAreaCell: the source in plain words and the measured year; 'okänd' without a source (FLAG-02)", () => {
    const cell = (areaSource: CandidateFacts["areaSource"], areaMeasuredYear: number | null = null) => formatAreaCell({ areaSource, areaMeasuredYear });
    expect(cell("uppmatt", 2019)).toBe("uppmätt 2019");
    expect(cell("uppmatt")).toBe("uppmätt");
    expect(cell("forening")).toBe("föreningen");
    expect(cell("ekonomisk_plan")).toBe("ekonomisk plan");
    expect(cell("lagenhetsregister")).toBe("lägenhetsregistret");
    expect(cell("saljare")).toBe("säljaren");
    expect(cell("ej_kontrollmatt")).toBe("ej kontrollmätt");
    expect(cell(null)).toBe("okänd");
    // A year belongs to a measurement only.
    expect(cell("forening", 2019)).toBe("föreningen");
  });

  it("the header puts the two hour columns right after 'Sol' and before 'Flaggor'; every printed row has as many cells as the header", () => {
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    expect(FIT_TABLE_HEADER).toContain("Smak | Sol | Soltim. fri (mar/jun/dec) | Soltim. med grannhus (mar/jun/dec) | Korsdrag | Sovrum | Takhöjd | Stambyte | Byggärenden | Area | Flaggor");
    const sun = resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } });
    const printed = renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], sun }, { ...sample[1], sun: null }] }, new Map())).split("\n");
    for (const line of printed.slice(1)) expect(line.split(" | ")).toHaveLength(headerCells.length);
    const rows = toFitTableRows({ ranked: [{ ...sample[0], sun }, { ...sample[1], sun: null }] }, new Map());
    expect(rows[0].solTheoretical).toBe("-"); // a stated side has no hours until computeSunFact fills them
    expect(rows[0].solObstructed).toBe("-");
    expect(rows[1].solTheoretical).toBe("-");
    expect(rows[1].solObstructed).toBe("-");
  });

  it("a row with hours prints the theoretical and obstructed cells at the header's indexes", () => {
    const hour = (w: number, r: [number, number, number] | null): DateHours => {
      const range = r === null ? null : { nominal: r[0], low: r[1], high: r[2] };
      return { theoreticalWindow: w, theoreticalDay: w + 1, obstructedWindow: range, obstructedDay: range, floorBelowWindow: null };
    };
    const base = resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } });
    const sun: SunFact = {
      ...base,
      sides: [{ ...base.sides[0], hours: { z: 16.5, heightsEstimated: false, mar: hour(6, [5, 4.5, 5.5]), jun: hour(5.5, [5, 4.5, 5.5]), sep: hour(5, [4, 3.5, 4.5]), dec: hour(4.1, [2, 1.5, 2.5]) } }],
    };
    const headerCells = FIT_TABLE_HEADER.split(" | ");
    const cells = renderFitTable(toFitTableRows({ ranked: [{ ...sample[0], sun }] }, new Map())).split("\n")[1].split(" | ");
    expect(cells[headerCells.indexOf("Soltim. fri (mar/jun/dec)")]).toBe("6,0/5,5/4,1");
    expect(cells[headerCells.indexOf("Soltim. med grannhus (mar/jun/dec)")]).toBe("5,0 (4,5\u20135,5) / 5,0 (4,5\u20135,5) / 2,0 (1,5\u20132,5)");
    expect(cells[headerCells.indexOf("Sol")]).toBe("S (angiven, 1,00)");
  });

  it("a flagged row with no reason prints 'oförklarat fynd', an unflagged one '-' (also without reasonsOf)", () => {
    const rows = toFitTableRows(
      { ranked: [{ ...sample[0], flags: ["hiddenDefectRisk", "residualFlag"] }, { ...sample[1], flags: ["ejBildtolkad"] }] },
      new Map(),
    );
    expect(rows[0].reasons).toBe("oförklarat fynd");
    expect(rows[1].reasons).toBe("-");
    const withCallback = toFitTableRows({ ranked: [{ ...sample[0], flags: ["residualFlag"] }] }, new Map(), { reasonsOf: () => [] });
    expect(withCallback[0].reasons).toBe("oförklarat fynd");
  });

  it("reasonsOf is called with the scored row", () => {
    const seen: (string | null)[] = [];
    toFitTableRows({ ranked: sample.slice(0, 3) }, new Map(), {
      reasonsOf: (r) => {
        seen.push(r.sourceListingUrl);
        return [];
      },
    });
    expect(seen).toEqual(sample.slice(0, 3).map((r) => r.sourceListingUrl));
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

describe("two price sections (D-12, WATCH-04)", () => {
  const base = toFitTableRows({ ranked: rankFit(snapshot.rows, model).ranked.slice(0, 1) }, new Map())[0];
  const row = (rank: number, expectedFinalKr: number | null): FitTableRow => ({
    ...base,
    rank,
    address: `Testgatan ${rank}`,
    expectedFinalKr,
  });

  it("the split is a constant at 4 000 000 and the titles are the two Swedish headings", () => {
    expect(FIT_PRICE_SECTION_SPLIT).toBe(4_000_000);
    expect(FIT_SECTION_TITLES).toEqual({ under: "Förväntat under 4 M", over: "Över 4 M förväntat" });
  });

  it("4 000 000 and 3 999 999 go to under, 4 000 001 and a missing expected final go to over", () => {
    const { under, over } = splitFitSections([row(1, 4_000_001), row(2, 4_000_000), row(3, null), row(4, 3_999_999)]);
    expect(under.map((r) => r.rank)).toEqual([2, 4]);
    expect(over.map((r) => r.rank)).toEqual([1, 3]);
  });

  it("keeps the input order inside each section and never renumbers '#'", () => {
    const rows = [row(1, 4_500_000), row(2, 3_900_000), row(3, 4_100_000), row(4, 3_000_000), row(5, 4_000_000)];
    const { under, over } = splitFitSections(rows);
    expect(under.map((r) => r.rank)).toEqual([2, 4, 5]);
    expect(over.map((r) => r.rank)).toEqual([1, 3]);
    const text = renderFitSections(rows);
    const numbered = text.split("\n").filter((l) => /^\d+ \| /.test(l)).map((l) => Number(l.split(" | ")[0]));
    expect(numbered).toEqual([2, 4, 5, 1, 3]);
  });

  it("prints the under section first with counts, then the over section, each with the table header", () => {
    const text = renderFitSections([row(1, 4_500_000), row(2, 3_900_000), row(3, 3_800_000)]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Förväntat under 4 M (2 annonser)");
    expect(lines[1]).toBe(FIT_TABLE_HEADER);
    const overAt = lines.indexOf("Över 4 M förväntat (1 annonser)");
    expect(overAt).toBeGreaterThan(1);
    expect(lines[overAt + 1]).toBe(FIT_TABLE_HEADER);
    expect(lines[overAt + 2].startsWith("1 | ")).toBe(true);
  });

  it("an empty section prints its heading with (0 annonser), the header and '0 kandidater'", () => {
    const onlyOver = renderFitSections([row(1, 4_500_000)]);
    expect(onlyOver).toContain(`Förväntat under 4 M (0 annonser)\n${FIT_TABLE_HEADER}\n0 kandidater`);
    const onlyUnder = renderFitSections([row(1, 3_000_000)]);
    expect(onlyUnder.endsWith(`Över 4 M förväntat (0 annonser)\n${FIT_TABLE_HEADER}\n0 kandidater`)).toBe(true);
    const none = renderFitSections([]);
    expect(none.match(/\(0 annonser\)/g)).toHaveLength(2);
    expect(none.match(/0 kandidater/g)).toHaveLength(2);
  });

  it("maxRows applies per section and the rest line is printed inside the section", () => {
    const many = Array.from({ length: 5 }, (_, i) => row(i + 1, 3_000_000));
    const text = renderFitSections(many, { maxRows: 2 });
    expect(text).toContain("Förväntat under 4 M (5 annonser)");
    expect(text).toContain("+3 till (se snapshot)");
    expect(text.split("\n").filter((l) => /^\d+ \| /.test(l))).toHaveLength(2);
  });

  it("the split does not change the ranking order: concatenated sections are the profit order restricted to each side", () => {
    const rows = toFitTableRows({ ranked: rankFit(snapshot.rows, model).ranked }, new Map());
    const { under, over } = splitFitSections(rows);
    expect(under.length + over.length).toBe(rows.length);
    const ranks = (rs: readonly FitTableRow[]) => rs.map((r) => r.rank);
    expect(ranks(under)).toEqual([...ranks(under)].sort((a, b) => a - b));
    expect(ranks(over)).toEqual([...ranks(over)].sort((a, b) => a - b));
  });
});

describe("run reports", () => {
  const okArea = (name: string): AreaReport => ({ name, listings: 12, renders: 3, ok: true, error: null });

  it("the area report says Kungsholmen: med when it was scraped, and SAKNAS when it failed or is absent", () => {
    const withIt = renderAreaReport([okArea("Södermalm"), okArea("Kungsholmen")]);
    expect(withIt).toContain("Kungsholmen: med");
    expect(withIt).toContain("Södermalm: 12 annonser (3 renders)");

    const failed = renderAreaReport([okArea("Södermalm"), { name: "Kungsholmen", listings: 0, renders: 0, ok: false, error: "timeout" }]);
    expect(failed).toContain("Kungsholmen: SAKNAS");
    expect(failed).toContain("MISSLYCKADES - timeout");
    expect(renderAreaReport([okArea("Södermalm")])).toContain("Kungsholmen: SAKNAS");
    expect(renderAreaReport([{ ...okArea("Kungsholmen"), listings: 0 }])).toContain("Kungsholmen: SAKNAS");
  });

  it("the window report lists the window in pre-rank order with outcomes and prints no listing link", async () => {
    const rows = fixtureScraped.slice(0, 26);
    const phrases = new Map<number, SunPhrases>([[0, { allDaySun: true, throughFlat: false }]]);
    const result = await run(fakeDeps(rows, { failIndexes: [1], sunPhrases: phrases }).deps);
    const text = renderWindowReport(result);
    const lines = text.split("\n");

    expect(lines[0]).toContain("20 annonser");
    expect(text).not.toContain("booli.se/");
    const listed = lines.filter((l) => l.startsWith("  Förrank "));
    expect(listed).toHaveLength(FIT_VISION_WINDOW);
    const positions = listed.map((l) => Number(/Förrank (\d+):/.exec(l)![1]));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain("detaljsida misslyckades");
    expect(text).toContain("solfras ja");
    expect(lines[lines.length - 1]).toContain("detaljsida hämtad 19/20");
    expect(lines[lines.length - 1]).toContain("solfraser 1/20");
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

describe('window "all" (D-06, WATCH-02)', () => {
  const rows = fixtureScraped;
  const comparable = preRank(
    rows.map((r) => ({ district: r.district, detailFetched: false, inVisionWindow: false, sunPhrases: null, candidate: r.candidate, facts: null, sun: null, layout: null })),
    model,
  ).ranked.length;

  it("enriches and picture-reads every comparable row, with the long deadline and the 2-page concurrency", async () => {
    expect(comparable).toBeGreaterThan(FIT_VISION_WINDOW);
    const { deps, enrich, vision } = fakeDeps(rows);
    const result = await run(deps, "all");

    const [enrichArg, limit, optsArg] = enrich.mock.calls[0] as unknown as [DiscoveryCandidate[], number, unknown];
    expect(enrichArg).toHaveLength(comparable);
    expect(limit).toBe(comparable);
    expect(optsArg).toEqual({ deadlineMs: FIT_ENRICH_DEADLINE_ALL_MS, concurrency: FIT_ENRICH_CONCURRENCY_ALL });
    expect(FIT_ENRICH_DEADLINE_ALL_MS).toBe(40 * 60_000);
    expect(vision.mock.calls[0][0]).toHaveLength(comparable);
    expect(result.window.size).toBe(comparable);
    expect(result.window.detailFetched).toBe(comparable);
    expect(result.snapshot.rows.filter((r) => r.inVisionWindow)).toHaveLength(comparable);
  });

  it("a numeric window keeps the 14.1 deadline and concurrency", async () => {
    const { deps, enrich } = fakeDeps(rows);
    await run(deps, 5);
    expect((enrich.mock.calls[0] as unknown as [unknown, unknown, unknown])[2]).toEqual({
      deadlineMs: FIT_ENRICH_DEADLINE_MS,
      concurrency: FIT_ENRICH_CONCURRENCY,
    });
  });

  it("zero candidates after filtering: neither enrichment nor vision is called and both sections say '0 kandidater'", async () => {
    const tooExpensive = scrapedWith(fixtureScraped[0], 900001, { price: FIT_PRICE_MAX + 1 });
    const { deps, enrich, vision } = fakeDeps([tooExpensive]);
    const result = await run(deps, "all");

    expect(enrich).not.toHaveBeenCalled();
    expect(vision).not.toHaveBeenCalled();
    const text = renderFitSections(toFitTableRows(result.ranking, result.preRankPositions));
    expect(text.match(/0 kandidater/g)).toHaveLength(2);
    expect(result.coverage.n).toBe(0);
    expect(renderCoverage(result.coverage)).toContain("detaljsida 0 av 0 (0,0 %)");
  });
});

describe("facts on the snapshot rows (R-08)", () => {
  const card = (patch: object) => candidateFactsSchema.parse(patch);
  const rows26 = fixtureScraped.slice(0, 26);
  /** The key of the first pre-ranked row, which is window index 0. */
  const firstKeyOf = async (rows: ScrapedRow[]): Promise<string> => {
    const probe = await run(fakeDeps(rows).deps);
    return [...probe.preRankPositions.entries()].find(([, pos]) => pos === 1)![0];
  };
  const withCardFacts = (rows: ScrapedRow[], key: string, facts: CandidateFacts): ScrapedRow[] =>
    rows.map((r) => (fitRowKey(r.candidate) === key ? { ...r, facts } : r));

  it("a window row carries the card facts merged with the detail facts; the detail wins", async () => {
    const firstKey = await firstKeyOf(rows26);
    const withCard = withCardFacts(rows26, firstKey, card({ avgiftMonthlySek: 3900, tenureForm: "Bostadsrätt", balcony: true }));
    const detail = card({ avgiftMonthlySek: 4100, balcony: false, elevatorListed: true, detailFetched: true });
    const result = await run(fakeDeps(withCard, { facts: new Map([[0, detail]]) }).deps);

    const row = result.snapshot.rows.find((r) => fitRowKey(r.candidate) === firstKey)!;
    expect(row.facts?.avgiftMonthlySek).toBe(4100); // detail wins
    expect(row.facts?.balcony).toBe(false); // detail false wins over a card true
    expect(row.facts?.tenureForm).toBe("Bostadsrätt"); // the card fills what the detail lacks
    expect(row.facts?.elevatorListed).toBe(true);
    expect(row.facts?.detailFetched).toBe(true);
  });

  it("a row outside the window keeps its card facts; a row with no facts at all is null", async () => {
    const withCard = rows26.map((r, i) => (i % 2 === 0 ? { ...r, facts: card({ tenureForm: "Bostadsrätt", avgiftMonthlySek: 3000 + i }) } : r));
    const result = await run(fakeDeps(withCard).deps, 3);
    const outside = result.snapshot.rows.filter((r) => !r.inVisionWindow);
    expect(outside.length).toBeGreaterThan(0);
    for (const r of outside) {
      const source = withCard.find((x) => fitRowKey(x.candidate) === fitRowKey(r.candidate))!;
      expect(r.facts).toEqual(source.facts ?? null);
    }
    expect(outside.some((r) => r.facts === null)).toBe(true);
    expect(outside.some((r) => r.facts !== null)).toBe(true);
  });

  it("a failed detail fetch leaves the card facts and no detail facts", async () => {
    const firstKey = await firstKeyOf(rows26);
    const withCard = withCardFacts(rows26, firstKey, card({ avgiftMonthlySek: 3900 }));
    const detail = card({ avgiftMonthlySek: 9999, detailFetched: true });
    const result = await run(fakeDeps(withCard, { failIndexes: [0], facts: new Map([[0, detail]]) }).deps);
    const row = result.snapshot.rows.find((r) => fitRowKey(r.candidate) === firstKey)!;
    expect(row.detailFetched).toBe(false);
    expect(row.facts?.avgiftMonthlySek).toBe(3900);
    expect(row.facts?.detailFetched).toBe(false);
  });

  it("detail facts alone become the row's facts when the card had none", async () => {
    const detail = card({ tenureForm: "Bostadsrätt", detailFetched: true });
    const result = await run(fakeDeps(fixtureScraped.slice(0, 3), { facts: new Map([[0, detail]]) }).deps);
    expect(result.snapshot.rows.filter((r) => r.facts?.tenureForm === "Bostadsrätt")).toHaveLength(1);
  });

  it("the facts survive JSON and a snapshot re-parse", async () => {
    const result = await run(fakeDeps(rows26).deps);
    const reparsed = parseFitSnapshot(JSON.parse(JSON.stringify(result.snapshot)));
    expect(reparsed.rows.map((r) => r.facts)).toEqual(result.snapshot.rows.map((r) => r.facts));
  });
});

describe("coverage (R-05)", () => {
  const baseRow = snapshot.rows[0];
  const plain = { orientation: null, balcony: null, vision: null, visionSkippedReason: null };
  const row = (patch: Partial<(typeof snapshot.rows)[number]> & { cand?: Partial<DiscoveryCandidate> } = {}) => {
    const { cand, ...rest } = patch;
    return { ...baseRow, detailFetched: false, sunPhrases: null, facts: null, ...rest, candidate: { ...baseRow.candidate, ...plain, ...cand } };
  };
  const knownOf = (rows: ReturnType<typeof row>[], label: (typeof COVERAGE_LABELS)[number]) =>
    computeCoverage(rows).items.find((i) => i.label === label)!.known;

  const hand = [
    row({
      detailFetched: true,
      facts: candidateFactsSchema.parse({
        balcony: true,
        descriptionRead: true,
        sunPhrases: ["kvällssol"],
        avgiftMonthlySek: 4000,
        tenureForm: "Bostadsrätt",
        detailFetched: true,
      }),
      cand: { vision: visionOf("Köket är nyrenoverat", "Badrummet är helrenoverat", "fräscht") },
    }),
    row({
      detailFetched: true,
      facts: candidateFactsSchema.parse({ balcony: false, descriptionRead: true, sunPhrases: [], tenureForm: "Bostadsrätt", detailFetched: true }),
      cand: { orientation: { facades: ["south"], confidence: 0.8 } },
    }),
    row({ cand: { balcony: true } }),
  ];

  it("counts each item on hand-built rows by the definitions", () => {
    const c = computeCoverage(hand);
    expect(c.n).toBe(3);
    expect(c.items.map((i) => i.label)).toEqual([...COVERAGE_LABELS]);
    expect(Object.fromEntries(c.items.map((i) => [i.label, i.known]))).toEqual({
      detaljsida: 2,
      "balkong känd": 3,
      "skick känt": 1,
      "beskrivning läst": 2,
      "sol/orientering angiven": 2,
      avgift: 1,
      upplåtelseform: 2,
    });
  });

  it("renders the pinned line exactly (decimal comma, one decimal, '<label> <k> av <N> (<p> %)')", () => {
    expect(renderCoverage(computeCoverage(hand))).toBe(
      "Täckning (3 annonser): detaljsida 2 av 3 (66,7 %), balkong känd 3 av 3 (100,0 %), skick känt 1 av 3 (33,3 %), " +
        "beskrivning läst 2 av 3 (66,7 %), sol/orientering angiven 2 av 3 (66,7 %), avgift 1 av 3 (33,3 %), upplåtelseform 2 av 3 (66,7 %), " +
        "föreningsskuld känd 0 av 3 (0,0 %), sol härledd 0 av 3 (0,0 %)",
    );
  });

  it("N = 0 prints '0 av 0 (0,0 %)' for every item and never divides by zero", () => {
    const text = renderCoverage(computeCoverage([]));
    expect(text.startsWith("Täckning (0 annonser): ")).toBe(true);
    // The seven plan-05 items plus "föreningsskuld känd" and (plan 14.3-07) "sol härledd".
    expect(text.match(/ 0 av 0 \(0,0 %\)/g)).toHaveLength(COVERAGE_LABELS.length + 2);
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("balcony: a card 'false' is not knowledge, a facts false from a detail page is", () => {
    expect(knownOf([row({ cand: { balcony: false } })], "balkong känd")).toBe(0);
    expect(knownOf([row({ cand: { balcony: true } })], "balkong känd")).toBe(1);
    expect(knownOf([row({ facts: candidateFactsSchema.parse({ balcony: false, detailFetched: true }) })], "balkong känd")).toBe(1);
  });

  it("condition: only a kitchen or overall claim counts, a bathroom claim alone does not", () => {
    const bathOnly: VisionResult = { ...ALL_FRESH, claims: [claim("bathroom", "Badrummet är helrenoverat")] };
    const overall: VisionResult = { ...ALL_FRESH, claims: [claim("overall", "fräscht")] };
    expect(knownOf([row({ cand: { vision: bathOnly } })], "skick känt")).toBe(0);
    expect(knownOf([row({ cand: { vision: overall } })], "skick känt")).toBe(1);
    expect(knownOf([row({ cand: { vision: { ...ALL_FRESH, claims: [] } } })], "skick känt")).toBe(0);
  });

  it("sun: stated facades, a stated phrase or the older allDaySun flag count; an empty phrase list does not", () => {
    expect(knownOf([row({ facts: candidateFactsSchema.parse({ sunPhrases: [] }) })], "sol/orientering angiven")).toBe(0);
    expect(knownOf([row({ facts: candidateFactsSchema.parse({ orientationFacades: ["west"] }) })], "sol/orientering angiven")).toBe(1);
    expect(knownOf([row({ sunPhrases: { allDaySun: true, throughFlat: false } })], "sol/orientering angiven")).toBe(1);
    expect(knownOf([row({ sunPhrases: { allDaySun: false, throughFlat: true } })], "sol/orientering angiven")).toBe(0);
  });

  it("an old snapshot row (no facts) reads as unknown, and coverageOfRows counts only comparable rows", () => {
    const c = coverageOfRows(snapshot.rows, model);
    const ranking = rankFit(snapshot.rows, model);
    expect(c.n).toBe(ranking.ranked.length);
    expect(c.items.find((i) => i.label === "upplåtelseform")!.known).toBe(0);
    expect(renderCoverage(c)).toMatch(/balkong känd \d+ av \d+ \(\d+,\d %\)/);
  });

  it("a live run reports coverage over its comparable rows", async () => {
    const detail = candidateFactsSchema.parse({ avgiftMonthlySek: 4100, tenureForm: "Bostadsrätt", descriptionRead: true, detailFetched: true });
    const facts = new Map<number, CandidateFacts>(Array.from({ length: 5 }, (_, i) => [i, detail]));
    const result = await run(fakeDeps(fixtureScraped.slice(0, 26), { facts }).deps, 5);
    expect(result.coverage.n).toBe(result.ranking.ranked.length);
    const get = (l: string) => result.coverage.items.find((i) => i.label === l)!.known;
    expect(get("detaljsida")).toBe(5);
    expect(get("upplåtelseform")).toBe(5);
    expect(get("avgift")).toBe(5);
  });
});

describe("coverage: association debt and reasons on flagged rows (WATCH-03, R-07)", () => {
  const withBrf = (debtPerSqm: number | null) => {
    const base = snapshot.rows[0];
    return {
      ...base,
      facts: candidateFactsSchema.parse({ brf: { loanSek: 1, areaSqm: 1, reportYear: 2024, debtPerSqm } }),
    };
  };
  const tableRow = (flags: string[], reasons: string): FitTableRow => ({
    ...toFitTableRows({ ranked: rankFit(snapshot.rows, model).ranked.slice(0, 1) }, new Map())[0],
    flags,
    reasons,
  });

  it("counts rows with a known debt per kvm; a brf object with a null debt does not count", () => {
    const c = computeCoverage([withBrf(1171), withBrf(null), snapshot.rows[1], withBrf(12_729)]);
    expect(c.brfDebt).toBe(2);
    expect(c.reasonsOnFlagged).toBeNull();
  });

  it("prints 'föreningsskuld känd k av N (p %)' right after upplåtelseform, the seven earlier items unchanged", () => {
    const text = renderCoverage(computeCoverage([withBrf(1171), withBrf(null), withBrf(3000), withBrf(null)]));
    expect(text).toContain("upplåtelseform 0 av 4 (0,0 %), föreningsskuld känd 2 av 4 (50,0 %)");
    expect(text.startsWith("Täckning (4 annonser): detaljsida 0 av 4 (0,0 %), balkong känd")).toBe(true);
    expect(text).not.toContain("anledning");
  });

  it("counts explained and unexplained flagged rows from the printed table rows", () => {
    const rows = [
      tableRow(["ovanligt långt under modellpris", "dold-defekt-risk"], "tomträtt"),
      tableRow(["ovanligt långt under modellpris"], "oförklarat fynd"),
      tableRow(["dold-defekt-risk"], "snart till salu (ej budgivning än)"),
      tableRow(["ej bildtolkad"], "-"),
      tableRow([], "-"),
    ];
    expect(reasonsOnFlaggedOf(rows)).toEqual({ explained: 2, unexplained: 1, flagged: 3 });
    expect(reasonsOnFlaggedOf([])).toEqual({ explained: 0, unexplained: 0, flagged: 0 });
  });

  it("appends 'anledning på flaggade rader: E förklarade, U oförklarat fynd av F' last, in the pinned shape", () => {
    const rows = [tableRow(["ovanligt långt under modellpris"], "tomträtt"), tableRow(["ovanligt långt under modellpris"], "oförklarat fynd")];
    const text = renderCoverage(withReasonsOnFlagged(computeCoverage([withBrf(1171), withBrf(null)]), rows));
    expect(text).toBe(
      "Täckning (2 annonser): detaljsida 0 av 2 (0,0 %), balkong känd 0 av 2 (0,0 %), skick känt 0 av 2 (0,0 %), " +
        "beskrivning läst 0 av 2 (0,0 %), sol/orientering angiven 0 av 2 (0,0 %), avgift 0 av 2 (0,0 %), upplåtelseform 0 av 2 (0,0 %), " +
        "föreningsskuld känd 1 av 2 (50,0 %), sol härledd 0 av 2 (0,0 %), anledning på flaggade rader: 1 förklarade, 1 oförklarat fynd av 2",
    );
    expect(text.endsWith("1 förklarade, 1 oförklarat fynd av 2")).toBe(true);
  });

  it("zero flagged rows print '0 förklarade, 0 oförklarat fynd av 0'", () => {
    const text = renderCoverage(withReasonsOnFlagged(computeCoverage([]), []));
    expect(text.endsWith("anledning på flaggade rader: 0 förklarade, 0 oförklarat fynd av 0")).toBe(true);
  });

  it("renders the BRF line in the pinned shape, zero included", () => {
    expect(renderBrfLine({ distinct: 30, fetched: 28, failed: 2 })).toBe("BRF-sidor: 28 av 30 lästa, 2 misslyckades");
    expect(renderBrfLine({ distinct: 0, fetched: 0, failed: 0 })).toBe("BRF-sidor: 0 av 0 lästa, 0 misslyckades");
  });

  it("a live run carries the enrichment's BRF stats through, and null when the enrichment has none", async () => {
    const detail = candidateFactsSchema.parse({ brf: { loanSek: 5, areaSqm: 1, reportYear: 2024, debtPerSqm: 5 }, detailFetched: true });
    const facts = new Map<number, CandidateFacts>(Array.from({ length: 3 }, (_, i) => [i, detail]));
    const deps = fakeDeps(fixtureScraped.slice(0, 26), { facts });
    const enrich = deps.enrich;
    enrich.mockImplementation(async (candidates: DiscoveryCandidate[]) => ({
      candidates: candidates.map((c) => ({ ...c, imageUrls: [DETAIL_IMAGE] })),
      brokerImages: new Map(),
      sunPhrases: new Map(),
      facts,
      brfStats: { distinct: 3, fetched: 2, failed: 1 },
    }));
    const result = await run(deps.deps, 3);
    expect(result.brfStats).toEqual({ distinct: 3, fetched: 2, failed: 1 });
    expect(result.coverage.brfDebt).toBe(3);
    const none = await run(fakeDeps(fixtureScraped.slice(0, 26)).deps, 3);
    expect(none.brfStats).toBeNull();
  });
});

describe("district completeness in the area report (R-04)", () => {
  const area = (name: string, patch: Partial<AreaReport> = {}): AreaReport => ({
    name,
    listings: 441,
    renders: 0,
    ok: true,
    error: null,
    totalCount: 444,
    pages: 13,
    complete: true,
    ...patch,
  });

  it("a complete district prints 'N av M annonser (P sidor, komplett)'", () => {
    const text = renderAreaReport([area("Södermalm"), area("Kungsholmen", { listings: 482, totalCount: 487, pages: 14 })]);
    expect(text).toContain("  Södermalm: 441 av 444 annonser (13 sidor, komplett)");
    expect(text).toContain("  Kungsholmen: 482 av 487 annonser (14 sidor, komplett)");
    expect(text.split("\n").at(-1)).toBe("Kandidatlista: komplett");
  });

  it("a short district prints 'ofullständig' and is named in the run line", () => {
    const text = renderAreaReport([area("Södermalm"), area("Vasastan", { listings: 300, totalCount: 509, pages: 9, complete: false })]);
    expect(text).toContain("  Vasastan: 300 av 509 annonser (9 sidor, ofullständig)");
    expect(text.split("\n").at(-1)).toBe("Kandidatlista: OFULLSTÄNDIG (Vasastan)");
  });

  it("an unknown total is never counted complete", () => {
    const unknown = area("Östermalm", { totalCount: null, complete: null });
    const text = renderAreaReport([area("Södermalm"), unknown]);
    expect(text).toContain("  Östermalm: 441 annonser (13 sidor, ofullständig: Booli angav inget antal)");
    expect(incompleteDistricts([area("Södermalm"), unknown])).toEqual(["Östermalm"]);
    expect(text.split("\n").at(-1)).toBe("Kandidatlista: OFULLSTÄNDIG (Östermalm)");
  });

  it("a failed district (including a page that had a count but no cards) is named, in scrape order", () => {
    const failed: AreaReport = { name: "Södermalm", listings: 0, renders: 0, ok: false, error: "Booli: sidan saknar annonser" };
    const areas = [failed, area("Vasastan", { complete: false, listings: 10 }), area("Östermalm")];
    expect(incompleteDistricts(areas)).toEqual(["Södermalm", "Vasastan"]);
    const text = renderAreaReport(areas);
    expect(text).toContain("MISSLYCKADES - Booli: sidan saknar annonser");
    expect(text.split("\n").at(-1)).toBe("Kandidatlista: OFULLSTÄNDIG (Södermalm, Vasastan)");
  });

  it("a 14.1 report without a count is not complete, and no district at all is not complete either", () => {
    const old: AreaReport = { name: "Södermalm", listings: 12, renders: 3, ok: true, error: null };
    expect(incompleteDistricts([old])).toEqual(["Södermalm"]);
    expect(renderAreaReport([old])).toContain("  Södermalm: 12 annonser (3 renders)");
    expect(renderAreaReport([])).toContain("Kandidatlista: OFULLSTÄNDIG (inga distrikt lästes)");
  });

  it("the Kandidatlista line comes right after the Kungsholmen line", () => {
    const lines = renderAreaReport([area("Södermalm"), area("Kungsholmen")]).split("\n");
    const k = lines.findIndex((l) => l.startsWith("Kungsholmen: "));
    expect(lines[k + 1]).toMatch(/^Kandidatlista: /);
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

describe("deps.sunOf: the sun stage before ranking (Phase 14.3, plan 07)", () => {
  const SOUTH: SunFact = resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } });
  const rowKey = (r: { sourceListingUrl: string | null; address: string | null; askingSek: number | null }) => r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;

  it("is called once per row in the snapshot (window, outside and not comparable), and every snapshot row carries the fact it returned", async () => {
    const rows = [
      ...fixtureScraped.slice(0, 8),
      scrapedWith(fixtureScraped[0], 900001, { price: 100_000, livingArea: 60 }), // not comparable: far under the model value
    ];
    const sunOf = vi.fn((row: { candidate: DiscoveryCandidate }): SunFact | null => (row.candidate.address === "Testgatan 900001" ? unknownSunFact("ingen byggnad inom 25 m") : SOUTH));
    const { deps } = fakeDeps(rows);
    const result = await run({ ...deps, sunOf }, 3); // a window of 3: the other rows are outside it

    expect(result.snapshot.rows.length).toBe(sunOf.mock.calls.length);
    expect(result.snapshot.rows.filter((r) => r.inVisionWindow)).toHaveLength(3);
    expect(result.snapshot.rows.filter((r) => !r.inVisionWindow).length).toBeGreaterThan(0);
    for (const r of result.snapshot.rows) {
      expect(r.sun).toEqual(r.candidate.address === "Testgatan 900001" ? unknownSunFact("ingen byggnad inom 25 m") : SOUTH);
    }
    expect(result.ranking.notComparable.length).toBeGreaterThan(0);
  });

  it("is applied BEFORE rankFit: a fact that adds taste changes that row's taste in the ranking", async () => {
    const rows = fixtureScraped.slice(0, 8);
    const without = await run(fakeDeps(rows).deps, "all");
    const { deps } = fakeDeps(rows);
    const withSun = await run({ ...deps, sunOf: () => SOUTH }, "all");

    const tasteOf = (res: typeof without) => new Map(res.ranking.ranked.map((r) => [rowKey(r), r.tasteSek]));
    const before = tasteOf(without);
    const after = tasteOf(withSun);
    expect([...after.entries()].some(([key, taste]) => taste > (before.get(key) ?? 0))).toBe(true);
    for (const r of withSun.ranking.ranked) expect(r.sun).toEqual(SOUTH);
  });

  it("without sunOf every row keeps sun null and the ranking is what it was", async () => {
    const rows = fixtureScraped.slice(0, 6);
    const a = await run(fakeDeps(rows).deps, "all");
    expect(a.snapshot.rows.every((r) => r.sun === null)).toBe(true);
    expect(a.ranking.ranked.every((r) => r.sun === null)).toBe(true);
  });

  it("a sunOf that returns null leaves the row's sun null", async () => {
    const { deps } = fakeDeps(fixtureScraped.slice(0, 4));
    const result = await run({ ...deps, sunOf: () => null }, "all");
    expect(result.snapshot.rows.every((r) => r.sun === null)).toBe(true);
  });
});

describe("coverage: 'sol härledd' (Phase 14.3, SUN-05)", () => {
  const sunRow = (sun: SunFact | null): FitInputRow => ({ ...snapshot.rows[0], sun });
  const south = resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } });
  const noBuilding = unknownSunFact("ingen byggnad inom 25 m");

  it("counts rows whose sun fact has a source other than okänd; a null fact and an okänd fact do not count", () => {
    const coverage = computeCoverage([sunRow(south), sunRow(south), sunRow(noBuilding), sunRow(null)]);
    expect(coverage.n).toBe(4);
    expect(coverage.sunInferred).toBe(2);
  });

  it("prints right after 'föreningsskuld känd' and before the reasons item; the seven pinned labels stay byte-identical and in order", () => {
    const rows = [sunRow(south), sunRow(noBuilding)];
    const flagged = withReasonsOnFlagged(computeCoverage(rows), []);
    const text = renderCoverage(flagged);
    expect(text).toMatch(/föreningsskuld känd 0 av 2 \(0,0 %\), sol härledd 1 av 2 \(50,0 %\), anledning på flaggade rader: 0 förklarade, 0 oförklarat fynd av 0$/);
    expect([...COVERAGE_LABELS]).toEqual([
      "detaljsida",
      "balkong känd",
      "skick känt",
      "beskrivning läst",
      "sol/orientering angiven",
      "avgift",
      "upplåtelseform",
    ]);
    const order = [...COVERAGE_LABELS, "föreningsskuld känd", "sol härledd", "anledning på flaggade rader"].map((label) => text.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("an empty row list prints 'sol härledd 0 av 0 (0,0 %)'", () => {
    expect(renderCoverage(computeCoverage([]))).toContain("sol härledd 0 av 0 (0,0 %)");
  });

  it("percentages: 61 of 77 is (79,2 %), 62 of 77 is (80,5 %), 75 of 77 is (97,4 %)", () => {
    const of = (k: number): string => renderCoverage({ ...computeCoverage([]), n: 77, sunInferred: k });
    expect(of(61)).toContain("sol härledd 61 av 77 (79,2 %)");
    expect(of(62)).toContain("sol härledd 62 av 77 (80,5 %)");
    expect(of(75)).toContain("sol härledd 75 av 77 (97,4 %)");
  });

  it("the live pipeline counts the sun stage's facts in its coverage", async () => {
    const rows = fixtureScraped.slice(0, 6);
    const { deps } = fakeDeps(rows);
    const withSun = await run({ ...deps, sunOf: () => south }, "all");
    expect(withSun.coverage.sunInferred).toBe(withSun.coverage.n);
    expect((await run(fakeDeps(rows).deps, "all")).coverage.sunInferred).toBe(0);
  });
});

describe("deps.layout: the layout read beside the picture read (Phase 14.4, plan 08, R-07)", () => {
  const layoutOf = (over: Partial<LayoutFact> = {}): LayoutFact => ({
    balconySide: "street", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
    windowSides: "twoOpposite", bedroomSide: "courtyard", streetEvidence: "oppositeFacade", confidence: 0.9,
    source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
    ...over,
  });

  it("window row 0 gets the fact the dependency returned for index 0, row 1 gets null; outside rows keep null", async () => {
    const rows = fixtureScraped.slice(0, 8);
    const { deps } = fakeDeps(rows);
    const layout = vi.fn(async (cs: DiscoveryCandidate[]) => cs.map((_c, i) => (i === 0 ? layoutOf() : null)));
    const result = await run({ ...deps, layout }, 3);
    const windowRows = result.snapshot.rows.filter((r) => r.inVisionWindow);
    expect(windowRows).toHaveLength(3);
    expect(windowRows[0].layout).toEqual(layoutOf());
    expect(windowRows[1].layout).toBeNull();
    expect(windowRows[2].layout).toBeNull();
    for (const r of result.snapshot.rows.filter((x) => !x.inVisionWindow)) expect(r.layout).toBeNull();
  });

  it("is called once, with exactly the candidates and the broker bytes the picture read received", async () => {
    const rows = fixtureScraped.slice(0, 6);
    const { deps, vision } = fakeDeps(rows);
    const layout = vi.fn<NonNullable<FitPipelineDeps["layout"]>>(async (cs) => cs.map(() => null));
    await run({ ...deps, layout }, 4);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(vision).toHaveBeenCalledTimes(1);
    expect(layout.mock.calls[0][0]).toBe(vision.mock.calls[0][0]);
    // the fake enrichment holds no broker photo, so the bytes the dependency can ask for are none, at every index
    const asked = layout.mock.calls[0][1].brokerImagesOf;
    for (let i = 0; i < layout.mock.calls[0][0].length; i++) expect(asked(layout.mock.calls[0][0][i], i)).toEqual([]);
  });

  it("is not called when nothing is comparable (empty window)", async () => {
    const { deps } = fakeDeps([]);
    const layout = vi.fn(async () => []);
    await run({ ...deps, layout });
    expect(layout).not.toHaveBeenCalled();
  });

  it("without deps.layout every row has layout null", async () => {
    const result = await run(fakeDeps(fixtureScraped.slice(0, 5)).deps, "all");
    expect(result.snapshot.rows.every((r) => r.layout === null)).toBe(true);
    expect(result.coverage.layout).toEqual({ read: 0, balcony: 0, windowSides: 0, bedroom: 0, appliedToSun: 0 });
  });

  it("a returned fact reaches the ranking: korsdrag and a courtyard bedroom add taste", async () => {
    const rows = fixtureScraped.slice(0, 6);
    const without = await run(fakeDeps(rows).deps, "all");
    const { deps } = fakeDeps(rows);
    const withLayout = await run({ ...deps, layout: async (cs) => cs.map(() => layoutOf()) }, "all");
    const key = (r: { sourceListingUrl: string | null; address: string | null; askingSek: number | null }) => r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;
    const before = new Map(without.ranking.ranked.map((r) => [key(r), r]));
    let raised = 0;
    for (const r of withLayout.ranking.ranked) {
      expect(r.tasteKorsdragPct).toBe(0.01);
      expect(r.tasteQuietBedroomPct).toBe(0.01);
      if (r.tasteSek > (before.get(key(r))?.tasteSek ?? 0)) raised += 1;
    }
    expect(raised).toBeGreaterThan(0);
  });
});

describe("layout coverage (Phase 14.4, LAY-04)", () => {
  const baseRow = (): FitInputRow => ({ ...(snapshot.rows[0] as FitInputRow), layout: null, sun: null });
  const fact = (over: Partial<LayoutFact> = {}): LayoutFact => ({
    balconySide: "street", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
    windowSides: "one", bedroomSide: "street", streetEvidence: "cars", confidence: 0.9,
    source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
    ...over,
  });
  const footprintSun = (): SunFact => ({
    ...resolveSunFact({ stated: ["south"], plan: null, footprint: { status: "unknown", reason: "adress saknas" } }),
    source: "fastighet/gata",
    sides: [
      { side: "gata", facade: "south", bearingDeg: 170, share: 0.5, point: null, hours: null },
      { side: "gård", facade: "north", bearingDeg: 350, share: 0.5, point: null, hours: null },
    ],
  });

  it("counts usable balcony, window sides and bedroom side by the gate, and the rows where the sun used the layout", () => {
    const rows: FitInputRow[] = [
      { ...baseRow(), layout: fact(), sun: footprintSun() }, // all usable, applied to the sun
      { ...baseRow(), layout: fact({ balconySide: "none", streetEvidence: "none", bedroomSide: "unknown", windowSides: "unknown" }) }, // confident no balcony only
      { ...baseRow(), layout: fact({ confidence: 0.59 }) }, // read, nothing usable
      { ...baseRow(), layout: fact({ balconySide: "courtyard", streetEvidence: "none", windowSides: "twoOpposite" }) }, // no photo evidence: balcony and bedroom unusable, windows usable
      baseRow(), // no layout
    ];
    const c = computeCoverage(rows);
    expect(c.layout).toEqual({ read: 4, balcony: 2, windowSides: 2, bedroom: 1, appliedToSun: 1 });
  });

  it("renderCoverage prints the Planlösning line when a layout was read, and the old text when none was", () => {
    const rows: FitInputRow[] = [{ ...baseRow(), layout: fact(), sun: footprintSun() }, baseRow()];
    const text = renderCoverage(computeCoverage(rows));
    expect(text.split("\n")[1]).toBe("Planlösning: balkongsida 1, korsdrag känt 1, sovrumssida 1, sol från planlösning 1 av 2");
    expect(text.split("\n")[0].startsWith("Täckning (2 annonser): ")).toBe(true);
    expect(renderCoverage(computeCoverage([baseRow()]))).not.toContain("Planlösning");
  });
});

describe("ceiling coverage (Phase 14.5, CEIL-01)", () => {
  const baseRow = (): FitInputRow => ({ ...(snapshot.rows[0] as FitInputRow), layout: null, sun: null, facts: null });
  const withCeiling = (ceilingHeightM: number | null, tallCeilingPhrase: boolean | null): FitInputRow => ({
    ...baseRow(),
    facts: candidateFactsSchema.parse({ ceilingHeightM, ceilingSource: ceilingHeightM === null ? null : "angiven", tallCeilingPhrase }),
  });

  it("counts read (the parser ran), stated (a number) and tallOnly (the flag and no number)", () => {
    const rows: FitInputRow[] = [
      withCeiling(3.2, false), // read, stated
      withCeiling(3.6, true), // read, stated, flag too: not tallOnly
      withCeiling(null, true), // read, tallOnly
      withCeiling(null, false), // read, nothing stated
      baseRow(), // no facts: not read
      { ...baseRow(), facts: candidateFactsSchema.parse({}) }, // facts without the keys: not read
    ];
    expect(computeCoverage(rows).ceiling).toEqual({ read: 4, stated: 2, tallOnly: 1 });
  });

  it("an old snapshot (no row read) has all three at 0", () => {
    expect(computeCoverage([baseRow(), baseRow()]).ceiling).toEqual({ read: 0, stated: 0, tallOnly: 0 });
    expect(computeCoverage([]).ceiling).toEqual({ read: 0, stated: 0, tallOnly: 0 });
  });

  it("with read 0 the output is byte-identical to today's (no Takhöjd line)", () => {
    const text = renderCoverage(computeCoverage([baseRow(), baseRow()]));
    expect(text).not.toContain("Takhöjd");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("prints the Takhöjd line right after the Täckning line, and the Täckning line itself is unchanged", () => {
    const rows: FitInputRow[] = [withCeiling(3.2, false), withCeiling(null, true), withCeiling(null, false)];
    const lines = renderCoverage(computeCoverage(rows)).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("Täckning (3 annonser): ")).toBe(true);
    expect(lines[0]).not.toContain("Takhöjd");
    expect(lines[1]).toBe("Takhöjd: angiven i 1 av 3 lästa beskrivningar (högt i tak utan siffra 1)");
  });

  it("the Takhöjd line goes before the Planlösning line when both are printed", () => {
    const layout: LayoutFact = {
      balconySide: "street", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
      windowSides: "one", bedroomSide: "street", streetEvidence: "cars", confidence: 0.9,
      source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
    };
    const rows: FitInputRow[] = [{ ...withCeiling(3.4, false), layout }];
    const lines = renderCoverage(computeCoverage(rows)).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("Takhöjd: angiven i 1 av 1 lästa beskrivningar (högt i tak utan siffra 0)");
    expect(lines[2].startsWith("Planlösning: ")).toBe(true);
  });
});
