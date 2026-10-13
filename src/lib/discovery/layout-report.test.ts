// @vitest-environment node
import { describe, expect, it } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import { parseFitSnapshot, type FitInputRow } from "@/lib/discovery/fit-score";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import { EYE_SAMPLE_SIZE, layoutReportOf } from "@/lib/discovery/layout-report";
import type { SunFact } from "@/lib/discovery/sun-fact";

/**
 * layout-report.test.ts - the counts of the live layout run (14.4 plan 08, LAY-04). Pure: hand-made rows, no
 * model, no network.
 */

const snapshot = parseFitSnapshot(snapshotJson);

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
  version: "v",
  images: { booli: 4, broker: 0 },
  ...over,
});

const footprint = {
  osmId: "way/1",
  inside: true,
  snapM: 1,
  streetBearingDeg: 170,
  streetFacade: "south" as const,
  courtyardBearingDeg: 350,
  courtyardFacade: "north" as const,
  confidence: 1,
  frontageM: 20,
  streetDistM: 8,
  ambiguous: false,
  floorAboveLevels: false,
};

const sunOf = (source: SunFact["source"], statedFacade: "south" | "north" | "east" | "west" = "south"): SunFact => ({
  source,
  confidence: 1,
  unknownReason: null,
  conflict: false,
  conflictWith: null,
  sides:
    source === "angiven"
      ? [{ side: "angiven", facade: statedFacade, bearingDeg: null, share: 1, point: null, hours: null }]
      : [
          { side: "gata", facade: "south", bearingDeg: 170, share: 0.5, point: null, hours: null },
          { side: "gård", facade: "north", bearingDeg: 350, share: 0.5, point: null, hours: null },
        ],
  footprint,
});

const row = (id: number, layout: LayoutFact | null, sun: SunFact | null = null): FitInputRow => ({
  ...snapshot.rows[0],
  candidate: { ...snapshot.rows[0].candidate, sourceListingUrl: `https://www.booli.se/bostad/${id}` },
  layout,
  sun,
});

describe("layoutReportOf", () => {
  it("only rows with a layout count; values count each answer and spread the confidence around the 0,6 gate", () => {
    const rows = [
      row(5, fact({ confidence: 0.45 })),
      row(4, fact({ confidence: 0.55, balconySide: "courtyard" })),
      row(3, fact({ confidence: 0.6, windowSides: "twoOpposite" })),
      row(2, fact({ confidence: 0.7, bedroomSide: "courtyard" })),
      row(1, null),
    ];
    const r = layoutReportOf(rows, 1.23456);
    expect(r.rowsWithLayout).toBe(4);
    expect(r.values.confidence).toEqual({ below05: 1, from05to06: 1, from06to07: 1, from07: 1 });
    expect(r.values.balconySide).toEqual({ street: 3, courtyard: 1 });
    expect(r.values.windowSides).toEqual({ one: 3, twoOpposite: 1 });
    expect(r.values.bedroomSide).toEqual({ street: 3, courtyard: 1 });
    expect(r.values.streetEvidence).toEqual({ cars: 4 });
    expect(r.spend).toEqual({ lifetimeSek: 1.2346 });
  });

  it("usable counts follow the gate: 0,6 passes, 0,59 does not, no photo evidence blocks the sides but not the windows, a confident 'none' counts as a balcony answer", () => {
    const rows = [
      row(1, fact({ confidence: 0.6 })),
      row(2, fact({ confidence: 0.59 })),
      row(3, fact({ streetEvidence: "none", windowSides: "twoOpposite" })),
      row(4, fact({ balconySide: "none", streetEvidence: "none", bedroomSide: "unknown", windowSides: "unknown" })),
    ];
    const r = layoutReportOf(rows, 0);
    expect(r.usable).toEqual({ balcony: 2, balconyStreetOrCourtyard: 1, windowSides: 2, bedroom: 1 });
  });

  it("counts the rows where the layout picked the sun's facade", () => {
    const rows = [row(1, fact(), sunOf("fastighet/gata")), row(2, fact(), sunOf("angiven")), row(3, fact(), null), row(4, fact({ confidence: 0.5 }), sunOf("fastighet/gata"))];
    expect(layoutReportOf(rows, 0).appliedToSun).toBe(1);
  });

  it("agreement uses only stated-facade rows with a known footprint and a usable street or courtyard balcony; n can be 0", () => {
    const none = layoutReportOf([row(1, fact(), sunOf("fastighet/gata")), row(2, fact({ confidence: 0.3 }), sunOf("angiven"))], 0);
    expect(none.agreement).toEqual({ n: 0, agree: 0, cases: [] });

    const rows = [
      row(10, fact({ balconySide: "street" }), sunOf("angiven", "south")), // street = south: agrees
      row(11, fact({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" }), sunOf("angiven", "south")), // courtyard = north: disagrees
      row(12, fact({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" }), sunOf("angiven", "north")), // agrees
    ];
    const r = layoutReportOf(rows, 0);
    expect(r.agreement.n).toBe(3);
    expect(r.agreement.agree).toBe(2);
    expect(r.agreement.cases.map((c) => [c.booliId, c.agree])).toEqual([
      [10, true],
      [11, false],
      [12, true],
    ]);
  });

  it("consistency counts a bedroom said to be on the balcony side but believed on the other side", () => {
    const rows = [
      row(1, fact()), // street/street: consistent
      row(2, fact({ bedroomSide: "courtyard" })), // street balcony, courtyard bedroom, "same side": contradiction
      row(3, fact({ bedroomSide: "courtyard", bedroomOnBalconySide: false })), // not claimed to be on that side: not evaluated
      row(4, fact({ bedroomSide: "courtyard", windowSides: "twoOpposite" })), // two window sides: not evaluated
      row(5, fact({ bedroomSide: "courtyard", confidence: 0.5 })), // not believed: not evaluated
    ];
    expect(layoutReportOf(rows, 0).consistency).toEqual({ n: 2, contradictions: 1 });
  });

  it("the eye sample is the lowest Booli ids with a layout, at most 12, and carries no URL", () => {
    const rows: FitInputRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(row(100 - i, fact()));
    rows.push(row(1, null)); // lowest id but no layout: left out
    const r = layoutReportOf(rows, 0);
    expect(r.eyeSample).toHaveLength(EYE_SAMPLE_SIZE);
    expect(r.eyeSample.map((e) => e.booliId)).toEqual(Array.from({ length: EYE_SAMPLE_SIZE }, (_v, i) => 81 + i));
    expect(JSON.stringify(r)).not.toContain("https://");
    expect(r.eyeSample[0]).toMatchObject({ korsdrag: false, quietBedroom: false, confidence: 0.9 });
  });

  it("an empty list reports zeros", () => {
    const r = layoutReportOf([], 0);
    expect(r.rowsWithLayout).toBe(0);
    expect(r.eyeSample).toEqual([]);
    expect(r.agreement.n).toBe(0);
  });
});
