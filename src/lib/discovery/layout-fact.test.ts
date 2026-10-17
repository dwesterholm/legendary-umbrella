// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  LAYOUT_MIN_CONFIDENCE,
  believedLayout,
  formatKorsdragCell,
  LAYOUT_INFLUENCE_ENABLED,
  formatLayoutSummary as formatLayoutSummarySwitch,
  formatLayoutSummaryWhen,
  formatSolCellWithLayout as formatSolCellWithLayoutSwitch,
  formatSolCellWithLayoutWhen,
  formatSovrumCell,
  korsdragOf as korsdragOfSwitch,
  korsdragWhen,
  layoutFactSchema,
  type LayoutGatePolicy,
  quietBedroomOf as quietBedroomOfSwitch,
  quietBedroomWhen,
  usableSide as usableSideSwitch,
  usableSideWhen,
  usablyNoBalcony as usablyNoBalconySwitch,
  usablyNoBalconyWhen,
  type LayoutFact,
} from "@/lib/discovery/layout-fact";
import { formatSolCell, unknownSunFact, type SunFact } from "@/lib/discovery/sun-fact";

// The gating logic is tested with the switch ON; the switch itself is tested at the end of the file.
const usableSide = (f: LayoutFact | null, which: "balcony" | "bedroom") => usableSideWhen(f, which, true);
const usablyNoBalcony = (f: LayoutFact | null) => usablyNoBalconyWhen(f, true);
const korsdragOf = (f: LayoutFact | null) => korsdragWhen(f, true);
const quietBedroomOf = (f: LayoutFact | null) => quietBedroomWhen(f, true);
const formatSolCellWithLayout = (sun: SunFact | null, l: LayoutFact | null, applied: boolean) => formatSolCellWithLayoutWhen(sun, l, applied, true);
const formatLayoutSummary = (f: LayoutFact | null) => formatLayoutSummaryWhen(f, true);

/**
 * layout-fact.test.ts - the deterministic gate (14.3 lesson: the model fell for the front-door arrow
 * despite the prompt) and the cell texts. Pure, no model, no network.
 */

const fact = (over: Partial<LayoutFact> = {}): LayoutFact => ({
  balconySide: "street",
  livingOnBalconySide: true,
  kitchenOnBalconySide: true,
  bedroomOnBalconySide: true,
  windowSides: "one",
  bedroomSide: "street",
  streetEvidence: "cars",
  confidence: 0.9,
  source: "planritning+foto",
  version: "test-version",
  images: { booli: 4, broker: 0 },
  ...over,
});

/** A footprint-only sun fact like Folkungagatan 61: street south, courtyard north, confidence 1. */
function footprintSun(over: Partial<SunFact> = {}): SunFact {
  return {
    source: "fastighet/gata",
    confidence: 1,
    unknownReason: null,
    conflict: false,
    conflictWith: null,
    sides: [
      { side: "gata", facade: "south", bearingDeg: 170, share: 0.5, point: null, hours: null },
      { side: "gård", facade: "north", bearingDeg: 350, share: 0.5, point: null, hours: null },
    ],
    footprint: null,
    ...over,
  };
}

const statedSun: SunFact = {
  source: "angiven",
  confidence: 1,
  unknownReason: null,
  conflict: false,
  conflictWith: null,
  sides: [{ side: "angiven", facade: "west", bearingDeg: null, share: 1, point: null, hours: null }],
  footprint: null,
};

describe("usableSide: the gate on confidence and photo evidence", () => {
  it("the minimum confidence is 0,6", () => {
    expect(LAYOUT_MIN_CONFIDENCE).toBe(0.6);
  });

  it("street counts at exactly 0,6 with evidence and not at 0,59", () => {
    expect(usableSide(fact({ confidence: 0.6 }), "balcony")).toBe("street");
    expect(usableSide(fact({ confidence: 0.59 }), "balcony")).toBeNull();
  });

  it("courtyard counts with evidence, and the bedroom follows the same rule", () => {
    expect(usableSide(fact({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" }), "balcony")).toBe("courtyard");
    expect(usableSide(fact({ bedroomSide: "courtyard" }), "bedroom")).toBe("courtyard");
    expect(usableSide(fact({ bedroomSide: "street", confidence: 0.6 }), "bedroom")).toBe("street");
    expect(usableSide(fact({ bedroomSide: "street", confidence: 0.59 }), "bedroom")).toBeNull();
  });

  it("no photo evidence (streetEvidence none) means unknown, whatever the confidence", () => {
    expect(usableSide(fact({ streetEvidence: "none", confidence: 1 }), "balcony")).toBeNull();
    expect(usableSide(fact({ streetEvidence: "none", confidence: 1 }), "bedroom")).toBeNull();
  });

  it("none and unknown values are never a side, and a missing fact is null", () => {
    expect(usableSide(fact({ balconySide: "none" }), "balcony")).toBeNull();
    expect(usableSide(fact({ balconySide: "unknown" }), "balcony")).toBeNull();
    expect(usableSide(fact({ bedroomSide: "unknown" }), "bedroom")).toBeNull();
    expect(usableSide(null, "balcony")).toBeNull();
    expect(usableSide(null, "bedroom")).toBeNull();
  });

  it("the balcony and bedroom are read from their own field", () => {
    const f = fact({ balconySide: "street", bedroomSide: "courtyard" });
    expect(usableSide(f, "balcony")).toBe("street");
    expect(usableSide(f, "bedroom")).toBe("courtyard");
  });
});

describe("korsdragOf and quietBedroomOf", () => {
  it("twoOpposite is korsdrag at 0,6 and unknown at 0,59", () => {
    expect(korsdragOf(fact({ windowSides: "twoOpposite", confidence: 0.6 }))).toBe(true);
    expect(korsdragOf(fact({ windowSides: "twoOpposite", confidence: 0.59 }))).toBeNull();
  });

  it("one side and a corner are no korsdrag; unknown and no fact are unknown", () => {
    expect(korsdragOf(fact({ windowSides: "one" }))).toBe(false);
    expect(korsdragOf(fact({ windowSides: "corner" }))).toBe(false);
    expect(korsdragOf(fact({ windowSides: "unknown" }))).toBeNull();
    expect(korsdragOf(null)).toBeNull();
  });

  it("korsdrag needs only the confidence, not photo evidence", () => {
    expect(korsdragOf(fact({ windowSides: "twoOpposite", streetEvidence: "none" }))).toBe(true);
  });

  it("a courtyard bedroom is quiet, a street bedroom is not, anything unusable is unknown", () => {
    expect(quietBedroomOf(fact({ bedroomSide: "courtyard" }))).toBe(true);
    expect(quietBedroomOf(fact({ bedroomSide: "street" }))).toBe(false);
    expect(quietBedroomOf(fact({ bedroomSide: "courtyard", confidence: 0.59 }))).toBeNull();
    expect(quietBedroomOf(fact({ bedroomSide: "courtyard", streetEvidence: "none" }))).toBeNull();
    expect(quietBedroomOf(fact({ bedroomSide: "unknown" }))).toBeNull();
    expect(quietBedroomOf(null)).toBeNull();
  });
});

describe("the Korsdrag and Sovrum cells", () => {
  it("korsdrag prints ja, nej or okänd", () => {
    expect(formatKorsdragCell(true)).toBe("ja");
    expect(formatKorsdragCell(false)).toBe("nej");
    expect(formatKorsdragCell(null)).toBe("okänd");
  });

  it("sovrum prints gård for the quiet bedroom, gata otherwise, okänd when unknown", () => {
    expect(formatSovrumCell(true)).toBe("gård");
    expect(formatSovrumCell(false)).toBe("gata");
    expect(formatSovrumCell(null)).toBe("okänd");
  });
});

describe("formatSolCellWithLayout", () => {
  it("applied: the balcony side's facade, the sun's own confidence, balkong gata", () => {
    expect(formatSolCellWithLayout(footprintSun(), fact(), true)).toBe("S gata (planritning+foto, 1,00), balkong gata");
    expect(formatSolCellWithLayout(footprintSun({ confidence: 0.9 }), fact(), true)).toBe(
      "S gata (planritning+foto, 0,90), balkong gata",
    );
  });

  it("applied on the courtyard side prints the courtyard facade", () => {
    const layout = fact({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" });
    expect(formatSolCellWithLayout(footprintSun(), layout, true)).toBe("N gård (planritning+foto, 1,00), balkong gård");
  });

  it("a stated facade keeps its cell and gets only the balcony word", () => {
    expect(formatSolCellWithLayout(statedSun, fact(), false)).toBe(`${formatSolCell(statedSun)}, balkong gata`);
    expect(formatSolCellWithLayout(statedSun, fact(), false)).toBe("V (angiven, 1,00), balkong gata");
  });

  it("a footprint fact the layout did not pick from keeps its cell plus the balcony word", () => {
    expect(formatSolCellWithLayout(footprintSun(), fact(), false)).toBe("S gata/N gård (fastighet/gata, 1,00), balkong gata");
  });

  it("a confident 'no balcony' adds ingen balkong, even without photo evidence", () => {
    expect(formatSolCellWithLayout(footprintSun(), fact({ balconySide: "none" }), false)).toBe(
      `${formatSolCell(footprintSun())}, ingen balkong`,
    );
    expect(formatSolCellWithLayout(footprintSun(), fact({ balconySide: "none", streetEvidence: "none" }), false)).toBe(
      `${formatSolCell(footprintSun())}, ingen balkong`,
    );
    expect(formatSolCellWithLayout(footprintSun(), fact({ balconySide: "none", confidence: 0.59 }), false)).toBe(
      formatSolCell(footprintSun()),
    );
  });

  it("no layout or an unusable one prints exactly the 14.3 cell", () => {
    for (const sun of [null, unknownSunFact("adress saknas"), footprintSun(), statedSun]) {
      expect(formatSolCellWithLayout(sun, null, false)).toBe(formatSolCell(sun));
      expect(formatSolCellWithLayout(sun, fact({ confidence: 0.59 }), false)).toBe(formatSolCell(sun));
      expect(formatSolCellWithLayout(sun, fact({ streetEvidence: "none" }), false)).toBe(formatSolCell(sun));
      expect(formatSolCellWithLayout(sun, fact({ balconySide: "unknown" }), false)).toBe(formatSolCell(sun));
    }
  });

  it("an applied flag with nothing to apply falls back to the unchanged cell", () => {
    expect(formatSolCellWithLayout(footprintSun(), null, true)).toBe(formatSolCell(footprintSun()));
  });
});

describe("layoutFactSchema", () => {
  it("accepts a full record and rejects a wrong source, an unknown enum value and a confidence above 1", () => {
    expect(layoutFactSchema.safeParse(fact()).success).toBe(true);
    expect(layoutFactSchema.safeParse({ ...fact(), source: "planritning" }).success).toBe(false);
    expect(layoutFactSchema.safeParse({ ...fact(), balconySide: "roof" }).success).toBe(false);
    expect(layoutFactSchema.safeParse({ ...fact(), confidence: 1.2 }).success).toBe(false);
  });
});

describe("formatLayoutSummary and usablyNoBalcony (14.4 plan 08)", () => {
  it("prints believed values only, with the confidence", () => {
    expect(formatLayoutSummary(fact())).toBe("balkong gata, fönster en sida, sovrum gata (säkerhet 0,90)");
    expect(
      formatLayoutSummary(fact({ balconySide: "courtyard", windowSides: "twoOpposite", bedroomSide: "courtyard", streetEvidence: "courtyardGreenery" })),
    ).toBe("balkong gård, fönster två motsatta sidor, sovrum gård (säkerhet 0,90)");
  });

  it("below the gate everything reads okänd, and no fact prints a dash", () => {
    expect(formatLayoutSummary(fact({ confidence: 0.59 }))).toBe("balkong okänd, fönster okänd, sovrum okänd (säkerhet 0,59)");
    expect(formatLayoutSummary(fact({ streetEvidence: "none" }))).toBe("balkong okänd, fönster en sida, sovrum okänd (säkerhet 0,90)");
    expect(formatLayoutSummary(null)).toBe("-");
  });

  it("a confident 'no balcony' prints ingen, and usablyNoBalcony needs only the confidence", () => {
    const none = fact({ balconySide: "none", streetEvidence: "none" });
    expect(formatLayoutSummary(none)).toBe("balkong ingen, fönster en sida, sovrum okänd (säkerhet 0,90)");
    expect(usablyNoBalcony(none)).toBe(true);
    expect(usablyNoBalcony({ ...none, confidence: 0.59 })).toBe(false);
    expect(usablyNoBalcony(fact())).toBe(false);
    expect(usablyNoBalcony(null)).toBe(false);
  });
});

describe("LAYOUT_INFLUENCE_ENABLED off (Daniel 2026-10-17, UAT 14.4 items 4-5)", () => {
  const confidentFact = fact({ windowSides: "twoOpposite", bedroomSide: "courtyard", streetEvidence: "cars", confidence: 0.95 });

  it("is off until the read is proven at least 75 % reliable", () => {
    expect(LAYOUT_INFLUENCE_ENABLED).toBe(false);
  });

  it("every helper returns unknown for a confident fact", () => {
    expect(usableSideSwitch(confidentFact, "balcony")).toBeNull();
    expect(usableSideSwitch(confidentFact, "bedroom")).toBeNull();
    expect(korsdragOfSwitch(confidentFact)).toBeNull();
    expect(quietBedroomOfSwitch(confidentFact)).toBeNull();
    expect(usablyNoBalconySwitch(fact({ balconySide: "none", confidence: 0.95 }))).toBe(false);
  });

  it("the explicit-switch variants return unknown when passed false and the gated value when passed true", () => {
    expect(usableSideWhen(confidentFact, "balcony", false)).toBeNull();
    expect(korsdragWhen(confidentFact, false)).toBeNull();
    expect(quietBedroomWhen(confidentFact, false)).toBeNull();
    expect(usablyNoBalconyWhen(fact({ balconySide: "none" }), false)).toBe(false);
    expect(korsdragWhen(confidentFact, true)).toBe(true);
  });

  it("the cells read okänd and the Sol cell never says planritning+foto", () => {
    expect(formatKorsdragCell(korsdragOfSwitch(confidentFact))).toBe("okänd");
    expect(formatSovrumCell(quietBedroomOfSwitch(confidentFact))).toBe("okänd");
    expect(formatSolCellWithLayoutSwitch(footprintSun(), confidentFact, true)).not.toContain("planritning+foto");
    expect(formatSolCellWithLayoutSwitch(footprintSun(), confidentFact, false)).toBe(formatSolCell(footprintSun()));
  });

  it("the tracked-flat summary still shows what the read found, marked as not affecting the score", () => {
    expect(formatLayoutSummarySwitch(fact())).toBe("balkong gata, fönster en sida, sovrum gata (säkerhet 0,90) (påverkar ej poängen)");
    expect(formatLayoutSummary(fact())).toBe("balkong gata, fönster en sida, sovrum gata (säkerhet 0,90)");
  });
});

describe("layoutFactSchema: the optional 14.5 keys", () => {
  it("still parses a 14.4 fact with neither fieldConfidence nor planPresent", () => {
    expect(layoutFactSchema.safeParse(fact()).success).toBe(true);
  });

  it("parses a fact with per-field confidences and planPresent", () => {
    const parsed = layoutFactSchema.safeParse(fact({ fieldConfidence: { balcony: 0.9, windows: 0.4, bedroom: 0.7 }, planPresent: true }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fieldConfidence?.windows).toBe(0.4);
  });

  it("rejects a per-field confidence outside 0..1", () => {
    expect(layoutFactSchema.safeParse(fact({ fieldConfidence: { balcony: 1.2, windows: 0.4, bedroom: 0.7 } })).success).toBe(false);
  });
});

describe("believedLayout: the one definition of what a read is believed to say", () => {
  const policy = (over: Partial<LayoutGatePolicy> = {}): LayoutGatePolicy => ({
    balconyGate: 0.8,
    windowsGate: 0.8,
    bedroomGate: 0.8,
    negativeGate: 0.6,
    sideEvidence: ["cars", "courtyardGreenery"],
    trustedVersion: null,
    ...over,
  });
  const UNKNOWN = { balconySide: null, noBalcony: false, korsdrag: null, bedroomSide: null };

  it("no fact is all unknown", () => {
    expect(believedLayout(null, policy())).toEqual(UNKNOWN);
  });

  it("a fact of another version than the trusted one is all unknown; null trusts every version", () => {
    expect(believedLayout(fact({ version: "old" }), policy({ trustedVersion: "new" }))).toEqual(UNKNOWN);
    expect(believedLayout(fact({ version: "new" }), policy({ trustedVersion: "new" })).balconySide).toBe("street");
    expect(believedLayout(fact({ version: "old" }), policy({ trustedVersion: null })).balconySide).toBe("street");
  });

  it("planPresent false abstains on everything; planPresent true or absent does not", () => {
    expect(believedLayout(fact({ planPresent: false }), policy())).toEqual(UNKNOWN);
    expect(believedLayout(fact({ planPresent: true }), policy()).balconySide).toBe("street");
    expect(believedLayout(fact(), policy()).balconySide).toBe("street");
  });

  it("the balcony needs its field confidence at the gate (inclusive) and evidence in the allowlist", () => {
    const f = (c: number, over: Partial<LayoutFact> = {}) => fact({ balconySide: "street", streetEvidence: "cars", confidence: c, ...over });
    expect(believedLayout(f(0.8), policy()).balconySide).toBe("street");
    expect(believedLayout(f(0.79), policy()).balconySide).toBeNull();
    expect(believedLayout(f(0.9, { streetEvidence: "oppositeFacade" }), policy()).balconySide).toBeNull();
    expect(believedLayout(f(0.9, { streetEvidence: "oppositeFacade" }), policy({ sideEvidence: ["cars", "oppositeFacade"] })).balconySide).toBe("street");
    expect(believedLayout(f(0.9, { streetEvidence: "none" }), policy()).balconySide).toBeNull();
    expect(believedLayout(f(0.9, { balconySide: "courtyard", streetEvidence: "courtyardGreenery" }), policy()).balconySide).toBe("courtyard");
    expect(believedLayout(f(0.9, { balconySide: "unknown" }), policy()).balconySide).toBeNull();
  });

  it("uses fieldConfidence.<field> when present, else the single confidence", () => {
    const f = fact({ confidence: 0.95, fieldConfidence: { balcony: 0.5, windows: 0.9, bedroom: 0.85 }, windowSides: "twoOpposite", bedroomSide: "courtyard" });
    const b = believedLayout(f, policy());
    expect(b.balconySide).toBeNull(); // balcony field confidence 0.5 < 0.8, although the single confidence is 0.95
    expect(b.korsdrag).toBe(true);
    expect(b.bedroomSide).toBe("courtyard");
  });

  it("korsdrag: a positive needs the stricter gate, a negative the negative gate", () => {
    const two = (c: number) => fact({ windowSides: "twoOpposite", confidence: c });
    expect(believedLayout(two(0.8), policy()).korsdrag).toBe(true);
    expect(believedLayout(two(0.79), policy()).korsdrag).toBeNull();
    expect(believedLayout(fact({ windowSides: "one", confidence: 0.6 }), policy()).korsdrag).toBe(false);
    expect(believedLayout(fact({ windowSides: "corner", confidence: 0.6 }), policy()).korsdrag).toBe(false);
    expect(believedLayout(fact({ windowSides: "one", confidence: 0.59 }), policy()).korsdrag).toBeNull();
    expect(believedLayout(fact({ windowSides: "unknown", confidence: 0.99 }), policy()).korsdrag).toBeNull();
  });

  it("noBalcony: balconySide none at or above the negative gate", () => {
    expect(believedLayout(fact({ balconySide: "none", confidence: 0.6 }), policy()).noBalcony).toBe(true);
    expect(believedLayout(fact({ balconySide: "none", confidence: 0.59 }), policy()).noBalcony).toBe(false);
    expect(believedLayout(fact({ balconySide: "street", confidence: 0.99 }), policy()).noBalcony).toBe(false);
  });

  it("the bedroom follows the balcony rule with its own gate; a quiet bedroom is bedroomSide courtyard", () => {
    const f = (c: number, side: LayoutFact["bedroomSide"]) => fact({ bedroomSide: side, confidence: c });
    expect(believedLayout(f(0.8, "courtyard"), policy()).bedroomSide).toBe("courtyard");
    expect(believedLayout(f(0.79, "courtyard"), policy()).bedroomSide).toBeNull();
    expect(believedLayout(f(0.9, "unknown"), policy()).bedroomSide).toBeNull();
    expect(believedLayout(f(0.9, "courtyard"), policy({ bedroomGate: 0.95 })).bedroomSide).toBeNull();
  });

  it("leaves the 14.4 gate functions exactly as they were", () => {
    const f = fact({ balconySide: "courtyard", streetEvidence: "courtyardGreenery", confidence: 0.6 });
    expect(usableSide(f, "balcony")).toBe("courtyard");
    expect(usableSide(fact({ confidence: 0.59 }), "balcony")).toBeNull();
    expect(korsdragOf(fact({ windowSides: "twoOpposite", confidence: 0.6 }))).toBe(true);
    // the new optional keys do not move the old gate
    expect(usableSide(fact({ planPresent: false, fieldConfidence: { balcony: 0.1, windows: 0.1, bedroom: 0.1 } }), "balcony")).toBe("street");
  });
});
