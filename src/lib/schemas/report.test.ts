import { describe, it, expect } from "vitest";
// RED (Wave 0): src/lib/schemas/report.ts is implemented in the GREEN step of
// this same task. These assertions pin the AI-SPEC §4b report contract and the
// CR-01 read-path guard before the production code exists.
import {
  reportSchema,
  reportDataSchema,
  safeParseReportData,
  type AiReport,
} from "@/lib/schemas/report";
import { computeFlags } from "@/lib/report/flags";

// A minimal, valid AiReport per AI-SPEC §4b (lines 374-407).
const validReport: AiReport = {
  leadSynthesis:
    "Priset ligger något över områdessnittet och föreningen är välkapitaliserad.",
  ekonomi: {
    status: "bedömd",
    claims: [
      {
        text: "Skuld per kvm är låg för åldern.",
        sourceRef: "brf.skuldPerKvm",
      },
    ],
  },
  pris: {
    status: "bedömd",
    claims: [
      { text: "Priset ligger 8 % över snittet.", sourceRef: "flag:price_above_area" },
    ],
  },
  omrade: {
    status: "ej_tillgänglig",
    claims: [],
  },
  prioritizedFlagIds: ["price_above_area", "brf_low_debt"],
};

describe("reportSchema — the report output contract (AI-SPEC §4b)", () => {
  it("accepts a valid AiReport with themed sections and prioritized flag ids", () => {
    const parsed = reportSchema.safeParse(validReport);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.leadSynthesis).toContain("Priset");
      expect(parsed.data.ekonomi.status).toBe("bedömd");
      expect(parsed.data.omrade.status).toBe("ej_tillgänglig");
      expect(parsed.data.prioritizedFlagIds).toEqual([
        "price_above_area",
        "brf_low_debt",
      ]);
    }
  });

  it("strips an unknown verdict/recommendation/betyg key — it is unrepresentable (D-04/FM2)", () => {
    const withVerdict = {
      ...validReport,
      verdict: "köp",
      recommendation: "lägg max 4 MSEK",
      betyg: "A",
    };
    const parsed = reportSchema.safeParse(withVerdict);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The inferred AiReport type has no such key — assert structurally that
      // they are absent from the parsed object (Zod strips unknown keys).
      expect("verdict" in parsed.data).toBe(false);
      expect("recommendation" in parsed.data).toBe(false);
      expect("betyg" in parsed.data).toBe(false);
      // Exactly the contract keys, nothing more.
      expect(Object.keys(parsed.data).sort()).toEqual(
        ["ekonomi", "leadSynthesis", "omrade", "pris", "prioritizedFlagIds"].sort(),
      );
    }
  });

  it("rejects a themedSection with a missing status key (every key present, never optional)", () => {
    const missingStatus = {
      ...validReport,
      ekonomi: { claims: [] }, // no status
    };
    const parsed = reportSchema.safeParse(missingStatus);
    expect(parsed.success).toBe(false);
  });
});

describe("safeParseReportData — CR-01 read-path guard", () => {
  // A valid persisted snapshot: the AiReport plus our own-code fields.
  const validSnapshot = {
    report: validReport,
    flags: [
      {
        id: "price_above_area",
        severity: "neutral",
        sourceRef: "price.deltaPct",
        sourceQuote: null,
        pageRef: null,
        confidence: null,
      },
    ],
    softSignals: null,
    dataFingerprint: "abc123",
    costSek: 0.3,
    model: "claude-sonnet-4-6",
    promptVersion: "report-synth/v1 (2026-06-23)",
  };

  it("returns null on null input", () => {
    expect(safeParseReportData(null)).toBeNull();
  });

  it("returns null on an empty object", () => {
    expect(safeParseReportData({})).toBeNull();
  });

  it("returns null on a drifted/malformed shape", () => {
    const drifted = { report: { leadSynthesis: 42 }, costSek: "free" };
    expect(safeParseReportData(drifted)).toBeNull();
  });

  it("returns the data on a valid persisted snapshot", () => {
    const result = safeParseReportData(validSnapshot);
    expect(result).not.toBeNull();
    expect(reportDataSchema.safeParse(validSnapshot).success).toBe(true);
    expect(result?.report.leadSynthesis).toContain("Priset");
  });

  // REGRESSION (04-UAT Test 1): a report generated with a numeric BRF/price flag
  // persisted with report_status='done' but read back as null — the numeric
  // flags produced by computeFlags OMIT sourceQuote/pageRef/confidence, JSONB
  // drops the undefined keys, and the read schema's `.nullable()` rejected the
  // absent keys. The page then showed the "Generera" trigger for a DONE report
  // (no error, no log). This exercises the REAL producer through a JSONB-shaped
  // round-trip so a `.nullable()`-vs-`.nullish()` regression fails here, not live.
  it("reads back a snapshot whose flags come from computeFlags (numeric flags omit optional keys)", () => {
    const flags = computeFlags({
      brf: { skuldPerKvm: 20000, avgiftsniva: 800, kassaflode: -5 },
      price: { reason: "ok", deltaPct: 12, sampleSize: 8 },
      softSignals: null,
    });
    expect(flags.length).toBeGreaterThan(0);
    // The offending flag really does lack the optional keys.
    expect("sourceQuote" in flags[0]).toBe(false);
    const snapshot = {
      ...validSnapshot,
      // Simulate Supabase JSONB serialization (drops undefined keys).
      flags: JSON.parse(JSON.stringify(flags)),
    };
    const result = safeParseReportData(snapshot);
    expect(result).not.toBeNull();
    expect(result?.flags[0].id).toBe(flags[0].id);
  });
});
