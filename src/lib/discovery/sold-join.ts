/**
 * sold-join.ts - the sold flats joined to the city's stambyte history (Phase 14.6, STAM-01, D-05).
 *
 * PURE: no network, no file access, no `node:` import. `scripts/stambyte-join.ts` hands in the sold rows, the case index
 * of the sweep (stambyte-join.ts), the answers the city's address search left in the address map and the detail pages
 * already read; this file decides which sold address is joined by which stage, builds the join rows, counts them and
 * writes the evidence in plain Swedish.
 *
 * THE STAGES (RESEARCH 5.4), a sold flat's address meets the swept cases:
 *   A   exact: a case is listed under this very address, and all such cases name one beteckning   (free)
 *   A+  the same street and number with another entrance letter, one beteckning                   (free)
 *   B   the near class (same street within two numbers) and an exact or letter match that names several
 *       beteckningar: the city's address search decides, on the equal-address rule
 *   C   an address with a number and no case on its street within two numbers: the address search, first for a
 *       seeded sample, then for the rest only when the sample earns it
 * An address with no house number is never asked. A relining case is carried for the record and is never a stambyte.
 */
import { z } from "zod/v4";
import { cleanAddressForSearch } from "@/lib/stockholm/beteckning-text";
import {
  beteckningKey,
  classifySoldAddress,
  isReliningCase,
  isStambyteCase,
  normaliseAddress,
  parseAddresses,
  stambyteAtSale,
  type AddressClass,
  type CaseIndex,
} from "@/lib/discovery/stambyte-join";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinStage = "A" | "A+" | "B" | "C";

/** What the join reads of a sold flat. */
export interface SoldInput {
  readonly booliId: string;
  readonly address: string;
  readonly district: string;
  /** YYYY-MM-DD. */
  readonly soldDate: string;
}

/** A case as the join file carries it: tags and dates. The detail dates are null until the detail page is read. */
export interface JoinCase {
  readonly rec: string;
  readonly startDate: string;
  readonly kinds: readonly string[];
  readonly archived: boolean;
  readonly startbeskedDate: string | null;
  readonly slutbeskedDate: string | null;
  /** The latest decision's type and code (the city's fixed words), only once the detail page is read. */
  readonly latest: { readonly type: string; readonly code: string | null } | null;
}

export interface JoinRow {
  /** The normalised address the lookup used ("hornsgatan 42b"). */
  readonly addressKey: string;
  readonly stage: JoinStage | null;
  readonly beteckning: string | null;
  /** The building's stambyte and relining cases, oldest first. */
  readonly cases: readonly JoinCase[];
}

/** What a detail page added to a case (`applyDetail` in bygglov-classify.ts). */
export interface JoinDetail {
  readonly startbeskedDate: string | null;
  readonly slutbeskedDate: string | null;
  readonly latest: { readonly type: string; readonly code: string | null } | null;
}

/** What the city's address search answered for one address (the address map's entry). */
export interface LookupAnswer {
  readonly beteckning: string | null;
  readonly status: "resolved" | "ambiguous" | "no_candidates";
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** The key a sold address is asked and cached under: cleaned like the candidate lookup, then normalised. */
export const soldAddressKey = (address: string): string => normaliseAddress(cleanAddressForSearch(address));

export type AddressGroup = AddressClass | "nonumber";

export interface AddressPlan {
  readonly key: string;
  /** The cleaned address in the sold set's own spelling: what the city's address search is asked (in memory only). */
  readonly asked: string;
  /** Sold rows at this address. */
  readonly rows: number;
  readonly group: AddressGroup;
  /** The free stage that identified the building, or null. */
  readonly freeStage: "A" | "A+" | null;
  readonly freeBeteckning: string | null;
  /** The stage that asks the city about this address when the free stages did not identify it, or null (never asked). */
  readonly asks: "B" | "C" | null;
}

/**
 * Classifies every distinct sold address. An exact or letter match is free only when the cases under it name exactly
 * one beteckning; several beteckningar (or none) is ambiguous and goes to the address search, so a wrong building is
 * never linked on a guess (T-14.6-51).
 */
export function planAddresses(sold: readonly SoldInput[], index: CaseIndex): Map<string, AddressPlan> {
  const rowsPerKey = new Map<string, { rows: number; asked: string }>();
  for (const s of sold) {
    const asked = cleanAddressForSearch(s.address);
    const key = normaliseAddress(asked);
    const seen = rowsPerKey.get(key);
    if (seen === undefined) rowsPerKey.set(key, { rows: 1, asked });
    else seen.rows += 1;
  }
  const plans = new Map<string, AddressPlan>();
  for (const [key, { rows, asked }] of rowsPerKey) {
    if (parseAddresses(key)[0] === undefined) {
      plans.set(key, { key, asked, rows, group: "nonumber", freeStage: null, freeBeteckning: null, asks: null });
      continue;
    }
    const match = classifySoldAddress(key, index);
    if ((match.class === "exact" || match.class === "letter") && match.beteckningar.length === 1) {
      plans.set(key, {
        key,
        asked,
        rows,
        group: match.class,
        freeStage: match.class === "exact" ? "A" : "A+",
        freeBeteckning: match.beteckningar[0],
        asks: null,
      });
    } else {
      plans.set(key, { key, asked, rows, group: match.class, freeStage: null, freeBeteckning: null, asks: match.class === "none" ? "C" : "B" });
    }
  }
  return plans;
}

/** The distinct addresses a stage asks about, the ones with the most sold rows first (ties alphabetical). */
export function addressesToAsk(plans: ReadonlyMap<string, AddressPlan>, stage: "B" | "C"): string[] {
  return [...plans.values()]
    .filter((p) => p.asks === stage)
    .sort((a, b) => b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((p) => p.key);
}

/** mulberry32: a small seeded generator, so the sample of the same seed is the same sample. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `size` items drawn without replacement (Fisher-Yates over the sorted input, seeded). */
export function seededSample<T>(items: readonly T[], size: number, seed: number): T[] {
  const pool = [...items].sort();
  const random = seededRandom(seed);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, size));
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** The stambyte and relining cases of one beteckning, oldest first, with the detail dates when they were read. */
export function casesOfBuilding(beteckning: string, index: CaseIndex, details: ReadonlyMap<string, JoinDetail>): JoinCase[] {
  const recs = index.byBeteckning.get(beteckningKey(beteckning)) ?? [];
  const out: JoinCase[] = [];
  for (const rec of recs) {
    const c = index.cases.get(rec);
    if (c === undefined || !(isStambyteCase(c) || isReliningCase(c))) continue;
    const d = details.get(rec);
    out.push({
      rec,
      startDate: c.startDate,
      kinds: [...c.kinds],
      archived: c.archived,
      startbeskedDate: d?.startbeskedDate ?? null,
      slutbeskedDate: d?.slutbeskedDate ?? null,
      latest: d?.latest ?? null,
    });
  }
  return out.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.rec < b.rec ? -1 : 1));
}

/**
 * The join row of every sold flat. The free stage wins; otherwise the city's answer for the address counts, and only a
 * "resolved" answer: an ambiguous or empty one leaves the flat unidentified.
 */
export function buildJoinRows(
  sold: readonly SoldInput[],
  index: CaseIndex,
  plans: ReadonlyMap<string, AddressPlan>,
  lookup: (key: string) => LookupAnswer | undefined,
  details: ReadonlyMap<string, JoinDetail>,
): Record<string, JoinRow> {
  const rows: Record<string, JoinRow> = {};
  const perBuilding = new Map<string, JoinCase[]>();
  const casesFor = (beteckning: string): JoinCase[] => {
    const k = beteckningKey(beteckning);
    let cases = perBuilding.get(k);
    if (cases === undefined) perBuilding.set(k, (cases = casesOfBuilding(beteckning, index, details)));
    return cases;
  };
  for (const s of sold) {
    const key = soldAddressKey(s.address);
    const plan = plans.get(key);
    let stage: JoinStage | null = null;
    let beteckning: string | null = null;
    if (plan?.freeStage != null && plan.freeBeteckning !== null) {
      stage = plan.freeStage;
      beteckning = plan.freeBeteckning;
    } else if (plan?.asks != null) {
      const answer = lookup(key);
      if (answer?.status === "resolved" && answer.beteckning !== null) {
        stage = plan.asks;
        beteckning = answer.beteckning;
      }
    }
    rows[s.booliId] = { addressKey: key, stage, beteckning, cases: beteckning === null ? [] : casesFor(beteckning) };
  }
  return rows;
}

/**
 * The stambyte cases the detail stage reads: cases of identified buildings that started in or after `fromYear`, are
 * stambyte cases and have no detail yet, oldest first, once per rec. `cap` of them at most.
 */
export function detailCandidates(
  rows: Readonly<Record<string, JoinRow>>,
  index: CaseIndex,
  fromYear: number,
  read: ReadonlySet<string>,
  cap: number,
): { wanted: number; take: Array<{ rec: string; archived: boolean }> } {
  const seen = new Map<string, { rec: string; archived: boolean; startDate: string }>();
  for (const row of Object.values(rows)) {
    for (const c of row.cases) {
      if (seen.has(c.rec) || !isStambyteCase(c) || Number(c.startDate.slice(0, 4)) < fromYear) continue;
      seen.set(c.rec, { rec: c.rec, archived: index.cases.get(c.rec)?.archived ?? c.archived, startDate: c.startDate });
    }
  }
  const all = [...seen.values()].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.rec < b.rec ? -1 : 1));
  const todo = all.filter((c) => !read.has(c.rec));
  return { wanted: all.length, take: todo.slice(0, Math.max(0, cap)).map(({ rec, archived }) => ({ rec, archived })) };
}

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

/** Years from the latest recorded stambyte to the sale, in classes. */
export const YEARS_CLASSES = ["0-5", "6-10", "11-15", "16-25", "26-40", "over 40"] as const;
export type YearsClass = (typeof YEARS_CLASSES)[number];

export function yearsClass(years: number): YearsClass | null {
  if (!Number.isFinite(years) || years < 0) return null;
  if (years <= 5) return "0-5";
  if (years <= 10) return "6-10";
  if (years <= 15) return "11-15";
  if (years <= 25) return "16-25";
  if (years <= 40) return "26-40";
  return "over 40";
}

const count = z.number().int().nonnegative();
const pct = z.number().min(0).max(100);
const yearsMap = z.strictObject({
  "0-5": count,
  "6-10": count,
  "11-15": count,
  "16-25": count,
  "26-40": count,
  "over 40": count,
});

const countsSchema = z.strictObject({
  rows: count,
  addresses: count,
  identified: count,
  stageA: count,
  stageAplus: count,
  stageB: count,
  stageC: count,
  joinRatePct: pct,
  /** Identified rows whose building has at least one stambyte case, whatever its date. */
  inStambyteBuilding: count,
  /** Rows identified by the free stages (A and A+) whose building has a stambyte case: the figure RESEARCH 5.3 estimated. */
  freeInStambyteBuilding: count,
  /** Rows with a stambyte recorded as finished on or before the sale. */
  recordedBeforeSale: count,
  ongoingAtSale: count,
  futureAtSale: count,
  /** Identified rows whose building has a relining case and no stambyte case. */
  reliningOnly: count,
  yearsBefore: yearsMap,
});
export type JoinCounts = z.infer<typeof countsSchema>;

const emptyYears = (): Record<YearsClass, number> => ({ "0-5": 0, "6-10": 0, "11-15": 0, "16-25": 0, "26-40": 0, "over 40": 0 });

const emptyCounts = (): JoinCounts => ({
  rows: 0,
  addresses: 0,
  identified: 0,
  stageA: 0,
  stageAplus: 0,
  stageB: 0,
  stageC: 0,
  joinRatePct: 0,
  inStambyteBuilding: 0,
  freeInStambyteBuilding: 0,
  recordedBeforeSale: 0,
  ongoingAtSale: 0,
  futureAtSale: 0,
  reliningOnly: 0,
  yearsBefore: emptyYears(),
});

/** A percentage with one decimal. */
export const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

/** The join counts of every district and of all sold rows together. */
export function summariseJoin(
  sold: readonly SoldInput[],
  rows: Readonly<Record<string, JoinRow>>,
): { total: JoinCounts; byDistrict: Record<string, JoinCounts> } {
  const total = emptyCounts();
  const byDistrict: Record<string, JoinCounts> = {};
  const addresses = new Map<string, Set<string>>();
  const allAddresses = new Set<string>();

  for (const s of sold) {
    const row = rows[s.booliId];
    if (row === undefined) continue;
    const d = (byDistrict[s.district] ??= emptyCounts());
    let set = addresses.get(s.district);
    if (set === undefined) addresses.set(s.district, (set = new Set()));
    set.add(row.addressKey);
    allAddresses.add(row.addressKey);

    const hasStambyte = row.cases.some(isStambyteCase);
    const state = row.beteckning === null ? null : stambyteAtSale(row.cases, s.soldDate);
    for (const c of [d, total]) {
      c.rows += 1;
      if (row.stage === null) continue;
      c.identified += 1;
      if (row.stage === "A") c.stageA += 1;
      else if (row.stage === "A+") c.stageAplus += 1;
      else if (row.stage === "B") c.stageB += 1;
      else c.stageC += 1;
      if (hasStambyte) {
        c.inStambyteBuilding += 1;
        if (row.stage === "A" || row.stage === "A+") c.freeInStambyteBuilding += 1;
      } else if (row.cases.some(isReliningCase)) {
        c.reliningOnly += 1;
      }
      if (state !== null) {
        if (state.recorded) {
          c.recordedBeforeSale += 1;
          const klass = state.yearsBefore === null ? null : yearsClass(state.yearsBefore);
          if (klass !== null) c.yearsBefore[klass] += 1;
        }
        if (state.ongoingAtSale) c.ongoingAtSale += 1;
        if (state.futureAtSale) c.futureAtSale += 1;
      }
    }
  }
  for (const [name, c] of Object.entries(byDistrict)) {
    c.addresses = addresses.get(name)?.size ?? 0;
    c.joinRatePct = percent(c.identified, c.rows);
  }
  total.addresses = allAddresses.size;
  total.joinRatePct = percent(total.identified, total.rows);
  return { total, byDistrict };
}

/** Distinct sold addresses and sold rows per address group. */
export function groupCounts(plans: ReadonlyMap<string, AddressPlan>): { addresses: Record<AddressGroup, number>; rows: Record<AddressGroup, number> } {
  const addresses: Record<AddressGroup, number> = { exact: 0, letter: 0, near: 0, none: 0, nonumber: 0 };
  const rows: Record<AddressGroup, number> = { exact: 0, letter: 0, near: 0, none: 0, nonumber: 0 };
  for (const p of plans.values()) {
    addresses[p.group] += 1;
    rows[p.group] += p.rows;
  }
  return { addresses, rows };
}

/**
 * How a sample of asked addresses came out. A hit is an address whose building has a stambyte case in the sweep: that
 * is what the full pass would add to the fit. `resolved` counts every address the city could place in a building.
 */
export function sampleOutcome(
  keys: readonly string[],
  lookup: (key: string) => LookupAnswer | undefined,
  index: CaseIndex,
): { asked: number; answered: number; resolved: number; hits: number } {
  let answered = 0;
  let resolved = 0;
  let hits = 0;
  for (const key of keys) {
    const answer = lookup(key);
    if (answer === undefined) continue;
    answered += 1;
    if (answer.status !== "resolved" || answer.beteckning === null) continue;
    resolved += 1;
    const recs = index.byBeteckning.get(beteckningKey(answer.beteckning)) ?? [];
    if (recs.some((rec) => { const c = index.cases.get(rec); return c !== undefined && isStambyteCase(c); })) hits += 1;
  }
  return { asked: keys.length, answered, resolved, hits };
}

/** Why a sold row is still not tied to a building, in rows. */
export interface UnidentifiedRows {
  /** The address has no house number ("Lützengatan", "Adress saknas"): never asked. */
  readonly noNumber: number;
  /** The city's address search named more than one beteckning for the address. */
  readonly ambiguous: number;
  /** The city's address search named none, or only street land. */
  readonly noCandidates: number;
  /** An address the stages did not reach (a stopped run). */
  readonly notAsked: number;
}

export function unidentifiedRows(
  sold: readonly SoldInput[],
  rows: Readonly<Record<string, JoinRow>>,
  plans: ReadonlyMap<string, AddressPlan>,
  lookup: (key: string) => LookupAnswer | undefined,
): UnidentifiedRows {
  const out = { noNumber: 0, ambiguous: 0, noCandidates: 0, notAsked: 0 };
  for (const s of sold) {
    const row = rows[s.booliId];
    if (row === undefined || row.stage !== null) continue;
    const plan = plans.get(row.addressKey);
    const answer = lookup(row.addressKey);
    if (plan?.group === "nonumber") out.noNumber += 1;
    else if (answer?.status === "ambiguous") out.ambiguous += 1;
    else if (answer?.status === "no_candidates") out.noCandidates += 1;
    else out.notAsked += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The evidence: counts only
// ---------------------------------------------------------------------------

const groupMap = z.strictObject({ exact: count, letter: count, near: count, none: count, nonumber: count });
const requestMap = z.strictObject({ B: count, "C-sample": count, C: count, detail: count });
const secondsMap = z.strictObject({
  B: z.number().nonnegative(),
  "C-sample": z.number().nonnegative(),
  C: z.number().nonnegative(),
  detail: z.number().nonnegative(),
});

/**
 * The shape of `evidence/join.json`. STRICT, like the sweep's: a key that is not a count, a district name, a date or a
 * fixed sentence cannot be written, so no address, name or case text reaches a committed file (T-14.6-53).
 */
export const joinEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ranAt: z.string(),
  soldAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: countsSchema,
  districts: z.record(z.string().min(1).max(40), countsSchema),
  addressGroups: z.strictObject({ addresses: groupMap, rows: groupMap }),
  /** The same years-before classes as `total.yearsBefore`, kept at top level for readers of the file. */
  yearsBefore: yearsMap,
  requests: z.strictObject({
    perStage: requestMap,
    secondsPerStage: secondsMap,
    total: count,
    medianSecondsPerRequest: z.number().nonnegative().nullable(),
  }),
  sample: z.strictObject({
    ran: z.boolean(),
    size: count,
    seed: z.number().int(),
    answered: count,
    resolved: count,
    hits: count,
    threshold: count,
  }),
  stageC: z.strictObject({
    run: z.boolean(),
    decision: z.string().max(400),
    addressesTotal: count,
    addressesAnswered: count,
  }),
  stageB: z.strictObject({ addressesTotal: count, addressesAnswered: count, resolved: count }),
  /** Rows not tied to a building, by reason. */
  unidentified: z.strictObject({ noNumber: count, ambiguous: count, noCandidates: count, notAsked: count }),
  detail: z.strictObject({ wanted: count, read: count, cap: count }),
  stop: z.string().max(60).nullable(),
});
export type JoinEvidence = z.infer<typeof joinEvidenceSchema>;

export interface JoinEvidenceInput {
  readonly ranAt: string;
  readonly soldAsOf: string;
  readonly summary: { total: JoinCounts; byDistrict: Record<string, JoinCounts> };
  readonly groups: ReturnType<typeof groupCounts>;
  readonly requests: { perStage: Record<"B" | "C-sample" | "C" | "detail", number>; secondsPerStage: Record<"B" | "C-sample" | "C" | "detail", number>; medianSecondsPerRequest: number | null };
  readonly sample: { ran: boolean; size: number; seed: number; answered: number; resolved: number; hits: number; threshold: number };
  readonly stageC: { run: boolean; decision: string; addressesTotal: number; addressesAnswered: number };
  readonly stageB: { addressesTotal: number; addressesAnswered: number; resolved: number };
  readonly unidentified: UnidentifiedRows;
  readonly detail: { wanted: number; read: number; cap: number };
  readonly stop: string | null;
}

export function buildJoinEvidence(input: JoinEvidenceInput): JoinEvidence {
  const { perStage } = input.requests;
  return joinEvidenceSchema.parse({
    schemaVersion: 1,
    ranAt: input.ranAt,
    soldAsOf: input.soldAsOf,
    total: input.summary.total,
    districts: input.summary.byDistrict,
    addressGroups: input.groups,
    yearsBefore: input.summary.total.yearsBefore,
    requests: {
      perStage: input.requests.perStage,
      secondsPerStage: input.requests.secondsPerStage,
      total: perStage.B + perStage["C-sample"] + perStage.C + perStage.detail,
      medianSecondsPerRequest: input.requests.medianSecondsPerRequest,
    },
    sample: input.sample,
    stageC: input.stageC,
    stageB: input.stageB,
    unidentified: input.unidentified,
    detail: input.detail,
    stop: input.stop,
  });
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** 7431 -> "7 431" (a plain space, so a line can be matched with [0-9 ]). */
export const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/** 20.6 -> "20,6". */
export const dec = (n: number): string => n.toFixed(1).replace(".", ",");

/** "Kopplade sålda rader: 3 112 av 7 431 (41,9 %)" */
export const joinLine = (c: Pick<JoinCounts, "identified" | "rows" | "joinRatePct">): string =>
  `Kopplade sålda rader: ${fmt(c.identified)} av ${fmt(c.rows)} (${dec(c.joinRatePct)} %)`;

/** The class as it is written in Swedish text ("over 40" is the key in the JSON). */
const yearsLabel = (k: YearsClass): string => (k === "over 40" ? "över 40" : k);

/** Fewer rows than this in a class is too few for the fit (RESEARCH 6.2). */
export const MIN_ROWS_PER_CLASS = 30;

const stageText = (c: JoinCounts) => `A ${fmt(c.stageA)}, A+ ${fmt(c.stageAplus)}, B ${fmt(c.stageB)}, C ${fmt(c.stageC)}`;

/** The text printed by the script after every run (and the head of join.md's tables). */
export function renderJoinReport(e: JoinEvidence): string[] {
  const lines: string[] = [joinLine(e.total)];
  lines.push(`Fördelning efter steg: ${stageText(e.total)}`);
  lines.push(
    `Rader i hus med registrerat stambyte före försäljningen: ${fmt(e.total.recordedBeforeSale)} av ${fmt(e.total.rows)} (${dec(percent(e.total.recordedBeforeSale, e.total.rows))} %)`,
  );
  lines.push(`Rader per år från stambyte till försäljning: ${YEARS_CLASSES.map((k) => `${yearsLabel(k)} ${fmt(e.yearsBefore[k])}`).join(", ")}`);
  lines.push(
    `Pågående stambyte vid försäljningen: ${fmt(e.total.ongoingAtSale)}. Stambyte som startade efter försäljningen: ${fmt(e.total.futureAtSale)}. Hus med bara relining: ${fmt(e.total.reliningOnly)} rader`,
  );
  for (const [name, c] of Object.entries(e.districts)) {
    lines.push(
      `  ${name}: ${fmt(c.identified)} av ${fmt(c.rows)} (${dec(c.joinRatePct)} %), steg ${stageText(c)}, med stambyte före försäljning ${fmt(c.recordedBeforeSale)}, i hus med stambyteärende ${fmt(c.inStambyteBuilding)}`,
    );
  }
  return lines;
}

/** join.md: the join in plain Swedish. */
export function renderJoinMarkdown(e: JoinEvidence): string {
  const t = e.total;
  const g = e.addressGroups;
  const lines: string[] = [];
  lines.push("# Kopplingen mellan sålda lägenheter och stadens stambyteregister", "");
  lines.push(`Körd ${e.ranAt.slice(0, 10)} mot de sålda raderna i slutprisfilen (läst, aldrig skriven; prisnivå per ${e.soldAsOf}).`, "");
  lines.push("## Hur många sålda lägenheter vi kunde knyta till ett hus", "");
  lines.push(joinLine(t), "");
  lines.push(
    `En såld lägenhet räknas som kopplad när vi vet vilken fastighet den ligger i. Det gäller ${fmt(t.identified)} av ${fmt(t.rows)} rader. En kopplad rad är ändå inte en rad med känt stambyte: bara ${fmt(t.recordedBeforeSale)} rader (${dec(percent(t.recordedBeforeSale, t.rows))} %) ligger i ett hus med ett stambyte registrerat före försäljningen. Övriga kopplade rader ligger i hus utan registrerat stambyte, och det betyder inte att de aldrig bytt stammar.`,
    "",
  );
  lines.push(
    `Kopplingen kom så här: exakt samma adress i stadens ärenden (steg A) ${fmt(t.stageA)} rader, samma gata och nummer med annan trappuppgång (A+) ${fmt(t.stageAplus)}, stadens adresssökning för grannnummer och tvetydiga träffar (B) ${fmt(t.stageB)}, stadens adresssökning för resten (C) ${fmt(t.stageC)}.`,
    "",
  );
  lines.push("| Stadsdel | Sålda rader | Kopplade rader | Andel | A | A+ | B | C | Stambyte före försäljning | I hus med stambyteärende |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, c] of Object.entries(e.districts)) {
    lines.push(
      `| ${name} | ${fmt(c.rows)} | ${fmt(c.identified)} | ${dec(c.joinRatePct)} % | ${fmt(c.stageA)} | ${fmt(c.stageAplus)} | ${fmt(c.stageB)} | ${fmt(c.stageC)} | ${fmt(c.recordedBeforeSale)} | ${fmt(c.inStambyteBuilding)} |`,
    );
  }
  lines.push(`| Alla | ${fmt(t.rows)} | ${fmt(t.identified)} | ${dec(t.joinRatePct)} % | ${fmt(t.stageA)} | ${fmt(t.stageAplus)} | ${fmt(t.stageB)} | ${fmt(t.stageC)} | ${fmt(t.recordedBeforeSale)} | ${fmt(t.inStambyteBuilding)} |`, "");

  lines.push("## Hur adresserna fördelade sig", "");
  lines.push(
    `Av ${fmt(t.addresses)} olika adresser hade ${fmt(g.addresses.exact)} ett ärende på exakt samma adress, ${fmt(g.addresses.letter)} ett ärende på samma gata och nummer med annan trappuppgång, ${fmt(g.addresses.near)} låg inom två husnummer från ett ärende, ${fmt(g.addresses.none)} hade inget ärende nära och ${fmt(g.addresses.nonumber)} saknade husnummer och frågades aldrig. Adresserna motsvarar ${fmt(g.rows.exact + g.rows.letter + g.rows.near + g.rows.none + g.rows.nonumber)} sålda rader.`,
    "",
  );

  lines.push("## Stickprovet och beslutet om steg C", "");
  const s = e.sample;
  if (s.ran) {
    lines.push(`Stickprov ingen-klassen: ${s.hits} av ${s.size} träffar (frö ${s.seed}). En träff är en adress vars hus har ett stambyteärende i svepet. ${s.resolved} av ${s.answered} besvarade adresser kunde placeras i en fastighet.`, "");
  } else {
    lines.push(`Stickprovet (${s.size} adresser, frö ${s.seed}) har inte körts.`, "");
  }
  lines.push(e.stageC.decision, "");
  lines.push(
    `Steg B besvarade ${fmt(e.stageB.addressesAnswered)} av ${fmt(e.stageB.addressesTotal)} adresser och kunde placera ${fmt(e.stageB.resolved)} av dem i en fastighet.`,
    "",
  );
  const u = e.unidentified;
  lines.push(
    `Rader som inte knöts till något hus: ${fmt(u.noNumber + u.ambiguous + u.noCandidates + u.notAsked)}. ${fmt(u.noNumber)} saknar husnummer, ${fmt(u.ambiguous)} gav flera fastigheter i stadens adresssökning (tvetydiga och därför lämnade), ${fmt(u.noCandidates)} gav ingen träff och ${fmt(u.notAsked)} hann inte frågas.`,
    "",
  );

  lines.push("## Hur många år före försäljningen stambytet gjordes", "");
  lines.push("| År från stambyte till försäljning | Sålda rader | Räcker för passningen (minst 30) |");
  lines.push("|---|---|---|");
  for (const k of YEARS_CLASSES) {
    lines.push(`| ${yearsLabel(k)} | ${fmt(e.yearsBefore[k])} | ${e.yearsBefore[k] >= MIN_ROWS_PER_CLASS ? "ja" : "nej"} |`);
  }
  lines.push("");
  lines.push(
    `Totalt ${fmt(t.recordedBeforeSale)} rader ligger i ett hus med ett stambyte registrerat före försäljningen. Pågående stambyte vid försäljningen: ${fmt(t.ongoingAtSale)} rader. Stambyte som startade först efter försäljningen: ${fmt(t.futureAtSale)} rader, de räknas aldrig som genomförda. Hus med bara relining: ${fmt(t.reliningOnly)} rader, relining räknas aldrig som stambyte.`,
    "",
  );
  const young = e.yearsBefore["0-5"];
  const mid = e.yearsBefore["6-10"] + e.yearsBefore["11-15"];
  const enough = (n: number, what: string) =>
    n >= MIN_ROWS_PER_CLASS ? `${what} når ${MIN_ROWS_PER_CLASS} rader.` : `${what} når inte ${MIN_ROWS_PER_CLASS} rader och går inte att anpassa på egen hand.`;
  lines.push(
    `Stambyte 0 till 5 år före försäljningen: ${fmt(young)} rader. 6 till 15 år: ${fmt(mid)} rader. ${enough(young, "Klassen 0 till 5 år")} ${enough(mid, "Klassen 6 till 15 år")}`,
    "",
  );

  lines.push("## Trafik", "");
  const sec = e.requests.secondsPerStage;
  const minutes = (n: number) => `${fmt(Math.round(n / 60))} min`;
  lines.push(
    `Anrop mot etjanster.stockholm.se: B ${fmt(e.requests.perStage.B)}, stickprov ${fmt(e.requests.perStage["C-sample"])}, C ${fmt(e.requests.perStage.C)}, detaljsidor ${fmt(e.requests.perStage.detail)}, totalt ${fmt(e.requests.total)}. Tid i körningarna: B ${minutes(sec.B)}, stickprov ${minutes(sec["C-sample"])}, C ${minutes(sec.C)}, detaljsidor ${minutes(sec.detail)} (pauserna mellan omstarter räknas inte). Median ${e.requests.medianSecondsPerRequest === null ? "-" : dec(e.requests.medianSecondsPerRequest)} sekunder per svar, med 3 sekunder mellan anropen. Detaljsidor lästes för ${fmt(e.detail.read)} av ${fmt(e.detail.wanted)} stambyteärenden som startade 2019 eller senare (tak ${fmt(e.detail.cap)}).`,
    "",
  );

  lines.push("## Vad kopplingen inte ser", "");
  lines.push(
    "Registret listar bara stambyten som någon har anmält till staden. Ett stambyte som aldrig anmäldes finns inte i listan, så ett hus utan post är okänt, inte utan stambyte. Posten är dessutom tunn efter 2011. Därför blandar gruppen utan registrerat stambyte hus som aldrig bytt stammar med hus som bytt utan att anmäla. En koppling kan också missa ett hus helt: en adress som staden skriver på ett annat sätt än Booli, eller en gårdsbyggnad med eget nummer, blir okänd. En okänd rad räknas aldrig som en rad utan stambyte.",
    "",
  );
  if (e.stop !== null) lines.push(`Körningen stoppades av: ${e.stop}.`, "");
  return lines.join("\n");
}
