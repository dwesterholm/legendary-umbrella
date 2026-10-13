/**
 * watch-reasons.ts - the "varför här" column of the weekly table (Phase 14.2,
 * WATCH-03, D-08, D-09, R-07): a short, plain-Swedish list of the facts that
 * may explain why a flat is cheap, built from the facts record and nothing else.
 *
 * WHY IT EXISTS: on 2026-10-13 all of the top 12 rows carried "kredit-tak" (the
 * model credits more than the 20 % cap allows) and "dold-defekt-risk" (the gap
 * looks too good to be only a renovation need). Nothing on a row said whether
 * the low price came from a tomträtt, a heavily indebted association, a listing
 * that has sat for months, a lure price in an ongoing bidding round, or a flat
 * that really needs work. A row with none of these facts is the interesting one,
 * and it is labelled honestly: "oförklarat fynd" (unexplained find).
 *
 * PURE, synchronous - no clock, randomness, network, file or environment access.
 * Same input, same output. Every number is in {@link REASON_THRESHOLDS}; the
 * functions own no constants (same discipline as TASTE_WEIGHTS in taste.ts).
 *
 * ORDER (fixed): reasons are listed in {@link REASON_ORDER} whatever order they
 * were found in, comma-joined, so the same row always prints the same cell and a
 * row with two reasons shows both.
 *
 * "SNART TILL SALU" (W3, D-08): a row whose card status key is "upcomingSale", or
 * whose candidate carries the upcomingSale flag, gets "snart till salu (ej
 * budgivning än)". It is INFORMATIONAL: the asking price has not been tested by
 * bidding yet, which says nothing about a defect. It counts as an explanation (the
 * row is not "oförklarat fynd") and sorts last. Rows with the tracking flag set are
 * removed before the table by the shared 14.1 hard filter (`filterCandidates` in
 * candidate.ts), so in the weekly table the reason normally fires through the card
 * status key.
 *
 * NOT USED: the card's sale-type field. It reads "succession" on every active card
 * and carries no information about the flat.
 *
 * MISSING IS NOT NO: a search card lists only some amenities, so a missing elevator
 * on a card is "not listed", never "no elevator". The facts record keeps that
 * difference (`elevatorListed` is `false` only after a detail read, `null` otherwise)
 * and the rule below fires only on `false`.
 *
 * ASSUMPTIONS (named, so a reader can overrule them): every threshold in
 * {@link REASON_THRESHOLDS} is a GUESS (research assumption A5) - a common rule of
 * thumb, not a Booli figure and not fitted to data: 60 days on market, an avgift
 * per kvm 25 % above the district median, 10 000 kr of association debt per kvm, a
 * flat of less than 14 or more than 30 kvm per room, a high floor from the 4th. Tune
 * them only on printed distributions (the smoke run prints how often each fires),
 * never to make a row look explained.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `taste.ts` and `listing-facts.ts` this module
 * sits beside the ranking path. `niche-score.ts` and `report/flags.ts` must NEVER
 * import it; the static-grep invariant in `niche-score.test.ts` enforces that and the
 * "discovery/watch-" specifier is registered there.
 */

import type { CandidateFacts } from "@/lib/discovery/listing-facts";

/** The one table of numbers this module uses (all guesses, see ASSUMPTIONS). */
export const REASON_THRESHOLDS: {
  /** Listed this many days or more: "ute i N dagar". */
  readonly daysOnMarketMin: 60;
  /** Avgift per kvm per year strictly above this multiple of the district median: "hög avgift". */
  readonly avgiftHighRatio: 1.25;
  /** Association debt strictly above this many kr per kvm: "hög föreningsskuld". */
  readonly brfDebtHighPerSqm: 10_000;
  /** Fewer kvm per room than this: "ovanlig planlösning". */
  readonly sqmPerRoomMin: 14;
  /** More kvm per room than this: "ovanlig planlösning". */
  readonly sqmPerRoomMax: 30;
  /** A district needs this many rows with a known avgift before it has a median. */
  readonly minRowsForMedian: 5;
  /** The asking price went down by at least this many kronor: "prissänkt". */
  readonly priceCutMinSek: 1;
  /** From this floor up, a detail page that lists no elevator is a reason. */
  readonly noElevatorFloorMin: 4;
} = {
  daysOnMarketMin: 60,
  avgiftHighRatio: 1.25,
  brfDebtHighPerSqm: 10_000,
  sqmPerRoomMin: 14,
  sqmPerRoomMax: 30,
  minRowsForMedian: 5,
  priceCutMinSek: 1,
  noElevatorFloorMin: 4,
};

/**
 * The reason kinds in print order. The last one is the informational "snart till
 * salu"; it must stay last (W3).
 */
export const REASON_ORDER = [
  "tenure",
  "landLease",
  "newConstruction",
  "bidding",
  "priceCut",
  "daysOnMarket",
  "highAvgift",
  "highBrfDebt",
  "noElevator",
  "unusualLayout",
  "upcomingSale",
] as const;

export type ReasonKind = (typeof REASON_ORDER)[number];

/** Printed when a flagged row has no reason at all. */
export const UNEXPLAINED_LABEL = "oförklarat fynd";
/** Printed when an unflagged row has no reason. */
export const NO_REASON_MARK = "-";
/** The informational reason (W3). */
export const UPCOMING_SALE_REASON = "snart till salu (ej budgivning än)";

/** The flags that make a row need an explanation (the two a cheap-for-a-reason row carries). */
const REASON_FLAGS = ["creditCapped", "hiddenDefectRisk"] as const;

/** What `reasonsFor` reads from a snapshot row (structurally satisfied by `FitInputRow`). */
export interface ReasonRow {
  readonly district: string;
  readonly facts: CandidateFacts | null;
  readonly candidate: {
    readonly livingArea: number | null;
    readonly rooms: number | null;
    /** The candidate's tracking flag (rows with it set are normally filtered out earlier). */
    readonly upcomingSale: boolean | null;
  };
}

/** Per district: the median avgift per kvm per year, or null when too few rows know it. */
export type DistrictAvgiftMedians = ReadonlyMap<string, number | null>;

export interface ReasonContext {
  readonly medians: DistrictAvgiftMedians;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Whole kronor with a space as thousands separator and ASCII digits ("10 001"). */
function formatSek(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Avgift per kvm per year (D-09): monthly avgift x 12 / living area. Null when either is
 * missing or the area is not above 0. Unrounded.
 */
export function avgiftPerSqmYear(
  facts: Pick<CandidateFacts, "avgiftMonthlySek"> | null,
  livingArea: number | null,
): number | null {
  const avgift = facts?.avgiftMonthlySek;
  if (!isNumber(avgift) || avgift <= 0 || !isNumber(livingArea) || livingArea <= 0) return null;
  return (avgift * 12) / livingArea;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median avgift per kvm per year of each district, from the run's own rows (D-09). A row
 * counts when it has a known avgift and a living area above 0. A district with fewer than
 * {@link REASON_THRESHOLDS.minRowsForMedian} such rows maps to null: a median of three flats
 * would flag the fourth for being normal.
 */
export function districtAvgiftMedians(rows: readonly ReasonRow[]): Map<string, number | null> {
  const byDistrict = new Map<string, number[]>();
  for (const row of rows) {
    if (!byDistrict.has(row.district)) byDistrict.set(row.district, []);
    const perSqm = avgiftPerSqmYear(row.facts, row.candidate.livingArea);
    if (perSqm !== null) byDistrict.get(row.district)!.push(perSqm);
  }
  const out = new Map<string, number | null>();
  for (const [district, values] of byDistrict) {
    out.set(
      district,
      values.length >= REASON_THRESHOLDS.minRowsForMedian ? median([...values].sort((a, b) => a - b)) : null,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The reasons that apply to one row, in {@link REASON_ORDER}, each at most once. A row
 * without facts has none (it never crashes). Pure.
 */
export function reasonsFor(row: ReasonRow, ctx: ReasonContext): string[] {
  const facts = row.facts;
  const found = new Map<ReasonKind, string>();

  if (facts !== null) {
    const tenure = facts.tenureForm?.trim() ?? "";
    if (tenure !== "" && tenure.toLowerCase() !== "bostadsrätt") {
      found.set("tenure", `upplåtelseform: ${tenure.toLowerCase()}`);
    }
    if (facts.landLease === true) found.set("landLease", "tomträtt");
    if (facts.isNewConstruction === true || facts.statusKey === "newConstruction") {
      found.set("newConstruction", "nyproduktion");
    }
    if (facts.biddingOpen === true || facts.statusKey === "biddingOpen") {
      found.set("bidding", "budgivning pågår");
    }
    if (isNumber(facts.priceCutSek) && facts.priceCutSek >= REASON_THRESHOLDS.priceCutMinSek) {
      found.set("priceCut", `prissänkt ${formatSek(facts.priceCutSek)} kr`);
    }
    if (isNumber(facts.daysOnMarket) && facts.daysOnMarket >= REASON_THRESHOLDS.daysOnMarketMin) {
      found.set("daysOnMarket", `ute i ${Math.round(facts.daysOnMarket)} dagar`);
    }

    const perSqm = avgiftPerSqmYear(facts, row.candidate.livingArea);
    const districtMedian = ctx.medians.get(row.district) ?? null;
    if (perSqm !== null && districtMedian !== null && districtMedian > 0) {
      if (perSqm > districtMedian * REASON_THRESHOLDS.avgiftHighRatio) {
        found.set(
          "highAvgift",
          `hög avgift (${formatSek(perSqm)} kr/kvm/år mot ${formatSek(districtMedian)} i ${row.district})`,
        );
      }
    }

    const debt = facts.brf?.debtPerSqm;
    if (isNumber(debt) && debt > REASON_THRESHOLDS.brfDebtHighPerSqm) {
      found.set("highBrfDebt", `hög föreningsskuld (${formatSek(debt)} kr/kvm)`);
    }

    // `elevatorListed` is false only after a detail read; a card's missing elevator is null.
    if (
      facts.elevatorListed === false &&
      isNumber(facts.floor) &&
      facts.floor >= REASON_THRESHOLDS.noElevatorFloorMin
    ) {
      found.set("noElevator", `ingen hiss angiven (vån ${facts.floor})`);
    }
  }

  const { livingArea, rooms } = row.candidate;
  if (isNumber(livingArea) && livingArea > 0 && isNumber(rooms) && rooms > 0) {
    const sqmPerRoom = livingArea / rooms;
    if (sqmPerRoom < REASON_THRESHOLDS.sqmPerRoomMin || sqmPerRoom > REASON_THRESHOLDS.sqmPerRoomMax) {
      found.set("unusualLayout", "ovanlig planlösning");
    }
  }

  if (facts?.statusKey === "upcomingSale" || row.candidate.upcomingSale === true) {
    found.set("upcomingSale", UPCOMING_SALE_REASON);
  }

  return REASON_ORDER.flatMap((kind) => {
    const text = found.get(kind);
    return text === undefined ? [] : [text];
  });
}

/** Whether a row's flags make it need an explanation: "kredit-tak" or "dold-defekt-risk". */
export function isReasonFlagged(flags: readonly string[]): boolean {
  return REASON_FLAGS.some((f) => flags.includes(f));
}

/**
 * The cell text: the reasons joined with ", ", else "oförklarat fynd" for a flagged row, else "-".
 * "Snart till salu" counts as a reason, so a flagged row that has only that one is not unexplained.
 */
export function reasonCell(reasons: readonly string[], flagged: boolean): string {
  if (reasons.length > 0) return reasons.join(", ");
  return flagged ? UNEXPLAINED_LABEL : NO_REASON_MARK;
}
