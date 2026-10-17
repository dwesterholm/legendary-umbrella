// @vitest-environment node
import { describe, expect, it } from "vitest";
import truthJson from "@/lib/discovery/__fixtures__/layout-truth-3row.fixture.json";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import { layoutTruthFileSchema, rawFieldScores, truthRowSchema } from "@/lib/discovery/layout-accuracy";

/**
 * layout-accuracy.test.ts - the truth-file format and the scoring of stored layout reads against it
 * (Phase 14.5 plan 02). Pure: hand-made rows, no model, no network.
 */

const file = layoutTruthFileSchema.parse(truthJson);

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

/** Folkungagatan 61's stored 14.4 read: wrong on balcony and bedroom (courtyard, truth street), right on windows. */
const f61Read = fact({
  balconySide: "courtyard",
  windowSides: "one",
  bedroomSide: "courtyard",
  streetEvidence: "courtyardGreenery",
  confidence: 0.55,
});

const rowOf = (over: Record<string, unknown> = {}) => ({ ...file.rows[0], ...over });

describe("layoutTruthFileSchema", () => {
  it("parses the three-row fixture", () => {
    expect(file.rows).toHaveLength(3);
    expect(file.rows[0].booliId).toBe(150148);
    expect(file.lockedAt).toBeNull();
    expect(file.seed).toBe("14.5");
  });

  it("rejects a non-integer Booli id", () => {
    expect(truthRowSchema.safeParse(rowOf({ booliId: 150148.5 })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ booliId: "150148" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ booliId: 0 })).success).toBe(false);
  });

  it("rejects a note holding a URL, a host or a street name", () => {
    for (const note of [
      "se https://example.test/x",
      "se http://example.test",
      "se www.example.test",
      "Folkungagatan balkong mot gården",
      "ligger vid Sveavägen",
      "Mårten Trotzigs gränd",
      "Götgatan 61",
      "Stureplan torget",
    ]) {
      expect(truthRowSchema.safeParse(rowOf({ note })).success, note).toBe(false);
    }
  });

  it("accepts a note that says 'gatan' as an ordinary word", () => {
    expect(truthRowSchema.safeParse(rowOf({ note: "balkong mot gatan, bilar syns" })).success).toBe(true);
  });

  it("rejects an empty note and one longer than 160 characters", () => {
    expect(truthRowSchema.safeParse(rowOf({ note: "" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ note: "a".repeat(160) })).success).toBe(true);
    expect(truthRowSchema.safeParse(rowOf({ note: "a".repeat(161) })).success).toBe(false);
  });

  it("rejects an extra key such as an address or a URL field", () => {
    expect(truthRowSchema.safeParse(rowOf({ address: "Någon väg 1" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ url: "x" })).success).toBe(false);
  });

  it("rejects an empty evidence list and an unknown evidence word", () => {
    expect(truthRowSchema.safeParse(rowOf({ evidence: [] })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ evidence: ["unicorn"] })).success).toBe(false);
  });
});

describe("rawFieldScores", () => {
  it("scores Folkungagatan 61's stored read: wrong balcony and bedroom, right windows, two flats without a read", () => {
    const reads = new Map<number, LayoutFact>([[150148, f61Read]]);
    const s = rawFieldScores(file.rows, reads);
    expect(s.balcony).toEqual({ decided: 2, read: 1, correct: 0, undecidable: 0 });
    expect(s.korsdrag).toEqual({ decided: 3, read: 1, correct: 1, undecidable: 0 });
    expect(s.bedroom).toEqual({ decided: 2, read: 1, correct: 0, undecidable: 1 });
    expect(s.noRead).toBe(2);
  });

  it("maps korsdrag like korsdragWhen: twoOpposite is ja, one and corner are nej, unknown is no answer", () => {
    const truth = [
      rowOf({ booliId: 1, windowSides: "twoOpposite" }),
      rowOf({ booliId: 2, windowSides: "one" }),
      rowOf({ booliId: 3, windowSides: "corner" }),
      rowOf({ booliId: 4, windowSides: "twoOpposite" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact({ windowSides: "twoOpposite" })], // ja, truth ja: right
      [2, fact({ windowSides: "corner" })], // nej, truth nej: right
      [3, fact({ windowSides: "twoOpposite" })], // ja, truth nej: wrong
      [4, fact({ windowSides: "unknown" })], // no answer
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.korsdrag).toEqual({ decided: 4, read: 3, correct: 2, undecidable: 0 });
  });

  it("leaves an undecidable truth row out of the denominator and counts it apart", () => {
    const truth = [
      rowOf({ booliId: 1, balconySide: "street", windowSides: "undecidable", bedroomSide: "undecidable" }),
      rowOf({ booliId: 2, balconySide: "undecidable", windowSides: "one", bedroomSide: "street" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact()],
      [2, fact()],
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
    expect(s.korsdrag).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
    expect(s.bedroom).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
  });

  it("does not count a truth 'none' balcony in the balcony score, and treats a 'none' or 'unknown' read as no answer", () => {
    const truth = [
      rowOf({ booliId: 1, balconySide: "none" }),
      rowOf({ booliId: 2, balconySide: "courtyard" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact({ balconySide: "street" })],
      [2, fact({ balconySide: "unknown" })],
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony).toEqual({ decided: 1, read: 0, correct: 0, undecidable: 0 });
  });

  it("scores only rows that are in the set", () => {
    const truth = [rowOf({ booliId: 1, inSet: false }), rowOf({ booliId: 2 })].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([[1, fact()]]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony.decided).toBe(1);
    expect(s.balcony.read).toBe(0);
    expect(s.noRead).toBe(1);
  });
});
