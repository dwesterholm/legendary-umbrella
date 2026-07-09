import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { NICHE_WEIGHTS, type NicheId } from "@/lib/discovery/niches";

/**
 * User-facing Swedish chip label per `SignalContribution.key` (mirrors
 * `report-flags.tsx`'s `FLAG_LABELS` lookup pattern — the UI never renders a
 * raw field/key name). `stambyteProxyAge`'s label is DELIBERATELY hedged
 * ("kan tyda på", "möjligt", "bekräfta med BRF-analys") — it is a
 * construction-year proxy, never a confirmed "föreningen betalar stambyte"
 * verdict (see niches.ts's module doc + the distinct `stambyteProxyAge` key
 * discipline, never `FLAG_IDS.STAMBYTE_PLANERAT`).
 */
export const NICHE_SIGNAL_LABELS: Record<string, string> = {
  constructionYearAge: "Byggår",
  pricePerSqmVsBaseline: "Pris/kvm vs området",
  tenureFormMatch: "Upplåtelseform",
  stambyteProxyAge:
    "Byggår tyder på möjligt stambytesbehov — bekräfta med BRF-analys",
};

/**
 * Human "Källa:" caption per `SignalContribution.sourceRef` (mirrors
 * `report-flags.tsx`'s `SOURCE_LABELS` lookup pattern).
 */
export const NICHE_SIGNAL_SOURCE_LABELS: Record<string, string> = {
  "candidate.constructionYear": "Annonsdata",
  "candidate.tenureForm": "Annonsdata",
  "candidate.price/candidate.livingArea vs areaBaseline.medianPricePerSqm":
    "Prisjämförelse",
};

/**
 * niche-score.ts — the DETERMINISTIC, LLM-free niche scorer (DISC-03).
 *
 * Mirrors `computeBrfGrade` (src/lib/brf/score.ts) and `computeFlags`
 * (src/lib/report/flags.ts) exactly: a PURE, synchronous function — no
 * `Date`/`Math.random`/network/async — the same input always yields the same
 * output. Every contributing signal carries a `sourceRef` (mirrors `Flag`'s
 * cited-signal shape); a null/absent fact yields `assessable: false` and
 * contribution `0`, NEVER a fabricated positive or negative (mirrors
 * `computeBrfGrade`'s `not_assessable` discipline). All weights/thresholds
 * are imported from `NICHE_WEIGHTS` — this module owns zero magic numbers.
 *
 * `NicheScoreResult.score` is an internal composite in [0,1] used ONLY for
 * sorting — it is NEVER rendered bare in the UI (binding UI-SPEC constraint).
 * The UI always renders `breakdown` as cited signal chips instead.
 *
 * The `imminent-stambyte` niche's `stambyteProxyAge` row is a HEDGED
 * construction-year proxy, distinctly keyed so it is never conflated with
 * `FLAG_IDS.STAMBYTE_PLANERAT` (the BRF-confirmed signal Phase 8 produces for
 * a fully analyzed listing). The real per-candidate BRF-backed signal is
 * deferred — see niches.ts's module doc for the cost rationale.
 */

/** A single cited signal contribution to a niche score (mirrors `Flag`). */
export interface SignalContribution {
  key: string;
  value: number | string | null;
  weight: number;
  /** weight × normalized sub-score, or 0 when not assessable. */
  contribution: number;
  /** false when the underlying fact is null/absent — never a fabricated value. */
  assessable: boolean;
  /** A data-path citation, e.g. "candidate.constructionYear". */
  sourceRef: string;
}

/** The deterministic scoring result: an internal composite + cited breakdown. */
export interface NicheScoreResult {
  niche: NicheId;
  /** [0,1] weighted composite — internal only, NEVER rendered bare in the UI. */
  score: number;
  /** ALWAYS what the UI renders, as cited chips. */
  breakdown: SignalContribution[];
}

/** The area-level baseline a niche's price/sqm signal compares against. */
export interface AreaBaseline {
  medianPricePerSqm: number | null;
}

/**
 * Maps a construction year to a [0,1] "age" sub-score for a given
 * old/new cutoff pair. `preferOld` selects which direction is rewarded:
 * `true` → older is better (renovation-upside, imminent-stambyte proxy);
 * `false` → newer is better (turnkey). Linear interpolation between the two
 * named cutoffs keeps the mapping smooth (no cliff at a single year).
 */
function scoreYearAge(
  year: number,
  oldCutoff: number,
  newCutoff: number,
  preferOld: boolean,
): number {
  const clamped = Math.min(Math.max(year, oldCutoff), newCutoff);
  const span = newCutoff - oldCutoff;
  const fractionNew = span === 0 ? 0 : (clamped - oldCutoff) / span;
  return preferOld ? 1 - fractionNew : fractionNew;
}

/** price/sqm-vs-baseline ratio → [0,1] sub-score (lower ratio = more upside). */
function scorePriceRatio(ratio: number, lowRatioMax: number, highRatioMin: number): number {
  if (ratio <= lowRatioMax) return 1.0;
  if (ratio >= highRatioMin) return 0.0;
  const span = highRatioMin - lowRatioMax;
  return span === 0 ? 0.5 : 1 - (ratio - lowRatioMax) / span;
}

/**
 * Computes a niche's deterministic score + cited-signal breakdown for one
 * candidate. PURE — no I/O, no clock, no randomness.
 *
 * @param candidate - the PII-safe candidate facts (src/lib/discovery/candidate.ts)
 * @param niche - which of the 3 NICHE_WEIGHTS tables to apply
 * @param areaBaseline - the area's median price/sqm (null when unavailable)
 * @returns the niche score result: an internal composite + cited breakdown
 */
export function computeNicheScore(
  candidate: DiscoveryCandidate,
  niche: NicheId,
  areaBaseline: AreaBaseline,
): NicheScoreResult {
  const breakdown: SignalContribution[] = [];

  const push = (
    key: string,
    value: number | string | null,
    weight: number,
    subScore: number | null | undefined,
    sourceRef: string,
  ): void => {
    // CR-01 defense in depth: loose `== null` (not strict `=== null`) so a
    // stray `undefined` — e.g. from an upstream shape mismatch that should
    // never happen post-CR-01 schema fix, but must never again silently
    // poison a score — is treated identically to `null`: not assessable,
    // contribution 0, never a fabricated or NaN value.
    const assessable = subScore != null;
    const contribution = assessable ? weight * subScore : 0;
    breakdown.push({ key, value, weight, contribution, assessable, sourceRef });
  };

  const candidatePricePerSqm =
    candidate.price != null && candidate.livingArea != null && candidate.livingArea > 0
      ? candidate.price / candidate.livingArea
      : null;

  if (niche === "renovation-upside") {
    const t = NICHE_WEIGHTS["renovation-upside"];

    push(
      "constructionYearAge",
      candidate.constructionYear,
      t.constructionYearAge.weight,
      // CR-01: `== null` (loose) catches both `null` and a stray
      // `undefined` — see the `push` helper's comment above.
      candidate.constructionYear == null
        ? null
        : scoreYearAge(
            candidate.constructionYear,
            t.constructionYearAge.oldBuildYearMax,
            t.constructionYearAge.newBuildYearMin,
            true,
          ),
      "candidate.constructionYear",
    );

    const ratio =
      candidatePricePerSqm != null && areaBaseline.medianPricePerSqm != null && areaBaseline.medianPricePerSqm > 0
        ? candidatePricePerSqm / areaBaseline.medianPricePerSqm
        : null;
    push(
      "pricePerSqmVsBaseline",
      candidatePricePerSqm,
      t.pricePerSqmVsBaseline.weight,
      ratio == null
        ? null
        : scorePriceRatio(
            ratio,
            t.pricePerSqmVsBaseline.lowRatioMax,
            t.pricePerSqmVsBaseline.highRatioMin,
          ),
      "candidate.price/candidate.livingArea vs areaBaseline.medianPricePerSqm",
    );
  } else if (niche === "turnkey") {
    const t = NICHE_WEIGHTS.turnkey;

    push(
      "constructionYearAge",
      candidate.constructionYear,
      t.constructionYearAge.weight,
      candidate.constructionYear == null
        ? null
        : scoreYearAge(
            candidate.constructionYear,
            t.constructionYearAge.oldBuildYearMax,
            t.constructionYearAge.newBuildYearMin,
            false,
          ),
      "candidate.constructionYear",
    );

    push(
      "tenureFormMatch",
      candidate.tenureForm,
      t.tenureFormMatch.weight,
      candidate.tenureForm == null
        ? null
        : candidate.tenureForm === t.tenureFormMatch.preferredTenureForm
          ? 1.0
          : 0.0,
      "candidate.tenureForm",
    );
  } else {
    // imminent-stambyte — hedged construction-year PROXY only (see module doc).
    const t = NICHE_WEIGHTS["imminent-stambyte"];

    push(
      "stambyteProxyAge",
      candidate.constructionYear,
      t.stambyteProxyAge.weight,
      candidate.constructionYear == null
        ? null
        : scoreYearAge(
            candidate.constructionYear,
            t.stambyteProxyAge.stambyteProxyYearCutoff,
            t.stambyteProxyAge.modernBuildYearMin,
            true,
          ),
      "candidate.constructionYear",
    );
  }

  const score = breakdown.reduce((sum, r) => sum + r.contribution, 0);

  return { niche, score, breakdown };
}
