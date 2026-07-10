import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

/**
 * condition-score.ts — a SECONDARY, vision-derived ordering signal that
 * surfaces genuine renovation objects (dated kitchen/bath, value-add
 * potential) ahead of already-done turnkey flats that happen to share the same
 * deterministic niche score.
 *
 * STRUCTURAL-SEPARATION COMPLIANCE (the locked constraint, 11-*): the binding
 * rule is that `niche-score.ts` and `flags.ts` must NEVER import vision types —
 * the deterministic score/flag system stays pure (enforced by
 * niche-score.test.ts's static-grep invariant). This module is DELIBERATELY
 * separate: it reads `candidate.vision` (vision's own read path) and is used
 * ONLY as a tiebreaker for display ordering in `discovery-results.tsx`, never
 * fed into `computeNicheScore`/`ReportFlags`. Any place a resulting
 * vision-influenced value is shown must carry the "från bildtolkning" marker
 * (11-UI-SPEC.md).
 *
 * Higher score = MORE renovation opportunity (better for a value-add hunt).
 */

/** Dated / renovation-needed language in a kitchen/bathroom/overall claim. */
const DATED =
  /daterat|daterad|gammalt|gammal|ursprunglig|omodern|slitet|sliten|renoveringsbehov|behöver\s+renover|ej\s+renover|äldre\s+standard|nött|nedgång/i;
/** Turnkey / already-renovated language — LESS upside for a renovation hunt. */
const RENOVATED =
  /nyrenoverat|nyrenoverad|helrenoverat|totalrenoverat|renoverat|renoverad|modernt|fräscht|fräsch|toppskick|påkostad/i;

/**
 * Derives a renovation-opportunity score from a candidate's vision claims.
 * `remodelPotential` claims (an explicit value-add the model spotted) weigh
 * most; a dated kitchen/bathroom/overall claim adds, an already-renovated one
 * subtracts. Returns 0 when there is no vision result (never negative-biases a
 * candidate merely for lacking images).
 */
export function conditionScore(candidate: DiscoveryCandidate): number {
  const vision = candidate.vision;
  if (!vision || vision.claims.length === 0) return 0;

  let score = 0;
  for (const claim of vision.claims) {
    if (claim.attribute === "remodelPotential") {
      score += 2;
      continue;
    }
    const text = `${claim.claim} ${claim.whatWasSeen}`;
    if (DATED.test(text)) score += 1;
    if (RENOVATED.test(text)) score -= 1;
  }
  return score;
}
