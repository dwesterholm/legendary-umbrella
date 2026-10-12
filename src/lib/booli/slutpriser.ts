/**
 * slutpriser.ts - the sold-price dataset puller for Phase 14.1 (FIT-01, D-17).
 *
 * Every coefficient of the hedonic model (D-02) and every bid premium (D-03)
 * is fitted on the rows this module produces, so the module is written to be
 * boring and checkable: sign-correct parsing, a bounded promise pool, a
 * resumable page-by-page walk, and a zod schema on everything it persists.
 *
 * The module is PURE in the sense that matters here: no file system, no
 * environment and no clock. The script (`scripts/pull-slutpriser.ts`) supplies
 * `render` (the paid Apify call) and `persist` (the cache write), so every edge
 * can be tested on fakes before a kronor is spent.
 */
import { z } from "zod/v4";
import { INNERSTAN_DISTRICTS, type InnerstanDistrict } from "@/lib/discovery/hedonic-model";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Most renders ever in flight (R-06: capacity noise above this; T-14.1-03). */
export const SLUTPRIS_CONCURRENCY = 8;
/** Actor wait per render, seconds (R-06). */
export const SLUTPRIS_WAIT_SECS = 240;
/** Apify-side request retries per render (R-06). */
export const SLUTPRIS_MAX_RETRIES = 3;
/** Render attempts per page before the page is recorded as failed. */
export const SLUTPRIS_PAGE_ATTEMPTS = 3;
/** How many months of sales to pull (D-17: 12-18 months). */
export const SLUTPRIS_MONTHS = 18;

/**
 * Deepest page walked for one district and size band. Taken from
 * 14.1-PROBES.md Branch rules: min(40, SLUTPRIS_PAGE_DEPTH) with
 * `SLUTPRIS_PAGE_DEPTH: 30` (page 30 returned 35 sold cards; deeper pages are
 * unproven), so min(40, 30) = 30.
 */
export const SLUTPRIS_MAX_PAGES_PER_SLICE = 30;

/**
 * The six size bands, in living area m2 (R-12). The hard filter admits any flat
 * from 35 m2 up, so the model needs sales across that whole range; a 70 m2
 * candidate must be priced from 70 m2 sales, not by stretching a 35-60 m2
 * model. Contiguous, from 35 to 120.
 */
export const SLUTPRIS_SIZE_BANDS: ReadonlyArray<readonly [number, number]> = [
  [35, 40],
  [40, 45],
  [45, 50],
  [50, 60],
  [60, 80],
  [80, 120],
];

/** Bands starting at or above this living area get the upper-band page cap. */
export const SLUTPRIS_UPPER_BAND_MIN_M2 = 60;

/**
 * Page cap per district for the two upper bands (60-80 and 80-120 m2), R-12.
 * In plain words: sold flats of 60-120 m2 are plentiful, because the sold pull
 * has no price filter (and must not get one: filtering sold prices would keep
 * only the cheapest large flats and bias the model low). Four pages per
 * district is about 140 sold rows per band, enough to anchor the size effect.
 * Choosing rows by size and recency selects on model features (size, months
 * since sale), which does not bias the fitted coefficients.
 */
export const SLUTPRIS_UPPER_BAND_MAX_PAGES = 4;

// ---------------------------------------------------------------------------
// Types and schemas
// ---------------------------------------------------------------------------

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One cached sold flat. Every number is a float and finite (T-14.1-02). */
export const soldRowSchema = z.object({
  booliId: z.string().min(1),
  url: z.string().nullable(),
  address: z.string().nullable(),
  district: z.enum(INNERSTAN_DISTRICTS),
  soldDate: isoDateSchema,
  soldPrice: z.number().positive(),
  /** Sold vs asking in percent, sign-correct; null when Booli shows no label (not "at asking"). */
  soldVsAskPct: z.number().nullable(),
  /** soldPrice / (1 + pct/100); only when the label gave a percentage. */
  askingPrice: z.number().positive().nullable(),
  livingArea: z.number().positive(),
  rooms: z.number().nullable(),
  floor: z.number().nullable(),
  /** soldPrice / livingArea, never rounded. */
  krPerSqm: z.number().positive(),
  lat: z.number(),
  lng: z.number(),
  sliceKey: z.string(),
  /** Filled by the sold-detail enrichment in 14.1-08. */
  enriched: z
    .object({
      buildYear: z.number().nullable(),
      balcony: z.boolean().nullable(),
      listPrice: z.number().nullable(),
    })
    .nullable()
    .optional(),
});
export type SoldRow = z.infer<typeof soldRowSchema>;

const pageStateSchema = z.object({
  status: z.enum(["ok", "failed"]),
  attempts: z.number().int().nonnegative(),
  /** Sold entries seen on the page (rows kept or excluded), before the cutoff filter. */
  rowCount: z.number().int().nonnegative(),
  newestSoldDate: isoDateSchema.nullable(),
  oldestSoldDate: isoDateSchema.nullable(),
});
export type PageState = z.infer<typeof pageStateSchema>;

export const slutprisCacheSchema = z.object({
  version: z.literal(1),
  asOf: isoDateSchema,
  cutoff: isoDateSchema,
  /** Key "<district>|<min>-<max>|<page>". */
  pages: z.record(z.string(), pageStateSchema),
  rows: z.array(soldRowSchema),
  counts: z.object({
    missingSoldDate: z.number().int().nonnegative(),
    missingCoords: z.number().int().nonnegative(),
    missingPriceOrArea: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    /** Cards where the node-side label parse and the page-function value disagreed in sign. */
    signDisagreements: z.number().int().nonnegative(),
  }),
});
export type SlutprisCache = z.infer<typeof slutprisCacheSchema>;

export type Slice = {
  district: InnerstanDistrict;
  areaId: string;
  band: readonly [number, number];
  /** Per-slice page cap; the effective cap is min(maxPagesPerSlice, maxPages). */
  maxPages?: number;
};

export function newSlutprisCache(asOf: string, cutoff: string): SlutprisCache {
  return {
    version: 1,
    asOf,
    cutoff,
    pages: {},
    rows: [],
    counts: { missingSoldDate: 0, missingCoords: 0, missingPriceOrArea: 0, duplicates: 0, signDisagreements: 0 },
  };
}

// ---------------------------------------------------------------------------
// URL (T-14.1-08)
// ---------------------------------------------------------------------------

/**
 * Builds a Booli slutpriser URL from numeric parts only: a fixed origin, the
 * query assembled with URLSearchParams, and an area id that must be all digits.
 */
export function buildSlutprisSearchUrl(q: {
  areaId: string;
  page: number;
  minLivingArea: number;
  maxLivingArea: number;
  objectType: "Lägenhet";
}): string {
  if (!/^\d+$/.test(q.areaId)) throw new Error(`Ogiltigt områdes-id: ${JSON.stringify(q.areaId)}`);
  if (!Number.isInteger(q.page) || q.page < 1) throw new Error(`Ogiltigt sidnummer: ${q.page}`);
  if (!Number.isFinite(q.minLivingArea) || !Number.isFinite(q.maxLivingArea) || q.minLivingArea < 0 || q.maxLivingArea <= q.minLivingArea) {
    throw new Error(`Ogiltigt storleksintervall: ${q.minLivingArea}-${q.maxLivingArea}`);
  }
  const params = new URLSearchParams({
    areaIds: q.areaId,
    objectType: q.objectType,
    minLivingArea: String(q.minLivingArea),
    maxLivingArea: String(q.maxLivingArea),
    page: String(q.page),
  });
  return `https://www.booli.se/sok/slutpriser?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Label parsers
// ---------------------------------------------------------------------------

/**
 * Sold-vs-asking label to a signed percentage, or null.
 *
 * Booli writes a below-asking sale with an EN DASH (U+2013) or MINUS SIGN
 * (U+2212), a plus for above asking, and a decimal comma. Number-reading with a
 * plain "-" turns every discount into a premium (R-04a), so the sign set is
 * explicit. No-break spaces (U+00A0, U+202F) are normalised first.
 *
 * Icon rule: the icon key ("TrendDown" / "TrendUp", PROBES
 * PRICE_REMARK_ICON_KEY priceRemark.icon.key) wins when the label's sign is
 * missing or contradicts it. A missing label is null, never 0 (R-07).
 */
export function parsePremiumLabel(label: string | null | undefined, iconKey?: string | null): number | null {
  if (typeof label !== "string" || label === "") return null;
  const m = label
    .replace(/[  ]/g, " ")
    .match(/^\s*([+\-–−])?\s*(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[2].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const sign = m[1];
  let negative = sign === "-" || sign === "–" || sign === "−";
  if (iconKey === "TrendDown") negative = true;
  else if (iconKey === "TrendUp") negative = false;
  return negative && n !== 0 ? -n : n;
}

/**
 * Floor text to a number: "vån 3" 3, "vån 2,5" 2.5, "vån -1" -1, "BV"
 * (bottenvåning) 0. Anything else is null.
 */
export function parseFloorLabel(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/[  ]/g, " ").trim();
  if (/^BV$/i.test(t)) return 0;
  const m = t.match(/^vån\.?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** `isoDate` minus whole months, clamped to the last day of a shorter month. */
export function subtractMonthsIso(isoDate: string, months: number): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Ogiltigt datum: ${JSON.stringify(isoDate)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const idx = y * 12 + (mo - 1) - months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12 + 12) % 12 + 1;
  const td = Math.min(d, daysInMonth(ty, tm));
  return `${String(ty).padStart(4, "0")}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Rows from rendered items
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const finiteNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rawOf = (v: unknown): number | null => (isRecord(v) ? finiteNum(v.raw) : null);

/** Leading number of a Swedish plainText ("37 m²", "2,5 rum", "159 500 kr/m²"). */
function plainNumber(text: string): number | null {
  const m = text.replace(/[  ]/g, " ").match(/-?\d[\d\s]*(?:,\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function dataPointTexts(entry: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const collect = (attr: unknown): void => {
    if (!isRecord(attr) || !Array.isArray(attr.dataPoints)) return;
    for (const p of attr.dataPoints) {
      const plain = isRecord(p) && isRecord(p.value) ? p.value.plainText : undefined;
      if (typeof plain === "string") texts.push(plain);
    }
  };
  collect(entry.displayAttributes);
  // Raw Apollo cache keys carry the variant in the key: displayAttributes({...}).
  for (const k of Object.keys(entry).sort()) {
    if (k.startsWith("displayAttributes(")) collect(entry[k]);
  }
  return texts;
}

/** ISO calendar date from the card's date text, or null (Swedish "12 okt." forms are not guessed). */
function isoSoldDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export interface SoldRowsResult {
  rows: SoldRow[];
  missingSoldDate: number;
  missingCoords: number;
  missingPriceOrArea: number;
  /** Cards where the node-side label parse and the page-function value disagreed in sign. */
  signDisagreements: number;
}

/**
 * Sold rows from the dataset items `APOLLO_PAGE_FUNCTION` returns
 * (`[{ hasApollo, __APOLLO_STATE__ }]`). Only `SoldProperty:` entries count;
 * Listings and projects on the same page are ignored. An entry that cannot be
 * turned into a complete row is counted under the FIRST defect found (sold
 * date, then price/area, then coordinates) and skipped, never coerced to 0.
 */
export function soldRowsFromItems(items: unknown[], district: InnerstanDistrict, sliceKey: string): SoldRowsResult {
  const out: SoldRowsResult = { rows: [], missingSoldDate: 0, missingCoords: 0, missingPriceOrArea: 0, signDisagreements: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    if (!isRecord(it)) continue;
    const state = isRecord(it.__APOLLO_STATE__) ? it.__APOLLO_STATE__ : null;
    if (!state) continue;
    for (const [key, value] of Object.entries(state)) {
      if (!key.startsWith("SoldProperty:") || !isRecord(value)) continue;

      const soldDate = isoSoldDate(value.soldDate);
      if (soldDate === null) {
        out.missingSoldDate += 1;
        continue;
      }

      const texts = dataPointTexts(value);
      const areaText = texts.find((t) => /m²/.test(t) && !/kr\/m²/i.test(t) && !/kr\/kvm/i.test(t));
      const livingArea = areaText ? plainNumber(areaText) : null;
      const soldPrice = rawOf(value.soldPrice);
      if (soldPrice === null || soldPrice <= 0 || livingArea === null || livingArea <= 0) {
        out.missingPriceOrArea += 1;
        continue;
      }

      const lat = finiteNum(value.latitude);
      const lng = finiteNum(value.longitude);
      if (lat === null || lng === null) {
        out.missingCoords += 1;
        continue;
      }

      const roomsText = texts.find((t) => /\brum\b/i.test(t));
      const rooms = roomsText ? plainNumber(roomsText) : null;
      let floor: number | null = null;
      for (const t of texts) {
        const f = parseFloorLabel(t);
        if (f !== null) {
          floor = f;
          break;
        }
      }

      // Premium: the raw priceRemark (label + icon) parsed here wins; the page
      // function's own value is the fallback when the remark is absent.
      const remark = isRecord(value.priceRemark) ? value.priceRemark : null;
      const label = remark && typeof remark.label === "string" ? remark.label : null;
      const iconKey = remark && isRecord(remark.icon) && typeof remark.icon.key === "string" ? remark.icon.key : null;
      const nodePct = parsePremiumLabel(label, iconKey);
      const pagePct = rawOf(value.soldPricePercentageDiff);
      if (nodePct !== null && pagePct !== null && Math.sign(nodePct) !== Math.sign(pagePct)) out.signDisagreements += 1;
      const soldVsAskPct = nodePct ?? pagePct;
      const divisor = soldVsAskPct === null ? null : 1 + soldVsAskPct / 100;
      const askingPrice = divisor !== null && divisor > 0 ? soldPrice / divisor : null;

      const booliId = String(value.booliId ?? value.id ?? key.slice("SoldProperty:".length));
      out.rows.push({
        booliId,
        url: strOrNull(value.url),
        address: strOrNull(value.streetAddress),
        district,
        soldDate,
        soldPrice,
        soldVsAskPct,
        askingPrice,
        livingArea,
        rooms,
        floor,
        krPerSqm: soldPrice / livingArea,
        lat,
        lng,
        sliceKey,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded pool
// ---------------------------------------------------------------------------

/**
 * Runs `tasks` with at most `limit` in flight. `limit` workers pull the next
 * task index from a shared counter; results come back in task order and a
 * rejecting (or synchronously throwing) task does not stop the others. A small
 * hand-rolled pool on purpose: no p-limit / p-queue dependency.
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Ogiltig samtidighet: ${limit}`);
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Resumable puller
// ---------------------------------------------------------------------------

export interface PullOptions {
  slices: Slice[];
  /** The paid render: one URL in, the dataset items out. Throws on a failed render. */
  render: (url: string) => Promise<unknown[]>;
  cache: SlutprisCache;
  /** Rows sold on or after this ISO date are kept. */
  cutoffIso: string;
  concurrency: number;
  maxPagesPerSlice: number;
  /** Hard cap on render ATTEMPTS (each retry counts). */
  maxRenders: number;
  /** Sold dates fall page by page (PROBES SLUTPRIS_ORDER newest-first): stop a slice at the first page older than the cutoff. */
  newestFirst: boolean;
  persist: (cache: SlutprisCache) => void;
  onProgress?: (msg: string) => void;
  /** Checked before every render; true stops scheduling (the script's USD budget guard). */
  budgetExceeded?: () => boolean;
}

export interface PullResult {
  cache: SlutprisCache;
  rendersUsed: number;
  stoppedBy: "done" | "max-renders" | "budget";
}

/**
 * Walks every slice page by page and fills `cache` (mutated in place and
 * returned). One pool task per slice, so renders in flight never exceed slices
 * in flight, which never exceed min(concurrency, SLUTPRIS_CONCURRENCY).
 *
 * - Pages already `ok` in the cache are not rendered again; their stored dates
 *   feed the stop rule. Failed pages are retried.
 * - Up to SLUTPRIS_PAGE_ATTEMPTS renders per page; a page that still fails is
 *   recorded `failed` and ends its slice (a gap in the middle would skew the
 *   time coverage; a re-run resumes at that page).
 * - A slice ends at a page with no sold entries and, when `newestFirst`, after
 *   the first page whose newest sold date is before the cutoff.
 * - `persist` runs after every page outcome.
 */
export async function pullSlutpriser(opts: PullOptions): Promise<PullResult> {
  const { cache, cutoffIso } = opts;
  const concurrency = Math.max(1, Math.min(Math.floor(opts.concurrency), SLUTPRIS_CONCURRENCY));
  const seen = new Set(cache.rows.map((r) => r.booliId));
  let rendersUsed = 0;
  let stoppedBy: PullResult["stoppedBy"] = "done";
  const say = (msg: string): void => opts.onProgress?.(msg);

  /** Checked synchronously right before each render; sticky once tripped. */
  const renderAllowed = (): boolean => {
    if (stoppedBy !== "done") return false;
    if (rendersUsed >= opts.maxRenders) {
      stoppedBy = "max-renders";
      return false;
    }
    if (opts.budgetExceeded?.()) {
      stoppedBy = "budget";
      return false;
    }
    return true;
  };

  /** Renders one page (with attempts), records the outcome and persists. null = stopped before finishing. */
  const fetchPage = async (s: Slice, sliceKey: string, page: number, pageKey: string): Promise<PageState | null> => {
    const url = buildSlutprisSearchUrl({
      areaId: s.areaId,
      page,
      minLivingArea: s.band[0],
      maxLivingArea: s.band[1],
      objectType: "Lägenhet",
    });
    let attempts = 0;
    let items: unknown[] | null = null;
    let lastError = "";
    while (attempts < SLUTPRIS_PAGE_ATTEMPTS) {
      if (!renderAllowed()) return null;
      rendersUsed += 1;
      attempts += 1;
      try {
        items = await opts.render(url);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    let state: PageState;
    if (items === null) {
      state = { status: "failed", attempts, rowCount: 0, newestSoldDate: null, oldestSoldDate: null };
      say(`${pageKey}: MISSLYCKADES efter ${attempts} försök (${lastError})`);
    } else {
      const parsed = soldRowsFromItems(items, s.district, sliceKey);
      const dates = parsed.rows.map((r) => r.soldDate).sort();
      let kept = 0;
      for (const row of parsed.rows) {
        if (row.soldDate < cutoffIso) continue;
        if (seen.has(row.booliId)) {
          cache.counts.duplicates += 1;
          continue;
        }
        seen.add(row.booliId);
        cache.rows.push(row);
        kept += 1;
      }
      cache.counts.missingSoldDate += parsed.missingSoldDate;
      cache.counts.missingCoords += parsed.missingCoords;
      cache.counts.missingPriceOrArea += parsed.missingPriceOrArea;
      cache.counts.signDisagreements += parsed.signDisagreements;
      const entries = parsed.rows.length + parsed.missingSoldDate + parsed.missingCoords + parsed.missingPriceOrArea;
      state = {
        status: "ok",
        attempts,
        rowCount: entries,
        newestSoldDate: dates.length ? dates[dates.length - 1] : null,
        oldestSoldDate: dates.length ? dates[0] : null,
      };
      say(
        `${pageKey}: ok, ${entries} sålda (${kept} nya inom fönstret)` +
          (parsed.signDisagreements ? `, ${parsed.signDisagreements} teckenavvikelse(r) mellan etikett och sidfunktion` : ""),
      );
    }
    cache.pages[pageKey] = state;
    opts.persist(cache);
    return state;
  };

  const runSlice = async (s: Slice): Promise<void> => {
    const sliceKey = `${s.district}|${s.band[0]}-${s.band[1]}`;
    const cap = Math.min(opts.maxPagesPerSlice, s.maxPages ?? opts.maxPagesPerSlice);
    for (let page = 1; page <= cap; page++) {
      const pageKey = `${sliceKey}|${page}`;
      const existing = cache.pages[pageKey];
      let info: PageState | null;
      if (existing && existing.status === "ok") {
        info = existing;
      } else {
        info = await fetchPage(s, sliceKey, page, pageKey);
        if (info === null || info.status === "failed") return;
      }
      if (info.rowCount === 0) return;
      if (opts.newestFirst && info.newestSoldDate !== null && info.newestSoldDate < cutoffIso) return;
    }
  };

  const results = await runPool(
    opts.slices.map((s) => () => runSlice(s)),
    concurrency,
  );
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected.length > 0) {
    opts.persist(cache);
    const first = rejected[0].reason;
    throw new Error(`${rejected.length} delmängd(er) avbröts oväntat: ${first instanceof Error ? first.message : String(first)}`);
  }
  return { cache, rendersUsed, stoppedBy };
}
