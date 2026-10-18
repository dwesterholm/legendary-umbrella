/**
 * stambyte-join.ts - the sweep plan and the join helpers for the city's stambyte history
 * (Phase 14.6, STAM-01, D-05, R-01, R-05, RESEARCH 5.1 to 5.5).
 *
 * PURE, synchronous - no file system, no network, no clock, no randomness. Dates and the cases come in as
 * parameters. The cache functions and the city client are handed to the runner by `scripts/bygglov-sweep.ts`.
 *
 * WHAT IT DOES: it names the one-off sweep (11 stadsdelar x a keyword list x two start-date windows), indexes the swept
 * cases by address and by fastighetsbeteckning, says how well a sold flat's address meets that index (exact, other
 * entrance letter, same street within two house numbers, or none), and states what a building's recorded stambyten
 * looked like ON THE SALE DATE.
 *
 * HONESTY RULES:
 *  - "No case on record" is unknown, not "never had a stambyte" (RESEARCH 5.2: the record is thin after 2011).
 *  - Relining is a separate tag. A building's stambyte status comes only from cases whose kinds contain "stambyte" and not "relining" (R-05, WR-03).
 *  - Years are counted from the SALE date. A case that started after the sale is `futureAtSale`, never a past stambyte
 *    (RESEARCH 5.5), so the later price fit cannot see the future.
 *  - A case that was withdrawn (Avskrivet) or refused (Avslag) is not a stambyte.
 *
 * PII RULE: the cases carry tags, digits, dates and street addresses only (bygglov-classify.ts). Nothing here reads a
 * name or a sentence.
 *
 * STRUCTURAL SEPARATION (LOCKED, D-12): like `ceiling-height.ts` and `sun-path.ts`, this module sits beside the ranking
 * path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the "discovery/stambyte-" prefix is registered in
 * `niche-score.test.ts` (in an earlier commit than this file).
 */
import { z } from "zod/v4";
import type { SweepCase, SweepQuery } from "@/lib/stockholm/bygglov-cache";
import { decisionKind, isStambyteKinds } from "@/lib/stockholm/bygglov-classify";

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * The stadsdelar the sweep asks about, spelled exactly as the city's dropdown spells them (the city says "Vasastaden",
 * Booli says "Vasastan"). The four the sold set uses come first, so a run that is stopped early has them.
 */
export const SWEEP_DISTRICTS = [
  "Södermalm",
  "Kungsholmen",
  "Vasastaden",
  "Östermalm",
  "Norrmalm",
  "Marieberg",
  "Fredhäll",
  "Kristineberg",
  "Reimersholme",
  "Hjorthagen",
  "Ladugårdsgärdet",
] as const;

/** The first start date of the sweep. */
export const SWEEP_START = "1985-01-01";

/** An answer with this many rows or more is not trusted to be complete: the window is split (RESEARCH 5.1). */
export const SPLIT_ROWS = 500;

/**
 * The search words. `substring` is the spike's measured answer to "does the Beskrivning field match inside words"
 * (R-07): true means a short stem finds every compound, so four words cover it. Otherwise the whole words are sent
 * one by one. The bare "VA" is never sent: inside words it would match half the language (RESEARCH 5.1).
 */
export function sweepKeywords(substring: boolean | null): string[] {
  return substring === true ? ["stam", "avlopp", "vatten", "relin"] : ["stambyte", "stamrenovering", "avlopp", "vatten", "relining"];
}

/** A start-date window. `to: null` means "up to today" (no CaseStartDateTo is sent), so the cache name never changes. */
export interface SweepWindow {
  /** YYYY-MM-DD. */
  readonly from: string;
  /** YYYY-MM-DD, or null for "up to today". */
  readonly to: string | null;
}

/** The two windows of D-05: 1985 to the end of 2009 and 2010 onwards. One window per query is plenty (RESEARCH 5.1). */
export function sweepWindows(): SweepWindow[] {
  return [
    { from: SWEEP_START, to: "2009-12-31" },
    { from: "2010-01-01", to: null },
  ];
}

/** The queries of the sweep: every stadsdel x search word x window, in that order. Cached ones (`isCached`) are left out. */
export function planSweep(
  districts: readonly string[],
  keywords: readonly string[],
  windows: readonly SweepWindow[],
  isCached: (query: SweepQuery) => boolean,
): SweepQuery[] {
  const out: SweepQuery[] = [];
  for (const district of districts) {
    for (const description of keywords) {
      for (const w of windows) {
        const query: SweepQuery = { district, description, from: w.from, to: w.to };
        if (!isCached(query)) out.push(query);
      }
    }
  }
  return out;
}

/** A span longer than this many calendar years is split into spans of this length; a shorter one is split by year. */
export const SPLIT_SPAN_YEARS = 5;

/**
 * Splits a window into 5-year spans (inclusive dates, no gap, no overlap): 1985 to 2009 becomes 1985-1989 ... 2005-2009.
 * A window that is 5 years long or shorter is split by year. A single year cannot be split (empty list). The first span
 * keeps the window's own start, the last its own end, so an open end stays open (`today` is then needed to count the
 * years, and is not sent anywhere).
 */
export function splitWindow(window: SweepWindow, today?: string): SweepWindow[] {
  const fromYear = Number(window.from.slice(0, 4));
  let toYear: number;
  if (window.to !== null) {
    toYear = Number(window.to.slice(0, 4));
  } else {
    if (today === undefined) throw new Error("splitWindow: a window with an open end needs today's date");
    toYear = Number(today.slice(0, 4));
  }
  const years = toYear - fromYear + 1;
  if (years <= 1) return [];
  const step = years > SPLIT_SPAN_YEARS ? SPLIT_SPAN_YEARS : 1;
  const out: SweepWindow[] = [];
  for (let year = fromYear; year <= toYear; year += step) {
    const last = Math.min(year + step - 1, toYear);
    out.push({ from: year === fromYear ? window.from : `${year}-01-01`, to: last === toYear ? window.to : `${last}-12-31` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The runner (the cache, the clock and the city are handed in)
// ---------------------------------------------------------------------------

/** What one extended search answers. The city client's `ExtendedSearchAnswer` fits. */
export type SweepAnswer =
  | { readonly ok: true; readonly cases: readonly SweepCase[]; readonly headingCount: number | null }
  /** `storlek`: the page is over the size cap. `antal`: the page's own count differs from its rows (a hidden cap). */
  | { readonly ok: false; readonly reason: "storlek" | "antal" };

/** Why a window was split: the answer was too big, or its count could not be trusted (500 rows or more, or a mismatch). */
export type SplitReason = "storlek" | "antal";

export interface SplitRecord extends SweepQuery {
  readonly reason: SplitReason;
}

export interface RunSweepDeps {
  /** One extended search. A refusal or a pause throws; `stopOf` tells which throw ends the run. */
  search(query: SweepQuery): Promise<SweepAnswer>;
  /** True when the query has a cache file that is not stale. */
  isFresh(query: SweepQuery): boolean;
  save(query: SweepQuery, answer: { readonly cases: readonly SweepCase[]; readonly headingCount: number | null }): void;
  /** True when the query was split in an earlier run (its spans are asked instead). */
  splitRecorded(query: SweepQuery): boolean;
  recordSplit(query: SweepQuery, reason: SplitReason): void;
  /** A window that is capped and cannot be split further (a single year). */
  recordUnsplittable(query: SweepQuery, reason: SplitReason): void;
  now(): Date;
  /** Throws a Swedish message when a manual run must not make a request at `at` (the Monday window). */
  allowed(at: Date): void;
  /** The label of a throw that ends the run (a refusal, a pause, the budget), or null for any other error. */
  stopOf(error: unknown): string | null;
  log(line: string): void;
  /** YYYY-MM-DD, to count the years of an open window. */
  today: string;
}

export interface SweepStop {
  /** `stad`: the city client ended the run. `fonster`: the Monday window. */
  readonly kind: "stad" | "fonster";
  readonly label: string;
  readonly detail: string;
}

export interface SweepRunResult {
  readonly status: "klar" | "stoppad";
  readonly stop: SweepStop | null;
  /** Queries of the plan that are fully in the cache (cached, or split with all spans cached). */
  readonly saved: number;
  readonly total: number;
  /** Searches answered in this run. */
  readonly searches: number;
  readonly splits: readonly SplitRecord[];
  /** Capped windows of a single year: they could not be split and are not in the cache. */
  readonly unsplittable: readonly SweepQuery[];
  /** The sentence to print when the run stopped, else null. */
  readonly message: string | null;
}

/** The start gate holds a request up to this long, so the window check looks this far ahead. */
const GATE_MS = 3000;

class SweepHalt extends Error {
  constructor(readonly stop: SweepStop) {
    super(stop.detail);
    this.name = "SweepHalt";
  }
}

/**
 * Runs the plan: each query that is not in the cache is asked once, in order. An answer that is too big (storlek),
 * whose count differs from its rows or that holds 500 rows or more is NOT saved; its window is split into 5-year spans
 * (by year when already short), the split is recorded and the spans are asked instead. A single year that is still capped
 * (or whose count cannot be trusted) is reported (`unsplittable`) and not saved, so it counts as missing; the run goes on. A refusal, a pause, the request budget or the Monday window ends the run
 * at once; everything saved stays, and the next run resumes (cached queries and recorded splits are never asked again).
 */
export async function runSweep(plan: readonly SweepQuery[], deps: RunSweepDeps): Promise<SweepRunResult> {
  let searches = 0;
  const splits: SplitRecord[] = [];
  const unsplittable: SweepQuery[] = [];

  const childrenOf = (q: SweepQuery): SweepQuery[] =>
    splitWindow({ from: q.from, to: q.to }, deps.today).map((w) => ({ district: q.district, description: q.description, from: w.from, to: w.to }));

  const covered = (q: SweepQuery): boolean => {
    if (deps.isFresh(q)) return true;
    if (!deps.splitRecorded(q)) return false;
    const kids = childrenOf(q);
    return kids.length > 0 && kids.every(covered);
  };

  const label = (q: SweepQuery) => `${q.district} ${q.description} ${q.from}..${q.to ?? "idag"}`;

  async function ask(q: SweepQuery): Promise<SweepAnswer> {
    try {
      deps.allowed(new Date(deps.now().getTime() + GATE_MS));
    } catch (error) {
      throw new SweepHalt({ kind: "fonster", label: "fonster", detail: error instanceof Error ? error.message : "körfönstret är stängt" });
    }
    try {
      const answer = await deps.search(q);
      searches += 1;
      return answer;
    } catch (error) {
      const stopLabel = deps.stopOf(error);
      if (stopLabel === null) throw error;
      throw new SweepHalt({ kind: "stad", label: stopLabel, detail: stopLabel });
    }
  }

  async function split(q: SweepQuery, reason: SplitReason): Promise<void> {
    const kids = childrenOf(q);
    if (kids.length === 0) {
      deps.recordUnsplittable(q, reason);
      unsplittable.push(q);
      deps.log(`[svep] ${label(q)}: svaret kan inte delas mer (${reason}); sökningen saknas`);
      return;
    }
    deps.recordSplit(q, reason);
    splits.push({ ...q, reason });
    deps.log(`[svep] ${label(q)}: delas i ${kids.length} tidsfönster (${reason})`);
    for (const kid of kids) await ensure(kid);
  }

  async function ensure(q: SweepQuery): Promise<void> {
    if (deps.isFresh(q)) return;
    if (deps.splitRecorded(q)) {
      for (const kid of childrenOf(q)) await ensure(kid);
      return;
    }
    const answer = await ask(q);
    if (!answer.ok) return split(q, answer.reason);
    const rows = answer.cases.length;
    const stated = answer.headingCount;
    if (stated !== null && stated !== rows) return split(q, "antal");
    // 500 rows or more may be a capped answer. A window that can be split is split; a single year cannot be, so it is
    // reported (unsplittable) and NOT saved: the sweep then counts it as missing, never as complete (WR-14).
    if (rows >= SPLIT_ROWS || (stated ?? 0) >= SPLIT_ROWS) return split(q, "antal");
    deps.save(q, { cases: answer.cases, headingCount: stated });
    deps.log(`[svep] ${label(q)}: ${rows} ärenden`);
  }

  let stop: SweepStop | null = null;
  try {
    for (const q of plan) await ensure(q);
  } catch (error) {
    if (!(error instanceof SweepHalt)) throw error;
    stop = error.stop;
  }

  const saved = plan.filter(covered).length;
  const total = plan.length;
  let message: string | null = null;
  if (stop !== null) {
    message = `Svepet stoppat (${stop.label}): ${saved} av ${total} sökningar sparade`;
    if (stop.kind === "fonster") message += `. ${stop.detail}`;
  }
  return { status: stop === null ? "klar" : "stoppad", stop, saved, total, searches, splits, unsplittable, message };
}

/** One query that is in the cache and answers for its window. */
export interface SweepLeaf {
  readonly query: SweepQuery;
  readonly cases: readonly SweepCase[];
  readonly headingCount: number | null;
}

export interface SweepCollection {
  /** The cached queries that together cover the plan (a split query is replaced by its spans). */
  readonly leaves: readonly SweepLeaf[];
  /** Queries that were split (their spans are in `leaves`, or in `missing`). */
  readonly splitParents: readonly SweepQuery[];
  /** Queries (or spans) that are not in the cache. */
  readonly missing: readonly SweepQuery[];
}

/**
 * Reads the plan back from the cache: a fresh file is a leaf, a recorded split is replaced by its spans, anything else
 * is missing. `load` returns null for a missing, damaged or stale file.
 */
export function collectSweep(
  plan: readonly SweepQuery[],
  deps: {
    load(query: SweepQuery): { readonly cases: readonly SweepCase[]; readonly headingCount: number | null } | null;
    splitRecorded(query: SweepQuery): boolean;
    today: string;
  },
): SweepCollection {
  const leaves: SweepLeaf[] = [];
  const splitParents: SweepQuery[] = [];
  const missing: SweepQuery[] = [];
  const walk = (q: SweepQuery): void => {
    const loaded = deps.load(q);
    if (loaded !== null) {
      leaves.push({ query: q, cases: loaded.cases, headingCount: loaded.headingCount });
      return;
    }
    if (deps.splitRecorded(q)) {
      const kids = splitWindow({ from: q.from, to: q.to }, deps.today);
      if (kids.length > 0) {
        splitParents.push(q);
        for (const k of kids) walk({ district: q.district, description: q.description, from: k.from, to: k.to });
        return;
      }
    }
    missing.push(q);
  };
  for (const q of plan) walk(q);
  return { leaves, splitParents, missing };
}

// ---------------------------------------------------------------------------
// The evidence: counts only
// ---------------------------------------------------------------------------

const queryRef = z.strictObject({
  district: z.string().min(1).max(60),
  keyword: z.string().min(1).max(60),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
const countMap = z.record(z.string().regex(/^\d{4}$/), z.number().int().nonnegative());
const count = z.number().int().nonnegative();

/**
 * The shape of `evidence/sweep.json`. STRICT: an extra key is a failure, so a name, a case text or a document list can
 * never reach the committed file (T-14.6-42). Everything in it is a count, a tag, a district, a keyword or a date.
 */
export const sweepEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ranAt: z.string(),
  complete: z.boolean(),
  stop: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable(),
  substring: z.boolean().nullable(),
  keywords: z.array(z.string().min(1).max(60)).max(20),
  districts: z.array(z.string().min(1).max(60)).max(30),
  windows: z.array(z.strictObject({ from: z.string(), to: z.string().nullable() })).max(10),
  requests: count,
  secondsMedian: z.number().nonnegative().nullable(),
  secondsMax: z.number().nonnegative().nullable(),
  queries: z
    .array(queryRef.extend({ rows: count.nullable(), headingCount: count.nullable(), split: z.boolean() }))
    .max(2000),
  splits: z.array(queryRef.extend({ reason: z.enum(["storlek", "antal"]) })).max(2000),
  missing: z.array(queryRef).max(2000),
  totals: z.strictObject({
    searches: count,
    cases: count,
    distinctBeteckningar: count,
    stambyteTagged: count,
    stambyteBeteckningar: count,
    reliningTagged: count,
    active: count,
    archived: count,
    casesPerStartYear: countMap,
    stambytePerStartYear: countMap,
  }),
  byDistrict: z
    .array(
      z.strictObject({
        district: z.string(),
        complete: z.boolean(),
        searches: count,
        cases: count,
        stambyteTagged: count,
        reliningTagged: count,
        beteckningar: count,
        stambyteBeteckningar: count,
        stambyteByDecade: countMap,
      }),
    )
    .max(30),
  byKeyword: z
    .array(z.strictObject({ keyword: z.string(), searches: count, cases: count, stambyteTagged: count }))
    .max(20),
});

export type SweepEvidence = z.infer<typeof sweepEvidenceSchema>;

export interface SweepEvidenceInput {
  readonly ranAt: string;
  readonly keywords: readonly string[];
  readonly substring: boolean | null;
  readonly districts: readonly string[];
  readonly windows: readonly SweepWindow[];
  readonly collection: SweepCollection;
  /** Every split ever recorded for this cache. */
  readonly splits: readonly SplitRecord[];
  /** Requests made to the city across all runs on this cache. */
  readonly requests: number;
  readonly seconds: readonly number[];
  /** The label that ended the last run, or null. */
  readonly stop: string | null;
}

const decadeOf = (startDate: string): string => `${Math.floor(Number(startDate.slice(0, 4)) / 10) * 10}`;
const yearOf = (startDate: string): string => startDate.slice(0, 4);

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function tally(dates: readonly string[], key: (d: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dates) out[key(d)] = (out[key(d)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Distinct cases (by rec) of a set of leaves. */
function distinctCases(leaves: readonly SweepLeaf[]): SweepCase[] {
  const seen = new Map<string, SweepCase>();
  for (const leaf of leaves) for (const c of leaf.cases) if (!seen.has(c.rec)) seen.set(c.rec, c);
  return [...seen.values()];
}

function groupTotals(cases: readonly SweepCase[]) {
  const stambyte = cases.filter(isStambyteCase);
  return {
    cases: cases.length,
    stambyteTagged: stambyte.length,
    reliningTagged: cases.filter(isReliningCase).length,
    beteckningar: new Set(cases.map((c) => beteckningKey(c.beteckning)).filter((k) => k !== "")).size,
    stambyteBeteckningar: new Set(stambyte.map((c) => beteckningKey(c.beteckning)).filter((k) => k !== "")).size,
    stambyte,
  };
}

/**
 * The counts of a sweep, built from the cache read-back. Counts, tags, districts, keywords and dates only (the strict
 * schema checks it). `stambyteTagged` counts cases whose kinds contain "stambyte" and not "relining"; relining is counted
 * on its own and never added to it (R-05, WR-03).
 */
export function buildSweepEvidence(input: SweepEvidenceInput): SweepEvidence {
  const { collection } = input;
  const order = (q: SweepQuery) => [input.districts.indexOf(q.district), input.keywords.indexOf(q.description), q.from] as const;
  const byPlanOrder = (a: SweepQuery, b: SweepQuery) => {
    const [da, ka, fa] = order(a);
    const [db, kb, fb] = order(b);
    return da - db || ka - kb || fa.localeCompare(fb);
  };
  const ref = (q: SweepQuery) => ({ district: q.district, keyword: q.description, from: q.from, to: q.to });

  const queries = [
    ...collection.splitParents.map((q) => ({ query: q, rows: null as number | null, headingCount: null as number | null, split: true })),
    ...collection.leaves.map((l) => ({ query: l.query, rows: l.cases.length as number | null, headingCount: l.headingCount, split: false })),
  ]
    .sort((a, b) => byPlanOrder(a.query, b.query) || Number(b.split) - Number(a.split))
    .map((x) => ({ ...ref(x.query), rows: x.rows, headingCount: x.headingCount, split: x.split }));

  const all = groupTotals(distinctCases(collection.leaves));
  const byDistrict = input.districts
    .filter((d) => collection.leaves.some((l) => l.query.district === d) || collection.missing.some((m) => m.district === d))
    .map((district) => {
      const leaves = collection.leaves.filter((l) => l.query.district === district);
      const g = groupTotals(distinctCases(leaves));
      return {
        district,
        complete: !collection.missing.some((m) => m.district === district),
        searches: leaves.length,
        cases: g.cases,
        stambyteTagged: g.stambyteTagged,
        reliningTagged: g.reliningTagged,
        beteckningar: g.beteckningar,
        stambyteBeteckningar: g.stambyteBeteckningar,
        stambyteByDecade: tally(g.stambyte.map((c) => c.startDate), decadeOf),
      };
    });
  const byKeyword = input.keywords.map((keyword) => {
    const leaves = collection.leaves.filter((l) => l.query.description === keyword);
    const g = groupTotals(distinctCases(leaves));
    return { keyword, searches: leaves.length, cases: g.cases, stambyteTagged: g.stambyteTagged };
  });

  const casesAll = distinctCases(collection.leaves);
  const evidence: SweepEvidence = {
    schemaVersion: 1,
    ranAt: input.ranAt,
    complete: collection.missing.length === 0 && input.stop === null,
    stop: input.stop,
    substring: input.substring,
    keywords: [...input.keywords],
    districts: [...input.districts],
    windows: input.windows.map((w) => ({ from: w.from, to: w.to })),
    requests: input.requests,
    secondsMedian: medianOf(input.seconds),
    secondsMax: input.seconds.length === 0 ? null : Math.round(Math.max(...input.seconds) * 10) / 10,
    queries,
    splits: input.splits.map((r) => ({ ...ref(r), reason: r.reason })),
    missing: [...collection.missing].sort(byPlanOrder).map(ref),
    totals: {
      searches: collection.leaves.length,
      cases: all.cases,
      distinctBeteckningar: all.beteckningar,
      stambyteTagged: all.stambyteTagged,
      stambyteBeteckningar: all.stambyteBeteckningar,
      reliningTagged: all.reliningTagged,
      active: casesAll.filter((c) => !c.archived).length,
      archived: casesAll.filter((c) => c.archived).length,
      casesPerStartYear: tally(casesAll.map((c) => c.startDate), yearOf),
      stambytePerStartYear: tally(all.stambyte.map((c) => c.startDate), yearOf),
    },
    byDistrict,
    byKeyword,
  };
  return sweepEvidenceSchema.parse(evidence);
}

const sv = (n: number) => n.toLocaleString("sv-SE").replace(/\u00a0/g, " ");
const dec = (n: number | null) => (n === null ? "-" : n.toFixed(1).replace(".", ","));

const averagePerYear = (perYear: Readonly<Record<string, number>>, from: number, to: number): number => {
  let total = 0;
  for (let y = from; y <= to; y += 1) total += perYear[String(y)] ?? 0;
  return total / (to - from + 1);
};

/** The sweep in plain Swedish: what was asked, what came back, and what a thin record means. */
export function renderSweepMarkdown(e: SweepEvidence): string {
  const t = e.totals;
  const decades = [...new Set(e.byDistrict.flatMap((d) => Object.keys(d.stambyteByDecade)))].sort();
  const lines: string[] = [];
  lines.push("# Svepet över innerstan: stambyten i stadens ärendelista", "");
  lines.push(
    e.complete
      ? "Utfall: KLAR. Alla sökningar finns i cachen."
      : `Utfall: DELVIS${e.stop === null ? "" : `, stoppat (${e.stop})`}. ${e.missing.length} sökningar saknas.`,
    "",
  );
  lines.push(`Körd ${e.ranAt.slice(0, 10)}. ${e.requests} anrop mot etjanster.stockholm.se, i median ${dec(e.secondsMedian)} sekunder per anrop (längst ${dec(e.secondsMax)}).`);
  lines.push(
    `Sökord: ${e.keywords.join(", ")}${e.substring === true ? " (fältet söker inuti ord, så korta ordstammar räcker)" : ""}. Tidsfönster: ${e.windows.map((w) => `${w.from} till ${w.to ?? "idag"}`).join(" och ")}.`,
    "",
  );
  lines.push("## Vad svepet hittade", "");
  lines.push(
    `${sv(t.cases)} ärenden i ${sv(t.distinctBeteckningar)} fastigheter, från ${t.searches} sökningar. Av dem är ${sv(t.stambyteTagged)} stambyten (i ${sv(t.stambyteBeteckningar)} fastigheter). Relining är ${sv(t.reliningTagged)} ärenden och räknas för sig, aldrig som stambyte. ${sv(t.active)} ärenden är aktiva och ${sv(t.archived)} arkiverade.`,
    "",
  );
  lines.push("Siffrorna är ärenden i stadens lista, inte genomförda stambyten: ett stambyte som ingen anmält syns inte.", "");

  lines.push("## Per stadsdel", "");
  lines.push("| Stadsdel | Sökningar | Ärenden | Stambyten | Relining | Fastigheter | Fastigheter med stambyte | Klar |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const d of e.byDistrict) {
    lines.push(`| ${d.district} | ${d.searches} | ${sv(d.cases)} | ${sv(d.stambyteTagged)} | ${sv(d.reliningTagged)} | ${sv(d.beteckningar)} | ${sv(d.stambyteBeteckningar)} | ${d.complete ? "ja" : "nej"} |`);
  }
  lines.push("");

  lines.push("## Per sökord", "");
  lines.push("| Sökord | Sökningar | Ärenden | Stambyten |", "|---|---|---|---|");
  for (const k of e.byKeyword) lines.push(`| ${k.keyword} | ${k.searches} | ${sv(k.cases)} | ${sv(k.stambyteTagged)} |`);
  lines.push("");

  lines.push("## Stambyten per decennium (startår för ärendet)", "");
  lines.push(`| Stadsdel | ${decades.map((d) => `${d}-talet`).join(" | ")} |`, `|---|${decades.map(() => "---").join("|")}|`);
  for (const d of e.byDistrict) lines.push(`| ${d.district} | ${decades.map((dc) => d.stambyteByDecade[dc] ?? 0).join(" | ")} |`);
  lines.push("");

  lines.push("## Delade tidsfönster", "");
  if (e.splits.length === 0) {
    lines.push("Inget svar var så stort eller så osäkert att ett tidsfönster behövde delas.", "");
  } else {
    lines.push(`${e.splits.length} sökningar delades i femårsfönster, för att antalet var 500 eller fler, svaret var för stort eller sidans eget antal stämde inte med raderna:`, "");
    for (const r of e.splits) lines.push(`- ${r.district}, "${r.keyword}", ${r.from} till ${r.to ?? "idag"} (${r.reason})`);
    lines.push("");
  }
  if (e.missing.length > 0) {
    lines.push("Saknas i cachen:", "");
    for (const m of e.missing) lines.push(`- ${m.district}, "${m.keyword}", ${m.from} till ${m.to ?? "idag"}`);
    lines.push("");
  }

  const early = averagePerYear(t.stambytePerStartYear, 1994, 2006);
  const late = averagePerYear(t.stambytePerStartYear, 2012, 2019);
  lines.push("## Vad den tunna posten efter 2011 betyder", "");
  lines.push(
    `Mellan 1994 och 2006 startade i snitt ${dec(early)} stambytesärenden per år i de stadsdelar som svepet täcker. Mellan 2012 och 2019 var det ${dec(late)}. Det säger inte att färre hus fick nya stammar. Staden listar ett stambyte först när någon har anmält det. Före domen MÖD 2020:19 anmälde troligen många föreningar inte, men det kan svepet inte avgöra. Svepet kan inte skilja ett hus utan stambyte från ett hus med ett stambyte som aldrig anmäldes. En fastighet utan post är därför okänd, inte utan stambyte.`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** What the join needs of a swept case. A `SweepCase` from the cache fits. */
export interface IndexableCase {
  readonly rec: string;
  readonly beteckning: string;
  readonly addresses: readonly string[];
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly kinds: readonly string[];
  readonly archived: boolean;
}

/** True when the case carries the stambyte tag and not the relining tag. Relining is never a stambyte (D-06, R-05, WR-03). */
export const isStambyteCase = (c: { readonly kinds: readonly string[] }): boolean => isStambyteKinds(c.kinds);
export const isReliningCase = (c: { readonly kinds: readonly string[] }): boolean => c.kinds.includes("relining");

export interface CaseTotals {
  readonly cases: number;
  readonly beteckningar: number;
  readonly stambyte: number;
  readonly relining: number;
}

/** Counts over distinct cases (by rec): cases, distinct beteckningar, stambyte-tagged, relining-tagged. */
export function summariseCases(cases: readonly IndexableCase[]): CaseTotals {
  const seen = new Map<string, IndexableCase>();
  for (const c of cases) if (!seen.has(c.rec)) seen.set(c.rec, c);
  const all = [...seen.values()];
  return {
    cases: all.length,
    beteckningar: new Set(all.map((c) => beteckningKey(c.beteckning)).filter((k) => k !== "")).size,
    stambyte: all.filter(isStambyteCase).length,
    relining: all.filter(isReliningCase).length,
  };
}

/** The comparison form of a beteckning: trimmed, inner whitespace collapsed, lower case (as the cache's `sameBeteckning`). */
export function beteckningKey(beteckning: string): string {
  return beteckning.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * The key form of an address: lower case, spaces collapsed, an entrance letter closed up ("Torsgatan 48 A" ->
 * "torsgatan 48a"). The same rule as `normaliseAddressKey` in bygglov-cache.ts (which uses node:fs, so it is not
 * imported here; a test keeps the two equal).
 */
export function normaliseAddress(address: string): string {
  return address
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("sv")
    .replace(/(\d) ([a-zåäö])$/u, "$1$2");
}

export interface ParsedAddress {
  /** Lower case street name, "krukmakarg" for "Krukmakarg 42". */
  readonly street: string;
  readonly number: number;
  /** One lower case entrance letter, or null. */
  readonly letter: string | null;
}

/** The key of a parsed address: "slipgatan 11", "bondegatan 1f". */
export const addressKey = (a: ParsedAddress): string => `${a.street} ${a.number}${a.letter ?? ""}`;

/** The most numbers or letters one range ("Tengdahlsgatan 4-18", "13 A-D") expands to. */
const RANGE_MAX = 15;
const LETTER_RANGE_MAX = 8;

/**
 * The street addresses one written address stands for. The city writes several things in the address field:
 *  - "Slipgatan 11", "Bondegatan 1f", "Heleneborgsgatan 28 A": one address;
 *  - "Siargatan 9-11", "Tengdahlsgatan 4-18": a range of house numbers (every second number, or every number when the
 *    ends have different parity);
 *  - "Heleneborgsgatan 13 A-D": a range of letters;
 *  - "Tavastgatan 39", then "41": a bare number takes the street of the one before it (`inheritStreet`);
 *  - "Östgötagatan 87A O B +": the first number and letter count, the rest is ignored.
 * An address with no street and no number ("Adress saknas") gives an empty list.
 */
export function parseAddresses(raw: string, inheritStreet: string | null = null): ParsedAddress[] {
  const text = raw.replace(/\\/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  if (text === "") return [];

  let street: string;
  let number: number;
  let rest: string;
  const full = /^(\D*?[^\d\s])\s*(\d{1,4})(.*)$/u.exec(text);
  if (full !== null && /\p{L}/u.test(full[1])) {
    street = full[1].trim();
    number = Number(full[2]);
    rest = full[3].trim();
  } else {
    const bare = /^(\d{1,4})(.*)$/u.exec(text);
    if (bare === null || inheritStreet === null) return [];
    street = inheritStreet;
    number = Number(bare[1]);
    rest = bare[2].trim();
  }
  if (street === "") return [];

  let letters: Array<string | null> = [null];
  const letter = /^([a-zåäö])(?:\s*-\s*([a-zåäö]))?(?![a-zåäö])/u.exec(rest);
  if (letter !== null) {
    rest = rest.slice(letter[0].length).trim();
    const first = letter[1];
    const last = letter[2];
    if (last === undefined) {
      letters = [first];
    } else {
      const span = last.charCodeAt(0) - first.charCodeAt(0);
      letters = span > 0 && span < LETTER_RANGE_MAX ? Array.from({ length: span + 1 }, (_, i) => String.fromCharCode(first.charCodeAt(0) + i)) : [first];
    }
  }

  let numbers = [number];
  const range = /^-\s*(\d{1,4})(?!\d)/u.exec(rest);
  if (range !== null && letters.length === 1 && letters[0] === null) {
    const end = Number(range[1]);
    const span = end - number;
    if (span > 0 && span <= 40) {
      const step = span % 2 === 0 ? 2 : 1;
      numbers = [];
      for (let n = number; n <= end && numbers.length < RANGE_MAX; n += step) numbers.push(n);
    }
  }

  const out: ParsedAddress[] = [];
  for (const n of numbers) for (const l of letters) out.push({ street, number: n, letter: l });
  return out;
}

// ---------------------------------------------------------------------------
// The case index
// ---------------------------------------------------------------------------

export interface CaseIndex {
  /** Distinct cases by rec. */
  readonly cases: ReadonlyMap<string, IndexableCase>;
  /** Address key ("slipgatan 11", "bondegatan 1f") to the recs of the cases listed under it. */
  readonly byAddress: ReadonlyMap<string, readonly string[]>;
  /** Beteckning key ("skrovet 8") to the recs of its cases. */
  readonly byBeteckning: ReadonlyMap<string, readonly string[]>;
  /** Street to house number to entrance letter ("" for none) to recs: for the letter and near classes. */
  readonly byStreet: ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, readonly string[]>>>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/**
 * Indexes the swept cases (distinct by rec; the first copy wins). Every address of every case is indexed, also the
 * ones of a list ("Brännkyrkagatan 64,Ludvigsbergsgatan 1") and the ones a range stands for, and every beteckning.
 */
export function buildCaseIndex(cases: readonly IndexableCase[]): CaseIndex {
  const byRec = new Map<string, IndexableCase>();
  const byAddress = new Map<string, string[]>();
  const byBeteckning = new Map<string, string[]>();
  const byStreet = new Map<string, Map<number, Map<string, string[]>>>();

  for (const c of cases) {
    if (byRec.has(c.rec)) continue;
    byRec.set(c.rec, c);
    const bet = beteckningKey(c.beteckning);
    if (bet !== "") push(byBeteckning, bet, c.rec);

    let lastStreet: string | null = null;
    for (const raw of c.addresses) {
      // A written list can also hold slashes and semicolons ("Krukmakarg 42 / RINGVÄGEN 14").
      for (const part of raw.split(/[/;]/)) {
        for (const a of parseAddresses(part, lastStreet)) {
          lastStreet = a.street;
          push(byAddress, addressKey(a), c.rec);
          let numbers = byStreet.get(a.street);
          if (numbers === undefined) byStreet.set(a.street, (numbers = new Map()));
          let letters = numbers.get(a.number);
          if (letters === undefined) numbers.set(a.number, (letters = new Map()));
          push(letters, a.letter ?? "", c.rec);
        }
      }
    }
  }
  return { cases: byRec, byAddress, byBeteckning, byStreet };
}

export type AddressClass = "exact" | "letter" | "near" | "none";

export interface AddressMatch {
  readonly class: AddressClass;
  /** The recs of the cases the class rests on (empty for "none"). */
  readonly recs: readonly string[];
  /** The distinct beteckningar of those cases, as the city writes them. */
  readonly beteckningar: readonly string[];
}

/** Same street within this many house numbers (not the same number) is "near" (RESEARCH 5.3). */
export const NEAR_NUMBERS = 2;

/**
 * How a sold flat's address meets the swept cases:
 *  - exact: a case is listed under this very address ("Slipgatan 11");
 *  - letter: the same street and number with another entrance letter, or with and without one ("Bondegatan 1" and
 *    "Bondegatan 1f");
 *  - near: the same street within two house numbers; the city's address search must decide if it is the same building
 *    (a corner block lists two streets);
 *  - none: anything else, also an address with no number ("Lützengatan").
 */
export function classifySoldAddress(address: string, index: CaseIndex): AddressMatch {
  const parsed = parseAddresses(address)[0];
  if (parsed === undefined) return { class: "none", recs: [], beteckningar: [] };
  const withBeteckningar = (cls: AddressClass, recs: readonly string[]): AddressMatch => ({
    class: cls,
    recs: [...recs],
    beteckningar: [
      ...new Set(recs.map((rec) => index.cases.get(rec)?.beteckning.replace(/\s+/g, " ").trim() ?? "").filter((b) => b !== "")),
    ],
  });

  const exact = index.byAddress.get(addressKey(parsed));
  if (exact !== undefined) return withBeteckningar("exact", exact);

  const numbers = index.byStreet.get(parsed.street);
  if (numbers === undefined) return withBeteckningar("none", []);

  const same = numbers.get(parsed.number);
  if (same !== undefined) return withBeteckningar("letter", [...same.values()].flat());

  const near: string[] = [];
  for (let d = -NEAR_NUMBERS; d <= NEAR_NUMBERS; d += 1) {
    if (d === 0) continue;
    const letters = numbers.get(parsed.number + d);
    if (letters !== undefined) near.push(...[...letters.values()].flat());
  }
  return near.length > 0 ? withBeteckningar("near", [...new Set(near)]) : withBeteckningar("none", []);
}

export interface JoinCounts {
  readonly rows: number;
  readonly exact: number;
  readonly letter: number;
  readonly near: number;
  readonly none: number;
}

/** How many sold rows fall in each class (RESEARCH 5.3). */
export function joinCounts(addresses: readonly string[], index: CaseIndex): JoinCounts {
  const counts = { rows: addresses.length, exact: 0, letter: 0, near: 0, none: 0 };
  for (const address of addresses) counts[classifySoldAddress(address, index).class] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The state of a building ON THE SALE DATE
// ---------------------------------------------------------------------------

/** What `stambyteAtSale` reads of a case. A `StoredCase` from the case list fits; a `SweepCase` fits without the decision fields. */
export interface StambyteCaseInput {
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly kinds: readonly string[];
  /** YYYY-MM-DD. Absent or null: no slutbesked is recorded (also when the detail page was never read). */
  readonly slutbeskedDate?: string | null;
  /** The latest decision, when the detail page was read. Used only to drop a withdrawn or refused case. */
  readonly latest?: { readonly type: string; readonly code: string | null } | null;
}

export interface StambyteAtSale {
  /** At least one stambyte was finished (or old enough to count as done) on the sale date. */
  readonly recorded: boolean;
  /** The year of the latest such stambyte, or null. */
  readonly latestYear: number | null;
  /** How that year was read: the slutbesked, or (list-only and archived cases) the start of the case. */
  readonly source: "slutbesked" | "start" | null;
  /** Sale year minus `latestYear`, or null. */
  readonly yearsBefore: number | null;
  /** A stambyte started within 5 years before the sale and was not finished by it. */
  readonly ongoingAtSale: boolean;
  /** A stambyte case started AFTER the sale. It is never counted as past (RESEARCH 5.5). */
  readonly futureAtSale: boolean;
}

/** A list-only case with no slutbesked counts as done when it started at least this many years before the sale. */
export const PAST_AFTER_YEARS = 3;
/** A case that started within this many years before the sale and is not done is "ongoing at sale". */
export const ONGOING_WITHIN_YEARS = 5;

/** `iso` moved by whole years; 29 February becomes 28 February in a year without one. */
export function shiftYears(iso: string, years: number): string {
  const year = Number(iso.slice(0, 4)) + years;
  const month = iso.slice(5, 7);
  let day = iso.slice(8, 10);
  if (month === "02" && day === "29") {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!leap) day = "28";
  }
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

/**
 * The recorded stambyte state of one building on `soldDate` (YYYY-MM-DD), from its stambyte cases (RESEARCH 5.5):
 *  - PAST at the sale: the slutbesked is on or before the sale date (the year is the slutbesked's), or no slutbesked is
 *    recorded at all and the case started at least 3 years before the sale (the year is the start year: the list-only
 *    and the archived case);
 *  - FUTURE at the sale: the case started after the sale date;
 *  - ONGOING at the sale: it started on or before the sale date, is not past, and started within 5 years of the sale.
 * A relining-only building is not recorded. A case withdrawn (Avskrivet) or refused (Avslag) is ignored.
 */
export function stambyteAtSale(cases: readonly StambyteCaseInput[], soldDate: string): StambyteAtSale {
  const pastLimit = shiftYears(soldDate, -PAST_AFTER_YEARS);
  const ongoingLimit = shiftYears(soldDate, -ONGOING_WITHIN_YEARS);
  let latestYear: number | null = null;
  let source: "slutbesked" | "start" | null = null;
  let ongoing = false;
  let future = false;

  for (const c of cases) {
    if (!isStambyteCase(c)) continue;
    if (c.latest != null) {
      const decision = decisionKind(c.latest.type, c.latest.code);
      if (decision === "avskrivet" || decision === "avslag") continue;
    }
    if (c.startDate > soldDate) {
      future = true;
      continue;
    }
    const finished = c.slutbeskedDate ?? null;
    let year: number | null = null;
    let how: "slutbesked" | "start" | null = null;
    if (finished !== null) {
      if (finished <= soldDate) {
        year = Number(finished.slice(0, 4));
        how = "slutbesked";
      }
    } else if (c.startDate <= pastLimit) {
      year = Number(c.startDate.slice(0, 4));
      how = "start";
    }
    if (year !== null) {
      if (latestYear === null || year > latestYear) {
        latestYear = year;
        source = how;
      }
    } else if (c.startDate >= ongoingLimit) {
      ongoing = true;
    }
  }

  const saleYear = Number(soldDate.slice(0, 4));
  return {
    recorded: latestYear !== null,
    latestYear,
    source,
    yearsBefore: latestYear === null ? null : saleYear - latestYear,
    ongoingAtSale: ongoing,
    futureAtSale: future,
  };
}
