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
  preRank,
  rankFit,
  selectVisionWindow,
  type FitFlag,
  type FitInputRow,
  type FitScoreResult,
  type FitSnapshot,
  type ModelHealth,
} from "@/lib/discovery/fit-score";
import type { HedonicModel, InnerstanDistrict } from "@/lib/discovery/hedonic-model";
import type { EnrichmentResult } from "@/lib/discovery/job";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wall-clock budget for the headless detail-page stage. The in-app ENRICH_DEADLINE_MS stays 120 s. */
export const FIT_ENRICH_DEADLINE_MS = 15 * 60_000;

/** Detail pages fetched at the same time (each one is a paid render). */
export const FIT_ENRICH_CONCURRENCY = 4;

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
}

/** What happened when one district was scraped. */
export interface AreaReport {
  readonly name: string;
  readonly listings: number;
  readonly renders: number;
  readonly ok: boolean;
  readonly error: string | null;
}

export type EnrichmentLike = Pick<EnrichmentResult, "candidates" | "brokerImages" | "sunPhrases">;

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
  opts: { model: HedonicModel; asOf: string; window?: number },
): Promise<FitPipelineResult> {
  const { model, asOf } = opts;
  const windowSize = opts.window ?? FIT_VISION_WINDOW;

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
  }));

  const counts = { scraped: scraped.rows.length, deduped: deduped.length, filtered: filtered.length };
  const pre = preRank(baseRows, model);
  const preRankPositions = new Map<string, number>();
  for (const p of pre.ranked) preRankPositions.set(fitRowKey(p.row.candidate), p.position);

  const { inWindow, outside } = selectVisionWindow(pre.ranked, windowSize);

  // Clear the card images so enrichment detail-fetches every window row.
  const originals = inWindow.map((p) => p.row.candidate);
  const copies = originals.map((c) => ({ ...c, imageUrls: null }));
  // With no window row (nothing comparable) neither paid stage is called.
  const enrichment =
    copies.length > 0
      ? await deps.enrich(copies, copies.length, { deadlineMs: FIT_ENRICH_DEADLINE_MS, concurrency: FIT_ENRICH_CONCURRENCY })
      : { candidates: [], brokerImages: new Map<number, BrokerImageBytes[]>(), sunPhrases: new Map() };

  // A detail fetch replaces the entry; an untouched entry keeps its identity
  // and gets the card's own images back before the picture read.
  const detailFetched = copies.map((c, i) => enrichment.candidates[i] !== undefined && enrichment.candidates[i] !== c);
  const forVision = copies.map((c, i) =>
    detailFetched[i] ? enrichment.candidates[i] : { ...(enrichment.candidates[i] ?? c), imageUrls: originals[i].imageUrls },
  );

  const afterVision =
    forVision.length > 0
      ? await deps.vision(forVision, { brokerImagesOf: (_c, i) => enrichment.brokerImages.get(i) ?? [] })
      : [];

  const windowRows: FitInputRow[] = inWindow.map((p, i) => ({
    district: p.row.district,
    detailFetched: detailFetched[i],
    inVisionWindow: true,
    sunPhrases: enrichment.sunPhrases.get(i) ?? null,
    candidate: afterVision[i] ?? forVision[i],
  }));
  const outsideRows: FitInputRow[] = outside.map((p) => p.row);
  const comparableRows = new Set(pre.ranked.map((p) => p.row));
  const notComparableRows: FitInputRow[] = baseRows.filter((r) => !comparableRows.has(r));

  const allRows = [...windowRows, ...outsideRows, ...notComparableRows];
  const ranking = rankFit(allRows, model);

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
  };
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** Swedish short labels for the flags (the 14.1-03 set plus the size flag from 14.1-07). */
export const FIT_FLAG_LABELS: Record<FitFlag, string> = {
  expectedFinalOver4M: "slutpris>4M",
  ejBildtolkad: "ej bildtolkad",
  hiddenDefectRisk: "dold-defekt-risk",
  creditCapped: "kredit-tak",
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
  readonly expectedFinalKr: number | null;
  readonly resaleKr: number | null;
  readonly renoTier: string;
  readonly renoMidKr: number;
  readonly renoLowKr: number;
  readonly renoHighKr: number;
  readonly profitKr: number | null;
  readonly tasteKr: number;
  readonly flags: string[];
  readonly link: string;
}

const roundKr = (n: number): number => Math.round(n);
const roundOrNull = (n: number | null): number | null => (n === null ? null : roundKr(n));

/**
 * The ranked results as printable rows. This is the one place money is rounded
 * (Math.round, half towards +infinity: 1234.5 gives 1235, -1234.5 gives -1234).
 */
export function toFitTableRows(
  ranking: { readonly ranked: readonly FitScoreResult[] },
  preRankPositions: ReadonlyMap<string, number>,
): FitTableRow[] {
  return ranking.ranked.map((r, i) => ({
    rank: i + 1,
    preRank: preRankPositions.get(r.sourceListingUrl ?? `${r.address}|${r.askingSek}`) ?? null,
    address: r.address ?? "-",
    district: r.district,
    kvm: r.livingArea,
    floor: r.floor,
    askingKr: roundOrNull(r.askingSek),
    expectedFinalKr: roundOrNull(r.purchaseSek),
    resaleKr: roundOrNull(r.resaleSek),
    renoTier: r.renoTier,
    renoMidKr: roundKr(r.renoSek),
    renoLowKr: roundKr(r.renoLowSek),
    renoHighKr: roundKr(r.renoHighSek),
    profitKr: roundOrNull(r.profitSek),
    tasteKr: roundKr(r.tasteSek),
    flags: r.flags.map((f) => FIT_FLAG_LABELS[f]),
    link: r.sourceListingUrl ?? "-",
  }));
}

export const FIT_TABLE_HEADER =
  "# | Förrank | Adress | Område | kvm | vån | Utgångspris | Förv. slutpris | Värde renoverad | Reno (nivå, spann) | Vinst | Smak | Flaggor | Länk";

const kr = (n: number): string => n.toLocaleString("sv-SE");
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
        orDash(r.expectedFinalKr),
        orDash(r.resaleKr),
        `${r.renoTier} ${kr(r.renoMidKr)} (${kr(r.renoLowKr)}–${kr(r.renoHighKr)})`,
        orDash(r.profitKr),
        kr(r.tasteKr),
        r.flags.join(", ") || "-",
        r.link,
      ].join(" | "),
    );
  }
  if (rows.length > maxRows) lines.push(`+${rows.length - maxRows} till (se snapshot)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run reports (shared by the script and the Phase 14.2 email)
// ---------------------------------------------------------------------------

/** One line per district plus the line that says whether Kungsholmen made it. */
export function renderAreaReport(areas: readonly AreaReport[]): string {
  const lines = ["Områden:"];
  for (const a of areas) {
    lines.push(
      a.ok ? `  ${a.name}: ${a.listings} annonser (${a.renders} renders)` : `  ${a.name}: MISSLYCKADES - ${a.error ?? "okänt fel"}`,
    );
  }
  const kungsholmen = areas.find((a) => a.name.toLowerCase() === "kungsholmen");
  lines.push(kungsholmen !== undefined && kungsholmen.ok && kungsholmen.listings > 0 ? "Kungsholmen: med" : "Kungsholmen: SAKNAS");
  return lines.join("\n");
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
