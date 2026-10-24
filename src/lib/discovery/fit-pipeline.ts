/**
 * fit-pipeline.ts - the headless run order for the personal fit score (Phase
 * 14.1, FIT-05, D-12): scrape the four innerstan districts, de-duplicate, apply
 * Daniel's hard filters, rank every comparable flat for free, spend money on
 * detail pages and picture reading only for the top FIT_VISION_WINDOW, then
 * re-rank by profit.
 *
 * ORCHESTRATION WITH INJECTED I/O. This module reaches no network, file or
 * environment: the scrape, the detail-page enrichment and the picture read are
 * arguments (`FitPipelineDeps`). `scripts/fit-score.ts` passes the real ones;
 * the tests pass fakes; the Phase 14.2 email can call `runFitPipeline` with the
 * same real ones instead of re-implementing the order of paid calls.
 *
 * Phase 14.2 (WATCH-02, D-06): `window: "all"` reads every comparable row (detail
 * page, broker page, facts record) through the free local browser; the facts record
 * rides on each row beside the candidate (R-08); the area report says "N av M
 * annonser" per district and whether the whole candidate list is complete (R-04); and
 * {@link computeCoverage} / {@link renderCoverage} print how much of each fact is
 * actually known (R-05).
 *
 * It imports types only from job.ts, vision and the broker modules, so loading
 * it loads no Apify transport and no Anthropic client. `niche-score.ts` and
 * `report/flags.ts` must never import it (registered in 14.1-01).
 *
 * MONEY: the pure scoring modules keep floats. Rounding to whole kronor
 * happens once, in {@link toFitTableRows}, because that is where a person
 * reads the number (FIT-03 precision).
 *
 * SPEND (R-13): {@link estimateFitRunUsd} is a priced WORST case, never an
 * average, and {@link checkApifyHeadroom} compares it with what is left of the
 * Apify month before the first paid call. The check informs; it is not an
 * approval step (the spend itself is pre-approved).
 */

import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import { filterCandidates, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { AREA_MAX_RENDERS_PER_AREA, OBSERVED_USD_PER_TIMED_OUT_RENDER } from "@/lib/discovery/cost";
import {
  FIT_VISION_WINDOW,
  booliIdOf,
  inferredSunWithLayout,
  preRank,
  rankFit,
  selectVisionWindow,
  type FitFlag,
  type FitInputRow,
  type FitScoreResult,
  type FitSnapshot,
  type ModelHealth,
} from "@/lib/discovery/fit-score";
import { readConditionTerm, type HedonicModel, type InnerstanDistrict, type OverbidDetail } from "@/lib/discovery/hedonic-model";
import type { EnrichmentResult } from "@/lib/discovery/job";
import { areaUpsideSek, type AreaFacts, type AreaSource } from "@/lib/discovery/area-source";
import { mergeFacts, type CandidateFacts } from "@/lib/discovery/listing-facts";
import {
  formatKorsdragCell,
  formatSolCellWithLayout,
  formatSovrumCell,
  korsdragOf,
  quietBedroomOf,
  korsdragWhen,
  quietBedroomWhen,
  usableSideWhen,
  usablyNoBalconyWhen,
  LAYOUT_INFLUENCE_ENABLED,
  LAYOUT_NO_INFLUENCE_SUFFIX,
  type LayoutFact,
} from "@/lib/discovery/layout-fact";
import { formatSolHours, type SunFact } from "@/lib/discovery/sun-fact";
import type { CaseKind } from "@/lib/stockholm/bygglov-classify";
import { UNEXPLAINED_LABEL, isReasonFlagged, reasonCell } from "@/lib/discovery/watch-reasons";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wall-clock budget for the headless detail-page stage. The in-app ENRICH_DEADLINE_MS stays 120 s. */
export const FIT_ENRICH_DEADLINE_MS = 15 * 60_000;

/**
 * Wall-clock budget for window "all" (Phase 14.2, D-06): about 100 candidates, each a detail page
 * (~5 s through the local browser's 2-page gate) and often a broker page. Generous on purpose: the
 * deadline is a safety net, not the expected duration.
 */
export const FIT_ENRICH_DEADLINE_ALL_MS = 40 * 60_000;

/** Detail pages fetched at the same time (each one is a paid render). */
export const FIT_ENRICH_CONCURRENCY = 4;

/** Window "all": the local browser opens at most 2 pages at once, so more candidates in flight would only queue. */
export const FIT_ENRICH_CONCURRENCY_ALL = 2;

/** D-10 "(cap 60)" read as the printed-table cap. The ranking itself covers every comparable row. */
export const FIT_TABLE_MAX_ROWS = 60;

/** D-08: asking price ceiling in SEK, inclusive. */
export const FIT_PRICE_MAX = 4_000_000;

/** D-08: smallest living area in m2, inclusive. */
export const FIT_SIZE_MIN = 35;

/**
 * Paid renders one window row can cost at worst: the detail page goes through
 * fetchListing's two own-render rungs (the paid Lexis rung is disabled) and the
 * broker page is one headless render.
 */
export const FIT_RENDERS_PER_WINDOW_ROW_MAX = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One scraped listing with the district it was scraped from. */
export interface ScrapedRow {
  readonly district: InnerstanDistrict;
  readonly candidate: DiscoveryCandidate;
  /** What the search card said beyond the candidate (R-08); absent in older callers. */
  readonly facts?: CandidateFacts | null;
}

/** What happened when one district was scraped. */
export interface AreaReport {
  readonly name: string;
  readonly listings: number;
  readonly renders: number;
  readonly ok: boolean;
  readonly error: string | null;
  /** Booli's own count for the district (Phase 14.2, R-04); null = Booli printed none; absent = not measured. */
  readonly totalCount?: number | null;
  /** Pages that came back with data. */
  readonly pages?: number;
  /** Every counted listing is in hand (fetchAreaListings.complete); null = unknown. */
  readonly complete?: boolean | null;
}

/** What the BRF stage did (Phase 14.2, R-07): distinct associations, pages read, pages that failed or were not reached. */
export interface BrfStats {
  readonly distinct: number;
  readonly fetched: number;
  readonly failed: number;
}

export type EnrichmentLike = Pick<EnrichmentResult, "candidates" | "brokerImages" | "sunPhrases"> & {
  /** Detail-side facts by window index (watch-enrich.ts); absent from the in-app enrichment. */
  readonly facts?: ReadonlyMap<number, CandidateFacts>;
  /** The BRF page stage (watch-enrich.ts); absent from the in-app enrichment. */
  readonly brfStats?: BrfStats;
  /** CR-01 (watch-enrich.ts): "utmaning" when Booli refused the run and the enrichment stopped early; absent otherwise. */
  readonly stoppedBy?: "utmaning" | null;
};

export interface FitPipelineDeps {
  /** Scrapes the districts. Never rejects for one failed district: that district is reported with ok false. */
  scrape(): Promise<{ rows: ScrapedRow[]; areas: AreaReport[] }>;
  /** Detail-fetches candidates that have no images (job.ts enrichCandidateImages). */
  enrich(
    candidates: DiscoveryCandidate[],
    limit: number,
    opts: { deadlineMs: number; concurrency: number },
  ): Promise<EnrichmentLike>;
  /** Reads the pictures (vision.ts runVisionPass). */
  vision(
    candidates: DiscoveryCandidate[],
    opts: { brokerImagesOf: (candidate: DiscoveryCandidate, index: number) => BrokerImageBytes[] },
  ): Promise<DiscoveryCandidate[]>;
  /**
   * Phase 14.3: what the sun spike works out for one flat (facade, source, confidence, hours). Pure and
   * offline (the cached OSM map, never a request). Applied to every row (window, outside and not
   * comparable) BEFORE ranking, so taste, the table and the coverage all see the same fact. Absent:
   * every row keeps `sun: null`.
   */
  sunOf?: (row: FitInputRow) => SunFact | null;
  /**
   * Phase 14.4 (R-07): the layout read for the window rows. Called right after `vision` with the SAME
   * candidates and the SAME `brokerImagesOf` (broker photo bytes exist only here, in memory), and answers
   * one stored fact per candidate, or null where the read did not run or could not be used. Rows outside
   * the window and not-comparable rows keep `layout: null`. Absent: every row has `layout: null`.
   */
  layout?: (
    candidates: DiscoveryCandidate[],
    opts: { brokerImagesOf: (candidate: DiscoveryCandidate, index: number) => BrokerImageBytes[] },
  ) => Promise<(LayoutFact | null)[]>;
}

/**
 * The city stage as the live run uses it (Phase 14.6, STAM-03, FLAG-01). `run` gets one row per detail-fetched candidate and
 * answers the new facts in the same order plus the coverage line to print; the caller builds it (dynamic imports, the city
 * client, Min Karta), so this module loads no city or network module. See {@link withCityStage}.
 */
export interface CityStageHook {
  run(rows: ReadonlyArray<{ address: string; brfName: string | null; facts: CandidateFacts }>): Promise<{
    readonly facts: ReadonlyArray<CandidateFacts | null>;
    readonly line: string;
  }>;
  log(line: string): void;
}

/** What the run says when the city stage failed outright; the run goes on with the facts the enrichment made. */
export const CITY_STAGE_FAILED_LINE = "Stadens ärendelista: misslyckades, körningen fortsätter utan stadens uppgifter";

/**
 * Wraps the enrichment so the city stage runs right after it, over the candidates that got a facts record (R-02: the stage is
 * allowed inside the weekly window). The new facts replace the enrichment's own for those candidates. NEVER lets the stage fail
 * the run: any error inside it (a refusal included) is swallowed, one fixed line is logged, and the enrichment is returned as
 * it was. Nothing about the error is printed, so no text from the city can reach the log.
 */
export function withCityStage(enrich: FitPipelineDeps["enrich"], hook: CityStageHook): FitPipelineDeps["enrich"] {
  return async (candidates, limit, opts) => {
    const enrichment = await enrich(candidates, limit, opts);
    try {
      const own = enrichment.facts;
      if (own === undefined || own.size === 0) return enrichment;
      const indexes = [...own.keys()].sort((a, b) => a - b);
      const result = await hook.run(
        indexes.map((i) => ({
          address: enrichment.candidates[i]?.address ?? candidates[i]?.address ?? "",
          brfName: (own.get(i) as CandidateFacts).brfName,
          facts: own.get(i) as CandidateFacts,
        })),
      );
      const next = new Map(own);
      indexes.forEach((index, k) => {
        const facts = result.facts[k];
        if (facts !== undefined && facts !== null) next.set(index, facts);
      });
      hook.log(result.line);
      return { ...enrichment, facts: next };
    } catch {
      try {
        hook.log(CITY_STAGE_FAILED_LINE);
      } catch {
        // A log that throws must not cost the run either.
      }
      return enrichment;
    }
  };
}

/** How many descriptions the area audit prints (FLAG-02). */
export const AREA_AUDIT_MAX_TEXTS = 60;

/**
 * The terminal callback of `--area-audit` (FLAG-02, T-14.6-93): one "Areagranskning <i>: <källa> | <masked clause>" line per
 * clause of each of the first {@link AREA_AUDIT_MAX_TEXTS} descriptions, "(ingen areamening)" for a text with no clause.
 * The clauses arrive already masked from the reader; this only prints them (to `print`, which the caller points at stdout)
 * and writes nothing anywhere.
 */
export function makeAreaAudit(
  print: (line: string) => void,
  limit: number = AREA_AUDIT_MAX_TEXTS,
): (lines: string[], facts: AreaFacts) => void {
  let seen = 0;
  return (lines, facts) => {
    if (seen >= limit) return;
    seen += 1;
    const source = facts.areaSource === null ? "okänd" : formatAreaCell({ areaSource: facts.areaSource, areaMeasuredYear: facts.areaMeasuredYear });
    if (lines.length === 0) print(`Areagranskning ${seen}: ${source} | (ingen areamening)`);
    for (const line of lines) print(`Areagranskning ${seen}: ${source} | ${line}`);
  };
}

export interface FitWindowStats {
  readonly size: number;
  readonly detailFetched: number;
  readonly orientationStated: number;
  /** Rows where the broker text stated "sol hela dagen" or "genomgående". */
  readonly sunPhrases: number;
  readonly visionWithClaims: number;
  /** Skipped reason -> number of window rows. */
  readonly visionSkipped: Record<string, number>;
}

export interface FitPipelineResult {
  readonly ranking: { ranked: FitScoreResult[]; notComparable: FitScoreResult[]; health: ModelHealth };
  /** Free pre-rank position (1-based) by {@link fitRowKey}. */
  readonly preRankPositions: Map<string, number>;
  readonly window: FitWindowStats;
  /** Sum of the window rows' vision spend, SEK. */
  readonly visionSek: number;
  readonly snapshot: FitSnapshot;
  readonly areas: AreaReport[];
  readonly counts: { scraped: number; deduped: number; filtered: number };
  /** R-05: how much is known across the comparable rows. */
  readonly coverage: Coverage;
  /** R-07: the BRF page stage; null when the enrichment did not read BRF pages (in-app or Apify path). */
  readonly brfStats: BrfStats | null;
  /** CR-01: "utmaning" when the enrichment was cut short because Booli refused the run; null otherwise. */
  readonly enrichStoppedBy: "utmaning" | null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The de-duplication and pre-rank key: the listing URL, else address and price. */
export function fitRowKey(c: Pick<DiscoveryCandidate, "sourceListingUrl" | "address" | "price">): string {
  return c.sourceListingUrl ?? `${c.address}|${c.price}`;
}

function dedupe(rows: readonly ScrapedRow[]): ScrapedRow[] {
  const seen = new Set<string>();
  const out: ScrapedRow[] = [];
  for (const row of rows) {
    const key = fitRowKey(row.candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** The year of a "YYYY-MM-DD" run date, or undefined when the text is not a date (the stambyte input then has no age). */
export function asOfYearOf(asOf: string): number | undefined {
  const year = Number(asOf.slice(0, 4));
  return /^\d{4}-\d{2}-\d{2}$/.test(asOf) && Number.isInteger(year) ? year : undefined;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The run order of paid calls, in one place:
 * scrape, de-duplicate, hard filters (D-08), free pre-rank of every comparable
 * row, detail pages and picture reading for the top `window` only, then the
 * final profit ranking. With no comparable candidate neither enrichment nor
 * vision is called.
 */
export async function runFitPipeline(
  deps: FitPipelineDeps,
  opts: { model: HedonicModel; asOf: string; window?: number | "all" },
): Promise<FitPipelineResult> {
  const { model, asOf } = opts;
  const asOfYear = asOfYearOf(asOf);
  const windowOpt = opts.window ?? FIT_VISION_WINDOW;
  const readAll = windowOpt === "all";

  const scraped = await deps.scrape();
  const deduped = dedupe(scraped.rows);

  // Hard filters (D-08). Floor is never a filter. The filter keeps object
  // identity, so the district stays attached through a Set lookup.
  const { shown } = filterCandidates(
    deduped.map((r) => r.candidate),
    { areaQuery: "innerstan", priceMax: FIT_PRICE_MAX, roomsMin: null, sizeMin: FIT_SIZE_MIN, objectType: "Lägenhet", confidence: 1 },
    Number.POSITIVE_INFINITY,
  );
  const kept = new Set(shown);
  const filtered = deduped.filter((r) => kept.has(r.candidate));

  const baseRows: FitInputRow[] = filtered.map((r) => ({
    district: r.district,
    detailFetched: false,
    inVisionWindow: false,
    sunPhrases: null,
    candidate: r.candidate,
    facts: r.facts ?? null,
    sun: null,
    layout: null,
  }));

  const counts = { scraped: scraped.rows.length, deduped: deduped.length, filtered: filtered.length };
  const pre = preRank(baseRows, model, { asOfYear });
  const preRankPositions = new Map<string, number>();
  for (const p of pre.ranked) preRankPositions.set(fitRowKey(p.row.candidate), p.position);

  // "all" = every comparable row (D-06, local mode only; the script refuses it with Apify).
  const { inWindow, outside } = selectVisionWindow(pre.ranked, readAll ? pre.ranked.length : windowOpt);

  // Clear the card images so enrichment detail-fetches every window row.
  const originals = inWindow.map((p) => p.row.candidate);
  const copies = originals.map((c) => ({ ...c, imageUrls: null }));
  // With no window row (nothing comparable) neither paid stage is called.
  const enrichment: EnrichmentLike =
    copies.length > 0
      ? await deps.enrich(copies, copies.length, {
          deadlineMs: readAll ? FIT_ENRICH_DEADLINE_ALL_MS : FIT_ENRICH_DEADLINE_MS,
          concurrency: readAll ? FIT_ENRICH_CONCURRENCY_ALL : FIT_ENRICH_CONCURRENCY,
        })
      : { candidates: [], brokerImages: new Map<number, BrokerImageBytes[]>(), sunPhrases: new Map() };

  // A detail fetch replaces the entry; an untouched entry keeps its identity
  // and gets the card's own images back before the picture read.
  const detailFetched = copies.map((c, i) => enrichment.candidates[i] !== undefined && enrichment.candidates[i] !== c);
  const forVision = copies.map((c, i) =>
    detailFetched[i] ? enrichment.candidates[i] : { ...(enrichment.candidates[i] ?? c), imageUrls: originals[i].imageUrls },
  );

  const brokerImagesOf = (_c: DiscoveryCandidate, i: number): BrokerImageBytes[] => enrichment.brokerImages.get(i) ?? [];
  const afterVision = forVision.length > 0 ? await deps.vision(forVision, { brokerImagesOf }) : [];
  // Phase 14.4 (R-07): the layout read sits right after the picture read, on the same candidates and bytes.
  const layouts =
    forVision.length > 0 && deps.layout !== undefined ? await deps.layout(forVision, { brokerImagesOf }) : [];

  const windowRows: FitInputRow[] = inWindow.map((p, i) => ({
    district: p.row.district,
    detailFetched: detailFetched[i],
    inVisionWindow: true,
    sunPhrases: enrichment.sunPhrases.get(i) ?? null,
    candidate: afterVision[i] ?? forVision[i],
    // Card facts, with the detail page's on top when it was read (R-08).
    facts: combineFacts(p.row.facts, detailFetched[i] ? (enrichment.facts?.get(i) ?? null) : null),
    sun: null, // set below by deps.sunOf, once the window row is complete
    layout: layouts[i] ?? null,
  }));
  const outsideRows: FitInputRow[] = outside.map((p) => p.row);
  const comparableRows = new Set(pre.ranked.map((p) => p.row));
  const notComparableRows: FitInputRow[] = baseRows.filter((r) => !comparableRows.has(r));

  // Phase 14.3 (SUN-01, SUN-03): the sun fact is attached to every row before ranking, so taste sees it.
  // Window rows have their final candidate and facts by now; the others keep what the card said.
  const withSun = (row: FitInputRow): FitInputRow => (deps.sunOf === undefined ? row : { ...row, sun: deps.sunOf(row) });
  const windowRowsSun = windowRows.map(withSun);
  const outsideRowsSun = outsideRows.map(withSun);
  const notComparableRowsSun = notComparableRows.map(withSun);

  const allRows = [...windowRowsSun, ...outsideRowsSun, ...notComparableRowsSun];
  const ranking = rankFit(allRows, model, { asOfYear });
  const coverage = computeCoverage([...windowRowsSun, ...outsideRowsSun]);

  const visionSkipped: Record<string, number> = {};
  let visionSek = 0;
  let visionWithClaims = 0;
  for (const r of windowRows) {
    visionSek += r.candidate.vision?.costSek ?? 0;
    if (r.candidate.vision !== null && r.candidate.vision.claims.length > 0) visionWithClaims += 1;
    const reason = r.candidate.visionSkippedReason;
    if (reason !== null) visionSkipped[reason] = (visionSkipped[reason] ?? 0) + 1;
  }
  const window: FitWindowStats = {
    size: windowRows.length,
    detailFetched: windowRows.filter((r) => r.detailFetched).length,
    orientationStated: windowRows.filter((r) => r.candidate.orientation !== null).length,
    sunPhrases: windowRows.filter((r) => r.sunPhrases !== null && (r.sunPhrases.allDaySun || r.sunPhrases.throughFlat)).length,
    visionWithClaims,
    visionSkipped,
  };

  return {
    ranking,
    preRankPositions,
    window,
    visionSek,
    snapshot: { version: 1, asOf, source: `live run ${asOf}`, rows: allRows },
    areas: scraped.areas,
    counts,
    coverage,
    brfStats: enrichment.brfStats ?? null,
    enrichStoppedBy: enrichment.stoppedBy ?? null,
  };
}

/** The card facts with the detail facts on top: the detail wins where it has a value. Null when neither exists. */
function combineFacts(card: CandidateFacts | null | undefined, detail: CandidateFacts | null): CandidateFacts | null {
  if (card && detail) return mergeFacts(card, detail);
  return detail ?? card ?? null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** Swedish short labels for the flags (the 14.1-03 set plus the size flag from 14.1-07). */
export const FIT_FLAG_LABELS: Record<FitFlag, string> = {
  expectedFinalOver4M: "slutpris>4M",
  ejBildtolkad: "ej bildtolkad",
  hiddenDefectRisk: "dold-defekt-risk",
  residualFlag: "ovanligt långt under modellpris",
  renoUnknown: "reno okänd",
  utanförModellensStorlek: "storlek utanför modellen",
  notComparable: "ej jämförbar",
};

/** One printed row. Every money field is a whole number of kronor. */
export interface FitTableRow {
  readonly rank: number;
  /** Free pre-rank position, null when the row has none (for example a replay of an old snapshot). */
  readonly preRank: number | null;
  readonly address: string;
  readonly district: InnerstanDistrict;
  readonly kvm: number | null;
  readonly floor: number | null;
  readonly askingKr: number | null;
  /**
   * "Budpremie": the expected overbid used for the expected final price and what it is made of,
   * "+4,2 % (distrikt+pris+dagar)", or "-" when the row has none. BID-02 adds the condition part in plan 09.
   */
  readonly budpremie: string;
  readonly expectedFinalKr: number | null;
  readonly resaleKr: number | null;
  /** "Skillnad": the renovated value minus the expected final price. Since 14.4 (D-05) the whole of it is credited in the profit. */
  readonly gapKr: number | null;
  readonly renoTier: string;
  readonly renoMidKr: number;
  readonly renoLowKr: number;
  readonly renoHighKr: number;
  readonly profitKr: number | null;
  readonly tasteKr: number;
  /** The D-02 "Sol" cell: facade, source and confidence ("S gata/N gård (fastighet/gata, 0,95)"), "okänd", or "-" when the run did not look. */
  readonly sol: string;
  /**
   * D-08 "Soltim. fri (mar/jun/dec)": hours of direct sun on 21 March, June and December with nothing in the way,
   * morning and midday (06-15 local), first side of the fact. "6,0/5,5/4,1", or "-".
   */
  readonly solTheoretical: string;
  /**
   * D-08 "Soltim. med grannhus (mar/jun/dec)": the same hours with the neighbouring buildings in the way, per date
   * "<nominal> (<low>–<high>)" joined by " / ", then " usäker" and/or " höjd uppskattad"; "-" when unknown.
   */
  readonly solObstructed: string;
  /** LAY-03 "Korsdrag": windows on two opposite sides, "ja" / "nej" / "okänd" (okänd adds nothing to taste). */
  readonly korsdrag: string;
  /** LAY-03 "Sovrum": which side the bedroom is on, "gård" (quiet) / "gata" / "okänd" (okänd adds nothing to taste). */
  readonly sovrum: string;
  /**
   * CEIL-01 "Takhöjd": the height the broker stated, "3,2 m", "högt i tak" when only the phrase was stated, else
   * "okänd". Stated text only (D-05); no picture-based estimate exists (D-08).
   */
  readonly takhojd: string;
  /**
   * STAM-03 "Stambyte" (D-07): "2019" (the latest completed year), "pågår", "planerat 2027", "planerat", "genomfört" (done,
   * year unknown) or "okänd". Information only; it moves a price only through a model term that cross-validation kept.
   */
  readonly stambyte: string;
  /** FLAG-01 "Byggärenden" (D-08): the building's recent cases of interest and the balcony flags, "-" when none, "okänd" when the building is unknown. */
  readonly byggarenden: string;
  /** FLAG-02 "Area" (D-09): where the area figure comes from, and for a non-measured figure in a pre-1987 building the separately computed upside (antagande). */
  readonly area: string;
  readonly flags: string[];
  /** WATCH-03 "Varför här": the reasons, "oförklarat fynd" on a flagged row with none, "-" on an unflagged one. */
  readonly reasons: string;
  readonly link: string;
}

/**
 * The "Budpremie" cell (VAL-03): the premium with its sign, one decimal and a decimal comma, then its makeup
 * in brackets: "+4,2 % (distrikt+pris+dagar)". "-" without a premium. A premium that rounds to zero reads "+0,0 %".
 */
export function budpremieCell(detail: Pick<OverbidDetail, "pct" | "label"> | null): string {
  if (detail === null || !Number.isFinite(detail.pct)) return "-";
  const magnitude = (Math.abs(detail.pct) * 100).toFixed(1);
  const sign = detail.pct < 0 && Number(magnitude) !== 0 ? "-" : "+";
  return `${sign}${magnitude.replace(".", ",")} % (${detail.label})`;
}

/**
 * The run header line about the condition part of the bid premium (BID-02, R-08). A fitted term that
 * cross-validation kept reads "Budpremie skick: mätt på <n> sålda (β <b>)"; a missing, prior or rejected
 * term reads "Budpremie skick: ej mätt (prior 0): <reason>" - the premium then ignores condition entirely.
 */
export function conditionLineOf(model: Pick<HedonicModel, "bidPremium">): string {
  const reading = readConditionTerm(model);
  if (reading.measured) {
    const beta = reading.beta.toFixed(3).replace(".", ",");
    return `Budpremie skick: mätt på ${reading.n} sålda (β ${beta})`;
  }
  return `Budpremie skick: ej mätt (prior 0): ${reading.reason ?? "ingen skickterm i modellen"}`;
}

/**
 * The "Takhöjd" cell (CEIL-01): the stated height with one decimal and a decimal comma ("3,2 m", "3,0 m"), "högt i tak"
 * when only a tall-ceiling phrase was stated, "okänd" when neither (or the text was never read, as in every stored
 * snapshot). A stated number wins over the phrase.
 */
export function formatTakhojdCell(ceilingHeightM: number | null, tallCeilingPhrase: boolean | null): string {
  if (ceilingHeightM !== null && Number.isFinite(ceilingHeightM)) return `${ceilingHeightM.toFixed(1).replace(".", ",")} m`;
  return tallCeilingPhrase === true ? "högt i tak" : "okänd";
}

/**
 * The "Stambyte" cell (STAM-03, D-07) from the merged stambyte facts: the completed year when known ("2019"), "genomfört"
 * when a completed stambyte has no year, "pågår", "planerat 2027" / "planerat", and "okänd" when nothing was read.
 * A year that only rests on the start of a case nobody opened ("ärendestart") reads "2006 (ansökt)": it may be a refused
 * or withdrawn application, so a bare year is never printed for it (WR-04).
 */
export function formatStambyteCell(facts: {
  readonly stambyteStatus: CandidateFacts["stambyteStatus"];
  readonly lastStambyteYear: number | null;
  readonly lastStambyteBasis?: NonNullable<CandidateFacts["cityStambyte"]>["basis"];
  readonly plannedStambyteYear: number | null;
}): string {
  switch (facts.stambyteStatus) {
    case "genomfort":
      if (facts.lastStambyteYear === null) return "genomfört";
      return facts.lastStambyteBasis === "ärendestart" ? `${facts.lastStambyteYear} (ansökt)` : String(facts.lastStambyteYear);
    case "pagar":
      return "pågår";
    case "planerat":
      return facts.plannedStambyteYear !== null ? `planerat ${facts.plannedStambyteYear}` : "planerat";
    default:
      return "okänd";
  }
}

/** The words the "Byggärenden" cell uses for a case kind. Stambyte, relining and "annat" never appear there. */
const BYGGARENDE_LABELS: Partial<Record<CaseKind, string>> = {
  balkong_ny: "balkong",
  balkong_inglasning: "inglasning",
  balkongdorr: "balkongdörr",
  balkong_renovering: "balkongrenovering",
  vind_inredning: "vind",
  hiss: "hiss",
  tak: "tak",
  fasad: "fasad",
};

/** At most this many items in the "Byggärenden" cell. */
const BYGGARENDE_MAX_ITEMS = 3;

type ByggarendeItem = NonNullable<CandidateFacts["byggarenden"]>[number];

/** The newest item (by month) among those that pass `keep`, or undefined. */
function newestItem(items: readonly ByggarendeItem[], keep: (item: ByggarendeItem) => boolean): ByggarendeItem | undefined {
  return items.filter(keep).sort((a, b) => b.month.localeCompare(a.month))[0];
}

/**
 * The "Byggärenden" cell (FLAG-01, D-08): the building's recent cases of interest from the city's list, newest first, at
 * most three, joined with ", ". The balcony flags lead: "Balkonger beviljade 2026-03, ej slutbesked" (a new or glazed
 * balcony is granted and not signed off) and "Inglasning ansökt 2026-09" (a glazing application with no outcome). Every
 * other case reads "<kind> YYYY-MM"; a balcony case whose decision was never read says "(beslut okänt)", a refused or
 * withdrawn case says so. Stambyte and relining live in the Stambyte column and are left out. "-" when the list was read
 * and showed nothing, "okänd" when the building (or its list) is unknown. Information only: it changes no number.
 */
export function formatByggarendenCell(facts: {
  readonly byggarenden: CandidateFacts["byggarenden"];
  readonly balkongBeviljadEjByggd?: boolean | null;
  readonly balkongInglasningAnsokt?: boolean | null;
}): string {
  if (facts.byggarenden === null) return "okänd";
  const items = facts.byggarenden;
  const granted = facts.balkongBeviljadEjByggd ?? null;
  const applied = facts.balkongInglasningAnsokt ?? null;
  const used = new Set<ByggarendeItem>();
  const lead: string[] = [];

  if (granted === true) {
    const item =
      newestItem(
        items,
        (i) =>
          (i.kind === "balkong_ny" || i.kind === "balkong_inglasning") &&
          (i.decision === "beviljad" || i.decision === "startbesked") &&
          i.slutbeskedMonth === null,
      ) ?? newestItem(items, (i) => i.kind === "balkong_ny");
    if (item !== undefined) used.add(item);
    lead.push(item === undefined ? "Balkonger beviljade, ej slutbesked" : `Balkonger beviljade ${item.month}, ej slutbesked`);
  }
  if (applied === true) {
    const item =
      newestItem(items, (i) => i.kind === "balkong_inglasning" && !used.has(i) && (i.decision === "ansokt" || i.decision === "okant")) ??
      newestItem(items, (i) => i.kind === "balkong_inglasning" && !used.has(i));
    if (item !== undefined) used.add(item);
    lead.push(item === undefined ? "Inglasning ansökt" : `Inglasning ansökt ${item.month}`);
  }

  const rest = items.flatMap((item) => {
    const label = BYGGARENDE_LABELS[item.kind];
    if (label === undefined || used.has(item)) return [];
    const decisionUnread =
      (item.kind === "balkong_ny" && granted === null) || (item.kind === "balkong_inglasning" && applied === null);
    const note = decisionUnread
      ? " (beslut okänt)"
      : item.decision === "avslag"
        ? " (avslag)"
        : item.decision === "avskrivet"
          ? " (avskrivet)"
          : "";
    return [`${label} ${item.month}${note}`];
  });
  return [...lead, ...rest].slice(0, BYGGARENDE_MAX_ITEMS).join(", ") || "-";
}

/** The words the "Area" cell uses for the source of the area figure. */
const AREA_SOURCE_LABELS: Record<AreaSource, string> = {
  uppmatt: "uppmätt",
  forening: "föreningen",
  ekonomisk_plan: "ekonomisk plan",
  lagenhetsregister: "lägenhetsregistret",
  saljare: "säljaren",
  ej_kontrollmatt: "ej kontrollmätt",
};

const kr = (n: number): string => n.toLocaleString("sv-SE");

/**
 * The "Area" cell (FLAG-02, D-09): where the broker says the area figure comes from ("uppmätt 2019", "föreningen", ...), or
 * "okänd" when the text said nothing or was never read. For a figure that is not a measurement in a building from before
 * 1987 the separately computed upside follows: "föreningen (+105 571–211 143 kr, antagande)". The upside is one and two
 * square metres at the flat's own price per square metre ({@link areaUpsideSek}); it is never part of the score.
 */
export function formatAreaCell(facts: {
  readonly areaSource: CandidateFacts["areaSource"];
  readonly areaMeasuredYear: number | null;
  readonly constructionYear?: number | null;
  readonly askingSek?: number | null;
  readonly livingArea?: number | null;
}): string {
  if (facts.areaSource === null) return "okänd";
  const label = AREA_SOURCE_LABELS[facts.areaSource];
  if (facts.areaSource === "uppmatt") return facts.areaMeasuredYear !== null ? `${label} ${facts.areaMeasuredYear}` : label;
  const upside = areaUpsideSek({
    areaSource: facts.areaSource,
    constructionYear: facts.constructionYear ?? null,
    askingSek: facts.askingSek ?? null,
    livingArea: facts.livingArea ?? null,
  });
  return upside === null ? label : `${label} (+${kr(upside.lowSek)}–${kr(upside.highSek)} kr, antagande)`;
}

/** The soft sentence per source whose figure is not a measurement (FLAG-02). */
const AREA_FLAG_SENTENCES: Record<Exclude<AreaSource, "uppmatt">, string> = {
  forening: "Arean bygger på föreningens uppgift, inte en uppmätning.",
  ekonomisk_plan: "Arean bygger på den ekonomiska planen, inte en uppmätning.",
  lagenhetsregister: "Arean bygger på lägenhetsregistret, inte en uppmätning.",
  saljare: "Arean bygger på säljarens uppgift, inte en uppmätning.",
  ej_kontrollmatt: "Arean är angiven som ej kontrollmätt, inte en uppmätning.",
};

/**
 * The soft area flag for the tracked-flat block (FLAG-02, D-09): the sentence for a figure that is not a measurement and,
 * for a building from before 1987, the note and the kr upside labelled "antagande, ej i värderingen". Empty for a measured
 * figure or an unknown source. Text only: it changes no number and is no FIT flag.
 */
export function areaFlagLines(r: Pick<FitScoreResult, "areaSource" | "constructionYear" | "askingSek" | "livingArea">): string[] {
  if (r.areaSource === null || r.areaSource === "uppmatt") return [];
  const lines = [AREA_FLAG_SENTENCES[r.areaSource]];
  const upside = areaUpsideSek({
    areaSource: r.areaSource,
    constructionYear: r.constructionYear,
    askingSek: r.askingSek,
    livingArea: r.livingArea,
  });
  if (upside !== null) {
    lines.push(
      `Kan vara större vid uppmätning (ofta 1–2 kvm, ej säkert). Möjlig uppsida +${kr(upside.lowSek)}–${kr(upside.highSek)} kr (antagande, ej i värderingen).`,
    );
  }
  return lines;
}

const roundKr = (n: number): number => Math.round(n);
const roundOrNull = (n: number | null): number | null => (n === null ? null : roundKr(n));

/**
 * The ranked results as printable rows. This is the one place money is rounded
 * (Math.round, half towards +infinity: 1234.5 gives 1235, -1234.5 gives -1234),
 * the skillnad (gapKr) included.
 */
export function toFitTableRows(
  ranking: { readonly ranked: readonly FitScoreResult[] },
  preRankPositions: ReadonlyMap<string, number>,
  opts: { reasonsOf?: (r: FitScoreResult) => string[] } = {},
): FitTableRow[] {
  return ranking.ranked.map((r, i) => {
    const solHours = formatSolHours(r.sun);
    return {
      rank: i + 1,
      preRank: preRankPositions.get(r.sourceListingUrl ?? `${r.address}|${r.askingSek}`) ?? null,
      address: r.address ?? "-",
      district: r.district,
      kvm: r.livingArea,
      floor: r.floor,
      askingKr: roundOrNull(r.askingSek),
      budpremie: budpremieCell(r.overbidDetail),
      expectedFinalKr: roundOrNull(r.purchaseSek),
      resaleKr: roundOrNull(r.resaleSek),
      gapKr: roundOrNull(r.gapSek),
      renoTier: r.renoTier,
      renoMidKr: roundKr(r.renoSek),
      renoLowKr: roundKr(r.renoLowSek),
      renoHighKr: roundKr(r.renoHighSek),
      profitKr: roundOrNull(r.profitSek),
      tasteKr: roundKr(r.tasteSek),
      sol: formatSolCellWithLayout(r.sun, r.layout, r.layoutAppliedToSun),
      solTheoretical: solHours.theoretical,
      solObstructed: solHours.obstructed,
      korsdrag: formatKorsdragCell(korsdragOf(r.layout)),
      sovrum: formatSovrumCell(quietBedroomOf(r.layout)),
      takhojd: formatTakhojdCell(r.ceilingHeightM, r.tallCeilingPhrase),
      stambyte: formatStambyteCell(r),
      byggarenden: formatByggarendenCell(r),
      area: formatAreaCell(r),
      flags: r.flags.map((f) => FIT_FLAG_LABELS[f]),
      reasons: reasonCell(opts.reasonsOf?.(r) ?? [], isReasonFlagged(r.flags)),
      link: r.sourceListingUrl ?? "-",
    };
  });
}

export const FIT_TABLE_HEADER =
  "# | Förrank | Adress | Område | kvm | vån | Utgångspris | Budpremie | Förv. slutpris | Värde renoverad | Skillnad | Reno (nivå, spann) | Vinst | Smak | Sol | Soltim. fri (mar/jun/dec) | Soltim. med grannhus (mar/jun/dec) | Korsdrag | Sovrum | Takhöjd | Stambyte | Byggärenden | Area | Flaggor | Varför här | Länk";

const orDash = (n: number | null): string => (n === null ? "-" : kr(n));

/** Prints the table: header, up to `maxRows` rows, then a line for the rest. Empty input prints "0 kandidater". */
export function renderFitTable(rows: readonly FitTableRow[], opts: { maxRows?: number } = {}): string {
  const maxRows = opts.maxRows ?? FIT_TABLE_MAX_ROWS;
  const lines = [FIT_TABLE_HEADER];
  if (rows.length === 0) {
    lines.push("0 kandidater");
    return lines.join("\n");
  }
  for (const r of rows.slice(0, maxRows)) {
    lines.push(
      [
        r.rank,
        r.preRank === null ? "-" : r.preRank,
        r.address,
        r.district,
        r.kvm === null ? "-" : r.kvm,
        r.floor === null ? "-" : r.floor,
        orDash(r.askingKr),
        r.budpremie,
        orDash(r.expectedFinalKr),
        orDash(r.resaleKr),
        orDash(r.gapKr),
        `${r.renoTier} ${kr(r.renoMidKr)} (${kr(r.renoLowKr)}–${kr(r.renoHighKr)})`,
        orDash(r.profitKr),
        kr(r.tasteKr),
        r.sol,
        r.solTheoretical,
        r.solObstructed,
        r.korsdrag,
        r.sovrum,
        r.takhojd,
        r.stambyte,
        r.byggarenden,
        r.area,
        r.flags.join(", ") || "-",
        r.reasons,
        r.link,
      ].join(" | "),
    );
  }
  if (rows.length > maxRows) lines.push(`+${rows.length - maxRows} till (se snapshot)`);
  return lines.join("\n");
}

/**
 * D-12: the table is split on the expected final price. A row whose printed
 * expectedFinalKr is at or under this goes to the first section (4 000 000
 * included). Compared on the printed whole-kronor number, so the section always
 * matches the figure the reader sees.
 */
export const FIT_PRICE_SECTION_SPLIT = 4_000_000;

/** The two section headings (D-12), in print order: under first. */
export const FIT_SECTION_TITLES = { under: "Förväntat under 4 M", over: "Över 4 M förväntat" } as const;

/**
 * Splits rows on {@link FIT_PRICE_SECTION_SPLIT}. A row with no expected final
 * goes to the over section. Order inside each section is the input order, so the
 * profit ranking is unchanged and each row keeps its innerstan '#'.
 */
export function splitFitSections(rows: readonly FitTableRow[]): { under: FitTableRow[]; over: FitTableRow[] } {
  const under: FitTableRow[] = [];
  const over: FitTableRow[] = [];
  for (const r of rows) {
    if (r.expectedFinalKr !== null && r.expectedFinalKr <= FIT_PRICE_SECTION_SPLIT) under.push(r);
    else over.push(r);
  }
  return { under, over };
}

/**
 * Prints the two sections (D-12): each is a heading with its count, then
 * {@link renderFitTable} of its rows (`maxRows` applies per section). An empty
 * section still prints its heading with "(0 annonser)", the header and "0 kandidater".
 */
export function renderFitSections(rows: readonly FitTableRow[], opts: { maxRows?: number } = {}): string {
  const { under, over } = splitFitSections(rows);
  const block = (title: string, part: readonly FitTableRow[]): string =>
    `${title} (${part.length} annonser)\n${renderFitTable(part, opts)}`;
  return [block(FIT_SECTION_TITLES.under, under), block(FIT_SECTION_TITLES.over, over)].join("\n\n");
}

// ---------------------------------------------------------------------------
// Run reports (shared by the script and the Phase 14.2 email)
// ---------------------------------------------------------------------------

/**
 * The districts whose list cannot be called complete (R-04): a district that failed, one for which
 * Booli printed no count (or none was measured), and one whose collected listings fall short of the
 * count. Never counted complete on a guess. A district whose page 1 carried Booli's count but no
 * cards fails in fetchAreaListings (a dead page, W6) and so appears here as failed. Pure.
 */
export function incompleteDistricts(areas: readonly AreaReport[]): string[] {
  return areas
    .filter((a) => !a.ok || a.totalCount === undefined || a.totalCount === null || a.complete !== true)
    .map((a) => a.name);
}

/**
 * One line per district, the line that says whether Kungsholmen made it, and the run line
 * "Kandidatlista: komplett" or "Kandidatlista: OFULLSTÄNDIG (<districts>)". A district with Booli's
 * count prints "<listings> av <count> annonser (<pages> sidor, komplett|ofullständig)"; without it
 * (14.1 callers) the old line.
 */
export function renderAreaReport(areas: readonly AreaReport[]): string {
  const lines = ["Områden:"];
  for (const a of areas) {
    if (!a.ok) {
      lines.push(`  ${a.name}: MISSLYCKADES - ${a.error ?? "okänt fel"}`);
    } else if (a.totalCount === undefined) {
      lines.push(`  ${a.name}: ${a.listings} annonser (${a.renders} renders)`);
    } else if (a.totalCount === null) {
      lines.push(`  ${a.name}: ${a.listings} annonser (${a.pages ?? "?"} sidor, ofullständig: Booli angav inget antal)`);
    } else {
      lines.push(
        `  ${a.name}: ${a.listings} av ${a.totalCount} annonser (${a.pages ?? "?"} sidor, ${a.complete === true ? "komplett" : "ofullständig"})`,
      );
    }
  }
  const kungsholmen = areas.find((a) => a.name.toLowerCase() === "kungsholmen");
  lines.push(kungsholmen !== undefined && kungsholmen.ok && kungsholmen.listings > 0 ? "Kungsholmen: med" : "Kungsholmen: SAKNAS");
  const missing = incompleteDistricts(areas);
  if (areas.length === 0) lines.push("Kandidatlista: OFULLSTÄNDIG (inga distrikt lästes)");
  else lines.push(missing.length === 0 ? "Kandidatlista: komplett" : `Kandidatlista: OFULLSTÄNDIG (${missing.join(", ")})`);
  return lines.join("\n");
}

/**
 * CR-01: runs `run` over `items` one after another and settles each, as `Promise.allSettled` would, except that an item
 * reached after `stopped()` turned true is not run at all: its slot holds a rejection with `skippedReason`. The local
 * browser pulls the four districts through this, so a Booli block in the first district means the other three send nothing
 * (a parallel pull would have started all four before the first answer). Never rejects.
 */
export async function settleInOrder<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  stopped: () => boolean,
  skippedReason: string,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (const item of items) {
    if (stopped()) {
      out.push({ status: "rejected", reason: new Error(skippedReason) });
      continue;
    }
    try {
      out.push({ status: "fulfilled", value: await run(item) });
    } catch (reason) {
      out.push({ status: "rejected", reason });
    }
  }
  return out;
}

/** The words the table and the mail use when Booli refused the run and the enrichment ended early (CR-01). */
export const ENRICH_CUT_SHORT_LABEL = "berikning avbruten (Booli)";

/**
 * CR-01: the terminal line printed above the table when the enrichment was cut short. It says how many of the window
 * flats got their detail page, so the reader knows how much of the table rests on the cards alone. Pure.
 */
export function renderEnrichCutShortLine(window: Pick<FitWindowStats, "size" | "detailFetched">): string {
  return `OBS: ${ENRICH_CUT_SHORT_LABEL}: ${window.detailFetched} av ${window.size} annonser fick sin detaljsida, resten bygger bara på kortens uppgifter. Vänta minst ett dygn innan nästa körning.`;
}

/**
 * CR-01: the mail header's candidate-list line. A run whose enrichment was cut short is not complete even when every
 * district list was, so the line gets the label added and the mail shows it in red and bold. Not cut short: unchanged.
 */
export function mailCompletenessOf(
  base: { completeness: string; incomplete: boolean },
  enrichStoppedBy: "utmaning" | null,
): { completeness: string; incomplete: boolean } {
  if (enrichStoppedBy === null) return base;
  return { completeness: `${base.completeness}; ${ENRICH_CUT_SHORT_LABEL}`, incomplete: true };
}

// ---------------------------------------------------------------------------
// Coverage (R-05)
// ---------------------------------------------------------------------------

/** The seven coverage items in print order. Plan 09 parses these labels; do not rename or reorder. */
export const COVERAGE_LABELS = [
  "detaljsida",
  "balkong känd",
  "skick känt",
  "beskrivning läst",
  "sol/orientering angiven",
  "avgift",
  "upplåtelseform",
] as const;

export interface CoverageItem {
  readonly label: string;
  /** Rows where the fact is known. */
  readonly known: number;
}

/** How many flagged rows (ovanligt långt under modellpris or dold-defekt-risk) carry a reason (WATCH-03). */
export interface ReasonsOnFlagged {
  /** Flagged rows with at least one reason. */
  readonly explained: number;
  /** Flagged rows that read "oförklarat fynd". */
  readonly unexplained: number;
  /** Flagged rows in all. */
  readonly flagged: number;
}

export interface Coverage {
  /** Comparable rows counted. */
  readonly n: number;
  readonly items: readonly CoverageItem[];
  /** Rows whose association debt per kvm is known (Phase 14.2, R-07), printed after the seven pinned items. */
  readonly brfDebt: number;
  /**
   * Phase 14.3 (SUN-05): rows whose sun fact has a source other than okänd, i.e. a facade was derived or stated.
   * Printed after föreningsskuld. "sol/orientering angiven" above stays the stated-only count.
   */
  readonly sunInferred: number;
  /**
   * Phase 14.4 (LAY-04): what the layout read gave across the counted rows. `read` rows carry a layout record;
   * the others count the rows where the gate (confidence >= 0,6, photo evidence for street or courtyard)
   * lets a field through, and the rows where the layout picked the facade the sun taste used.
   */
  readonly layout: {
    readonly read: number;
    readonly balcony: number;
    readonly windowSides: number;
    readonly bedroom: number;
    readonly appliedToSun: number;
  };
  /**
   * Phase 14.5 (CEIL-01): `read` counts the rows whose description was parsed for a ceiling height (the
   * facts' tallCeilingPhrase is not null; a stored snapshot holds no text, so it reads 0), `stated` those with
   * a height in metres, `tallOnly` those with a tall-ceiling phrase and no number.
   */
  readonly ceiling: {
    readonly read: number;
    readonly stated: number;
    readonly tallOnly: number;
  };
  /**
   * Phase 14.6 (FLAG-02): `read` counts the rows whose description was read by the 14.6 text readers (the facts hold a
   * stambyte reading of the text, or an area source; a stored snapshot from before 14.6 holds neither, so it reads 0),
   * `stated` those whose text named where the area figure comes from, `bySource` that count per source.
   */
  readonly area: {
    readonly read: number;
    readonly stated: number;
    readonly bySource: Readonly<Record<AreaSource, number>>;
  };
  /** Reasons on flagged rows; null until {@link withReasonsOnFlagged} sets it (it needs the table rows). */
  readonly reasonsOnFlagged: ReasonsOnFlagged | null;
}

/** The area sources in the order the Areakälla line prints them. */
const AREA_SOURCE_ORDER = ["uppmatt", "forening", "ekonomisk_plan", "lagenhetsregister", "saljare", "ej_kontrollmatt"] as const satisfies readonly AreaSource[];

/** Rows whose fact is known, by the R-05 definitions. One predicate per label, in {@link COVERAGE_LABELS} order. */
const COVERAGE_KNOWN: readonly ((row: FitInputRow) => boolean)[] = [
  // detaljsida: a detail page was read
  (r) => r.detailFetched,
  // balkong känd: the facts record knows (true or false), or the candidate says true
  (r) => r.facts?.balcony != null || r.candidate.balcony === true,
  // skick känt: a vision claim on the kitchen or the overall impression
  (r) => (r.candidate.vision?.claims ?? []).some((c) => c.attribute === "kitchen" || c.attribute === "overall"),
  // beskrivning läst: a broker or Booli description was read
  (r) => r.facts?.descriptionRead === true,
  // sol/orientering angiven: stated facades, or a stated sun phrase ("sol hela dagen", "kvällssol", ...)
  (r) =>
    (r.candidate.orientation?.facades.length ?? 0) > 0 ||
    (r.facts?.orientationFacades?.length ?? 0) > 0 ||
    (r.facts?.sunPhrases?.length ?? 0) > 0 ||
    r.sunPhrases?.allDaySun === true,
  // avgift / upplåtelseform: the listing states them
  (r) => r.facts?.avgiftMonthlySek != null,
  (r) => r.facts?.tenureForm != null,
];

/**
 * How much is actually known across `rows` (pass the comparable rows). Measured, never faked: a fact
 * counts only when the row holds it. Pure.
 */
export function computeCoverage(rows: readonly FitInputRow[]): Coverage {
  return {
    n: rows.length,
    items: COVERAGE_LABELS.map((label, i) => ({ label, known: rows.filter(COVERAGE_KNOWN[i]).length })),
    brfDebt: rows.filter((r) => r.facts?.brf?.debtPerSqm != null).length,
    sunInferred: rows.filter((r) => r.sun !== null && r.sun.source !== "okänd").length,
    layout: {
      read: rows.filter((r) => r.layout !== null).length,
      // street / courtyard need the gate, "no balcony" needs only the confidence (layout-fact.ts)
      balcony: rows.filter((r) => usableSideWhen(r.layout, "balcony", true) !== null || usablyNoBalconyWhen(r.layout, true)).length,
      windowSides: rows.filter((r) => korsdragWhen(r.layout, true) !== null).length,
      bedroom: rows.filter((r) => quietBedroomWhen(r.layout, true) !== null).length,
      appliedToSun: rows.filter((r) => inferredSunWithLayout(r.sun, r.layout, true).applied).length,
    },
    ceiling: {
      read: rows.filter((r) => r.facts?.tallCeilingPhrase != null).length,
      stated: rows.filter((r) => r.facts?.ceilingHeightM != null).length,
      tallOnly: rows.filter((r) => r.facts?.tallCeilingPhrase === true && r.facts.ceilingHeightM == null).length,
    },
    area: {
      read: rows.filter((r) => r.facts?.textStambyte != null || r.facts?.areaSource != null).length,
      stated: rows.filter((r) => r.facts?.areaSource != null).length,
      bySource: Object.fromEntries(
        AREA_SOURCE_ORDER.map((source) => [source, rows.filter((r) => r.facts?.areaSource === source).length]),
      ) as Record<AreaSource, number>,
    },
    reasonsOnFlagged: null,
  };
}

/**
 * Counts the reasons on the flagged rows of the printed table: a row is flagged when it carries
 * ovanligt långt under modellpris or dold-defekt-risk, unexplained when its cell reads "oförklarat fynd". Pure.
 */
export function reasonsOnFlaggedOf(rows: readonly FitTableRow[]): ReasonsOnFlagged {
  const flaggedLabels = [FIT_FLAG_LABELS.residualFlag, FIT_FLAG_LABELS.hiddenDefectRisk];
  const flagged = rows.filter((r) => r.flags.some((f) => flaggedLabels.includes(f)));
  const unexplained = flagged.filter((r) => r.reasons === UNEXPLAINED_LABEL).length;
  return { explained: flagged.length - unexplained, unexplained, flagged: flagged.length };
}

/** The coverage with the reason counts of `rows` (the full printed list, not only the first 60 per section). Pure. */
export function withReasonsOnFlagged(coverage: Coverage, rows: readonly FitTableRow[]): Coverage {
  return { ...coverage, reasonsOnFlagged: reasonsOnFlaggedOf(rows) };
}

/** Coverage over a stored snapshot's comparable rows (the same set the live run counts), for replay. Pure. */
export function coverageOfRows(rows: readonly FitInputRow[], model: HedonicModel): Coverage {
  return computeCoverage(preRank(rows, model).ranked.map((p) => p.row));
}

const percent = (k: number, n: number): string => (n === 0 ? "0,0" : ((k / n) * 100).toFixed(1).replace(".", ","));

/**
 * The pinned R-05 line that plan 09 parses:
 * "Täckning (N annonser): detaljsida k av N (p %), balkong känd k av N (p %), ..." with every item
 * "<label> <k> av <N> (<p> %)", p to one decimal with a decimal comma, and N = 0 printing
 * "0 av 0 (0,0 %)" instead of dividing by zero. After the seven plan-05 items (text and order
 * unchanged) comes "föreningsskuld känd k av N (p %)" in the same shape, then (Phase 14.3, SUN-05)
 * "sol härledd k av N (p %)" (rows whose sun fact is not okänd), and, when the reason counts
 * are known, last: "anledning på flaggade rader: E förklarade, U oförklarat fynd av F".
 *
 * Phase 14.4 (LAY-04): when at least one row carries a layout record, a second line follows:
 * "Planlösning: balkongsida <a>, korsdrag känt <b>, sovrumssida <c>, sol från planlösning <d> av <N>"
 * (rows where the gate lets the field through, and rows where the layout picked the sun's facade).
 * The Täckning line itself is unchanged, so what plan 09 parses stays as it was.
 *
 * Phase 14.5 (CEIL-01): when at least one description was parsed for a ceiling height, a line follows the
 * Täckning line (before the Planlösning line): "Takhöjd: angiven i <a> av <n> lästa beskrivningar (högt i tak
 * utan siffra <b>)". With none parsed (every replay of a stored snapshot) the output is what it always was.
 *
 * Phase 14.6 (FLAG-02): when at least one description was read by the 14.6 readers, a line follows the Takhöjd line (before
 * the Planlösning line): "Areakälla: angiven i <a> av <n> lästa beskrivningar (uppmätt <u>, föreningen <f>, ekonomisk plan
 * <e>, lägenhetsregistret <l>, säljaren <s>, ej kontrollmätt <k>)". With none read the output is byte-identical to before.
 */
export function renderCoverage(coverage: Coverage): string {
  const item = (label: string, known: number): string => `${label} ${known} av ${coverage.n} (${percent(known, coverage.n)} %)`;
  const items = [
    ...coverage.items.map((i) => item(i.label, i.known)),
    item("föreningsskuld känd", coverage.brfDebt),
    item("sol härledd", coverage.sunInferred),
  ];
  const r = coverage.reasonsOnFlagged;
  if (r !== null) items.push(`anledning på flaggade rader: ${r.explained} förklarade, ${r.unexplained} oförklarat fynd av ${r.flagged}`);
  const line = `Täckning (${coverage.n} annonser): ${items.join(", ")}`;
  // Phase 14.5: the ceiling line, only when at least one description was parsed for a height.
  const c = coverage.ceiling;
  const withCeiling =
    c.read === 0
      ? line
      : `${line}\nTakhöjd: angiven i ${c.stated} av ${c.read} lästa beskrivningar (högt i tak utan siffra ${c.tallOnly})`;
  // Phase 14.6: the area-source line, only when at least one description was read by the 14.6 readers.
  const a = coverage.area;
  const by = a.bySource;
  const withArea =
    a.read === 0
      ? withCeiling
      : `${withCeiling}\nAreakälla: angiven i ${a.stated} av ${a.read} lästa beskrivningar (uppmätt ${by.uppmatt}, föreningen ${by.forening}, ekonomisk plan ${by.ekonomisk_plan}, lägenhetsregistret ${by.lagenhetsregister}, säljaren ${by.saljare}, ej kontrollmätt ${by.ej_kontrollmatt})`;
  // Phase 14.4: a further line, only when the run read at least one layout (a replay of an older snapshot prints the line it always did).
  const l = coverage.layout;
  if (l.read === 0) return withArea;
  return (
    `${withArea}\nPlanlösning: balkongsida ${l.balcony}, korsdrag känt ${l.windowSides}, sovrumssida ${l.bedroom}, ` +
    `sol från planlösning ${l.appliedToSun} av ${coverage.n}` +
    (LAYOUT_INFLUENCE_ENABLED ? "" : ` ${LAYOUT_NO_INFLUENCE_SUFFIX}`)
  );
}

/** The pinned BRF line (R-07): "BRF-sidor: <fetched> av <distinct> lästa, <failed> misslyckades". Pure. */
export function renderBrfLine(stats: BrfStats): string {
  return `BRF-sidor: ${stats.fetched} av ${stats.distinct} lästa, ${stats.failed} misslyckades`;
}

/**
 * The picture-read window in pre-rank order, then its outcome counts. Listing
 * links are left out on purpose: the only place a link is printed is the table,
 * so a live log and a replay of its snapshot list links in the same order.
 */
export function renderWindowReport(
  result: Pick<FitPipelineResult, "snapshot" | "preRankPositions" | "window">,
): string {
  const position = (c: DiscoveryCandidate): number => result.preRankPositions.get(fitRowKey(c)) ?? Number.POSITIVE_INFINITY;
  const rows = result.snapshot.rows.filter((r) => r.inVisionWindow).sort((a, b) => position(a.candidate) - position(b.candidate));
  const w = result.window;
  const lines = [`Bildfönster (${w.size} annonser, i förrank-ordning; länkar finns bara i tabellen):`];
  for (const r of rows) {
    const c = r.candidate;
    const id = booliIdOf(c);
    const pos = result.preRankPositions.get(fitRowKey(c));
    const vision = c.vision ? `${c.vision.claims.length} påståenden` : `ingen bildtolkning (${c.visionSkippedReason ?? "ej körd"})`;
    const sun = r.sunPhrases !== null && (r.sunPhrases.allDaySun || r.sunPhrases.throughFlat) ? "ja" : "nej";
    lines.push(
      `  Förrank ${pos ?? "-"}: ${c.address ?? "-"} (Booli ${id ?? "-"}, ${r.district}) | detaljsida ${r.detailFetched ? "hämtad" : "misslyckades"} | orientering ${c.orientation ? "angiven" : "ej angiven"} | solfras ${sun} | ${vision}`,
    );
  }
  const skipped = Object.entries(w.visionSkipped).map(([reason, n]) => `${reason} ${n}`).join(", ") || "inga";
  lines.push(
    `Fönsterutfall: detaljsida hämtad ${w.detailFetched}/${w.size}, orientering angiven ${w.orientationStated}/${w.size}, solfraser ${w.sunPhrases}/${w.size}, bildtolkning med påståenden ${w.visionWithClaims}/${w.size}, hoppade över: ${skipped}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spend estimate and headroom check (R-13)
// ---------------------------------------------------------------------------

/**
 * A priced worst case for the paid Apify renders of one run, in USD: every
 * district sweep at its maximum page count and every window row at its maximum
 * render count, each priced at the timed-out rate. Never an average, so the
 * number it gives can only be too high. 4 districts and a 20-row window give
 * about 5.90 USD.
 */
export function estimateFitRunUsd(opts: { districts: number; window: number }): number {
  const districts = Number.isFinite(opts.districts) ? Math.max(0, Math.floor(opts.districts)) : 0;
  const window = Number.isFinite(opts.window) ? Math.max(0, Math.floor(opts.window)) : 0;
  const renders = districts * AREA_MAX_RENDERS_PER_AREA + window * FIT_RENDERS_PER_WINDOW_ROW_MAX;
  // Every term is a multiple of 0.001, so rounding at 6 decimals only removes float noise.
  return Math.round(renders * OBSERVED_USD_PER_TIMED_OUT_RENDER * 1e6) / 1e6;
}

export interface HeadroomCheck {
  readonly proceed: boolean;
  /** Null when the provider could not tell. */
  readonly headroomUsd: number | null;
  readonly requiredUsd: number;
  /** Swedish and English, ready to print. */
  readonly message: string;
}

const usd = (n: number): string => n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Compares the Apify monthly headroom with what the run may cost. Calls the
 * injected provider once. A rejection or a null answer means "unknown": the
 * run proceeds with a warning, because the check must never block on its own
 * failure. Only a known headroom strictly below the requirement stops the run.
 */
export async function checkApifyHeadroom(
  headroom: () => Promise<number | null>,
  requiredUsd: number,
): Promise<HeadroomCheck> {
  let value: number | null;
  try {
    const answer = await headroom();
    value = typeof answer === "number" && Number.isFinite(answer) ? answer : null;
  } catch {
    value = null;
  }
  if (value === null) {
    return {
      proceed: true,
      headroomUsd: null,
      requiredUsd,
      message: "Apify-utrymme för månaden okänt, fortsätter / Apify monthly headroom unknown, continuing",
    };
  }
  if (value < requiredUsd) {
    return {
      proceed: false,
      headroomUsd: value,
      requiredUsd,
      message:
        `Apify-utrymmet för månaden räcker inte: ${usd(value)} USD kvar, körningen kan kosta upp till ${usd(requiredUsd)} USD. / ` +
        `Apify monthly headroom too low: ${usd(value)} USD left, run may cost up to ${usd(requiredUsd)} USD.`,
    };
  }
  return {
    proceed: true,
    headroomUsd: value,
    requiredUsd,
    message: `Apify-utrymme: ${usd(value)} USD kvar, körningen kan kosta upp till ${usd(requiredUsd)} USD. / Apify headroom: ${usd(value)} USD left, run may cost up to ${usd(requiredUsd)} USD.`,
  };
}
