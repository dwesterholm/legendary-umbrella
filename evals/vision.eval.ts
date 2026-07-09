/**
 * Gallery condition vision eval harness (DISC-04 validation gate).
 *
 * COST-GATED — incurs live Anthropic spend. The whole live body is behind
 * `RUN_LLM_EVALS=1` AND a present `ANTHROPIC_API_KEY`; without BOTH the suite
 * is a single skipped placeholder (no network, no spend) so `npm run test`
 * and CI stay free. Mirrors `evals/extractor.eval.ts`'s RUN_LLM_EVALS-gated
 * skeleton + beforeAll fixture/labels resolution exactly.
 *
 * This file is BUILDABLE NOW (harness + rubric). Per CONTEXT.md's kill
 * criterion, the ACTUAL RUN requires:
 *   - 20–30 REAL Booli listings' image sets (operator-gathered, gitignored)
 *   - manually-labeled ground truth for each (operator-authored, gitignored)
 *   - `DISCOVERY_ENABLED`/the vision pipeline flag ON
 *   - a live `ANTHROPIC_API_KEY` + explicit `RUN_LLM_EVALS=1` spend opt-in
 * None of that is performed here — this harness/rubric is buildable-now
 * scaffolding; the 20–30-listing RUN and the deciding CUT-vs-SHIP call are
 * OPERATOR-DEFERRED (11-RESEARCH.md "Evaluation Strategy"). This file MUST
 * NOT run live in autonomous execution.
 *
 * Separately, the ONE live API smoke test (a single 4-image call, confirming
 * the slim schema does not 400 per the `anthropic-structured-output-limits`
 * project memory) is ALSO operator-deferred — distinct from, and cheaper
 * than, the full 20–30-listing gate below. Run it manually via:
 *   RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts
 * against a single real fixture before relying on the schema in production.
 *
 * Inputs (all gitignored — real listing images + human ground truth):
 *  - evals/fixtures/vision/*.json — one file per listing:
 *      { booliId: string, imageUrls: string[] }
 *  - evals/vision-labels.json — keyed by booliId, shape documented in
 *    evals/vision-labels.example.json:
 *      { kitchen: {expectedDirection, expectedAssessable},
 *        bathroom: {...}, overall: {...},
 *        expectedNoHallucination: boolean,
 *        citationsVerifiedTrue?: Record<"kitchen"|"bathroom"|"overall", boolean> }
 *
 * It exercises the REAL shipping `runVisionForCandidate` — tests exactly
 * what ships, not a reimplementation.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { runVisionForCandidate } from "@/lib/discovery/vision";
import { CAP_VISION_SEK_MAX } from "@/lib/discovery/cost";
import type { VisionConditionClaim } from "@/lib/discovery/vision-schema";

/** Live eval runs only with the explicit opt-in AND a key present (no spend otherwise). */
const RUN_LIVE = process.env.RUN_LLM_EVALS === "1" && !!process.env.ANTHROPIC_API_KEY;

const FIXTURES_DIR = path.resolve(__dirname, "fixtures/vision");
const LABELS_PATH = path.resolve(__dirname, "vision-labels.json");

/** One listing's image-set fixture (evals/fixtures/vision/*.json). */
interface VisionFixture {
  booliId: string;
  imageUrls: string[];
}

/** A per-attribute human label — direction + whether it was assessable at all. */
interface AttributeLabel {
  expectedDirection: "renovated" | "dated" | "no_claim";
  expectedAssessable: boolean;
}

/** One expert-labelled listing (the shape in evals/vision-labels.example.json). */
interface VisionLabel {
  kitchen: AttributeLabel;
  bathroom: AttributeLabel;
  overall: AttributeLabel;
  /** True if a human reviewer confirms NO claim references a person, personal
   * document, or a fabricated detail absent from every sent image. */
  expectedNoHallucination: boolean;
  /** Per-attribute human verification that a NON-null claim's cited image
   * (imageIndex) actually shows what whatWasSeen describes. Only meaningful
   * for attributes the model DID claim something on. Widened to the full
   * 4-member `VisionConditionClaim["attribute"]` union (Phase 12, DISC-05)
   * since the citation-validity loop below iterates ALL of `result.claims`,
   * not just the 3 directionally-scored attributes — `remodelPotential`'s
   * OWN directional-accuracy ground truth is a separate, not-yet-built eval
   * concern (Plan 04+), out of scope for this type fix. */
  citationsVerifiedTrue?: Partial<
    Record<"kitchen" | "bathroom" | "overall" | "remodelPotential", boolean>
  >;
}

/** A fixture paired with its label, resolved by booliId. */
interface Case {
  file: string;
  fixture: VisionFixture;
  label: VisionLabel;
}

/**
 * A fresh directional-match helper — there is NO existing fuzzy directional-
 * match analog in this codebase (extractor.eval.ts's numberMatches only
 * handles numeric tolerance). A hedged Swedish claim is scored on its
 * DIRECTION (renovated/dated/no-claim), never exact wording — an exact match
 * is not required, and not meaningful for hedged natural language
 * (11-RESEARCH.md "Evaluation Strategy" Directional accuracy metric).
 *
 * Heuristic: a null claim means "no_claim"; otherwise a small keyword set
 * distinguishes "renovated"-leaning vs "dated"-leaning Swedish hedged phrasing.
 * This is a STARTING heuristic for the operator's manual run — the operator
 * may refine it once real labeled data is available (RESEARCH Open Question 3).
 */
function claimDirectionMatches(
  claim: VisionConditionClaim | undefined,
  expectedDirection: AttributeLabel["expectedDirection"],
): boolean {
  if (!claim || claim.claim === null) {
    return expectedDirection === "no_claim";
  }
  if (expectedDirection === "no_claim") return false;

  const text = claim.claim.toLowerCase();
  const renovatedKeywords = ["renoverat", "modern", "nytt", "nya", "fräsch"];
  const datedKeywords = ["daterat", "omodern", "slitet", "gammal", "gammalt", "renoveringsbehov"];

  const looksRenovated = renovatedKeywords.some((k) => text.includes(k));
  const looksDated = datedKeywords.some((k) => text.includes(k));

  if (expectedDirection === "renovated") return looksRenovated && !looksDated;
  if (expectedDirection === "dated") return looksDated && !looksRenovated;
  return false;
}

/** A person/personal-document/fabrication marker — a hard-gate red flag if
 * it ever appears in a claim's text (structural PII guard, T-11-06). */
const HALLUCINATION_MARKERS = [
  "person",
  "människa",
  "människor",
  "ansikte",
  "id-handling",
  "faktura",
  "brev",
];

function claimMentionsHallucinationMarker(claim: VisionConditionClaim): boolean {
  const text = `${claim.claim} ${claim.whatWasSeen}`.toLowerCase();
  return HALLUCINATION_MARKERS.some((marker) => text.includes(marker));
}

// Resolved at beforeAll so the no-fixtures / no-labels case reports cleanly
// instead of throwing at import time (mirrors extractor.eval.ts:81-118).
let cases: Case[] = [];
let setupNote = "";

describe("Vision condition eval (DISC-04 validation gate)", () => {
  if (!RUN_LIVE) {
    it.skip("skipped — set RUN_LLM_EVALS=1 with a live ANTHROPIC_API_KEY to run (incurs spend)", () => {
      // intentionally empty — no network, no spend in CI / `npm run test`.
    });
    return;
  }

  beforeAll(() => {
    if (!existsSync(FIXTURES_DIR) || !existsSync(LABELS_PATH)) {
      setupNote =
        `Missing eval inputs: expected ${FIXTURES_DIR}/*.json and ${LABELS_PATH} ` +
        `(both gitignored — see evals/vision-labels.example.json for the label shape). ` +
        `Per CONTEXT.md's kill criterion, gathering 20-30 real listings + manual ` +
        `ground truth is OPERATOR-DEFERRED.`;
      return;
    }
    const labels = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as Record<
      string,
      VisionLabel
    >;
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const fixture = JSON.parse(
        readFileSync(path.join(FIXTURES_DIR, file), "utf8"),
      ) as VisionFixture;
      const label = labels[fixture.booliId];
      if (!label) {
        setupNote +=
          `\nFixture ${file} (booliId ${fixture.booliId}) has no label entry in ` +
          `vision-labels.json. Add it before this gate can pass.`;
        continue;
      }
      cases.push({ file, fixture, label });
    }
  });

  it("has 20-30 labelled real listings wired (CONTEXT.md validation gate)", () => {
    expect(setupNote, setupNote || "ok").toBe("");
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(30);
  });

  describe("per-listing accuracy vs human labels", () => {
    // A single pass over every listing feeds ALL FOUR aggregate rubric gates
    // below — this is an AGGREGATE-threshold eval (closer to
    // evals/report-judge.ts's scoreboard shape than extractor.eval.ts's
    // per-fixture exact-match shape), per RESEARCH.md's Harness shape.
    interface Scoreboard {
      directionalTotal: number;
      directionalMatches: number;
      citationsTotal: number;
      citationsValid: number;
      hallucinationFreeListings: number;
      totalCostSek: number;
    }

    let scoreboard: Scoreboard;

    it(
      "runs the real runVisionForCandidate over every labelled listing and scores the rubric",
      async () => {
        scoreboard = {
          directionalTotal: 0,
          directionalMatches: 0,
          citationsTotal: 0,
          citationsValid: 0,
          hallucinationFreeListings: 0,
          totalCostSek: 0,
        };

        for (const c of cases) {
          const { result } = await runVisionForCandidate(
            c.fixture.booliId,
            c.fixture.imageUrls,
          );
          expect(result, `${c.file}: expected a VisionResult (images were provided)`).not.toBeNull();
          if (!result) continue;

          scoreboard.totalCostSek += result.costSek;

          const byAttribute = new Map(result.claims.map((claim) => [claim.attribute, claim]));

          // (a) Directional accuracy per attribute.
          for (const attribute of ["kitchen", "bathroom", "overall"] as const) {
            scoreboard.directionalTotal += 1;
            if (claimDirectionMatches(byAttribute.get(attribute), c.label[attribute].expectedDirection)) {
              scoreboard.directionalMatches += 1;
            }
          }

          // (b) Citation validity — every NON-null claim must cite a resolvable
          // imageIndex AND the human label must mark that citation TRUE.
          for (const claim of result.claims) {
            scoreboard.citationsTotal += 1;
            const resolvesToRealImage =
              claim.imageIndex > 0 && result.imageUrlsUsed[claim.imageIndex - 1] !== undefined;
            const humanVerifiedTrue = c.label.citationsVerifiedTrue?.[claim.attribute] === true;
            if (resolvesToRealImage && humanVerifiedTrue) {
              scoreboard.citationsValid += 1;
            }
          }

          // (c) Zero-hallucination — no claim on this listing may reference a
          // person/personal document/fabricated detail (hard gate, T-11-06).
          const hasHallucinationMarker = result.claims.some(claimMentionsHallucinationMarker);
          if (!hasHallucinationMarker && c.label.expectedNoHallucination) {
            scoreboard.hallucinationFreeListings += 1;
          }
        }
      },
      120_000, // live multi-listing vision calls — generous timeout.
    );

    it("directional accuracy >= 70% per attribute, aggregated across all listings", () => {
      const rate = scoreboard.directionalMatches / Math.max(1, scoreboard.directionalTotal);
      expect(rate, `directional accuracy ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.7);
    });

    it("citation validity rate >= 90%", () => {
      const rate = scoreboard.citationsValid / Math.max(1, scoreboard.citationsTotal);
      expect(rate, `citation validity ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.9);
    });

    it("zero-hallucination rate === 100% (hard gate)", () => {
      const rate = scoreboard.hallucinationFreeListings / Math.max(1, cases.length);
      expect(rate, `zero-hallucination rate ${(rate * 100).toFixed(1)}%`).toBe(1);
    });

    it("measured per-search cost projection stays under CAP_VISION_SEK_MAX", () => {
      const avgCostPerListing = scoreboard.totalCostSek / Math.max(1, cases.length);
      // Extrapolate to a 25-candidate search (CAP_CANDIDATES_MAX), matching
      // the Cost Math section's per-search framing.
      const projectedSearchCost = avgCostPerListing * 25;
      expect(
        projectedSearchCost,
        `projected 25-candidate search cost ${projectedSearchCost.toFixed(2)} SEK`,
      ).toBeLessThanOrEqual(CAP_VISION_SEK_MAX);
    });
  });
});
