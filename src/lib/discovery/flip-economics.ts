/**
 * flip-economics.ts — the PURE, deterministic economic core of the discovery
 * analysis redesign (SPEC 2026-07-10 §2.3/§2.4/§2.6/§2.7). Zero I/O, zero
 * model calls: buyer-segment derivation, the tiered reno cost matrix, the
 * with/without-tax profit lines, and the value-gap opportunity metric.
 *
 * STRUCTURAL SEPARATION (LOCKED): this module lives on the vision/analysis
 * READ path. Like the vision modules it must NEVER be imported by
 * `niche-score.ts` or `report/flags.ts` — value-gap must not silently become a
 * deterministic scored signal without the visible "från bildtolkning" marker
 * (UI-SPEC §4). The static-grep invariant in `niche-score.test.ts` forbids
 * that import; this module's specifier is added to that list.
 *
 * All SEK figures are Stockholm 2025–2026 anchors from the research synthesis
 * §8.3 (pre-ROT) and are deliberately encoded as BANDS — they are estimates to
 * present as ranges, never false-precision point values.
 */

// ---------------------------------------------------------------------------
// Buyer segmentation (§2.4)
// ---------------------------------------------------------------------------

/**
 * The likely buyer of a flat of this size, which tailors the recommendations
 * and the value-gap premium tolerance:
 *  - "etta": 1-rok, single first-time buyer, financing-capped, turnkey-seeker
 *    → cap renovation ambition at MID, never luxury.
 *  - "par-2-3rok": couple/young family, premium-tolerant, rewards an extra
 *    room / open plan → renovation converts to premium more reliably.
 */
export type BuyerSegment = "etta" | "par-2-3rok";

/** Size (m²) below which a room-less candidate is treated as an etta. */
const ETTA_MAX_LIVING_AREA = 45;

/**
 * Derives the buyer segment from room count (preferred) or, when rooms are
 * unknown, from living area. `rooms <= 1` → etta; `rooms >= 2` → par-2-3rok
 * (4+ rooms still fall in the premium-tolerant family bucket). With neither
 * signal, defaults to the premium-tolerant bucket (the safer default — it does
 * NOT suppress renovation upside the way an etta classification does).
 */
export function buyerSegment(
  rooms: number | null,
  livingArea: number | null,
): BuyerSegment {
  if (rooms !== null) return rooms <= 1 ? "etta" : "par-2-3rok";
  if (livingArea !== null) return livingArea < ETTA_MAX_LIVING_AREA ? "etta" : "par-2-3rok";
  return "par-2-3rok";
}

// ---------------------------------------------------------------------------
// Tiered reno cost matrix (§2.3)
// ---------------------------------------------------------------------------

export type RenoOpportunity =
  | "kitchen-full"
  | "kitchen-cosmetic"
  | "bathroom-full"
  | "bathroom-cosmetic"
  | "paint-apartment"
  | "floors"
  | "wall-nonbearing"
  | "wall-bearing";

export type CostTier = "cheap" | "mid" | "high";

/** A SEK range [low, high]. */
export type SekBand = readonly [number, number];

export interface RenoCostProfile {
  /** cheap = DIY + budget; mid = mixed + builder for advanced; high = builder + premium. */
  readonly cheap: SekBand;
  readonly mid: SekBand;
  readonly high: SekBand;
  /** Rough hedonic value-uplift anchor (a CEILING — WTP has softened since 2022). */
  readonly upliftAnchor?: SekBand;
  /** Tiers that are not legitimately available (e.g. DIY wet room, DIY bearing wall). */
  readonly invalidTiers?: readonly CostTier[];
  /** Short caveat surfaced with the estimate. */
  readonly note?: string;
}

/**
 * Stockholm 2025–2026 anchors (§8.3, pre-ROT). Bands, not point values. Uplift
 * anchors are ceilings. A full-reno anchor should be discounted to ~40–70% for
 * a 1–2-step refresh; the middle (2→4) path is the most economically favorable
 * — do not recommend luxury on top of the range.
 */
export const RENO_COST_MATRIX: Record<RenoOpportunity, RenoCostProfile> = {
  "kitchen-full": {
    cheap: [50_000, 100_000],
    mid: [150_000, 250_000],
    high: [350_000, 800_000],
    upliftAnchor: [200_000, 267_000],
    note: "Aim mid (scale 2→4); luxury costs disproportionately more than it returns.",
  },
  "kitchen-cosmetic": {
    cheap: [20_000, 40_000],
    mid: [30_000, 60_000],
    high: [50_000, 90_000],
    upliftAnchor: [80_000, 150_000],
    note: "Best ROI per krona — captures most of the kitchen curve at a fraction of a full reno.",
  },
  "bathroom-full": {
    cheap: [60_000, 110_000],
    mid: [130_000, 190_000],
    high: [200_000, 320_000],
    upliftAnchor: [108_000, 108_000],
    invalidTiers: ["cheap"],
    note: "Pure-DIY wet room is invalid — tätskikt needs GVK-certified labor or the flat loses insurability. A full reno returns only ~50–70% of cost: treat as a margin RISK, not a value-add.",
  },
  "bathroom-cosmetic": {
    cheap: [5_000, 20_000],
    mid: [15_000, 40_000],
    high: [30_000, 60_000],
    upliftAnchor: [20_000, 50_000],
    note: "Reward freshness, not material tier. Dated/ugly tile is a turnoff even if functional — a cheap refresh (paint/microcement-over-tile) beats a full reno. Microcement over VÅTMATTA is high-risk: cosmetic only, does not renew the tätskikt or reset the våtrumsintyg.",
  },
  "paint-apartment": {
    cheap: [5_000, 15_000],
    mid: [25_000, 40_000],
    high: [45_000, 85_000],
    note: "Indirect uplift via the condition score; fresh white walls sell small flats faster.",
  },
  floors: {
    cheap: [10_000, 30_000],
    mid: [25_000, 45_000],
    high: [70_000, 130_000],
    note: "Slipa existing parkett (cheap) vs new parkett/fiskben (high). Fresh floors lift the condition score.",
  },
  "wall-nonbearing": {
    cheap: [3_000, 8_000],
    mid: [3_500, 14_000],
    high: [15_000, 25_000],
    note: "Indirect uplift via open-plan desirability; no bygganmälan needed.",
  },
  "wall-bearing": {
    cheap: [20_000, 30_000],
    mid: [30_000, 45_000],
    high: [50_000, 80_000],
    invalidTiers: ["cheap"],
    note: "Avväxling is anmälningspliktigt — requires konstruktör + kontrollplan; no legitimate DIY tier. Never state a wall's bärande status as fact.",
  },
};

/** ROT 2026 = 30% of the LABOR line only, cap 50,000 kr/person/yr (100k for two owners). DIY gets none. */
export const ROT_RATE_2026 = 0.3;
export const ROT_CAP_PER_PERSON = 50_000;

/**
 * Applies ROT to a labor amount: 30% off labor, capped per person. DIY (cheap
 * tier) passes `owners = 0` → no relief. Materials never get ROT, so callers
 * pass only the labor share.
 */
export function applyRot(laborSek: number, owners: number): number {
  if (owners <= 0) return laborSek;
  const relief = Math.min(laborSek * ROT_RATE_2026, ROT_CAP_PER_PERSON * owners);
  return laborSek - relief;
}

// ---------------------------------------------------------------------------
// Capital-gains tax lines (§2.7)
// ---------------------------------------------------------------------------

/** Effective Swedish capital-gains rate on privatbostad: kvoterad 22/30 taxed at 30% = 22% of vinst. */
export const CGT_EFFECTIVE_RATE = 0.22;

export interface TaxLines {
  /** The taxable gain fed in (may be negative — a loss). */
  readonly vinst: number;
  /** Tax due at the flat effective rate (0 on a loss). */
  readonly taxSek: number;
  /** Profit ignoring tax entirely. */
  readonly profitWithoutTax: number;
  /** Profit after the flat 22%. */
  readonly profitWithTax: number;
}

/** The two profit lines the analysis must always show (decision #3: both, no per-session input). */
export function taxLines(vinst: number): TaxLines {
  const taxSek = Math.max(vinst, 0) * CGT_EFFECTIVE_RATE;
  return { vinst, taxSek, profitWithoutTax: vinst, profitWithTax: vinst - taxSek };
}

/** Static tax caveats surfaced alongside the two lines — NOT personalized (decision #3). */
export const TAX_NOTES = {
  uppskov:
    "Vinstskatten kan skjutas upp (uppskov) genom att rulla vinsten till en ersättningsbostad — sedan 2021 räntefritt och tills vidare, takbelopp 3 000 000 kr per bostad. Skatten försvinner inte, den förfaller vid en framtida försäljning utan ersättningsbostad.",
  lossOffset:
    "En kapitalförlust kvoteras till 50 % och kvittas fullt mot annan kapitalvinst — men ENDAST samma beskattningsår (förlust kan inte sparas till senare år). En förlust sänker alltså bara skatten på flippar som säljs samma kalenderår.",
  naringsverksamhet:
    "Upprepade köp-renovera-sälj med kort innehav och vinstsyfte riskerar att omklassas som näringsverksamhet — då beskattas vinsten med marginalskatt + egenavgifter i stället för 22 %, och uppskov/kvotering försvinner.",
} as const;

// ---------------------------------------------------------------------------
// Value-gap opportunity metric (§2.6)
// ---------------------------------------------------------------------------

export type ValueGapFlag = "HIGH" | "MED" | "LOW";

export interface ValueGapInput {
  /** Asking price (utgångspris) in SEK. */
  readonly askingPrice: number;
  /** Living area in m². */
  readonly livingArea: number;
  /** Renovated-comp median kr/m² for {stadsdel, ±15% m², floor bucket, ≤12mo}. */
  readonly renovatedMedianPerSqm: number;
  /** Unrenovated-comp median kr/m² (for the ROI-floor sanity check). */
  readonly unrenovatedMedianPerSqm: number;
  /** Chosen reno-cost tier total in SEK (default MID). */
  readonly renoCostSek: number;
  /** Expected overbid over asking: hot +0.10 / neutral 0 / cautious −0.03. Bias low for reno objects. */
  readonly expectedOverbid: number;
  /** Selling costs (mäklararvode etc.) in SEK. */
  readonly salesCostsSek: number;
  /** Whether the flat reads dated/original (a vision signal) — required for a HIGH flag. */
  readonly isDated: boolean;
  /** Optional cap on Resale_W kr/m² (the area renovated 75th percentile). */
  readonly renovatedCapPerSqm?: number;
}

export interface ValueGap {
  /** Estimated renovated resale value (capped). */
  readonly resaleW: number;
  /** Effective purchase price incl. expected overbid. */
  readonly purchaseP: number;
  /** How far below the renovated median the asking kr/m² sits (0.15 = 15% below). */
  readonly belowMarketPct: number;
  /** Net uplift ignoring tax. */
  readonly netUpliftWithoutTax: number;
  /** Net uplift after the flat 22% on the gain. */
  readonly netUpliftWithTax: number;
  /** Whether the reno "pays" the §2.6 ROI-floor sanity check. */
  readonly roiFloorMet: boolean;
  /** Headline opportunity flag. */
  readonly flag: ValueGapFlag;
  /**
   * Discount-attribution guard: asking is >25% below the renovated median, too
   * much to explain by condition alone — a hidden-defect penalty likely applies
   * (BRF debt, bottenvåning, odd BOA, tomträtt). The flag is held at MED and
   * confidence downgraded rather than celebrated as a HIGH bargain.
   */
  readonly hiddenDefectRisk: boolean;
}

const VALUE_GAP_HIGH_BELOW_PCT = 0.15;
const VALUE_GAP_MED_BELOW_PCT = 0.08;
const VALUE_GAP_LOW_BAND = 0.05; // within ±5% of R_med → already priced renovated
const VALUE_GAP_HIGH_MIN_UPLIFT = 150_000;
const VALUE_GAP_HIGH_MIN_UPLIFT_PCT = 0.08; // of purchase price
const DISCOUNT_ATTRIBUTION_GUARD = 0.25;
const ROI_FLOOR_RATIO = 0.65;

/**
 * The headline opportunity metric (§2.6). Deterministic given comps + asking +
 * reno cost. Never fed into `computeNicheScore` — consumed only on the
 * vision/analysis read path with the "från bildtolkning" marker.
 */
export function valueGap(input: ValueGapInput): ValueGap {
  const {
    askingPrice,
    livingArea,
    renovatedMedianPerSqm,
    unrenovatedMedianPerSqm,
    renoCostSek,
    expectedOverbid,
    salesCostsSek,
    isDated,
    renovatedCapPerSqm,
  } = input;

  const effectiveRMed =
    renovatedCapPerSqm !== undefined
      ? Math.min(renovatedMedianPerSqm, renovatedCapPerSqm)
      : renovatedMedianPerSqm;

  const resaleW = effectiveRMed * livingArea;
  const purchaseP = askingPrice * (1 + expectedOverbid);
  const askingPerSqm = livingArea > 0 ? askingPrice / livingArea : 0;
  const belowMarketPct =
    renovatedMedianPerSqm > 0 ? (renovatedMedianPerSqm - askingPerSqm) / renovatedMedianPerSqm : 0;

  const vinst = resaleW - purchaseP - renoCostSek - salesCostsSek;
  const { profitWithoutTax: netUpliftWithoutTax, profitWithTax: netUpliftWithTax } =
    taxLines(vinst);

  // ROI-floor: the condition-driven value recovered must be ≥ 65% of reno cost.
  const conditionValueRecovered = resaleW - unrenovatedMedianPerSqm * livingArea;
  const roiFloorMet =
    renoCostSek <= 0 ? true : conditionValueRecovered >= ROI_FLOOR_RATIO * renoCostSek;

  const hiddenDefectRisk = belowMarketPct > DISCOUNT_ATTRIBUTION_GUARD;

  let flag: ValueGapFlag;
  if (Math.abs(belowMarketPct) <= VALUE_GAP_LOW_BAND) {
    flag = "LOW"; // already priced as renovated
  } else if (
    !hiddenDefectRisk &&
    isDated &&
    belowMarketPct >= VALUE_GAP_HIGH_BELOW_PCT &&
    netUpliftWithoutTax >= VALUE_GAP_HIGH_MIN_UPLIFT &&
    netUpliftWithoutTax >= VALUE_GAP_HIGH_MIN_UPLIFT_PCT * purchaseP
  ) {
    flag = "HIGH";
  } else if (belowMarketPct >= VALUE_GAP_MED_BELOW_PCT) {
    // ≥15% below but not dated / not enough uplift / hidden-defect guard → held at MED.
    flag = "MED";
  } else {
    flag = "LOW";
  }

  return {
    resaleW,
    purchaseP,
    belowMarketPct,
    netUpliftWithoutTax,
    netUpliftWithTax,
    roiFloorMet,
    flag,
    hiddenDefectRisk,
  };
}
