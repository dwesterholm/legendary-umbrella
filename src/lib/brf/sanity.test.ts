import { describe, it, expect } from "vitest";
// RED: implemented in Plan 03 (src/lib/brf/sanity.ts).
import {
  applySanityChecks,
  applyManualConfidence,
  MANUAL_CONFIDENCE,
  BRF_SANITY_BANDS,
} from "@/lib/brf/sanity";

// applySanityChecks takes a per-field extraction (value + model confidence) and
// downgrades confidence when a value falls outside its plausible band (D-10).
// It NEVER drops the value — the field stays editable for the user (D-12).

// The "Osäker — kontrollera själv" threshold: confidence below this is flagged
// uncertain in the UI. We assert downgraded values land strictly below it.
const OSAKER_THRESHOLD = 0.5;

describe("applySanityChecks — out-of-band confidence downgrade (D-10)", () => {
  it("forces an out-of-band skuldPerKvm below the Osäker threshold regardless of model confidence", () => {
    // 50000 SEK/m² is far outside the ~2,000–15,000 Stockholm band.
    const result = applySanityChecks({
      skuldPerKvm: { value: 50000, confidence: 0.99 },
    });
    expect(result.skuldPerKvm.confidence).toBeLessThan(OSAKER_THRESHOLD);
  });

  it("downgrades an out-of-band avgiftsniva (outside ~300–1200 SEK/m²/år)", () => {
    const result = applySanityChecks({
      avgiftsniva: { value: 3000, confidence: 0.95 },
    });
    expect(result.avgiftsniva.confidence).toBeLessThan(OSAKER_THRESHOLD);
  });
});

describe("applySanityChecks — in-band values are left unchanged", () => {
  it("leaves an in-band high-confidence skuldPerKvm untouched", () => {
    const result = applySanityChecks({
      skuldPerKvm: { value: 4000, confidence: 0.9 },
    });
    expect(result.skuldPerKvm.confidence).toBe(0.9);
  });

  it("leaves an in-band high-confidence avgiftsniva untouched", () => {
    const result = applySanityChecks({
      avgiftsniva: { value: 600, confidence: 0.88 },
    });
    expect(result.avgiftsniva.confidence).toBe(0.88);
  });
});

describe("applySanityChecks — value is never dropped (D-12 keeps it editable)", () => {
  it("preserves the out-of-band value, only downgrading its confidence", () => {
    const result = applySanityChecks({
      skuldPerKvm: { value: 50000, confidence: 0.99 },
    });
    // The number the user can verify/correct must survive untouched.
    expect(result.skuldPerKvm.value).toBe(50000);
  });
});

describe("applyManualConfidence — manual edits stay authoritative (WR-02, D-12)", () => {
  it("keeps a manually-corrected field at full confidence even when the sanity band downgraded it", () => {
    // A user deliberately enters skuldPerKvm = 18000 (above the 15000 band).
    // applySanityChecks would force it to the downgraded confidence...
    const sanitized = applySanityChecks({
      skuldPerKvm: { value: 18000, confidence: 1 },
    });
    expect(sanitized.skuldPerKvm.confidence).toBeLessThan(OSAKER_THRESHOLD);

    // ...but because the user typed it, manual confidence must win.
    const perField = applyManualConfidence(
      { skuldPerKvm: sanitized.skuldPerKvm.confidence },
      ["skuldPerKvm"],
    );
    expect(perField.skuldPerKvm).toBe(MANUAL_CONFIDENCE);
    expect(perField.skuldPerKvm).toBeGreaterThanOrEqual(OSAKER_THRESHOLD);
  });

  it("leaves non-manual fields' confidence untouched", () => {
    const perField = applyManualConfidence(
      { skuldPerKvm: 0.2, avgiftsniva: 0.9 },
      ["skuldPerKvm"],
    );
    expect(perField.skuldPerKvm).toBe(MANUAL_CONFIDENCE);
    expect(perField.avgiftsniva).toBe(0.9);
  });

  it("ignores manual field keys that are not present in the map", () => {
    const perField = applyManualConfidence({ kassaflode: 0.7 }, ["skuldPerKvm"]);
    expect(perField).toEqual({ kassaflode: 0.7 });
  });
});

describe("BRF_SANITY_BANDS — published bands", () => {
  it("exposes bands for the sanity-checked metrics", () => {
    expect(BRF_SANITY_BANDS).toBeDefined();
    expect(BRF_SANITY_BANDS).toHaveProperty("skuldPerKvm");
    expect(BRF_SANITY_BANDS).toHaveProperty("avgiftsniva");
  });
});
