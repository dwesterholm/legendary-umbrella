import { describe, it, expect } from "vitest";
import {
  BANNED_PREDICTIVE_PHRASES,
  MACRO_CARD_LABELS,
  containsBannedPredictivePhrase,
} from "@/lib/report/banned-phrases";
import { REPORT_SYNTHESIS_SYSTEM_PROMPT } from "@/lib/report/prompt";
import type { AiReport } from "@/lib/schemas/report";

/**
 * banned-predictive-phrases.test.ts — the tertiary MACRO-02 enforcement
 * layer (07-RESEARCH.md § Don't Hand-Roll): a deterministic regex/`.includes`
 * scan, NOT an LLM judge, so it is CI-friendly and never flaky. This is the
 * THIRD independent no-prediction layer alongside the schema shape
 * (macro-schema.ts — no direction/trend/magnitude field) and the prompt's
 * ABSOLUT REGEL 5 (this scan proves the rule text + the card labels don't
 * themselves slip a banned phrase into the model's or the UI's own words).
 */

/**
 * Scans a lowercased string for any banned phrase. Exported implicitly via
 * its use below — kept local since it's a one-line deterministic helper, not
 * part of the shared banned-phrases module's public surface.
 */
function containsBannedPhrase(haystackLower: string): boolean {
  return BANNED_PREDICTIVE_PHRASES.some((phrase) =>
    haystackLower.includes(phrase),
  );
}

/**
 * Strips the deliberately-quoted "EXEMPEL PÅ EN DÅLIG LEAD-SYNTES (förbjuden)"
 * block from the prompt before scanning. That block INTENTIONALLY demonstrates
 * bad phrasing as a negative example for the model — scanning it would be a
 * false positive against the instructive (real-rule) text we actually care
 * about here. The block runs from its own heading to the end of the prompt
 * (it is the final paragraph in REPORT_SYNTHESIS_SYSTEM_PROMPT).
 */
function stripForbiddenExampleBlock(prompt: string): string {
  const marker = "EXEMPEL PÅ EN DÅLIG LEAD-SYNTES";
  const idx = prompt.indexOf(marker);
  return idx === -1 ? prompt : prompt.slice(0, idx);
}

describe("banned predictive phrases — tertiary MACRO-02 enforcement (deterministic scan)", () => {
  it("REPORT_SYNTHESIS_SYSTEM_PROMPT's instructive text contains no banned phrase (excluding the deliberate förbjudet example)", () => {
    const instructive = stripForbiddenExampleBlock(
      REPORT_SYNTHESIS_SYSTEM_PROMPT,
    ).toLowerCase();
    for (const phrase of BANNED_PREDICTIVE_PHRASES) {
      expect(instructive.includes(phrase)).toBe(false);
    }
  });

  it("MACRO_CARD_LABELS contain no banned phrase", () => {
    for (const label of Object.values(MACRO_CARD_LABELS)) {
      const lower = label.toLowerCase();
      for (const phrase of BANNED_PREDICTIVE_PHRASES) {
        expect(lower.includes(phrase)).toBe(false);
      }
    }
  });

  it("gate-bites proof: a synthetic banned string IS caught by the scan (the check is not a no-op)", () => {
    const synthetic =
      "Styrräntan kommer att sjunka nästa år, så det är ett bra läge att köpa nu.";
    expect(containsBannedPhrase(synthetic.toLowerCase())).toBe(true);
  });

  it("gate-bites proof: adding a banned phrase to the prompt's REAL instructions would fail this scan", () => {
    // Simulates what would happen if someone added a banned phrase to the
    // instructive (non-example) part of the prompt — proves the exclusion
    // boundary doesn't accidentally swallow the whole prompt.
    const tampered =
      stripForbiddenExampleBlock(REPORT_SYNTHESIS_SYSTEM_PROMPT) +
      " Priserna kommer att stiga nästa kvartal.";
    expect(containsBannedPhrase(tampered.toLowerCase())).toBe(true);
  });
});

describe("containsBannedPredictivePhrase — runtime report gate (BL-2)", () => {
  const clean: AiReport = {
    leadSynthesis: "Föreningens ekonomi är stabil och priset ligger nära områdessnittet.",
    ekonomi: { status: "bedömd", claims: [{ text: "Låg skuld per kvm.", sourceRef: "brf.skuldPerKvm" }] },
    pris: { status: "bedömd", claims: [{ text: "Pris/kvm i linje med området.", sourceRef: "flag:price_in_line" }] },
    omrade: { status: "ej_tillgänglig", claims: [] },
    prioritizedFlagIds: [],
  };

  it("passes a clean, descriptive report", () => {
    expect(containsBannedPredictivePhrase(clean)).toBe(false);
  });

  it("catches a banned phrase in leadSynthesis", () => {
    const report: AiReport = {
      ...clean,
      leadSynthesis: "Sammantaget är det ett bra läge att köpa nu.",
    };
    expect(containsBannedPredictivePhrase(report)).toBe(true);
  });

  it("catches a banned phrase inside a themed-section claim (not just the lead)", () => {
    const report: AiReport = {
      ...clean,
      pris: {
        status: "bedömd",
        claims: [{ text: "Priserna kommer stiga kraftigt nästa år.", sourceRef: "macro.regionalPrice" }],
      },
    };
    expect(containsBannedPredictivePhrase(report)).toBe(true);
  });

  it("is case-insensitive", () => {
    const report: AiReport = { ...clean, leadSynthesis: "PRISERNA KOMMER STIGA." };
    expect(containsBannedPredictivePhrase(report)).toBe(true);
  });
});
