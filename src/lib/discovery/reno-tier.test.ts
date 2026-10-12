import { describe, it, expect } from "vitest";
import {
  NEGATED_RENOVATION,
  NO_RENOVATION_NEED,
  RENO_BAND,
  UNKNOWN_RENO_STATES,
  classifyAttribute,
  classifyClaimText,
  renoBundle,
  renoEstimateFromVision,
  type RenoAttribute,
  type RenoState,
} from "@/lib/discovery/reno-tier";
import { RENO_COST_MATRIX, type CostTier, type RenoOpportunity } from "@/lib/discovery/flip-economics";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";

function claim(attribute: VisionConditionClaim["attribute"], text: string, seen = ""): VisionConditionClaim {
  return { attribute, claim: text, whatWasSeen: seen, imageIndex: 1, confidence: 0.8 };
}

function vision(claims: VisionConditionClaim[]): VisionResult {
  return { claims, imageUrlsUsed: [], model: "m", costSek: 0, ranAt: "2026-10-13T00:00:00Z" };
}

/** Midpoint of one matrix item at a band: the test derives totals from the matrix, not from literals. */
function mid(item: RenoOpportunity, band: CostTier = RENO_BAND): number {
  const [lo, hi] = RENO_COST_MATRIX[item][band];
  return (lo + hi) / 2;
}
function ends(item: RenoOpportunity, band: CostTier = RENO_BAND): [number, number] {
  const [lo, hi] = RENO_COST_MATRIX[item][band];
  return [lo, hi];
}

const all = (s: RenoState): Record<RenoAttribute, RenoState> => ({ kitchen: s, bathroom: s, overall: s });

describe("classifyClaimText: negation first (FIT-04, T-14.1-15)", () => {
  it.each([
    ["Köket verkar inte renoverat", "dated"],
    ["Orenoverat badrum", "dated"],
    ["orenoverat kök", "dated"],
    ["Ej renoverat sedan 70-talet", "dated"],
    ["Badrummet är inte renoverat", "dated"],
    ["Köket ser inte ut att vara renoverat", "dated"],
    ["Ursprungligt skick", "dated"],
    ["Slitna golv", "dated"],
    ["Daterade ytskikt", "dated"],
    ["Nyrenoverat kök", "fresh"],
    ["Toppskick", "fresh"],
    ["Fräscht badrum", "fresh"],
    ["Inget uppenbart renoveringsbehov", "ok"],
    ["Inget renoveringsbehov", "ok"],
    ["Ej något renoveringsbehov", "ok"],
    ["Köket ser ut att vara i gott skick", "ok"],
    ["", "ok"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(classifyClaimText(text)).toBe(expected);
  });

  it("'renoverat' inside a negation is dated, not fresh, whichever word order it uses", () => {
    for (const text of ["inte renoverat", "ej renoverat", "icke renoverat", "aldrig renoverat", "verkar inte renoverat"]) {
      expect(NEGATED_RENOVATION.test(text), text).toBe(true);
      expect(classifyClaimText(text), text).toBe("dated");
    }
  });

  it("a negation does not reach across a sentence boundary", () => {
    // 'Ej synliga skador. Nyrenoverat kök' is a fresh kitchen, not a dated one.
    expect(classifyClaimText("Ej synliga skador. Nyrenoverat kök")).toBe("fresh");
  });

  it("'inget renoveringsbehov' is matched by the no-need regex, which wins over the dated word 'renoveringsbehov'", () => {
    expect(NO_RENOVATION_NEED.test("inget uppenbart renoveringsbehov")).toBe(true);
    expect(NO_RENOVATION_NEED.test("Stort renoveringsbehov")).toBe(false);
    expect(classifyClaimText("Stort renoveringsbehov")).toBe("dated");
  });
});

describe("classifyAttribute (FIT-04)", () => {
  it("no claim for the attribute is unknown", () => {
    expect(classifyAttribute([], "kitchen")).toBe("unknown");
    expect(classifyAttribute([claim("bathroom", "Slitet")], "kitchen")).toBe("unknown");
  });

  it("worst state wins: dated > ok > fresh", () => {
    expect(classifyAttribute([claim("kitchen", "Nyrenoverat kök"), claim("kitchen", "Daterat kök")], "kitchen")).toBe("dated");
    expect(classifyAttribute([claim("kitchen", "Daterat kök"), claim("kitchen", "Nyrenoverat kök")], "kitchen")).toBe("dated");
    expect(classifyAttribute([claim("kitchen", "Nyrenoverat kök"), claim("kitchen", "Gott skick")], "kitchen")).toBe("ok");
    expect(classifyAttribute([claim("kitchen", "Gott skick"), claim("kitchen", "Nyrenoverat kök")], "kitchen")).toBe("ok");
    expect(classifyAttribute([claim("kitchen", "Nyrenoverat kök"), claim("kitchen", "Toppskick")], "kitchen")).toBe("fresh");
  });

  it("reads both the claim and the whatWasSeen text", () => {
    expect(classifyAttribute([claim("kitchen", "Köket", "luckor från 70-talet, daterat")], "kitchen")).toBe("dated");
  });

  it("remodelPotential claims are ignored for every priced attribute", () => {
    const claims = [claim("remodelPotential", "Dated and worn, renoveringsbehov, ursprunglig planlösning")];
    for (const a of ["kitchen", "bathroom", "overall"] as const) expect(classifyAttribute(claims, a)).toBe("unknown");
  });
});

describe("renoBundle: totals come from RENO_COST_MATRIX (R-01, FIT-04 precision probe)", () => {
  it("all fresh is the cheap-band paint touch-up", () => {
    const expected = mid("paint-apartment", "cheap");
    const b = renoBundle(all("fresh"));
    expect(b.midSek).toBe(expected);
    expect(b.midSek).toBe(10_000);
    expect(b.tier).toBe("low");
    expect(b.anyDated).toBe(false);
    expect(b.anyUnknown).toBe(false);
  });

  it("all unknown is the cosmetic bundle", () => {
    const expected = mid("kitchen-cosmetic") + mid("bathroom-cosmetic") + mid("paint-apartment");
    const b = renoBundle(all("unknown"));
    expect(b.midSek).toBe(expected);
    expect(b.midSek).toBe(105_000);
    expect(b.tier).toBe("mid");
    expect(b.anyUnknown).toBe(true);
  });

  it("all dated is full kitchen + full bathroom + paint + floors; the range prints the band ends", () => {
    const items: RenoOpportunity[] = ["kitchen-full", "bathroom-full", "paint-apartment", "floors"];
    const expectedMid = items.reduce((sum, i) => sum + mid(i), 0);
    const expectedLow = items.reduce((sum, i) => sum + ends(i)[0], 0);
    const expectedHigh = items.reduce((sum, i) => sum + ends(i)[1], 0);
    const b = renoBundle(all("dated"));
    expect(b.midSek).toBe(expectedMid);
    expect(b.midSek).toBe(427_500);
    expect(b.lowSek).toBe(expectedLow);
    expect(b.highSek).toBe(expectedHigh);
    expect(b.tier).toBe("high");
    expect(b.anyDated).toBe(true);
  });

  it("a mid total sits between its own low and high ends in every state combination", () => {
    const states: RenoState[] = ["fresh", "ok", "dated", "unknown"];
    for (const k of states) for (const bt of states) for (const o of states) {
      const b = renoBundle({ kitchen: k, bathroom: bt, overall: o });
      expect(b.lowSek).toBeLessThanOrEqual(b.midSek);
      expect(b.midSek).toBeLessThanOrEqual(b.highSek);
    }
  });

  it("an invalid tier steps up: bathroom-full never uses the cheap band", () => {
    expect(RENO_COST_MATRIX["bathroom-full"].invalidTiers).toContain("cheap");
    const cheap = renoBundle(all("dated"), "cheap");
    const items: RenoOpportunity[] = ["kitchen-full", "paint-apartment", "floors"];
    const expected = items.reduce((sum, i) => sum + mid(i, "cheap"), 0) + mid("bathroom-full", "mid");
    expect(cheap.midSek).toBe(expected);
  });

  it("the band parameter defaults to RENO_BAND", () => {
    expect(renoBundle(all("dated"), RENO_BAND).midSek).toBe(renoBundle(all("dated")).midSek);
  });

  it("ok costs the same as unknown but does not set anyUnknown", () => {
    const ok = renoBundle(all("ok"));
    expect(ok.midSek).toBe(renoBundle(all("unknown")).midSek);
    expect(ok.anyUnknown).toBe(false);
    expect(ok.tier).toBe("mixed");
  });
});

describe("renoEstimateFromVision (FIT-04)", () => {
  it("null vision gives the unknown bundle with source none", () => {
    const e = renoEstimateFromVision(null);
    expect(e.states).toEqual(UNKNOWN_RENO_STATES);
    expect(e.source).toBe("none");
    expect(e.midSek).toBe(105_000);
  });

  it("a vision read with no claims is also unknown with source none", () => {
    const e = renoEstimateFromVision(vision([]));
    expect(e.states).toEqual(UNKNOWN_RENO_STATES);
    expect(e.source).toBe("none");
    expect(e.midSek).toBe(105_000);
  });

  it("only a kitchen verdict leaves bathroom and overall unknown (FIT-04 boundary probe)", () => {
    const e = renoEstimateFromVision(vision([claim("kitchen", "Nyrenoverat kök")]));
    expect(e.states).toEqual({ kitchen: "fresh", bathroom: "unknown", overall: "unknown" });
    expect(e.midSek).toBe(0 + mid("bathroom-cosmetic") + mid("paint-apartment"));
    expect(e.midSek).toBe(60_000);
    expect(e.anyUnknown).toBe(true);
    expect(e.source).toBe("vision");
  });

  it("all three fresh is 10 000 and tier low", () => {
    const e = renoEstimateFromVision(
      vision([claim("kitchen", "Nyrenoverat kök"), claim("bathroom", "Fräscht badrum"), claim("overall", "Toppskick")]),
    );
    expect(e.midSek).toBe(mid("paint-apartment", "cheap"));
    expect(e.midSek).toBe(10_000);
    expect(e.tier).toBe("low");
    expect(e.source).toBe("vision");
  });

  it("all three dated is 427 500 and tier high", () => {
    const e = renoEstimateFromVision(
      vision([
        claim("kitchen", "Köket verkar inte renoverat"),
        claim("bathroom", "Orenoverat badrum"),
        claim("overall", "Ursprungligt skick"),
      ]),
    );
    const expected = mid("kitchen-full") + mid("bathroom-full") + mid("paint-apartment") + mid("floors");
    expect(e.midSek).toBe(expected);
    expect(e.midSek).toBe(427_500);
    expect(e.tier).toBe("high");
    expect(e.anyDated).toBe(true);
    const items: RenoOpportunity[] = ["kitchen-full", "bathroom-full", "paint-apartment", "floors"];
    expect(e.lowSek).toBe(items.reduce((s, i) => s + ends(i)[0], 0));
    expect(e.highSek).toBe(items.reduce((s, i) => s + ends(i)[1], 0));
  });

  it("a remodelPotential-only read adds no cost: all unknown, source vision", () => {
    const e = renoEstimateFromVision(vision([claim("remodelPotential", "Kan öppna upp mot vardagsrum")]));
    expect(e.states).toEqual(UNKNOWN_RENO_STATES);
    expect(e.source).toBe("vision");
    expect(e.midSek).toBe(105_000);
  });

  it("a 'renoverat' claim that is really a negation costs the dated bundle, never the fresh one", () => {
    const e = renoEstimateFromVision(vision([claim("kitchen", "Orenoverat kök")]));
    expect(e.states.kitchen).toBe("dated");
    expect(e.midSek).toBeGreaterThan(renoEstimateFromVision(vision([claim("kitchen", "Nyrenoverat kök")])).midSek);
  });
});
