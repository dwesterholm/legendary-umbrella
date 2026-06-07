import type {
  NormalizedBrf,
  UnderhallsplanStatus,
  UnderhallsplanValue,
} from "@/lib/schemas/brf";

/**
 * The single source of truth for every threshold and weight used to grade a
 * BRF. The public methodology page (Plan 05, "Så räknar vi", D-09) imports
 * this exact constant — the numbers are NOT duplicated anywhere else.
 *
 * Bands are derived from the cited domain guidance (AI-SPEC §1b):
 *  - skuldPerKvm (räntebärande skuld ÷ upplåten bostadsrättsyta, BFNAR 2023:1):
 *    <5,000 SEK/m² strong, 5,000–12,000 mid, >12,000 a red flag.
 *  - avgiftsniva (årsavgift per kvm, SEK/m²/år): a low fee is only good if the
 *    förening still saves for maintenance — treat very low and very high as
 *    weaker; ~550–750 is the healthy middle band.
 *  - kassaflode / sparande per kvm (SEK/m²): experts cite ≥250 healthy,
 *    120–250 a warning, <120 (and any negative) weak.
 *  - underhallsplanStatus: finns_aktuell best → saknas worst.
 *
 * Each metric maps to a 0–1 sub-score. The weighted sum (weights sum to 1)
 * maps to the A–F grade via GRADE_BANDS.
 */
export const BRF_SCORE_THRESHOLDS = {
  skuldPerKvm: {
    weight: 0.35,
    // SEK/m². Lower is better. Boundaries are inclusive of the lower band.
    strongMax: 5000, // < 5,000 → strong (score 1.0)
    midMax: 8500, // 5,000–8,500 → good (0.75)
    weakMax: 12000, // 8,500–12,000 → mid (0.45); > 12,000 → red flag (0.1)
  },
  avgiftsniva: {
    weight: 0.2,
    // SEK/m²/år. A healthy fee is neither starved nor inflated.
    healthyMin: 450,
    healthyMax: 750, // 450–750 → healthy (1.0)
    elevatedMax: 950, // 750–950 (or 350–450) → elevated/lean (0.6); else (0.25)
    leanMin: 350,
  },
  kassaflode: {
    weight: 0.3,
    // Sparande per kvm, SEK/m². Higher is better; negative is a deficit.
    healthyMin: 250, // ≥ 250 → healthy (1.0)
    warningMin: 120, // 120–250 → warning (0.55); 0–120 → weak (0.25); < 0 → deficit (0.0)
  },
  underhallsplanStatus: {
    weight: 0.15,
    // Maintenance-plan status → sub-score.
    scores: {
      finns_aktuell: 1.0,
      finns_inaktuell: 0.5,
      oklart: 0.3,
      saknas: 0.1,
    } as Record<UnderhallsplanValue, number>,
  },
} as const;

/**
 * Weighted-sum thresholds mapping the [0,1] composite score to an A–F grade.
 * A null (not-assessable) metric contributes 0 score but its weight is still
 * counted — missing data drags the grade down, it is never silently "good".
 */
const GRADE_BANDS: { min: number; grade: BrfGrade }[] = [
  { min: 0.85, grade: "A" },
  { min: 0.7, grade: "B" },
  { min: 0.5, grade: "C" },
  { min: 0.35, grade: "D" },
  { min: 0.2, grade: "E" },
  { min: 0, grade: "F" },
];

/** The A–F health grade. Lower letter == better förening. */
export type BrfGrade = "A" | "B" | "C" | "D" | "E" | "F";

/** Which of the four core metrics a breakdown entry describes. */
export type BrfMetricKey =
  | "skuldPerKvm"
  | "avgiftsniva"
  | "kassaflode"
  | "underhallsplanStatus";

/** A per-metric qualitative rating, surfaced in the breakdown (D-07). */
export type MetricRating =
  | "strong"
  | "good"
  | "mid"
  | "weak"
  | "not_assessable";

/** A single row of the per-metric breakdown (D-07). */
export interface MetricBreakdown {
  key: BrfMetricKey;
  value: number | UnderhallsplanStatus | null;
  rating: MetricRating;
  /** This metric's weight in the composite grade (weights sum to 1). */
  weight: number;
  /** weight × normalized sub-score — the metric's contribution to the grade. */
  contribution: number;
}

/** The deterministic scoring result: an A–F grade plus an auditable breakdown. */
export interface BrfScoreResult {
  grade: BrfGrade;
  breakdown: MetricBreakdown[];
}

/** Maps a [0,1] sub-score to a qualitative rating for the breakdown table. */
function rate(subScore: number): MetricRating {
  if (subScore >= 0.85) return "strong";
  if (subScore >= 0.7) return "good";
  if (subScore >= 0.4) return "mid";
  return "weak";
}

/** skuldPerKvm → [0,1] sub-score (lower debt is better). */
function scoreSkuld(value: number): number {
  const t = BRF_SCORE_THRESHOLDS.skuldPerKvm;
  if (value < t.strongMax) return 1.0;
  if (value < t.midMax) return 0.75;
  if (value <= t.weakMax) return 0.45;
  return 0.1;
}

/** avgiftsniva → [0,1] sub-score (healthy middle band is best). */
function scoreAvgift(value: number): number {
  const t = BRF_SCORE_THRESHOLDS.avgiftsniva;
  if (value >= t.healthyMin && value <= t.healthyMax) return 1.0;
  if (value >= t.leanMin && value <= t.elevatedMax) return 0.6;
  return 0.25;
}

/** kassaflode / sparande per kvm → [0,1] sub-score (higher is better). */
function scoreKassaflode(value: number): number {
  const t = BRF_SCORE_THRESHOLDS.kassaflode;
  if (value >= t.healthyMin) return 1.0;
  if (value >= t.warningMin) return 0.55;
  if (value >= 0) return 0.25;
  return 0.0;
}

/** underhallsplanStatus → [0,1] sub-score. */
function scoreUnderhall(value: UnderhallsplanValue): number {
  return BRF_SCORE_THRESHOLDS.underhallsplanStatus.scores[value] ?? 0.1;
}

/**
 * Computes the transparent A–F health grade from a normalized extraction.
 *
 * This is the trust core (D-08): a PURE, deterministic function — no Claude,
 * no async, no `Date`/`Math.random`/network. The same input always yields the
 * same grade and the same per-metric breakdown (D-07). Claude only supplies
 * the numbers; this code decides the grade.
 *
 * A `null` metric value is treated as "not assessable": its sub-score is 0 and
 * its weight still counts, so missing data lowers the grade rather than being
 * silently scored as good.
 *
 * @param normalized - primitive figures from `normalizeBrfExtraction`
 * @returns the A–F grade and an auditable per-metric breakdown
 */
export function computeBrfGrade(normalized: NormalizedBrf): BrfScoreResult {
  const breakdown: MetricBreakdown[] = [];

  const push = (
    key: BrfMetricKey,
    value: number | UnderhallsplanStatus | null,
    weight: number,
    subScore: number | null,
  ): void => {
    const isNull = subScore === null;
    const effective = isNull ? 0 : subScore;
    breakdown.push({
      key,
      value,
      rating: isNull ? "not_assessable" : rate(effective),
      weight,
      contribution: weight * effective,
    });
  };

  const t = BRF_SCORE_THRESHOLDS;

  push(
    "skuldPerKvm",
    normalized.skuldPerKvm,
    t.skuldPerKvm.weight,
    normalized.skuldPerKvm === null ? null : scoreSkuld(normalized.skuldPerKvm),
  );
  push(
    "avgiftsniva",
    normalized.avgiftsniva,
    t.avgiftsniva.weight,
    normalized.avgiftsniva === null
      ? null
      : scoreAvgift(normalized.avgiftsniva),
  );
  push(
    "kassaflode",
    normalized.kassaflode,
    t.kassaflode.weight,
    normalized.kassaflode === null
      ? null
      : scoreKassaflode(normalized.kassaflode),
  );
  push(
    "underhallsplanStatus",
    normalized.underhallsplanStatus,
    t.underhallsplanStatus.weight,
    normalized.underhallsplanStatus === null
      ? null
      : scoreUnderhall(normalized.underhallsplanStatus),
  );

  const composite = breakdown.reduce((sum, m) => sum + m.contribution, 0);
  const grade =
    GRADE_BANDS.find((b) => composite >= b.min)?.grade ?? "F";

  return { grade, breakdown };
}
