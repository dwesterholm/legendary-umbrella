import { describe, it, expect } from "vitest";
import { conditionScore } from "@/lib/discovery/condition-score";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import type { VisionResult, VisionConditionClaim } from "@/lib/discovery/vision-schema";

function claim(overrides: Partial<VisionConditionClaim>): VisionConditionClaim {
  return {
    attribute: "overall",
    claim: "",
    imageIndex: 1,
    whatWasSeen: "",
    confidence: 0.8,
    ...overrides,
  };
}

function withVision(claims: VisionConditionClaim[] | null): DiscoveryCandidate {
  const vision: VisionResult | null =
    claims === null ? null : { claims, imageUrlsUsed: [], model: "m", costSek: 0, ranAt: "" };
  return { vision } as DiscoveryCandidate;
}

describe("conditionScore", () => {
  it("is 0 when there is no vision result (never penalizes a candidate for lacking images)", () => {
    expect(conditionScore(withVision(null))).toBe(0);
    expect(conditionScore(withVision([]))).toBe(0);
  });

  it("weights a remodelPotential claim highest (+2 — an explicit value-add)", () => {
    expect(conditionScore(withVision([claim({ attribute: "remodelPotential", claim: "x" })]))).toBe(2);
  });

  it("adds for a dated kitchen/bathroom/overall claim", () => {
    expect(
      conditionScore(
        withVision([claim({ attribute: "kitchen", claim: "Köket ser daterat ut med äldre vitvaror" })]),
      ),
    ).toBe(1);
  });

  it("subtracts for an already-renovated (turnkey) claim — less upside", () => {
    expect(
      conditionScore(
        withVision([claim({ attribute: "bathroom", claim: "Badrummet är nyrenoverat och fräscht" })]),
      ),
    ).toBe(-1);
  });

  it("sums across mixed claims so a dated flat with remodel potential ranks above a renovated one", () => {
    const renovationObject = withVision([
      claim({ attribute: "remodelPotential", claim: "väggen kan öppnas" }),
      claim({ attribute: "kitchen", claim: "daterat kök" }),
    ]);
    const turnkey = withVision([
      claim({ attribute: "kitchen", claim: "nyrenoverat kök" }),
      claim({ attribute: "bathroom", claim: "helrenoverat badrum" }),
    ]);
    expect(conditionScore(renovationObject)).toBe(3); // +2 remodel, +1 dated
    expect(conditionScore(turnkey)).toBe(-2); // two renovated claims
    expect(conditionScore(renovationObject)).toBeGreaterThan(conditionScore(turnkey));
  });
});
