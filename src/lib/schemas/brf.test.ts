import { describe, it, expect } from "vitest";
// RED: implemented in Plan 03 (src/lib/schemas/brf.ts).
import {
  brfExtractionSchema,
  normalizeBrfExtraction,
  type NormalizedBrf,
} from "@/lib/schemas/brf";
import { computeBrfGrade } from "@/lib/brf/score";

// A well-formed extraction: 4 fields, each {value, confidence, sourceQuote, pageRef}.
// Numbers + confidence + source ONLY — no grade/score field (D-08).
const wellFormed = {
  skuldPerKvm: {
    value: 4000,
    confidence: 0.9,
    sourceQuote: "Skuldsättning per kvm: 4 000 kr/m²",
    pageRef: 7,
  },
  avgiftsniva: {
    value: 600,
    confidence: 0.85,
    sourceQuote: "Årsavgift 600 kr/m²/år",
    pageRef: 7,
  },
  kassaflode: {
    value: 350,
    confidence: 0.7,
    sourceQuote: "Kassaflöde från löpande verksamhet",
    pageRef: 12,
  },
  underhallsplanStatus: {
    value: "finns_aktuell",
    confidence: 0.8,
    sourceQuote: "Underhållsplan upprättad och aktuell",
    pageRef: 4,
  },
};

describe("brfExtractionSchema — well-formed parse", () => {
  it("parses a well-formed extraction object without throwing", () => {
    const parsed = brfExtractionSchema.parse(wellFormed);
    expect(parsed.skuldPerKvm.value).toBe(4000);
    expect(parsed.skuldPerKvm.sourceQuote).toContain("4 000");
    expect(parsed.skuldPerKvm.pageRef).toBe(7);
  });

  it("accepts a null value with its citation (figure absent from PDF)", () => {
    const withNull = {
      ...wellFormed,
      kassaflode: { value: null, confidence: 0.2, sourceQuote: null, pageRef: null },
    };
    expect(() => brfExtractionSchema.parse(withNull)).not.toThrow();
  });
});

describe("brfExtractionSchema — FM2 invariant: extraction never grades (D-08)", () => {
  it("contains NO grade/score/rating/betyg key anywhere in the schema shape", () => {
    // Parse a representative object and walk every key in the result — the
    // extraction output must carry numbers + provenance only, never a judgement.
    const parsed = brfExtractionSchema.parse(wellFormed) as Record<string, unknown>;
    const forbidden = /grade|score|rating|betyg/i;

    const walk = (obj: unknown): void => {
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const key of Object.keys(obj as Record<string, unknown>)) {
          expect(forbidden.test(key)).toBe(false);
          walk((obj as Record<string, unknown>)[key]);
        }
      }
    };
    walk(parsed);
  });
});

describe("normalizeBrfExtraction — contract feeds the scorer (D-08)", () => {
  it("returns a NormalizedBrf the deterministic scorer can consume without throwing", () => {
    const parsed = brfExtractionSchema.parse(wellFormed);
    const normalized: NormalizedBrf = normalizeBrfExtraction(parsed);
    // The whole point of the contract: scorer accepts the normalized shape.
    expect(() => computeBrfGrade(normalized)).not.toThrow();
  });

  it("flattens each extracted field down to its primitive value", () => {
    const parsed = brfExtractionSchema.parse(wellFormed);
    const normalized = normalizeBrfExtraction(parsed);
    expect(normalized.skuldPerKvm).toBe(4000);
    expect(normalized.avgiftsniva).toBe(600);
    expect(normalized.underhallsplanStatus).toBe("finns_aktuell");
  });

  it("propagates a null extracted value through as null (null-tolerant, mirrors listing.ts)", () => {
    const withNull = brfExtractionSchema.parse({
      ...wellFormed,
      skuldPerKvm: { value: null, confidence: 0.1, sourceQuote: null, pageRef: null },
    });
    const normalized = normalizeBrfExtraction(withNull);
    expect(normalized.skuldPerKvm).toBeNull();
  });
});
