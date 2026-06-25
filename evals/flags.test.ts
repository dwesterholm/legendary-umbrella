import { describe, it, expect } from "vitest";
// RED (Wave 0): src/lib/report/flags.ts is implemented in the GREEN step of
// this same task. These golden assertions pin the deterministic flag set
// (D-01a numeric + D-03 enum soft signal) before the production code exists.
import {
  computeFlags,
  FLAG_IDS,
  type Flag,
  type FlagInput,
} from "@/lib/report/flags";

// A fully-null input: no source produces any flag (never "missing = bad").
const emptyInput: FlagInput = {
  brf: null,
  price: null,
  softSignals: null,
};

/** Convenience: pull the flag ids out of a flag set. */
const idsOf = (flags: Flag[]): string[] => flags.map((f) => f.id);
/** Convenience: find a flag by id. */
const byId = (flags: Flag[], id: string): Flag | undefined =>
  flags.find((f) => f.id === id);

describe("computeFlags — null/absent sources (partial-data rule)", () => {
  it("produces zero flags when every source is null", () => {
    expect(computeFlags(emptyInput)).toEqual([]);
  });

  it("produces no brf or price flag when those sources are null", () => {
    const flags = computeFlags({ ...emptyInput, softSignals: null });
    expect(flags.filter((f) => f.id.startsWith("brf_"))).toHaveLength(0);
    expect(flags.filter((f) => f.id.startsWith("price_"))).toHaveLength(0);
  });
});

describe("computeFlags — skuldPerKvm (BRF_SCORE_THRESHOLDS.weakMax=12000)", () => {
  it("flags red high debt above weakMax (13000 > 12000)", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: 13000, avgiftsniva: null, kassaflode: null },
    });
    const flag = byId(flags, FLAG_IDS.BRF_HIGH_DEBT);
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("red");
  });

  it("flags green low debt below strongMax (4000)", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: 4000, avgiftsniva: null, kassaflode: null },
    });
    const flag = byId(flags, FLAG_IDS.BRF_LOW_DEBT);
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("green");
  });

  it("produces no debt flag when skuldPerKvm is null", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: null, kassaflode: null },
    });
    expect(byId(flags, FLAG_IDS.BRF_HIGH_DEBT)).toBeUndefined();
    expect(byId(flags, FLAG_IDS.BRF_LOW_DEBT)).toBeUndefined();
  });
});

describe("computeFlags — avgiftsniva (healthy band 450–750)", () => {
  it("marks a healthy avgift inside 450–750 as green/neutral", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: 600, kassaflode: null },
    });
    const flag = byId(flags, FLAG_IDS.BRF_AVGIFT_HEALTHY);
    expect(flag).toBeDefined();
    expect(["green", "neutral"]).toContain(flag?.severity);
  });

  it("flags an avgift below leanMin (300 < 350)", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: 300, kassaflode: null },
    });
    expect(idsOf(flags).some((id) => id.startsWith("brf_avgift_"))).toBe(true);
    expect(byId(flags, FLAG_IDS.BRF_AVGIFT_HEALTHY)).toBeUndefined();
  });

  it("flags an avgift above elevatedMax (1000 > 950)", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: 1000, kassaflode: null },
    });
    expect(idsOf(flags).some((id) => id.startsWith("brf_avgift_"))).toBe(true);
  });

  it("produces no avgift flag when avgiftsniva is null", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: null, kassaflode: null },
    });
    expect(idsOf(flags).some((id) => id.startsWith("brf_avgift_"))).toBe(false);
  });
});

describe("computeFlags — kassaflode (warningMin=120)", () => {
  it("flags a red deficit when kassaflode < 0", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: null, kassaflode: -50 },
    });
    const flag = byId(flags, FLAG_IDS.BRF_KASSAFLODE_DEFICIT);
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("red");
  });

  it("flags a weak kassaflode in 120–250 (warning band, here 150)", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: null, kassaflode: 150 },
    });
    expect(byId(flags, FLAG_IDS.BRF_KASSAFLODE_WEAK)).toBeDefined();
  });

  it("produces no kassaflode flag when null", () => {
    const flags = computeFlags({
      ...emptyInput,
      brf: { skuldPerKvm: null, avgiftsniva: null, kassaflode: null },
    });
    expect(byId(flags, FLAG_IDS.BRF_KASSAFLODE_DEFICIT)).toBeUndefined();
    expect(byId(flags, FLAG_IDS.BRF_KASSAFLODE_WEAK)).toBeUndefined();
  });
});

describe("computeFlags — pricing (reason 'ok' AND sampleSize > thinMaxComps)", () => {
  it("flags price_above_area when reason ok, sample > 2, deltaPct above band", () => {
    const flags = computeFlags({
      ...emptyInput,
      price: { reason: "ok", deltaPct: 12, sampleSize: 5 },
    });
    expect(byId(flags, FLAG_IDS.PRICE_ABOVE_AREA)).toBeDefined();
  });

  it("flags price_below_area when deltaPct below the negative band", () => {
    const flags = computeFlags({
      ...emptyInput,
      price: { reason: "ok", deltaPct: -12, sampleSize: 5 },
    });
    expect(byId(flags, FLAG_IDS.PRICE_BELOW_AREA)).toBeDefined();
  });

  it("produces NO pricing flag when reason is 'thin'", () => {
    const flags = computeFlags({
      ...emptyInput,
      price: { reason: "thin", deltaPct: 12, sampleSize: 2 },
    });
    expect(idsOf(flags).some((id) => id.startsWith("price_"))).toBe(false);
  });

  it("produces NO pricing flag when reason is 'listing_pris_okand'", () => {
    const flags = computeFlags({
      ...emptyInput,
      price: { reason: "listing_pris_okand", deltaPct: null, sampleSize: 5 },
    });
    expect(idsOf(flags).some((id) => id.startsWith("price_"))).toBe(false);
  });

  it("produces NO pricing flag when sampleSize <= thinMaxComps (2) even if reason ok", () => {
    const flags = computeFlags({
      ...emptyInput,
      price: { reason: "ok", deltaPct: 12, sampleSize: 2 },
    });
    expect(idsOf(flags).some((id) => id.startsWith("price_"))).toBe(false);
  });
});

describe("computeFlags — D-03 enum soft signal (stambytePlanerat)", () => {
  it("raises a red stambyte_planerat flag carrying its citation/confidence", () => {
    const flags = computeFlags({
      ...emptyInput,
      softSignals: {
        stambytePlanerat: {
          value: "planerat",
          confidence: 0.8,
          sourceQuote: "Stambyte planeras till 2027 enligt underhållsplanen.",
          pageRef: 4,
        },
      },
    });
    const flag = byId(flags, FLAG_IDS.STAMBYTE_PLANERAT);
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("red");
    expect(flag?.sourceQuote).toContain("Stambyte");
    expect(flag?.pageRef).toBe(4);
    expect(flag?.confidence).toBe(0.8);
  });

  it("raises a green flag for a recently completed stambyte", () => {
    const flags = computeFlags({
      ...emptyInput,
      softSignals: {
        stambytePlanerat: {
          value: "nyligen_genomfort",
          confidence: 0.9,
          sourceQuote: "Stambyte genomfört 2023.",
          pageRef: 5,
        },
      },
    });
    const flag = byId(flags, FLAG_IDS.STAMBYTE_NYLIGEN);
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("green");
  });

  it("produces no stambyte flag for 'ej_nämnt' or null", () => {
    const ejNamnt = computeFlags({
      ...emptyInput,
      softSignals: {
        stambytePlanerat: {
          value: "ej_nämnt",
          confidence: 0.7,
          sourceQuote: null,
          pageRef: null,
        },
      },
    });
    expect(idsOf(ejNamnt).some((id) => id.startsWith("stambyte"))).toBe(false);

    const nullSignal = computeFlags({
      ...emptyInput,
      softSignals: { stambytePlanerat: null },
    });
    expect(idsOf(nullSignal).some((id) => id.startsWith("stambyte"))).toBe(false);
  });

  it("does NOT feed a red flag when soft-signal confidence is below OSAKER_THRESHOLD or sourceQuote is null", () => {
    const lowConf = computeFlags({
      ...emptyInput,
      softSignals: {
        stambytePlanerat: {
          value: "planerat",
          confidence: 0.3, // below OSAKER_THRESHOLD (0.5)
          sourceQuote: "vag formulering",
          pageRef: 2,
        },
      },
    });
    expect(byId(lowConf, FLAG_IDS.STAMBYTE_PLANERAT)).toBeUndefined();

    const noQuote = computeFlags({
      ...emptyInput,
      softSignals: {
        stambytePlanerat: {
          value: "planerat",
          confidence: 0.9,
          sourceQuote: null, // no citation → cannot back a red flag (AI-SPEC §6)
          pageRef: null,
        },
      },
    });
    expect(byId(noQuote, FLAG_IDS.STAMBYTE_PLANERAT)).toBeUndefined();
  });
});

describe("computeFlags — D-03 free-text soft signals are NEVER flags", () => {
  it("never mints a flag id from storreRenoveringar / ovrigaAnmarkningar", () => {
    const flags = computeFlags({
      ...emptyInput,
      softSignals: {
        storreRenoveringar: {
          value: "Tak omlagt 2022, fasad planerad 2026.",
          confidence: 0.9,
          sourceQuote: "Tak omlagt 2022.",
          pageRef: 3,
        },
        ovrigaAnmarkningar: {
          value: "Revisorn noterade en avvikelse.",
          confidence: 0.8,
          sourceQuote: "avvikelse",
          pageRef: 9,
        },
      },
    });
    const ids = idsOf(flags);
    expect(ids.some((id) => id.includes("renover"))).toBe(false);
    expect(ids.some((id) => id.includes("anmark"))).toBe(false);
    // No flag at all from free-text-only soft signals.
    expect(flags).toHaveLength(0);
  });
});

describe("computeFlags — purity / determinism", () => {
  it("is deterministic: same input → identical flag set across calls", () => {
    const input: FlagInput = {
      brf: { skuldPerKvm: 13000, avgiftsniva: 600, kassaflode: -10 },
      price: { reason: "ok", deltaPct: 12, sampleSize: 6 },
      softSignals: {
        stambytePlanerat: {
          value: "planerat",
          confidence: 0.8,
          sourceQuote: "Stambyte planeras.",
          pageRef: 4,
        },
      },
    };
    expect(computeFlags(input)).toEqual(computeFlags(input));
  });
});
