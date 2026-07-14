/**
 * BRF årsredovisning extraction eval harness (AI-SPEC §5).
 *
 * COST-GATED — incurs live Anthropic spend. The whole live body is behind
 * `RUN_LLM_EVALS=1` AND a present `ANTHROPIC_API_KEY`; without BOTH the suite is
 * a single skipped placeholder (no network, no spend) so `npm run test` and CI
 * stay free. Invoked by `npm run eval` (`RUN_LLM_EVALS=1 vitest run
 * evals/extractor.eval.ts`).
 *
 * What it checks (the cross-phase regression gate for `brf-extract/v2`, Plan
 * 04-02 Task 3):
 *  - the FOUR original metrics (skuldPerKvm, avgiftsniva, kassaflode,
 *    underhallsplanStatus) still match the expert labels — NO regression;
 *  - the THREE new D-02 soft signals (stambytePlanerat, storreRenoveringar,
 *    ovrigaAnmarkningar) extract as labelled AND every non-null soft signal
 *    carries a supporting verbatim citation (sourceQuote + pageRef) — the
 *    T-04-05 "no invented stambyte/renovation/anmärkning" mitigation.
 *
 * Inputs (all gitignored — PII per GDPR, see .gitignore + evals/labels.example.json):
 *  - evals/fixtures/*.pdf — the frozen 4–6 PDF reference subset.
 *  - evals/labels.json    — expert labels keyed by the SHA-256 content hash of
 *                            each fixture PDF (same hash as analyze-brf.ts
 *                            hashBytes). Shape: evals/labels.example.json.
 *
 * It exercises the REAL shipping extraction path (`extractBrfFinancials`), which
 * reads `BRF_EXTRACTION_SYSTEM_PROMPT` — i.e. it tests exactly the
 * `brf-extract/v2` prompt that ships, not a copy.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { extractBrfFinancials } from "@/lib/brf/extract";
import { BRF_EXTRACTION_PROMPT_VERSION } from "@/lib/brf/prompt";

/** Live eval runs only with the explicit opt-in AND a key present (no spend otherwise). */
const RUN_LIVE = process.env.RUN_LLM_EVALS === "1" && !!process.env.ANTHROPIC_API_KEY;

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");
const LABELS_PATH = path.resolve(__dirname, "labels.json");

/** Mirrors analyze-brf.ts hashBytes — labels are keyed by this SHA-256 hex. */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One expert-labelled fixture (the shape in evals/labels.example.json). */
interface Label {
  skuldPerKvm: number | null;
  avgiftsniva: number | null;
  kassaflode: number | null;
  underhallsplanStatus: string;
  // D-02 soft-signal labels (brf-extract/v2).
  expectedStambyte: "planerat" | "nyligen_genomfort" | "ej_nämnt";
  expectedStorreRenovering: boolean;
  expectedAnmarkning: boolean;
  expectedOsaker: boolean;
  sourcePage?: number;
}

/** A fixture paired with its label, resolved by content hash. */
interface Case {
  file: string;
  hash: string;
  bytes: Uint8Array;
  label: Label;
}

/**
 * Numeric labels are matched with a small relative tolerance — the extractor may
 * round/derive a figure (e.g. skuld ÷ yta) so an exact-equality gate would be
 * brittle. A null label must extract null (and vice versa).
 */
function numberMatches(expected: number | null, actual: number | null): boolean {
  if (expected === null) return actual === null;
  if (actual === null) return false;
  const tol = Math.max(1, Math.abs(expected) * 0.02); // 2% or 1 unit, whichever larger
  return Math.abs(actual - expected) <= tol;
}

// Resolved at beforeAll so the no-fixtures / no-labels case reports cleanly
// instead of throwing at import time.
const cases: Case[] = [];
let setupNote = "";

describe("BRF extraction eval (brf-extract/v2 regression gate, D-02)", () => {
  if (!RUN_LIVE) {
    it.skip("skipped — set RUN_LLM_EVALS=1 with a live ANTHROPIC_API_KEY to run (incurs spend)", () => {
      // intentionally empty — no network, no spend in CI / `npm run test`.
    });
    return;
  }

  beforeAll(() => {
    if (!existsSync(FIXTURES_DIR) || !existsSync(LABELS_PATH)) {
      setupNote =
        `Missing eval inputs: expected ${FIXTURES_DIR}/*.pdf and ${LABELS_PATH} ` +
        `(both gitignored — see evals/labels.example.json for the label shape).`;
      return;
    }
    const labels = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as Record<
      string,
      Label
    >;
    const pdfs = readdirSync(FIXTURES_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
    for (const file of pdfs) {
      const bytes = new Uint8Array(readFileSync(path.join(FIXTURES_DIR, file)));
      const hash = hashBytes(bytes);
      const label = labels[hash];
      if (!label) {
        setupNote +=
          `\nFixture ${file} (hash ${hash.slice(0, 12)}…) has no label entry in labels.json. ` +
          `Add it (key by the full SHA-256) before this gate can pass.`;
        continue;
      }
      cases.push({ file, hash, bytes, label });
    }
  });

  it("has at least one labelled fixture wired (4–6 expected per AI-SPEC §5)", () => {
    expect(setupNote, setupNote || "ok").toBe("");
    expect(cases.length).toBeGreaterThan(0);
  });

  it("pins the eval to the shipping prompt version", () => {
    // Documents which prompt revision this regression run attributes to.
    expect(BRF_EXTRACTION_PROMPT_VERSION).toContain("brf-extract/v2");
  });

  describe("per-fixture extraction vs expert labels", () => {
    it("extracts every labelled fixture without throwing the four metrics + three soft signals", async () => {
      // One pass over the fixtures; per-fixture assertions collected so a single
      // bad fixture reports its own filename rather than masking the rest.
      for (const c of cases) {
        const { parsed } = await extractBrfFinancials({
          kind: "pdf",
          bytes: c.bytes,
          contentHash: c.hash,
        });

        // (a) NO regression on the four original metrics.
        expect(
          numberMatches(c.label.skuldPerKvm, parsed.skuldPerKvm.value),
          `${c.file}: skuldPerKvm ${parsed.skuldPerKvm.value} vs label ${c.label.skuldPerKvm}`,
        ).toBe(true);
        expect(
          numberMatches(c.label.avgiftsniva, parsed.avgiftsniva.value),
          `${c.file}: avgiftsniva ${parsed.avgiftsniva.value} vs label ${c.label.avgiftsniva}`,
        ).toBe(true);
        expect(
          numberMatches(c.label.kassaflode, parsed.kassaflode.value),
          `${c.file}: kassaflode ${parsed.kassaflode.value} vs label ${c.label.kassaflode}`,
        ).toBe(true);
        expect(
          parsed.underhallsplanStatus.value,
          `${c.file}: underhallsplanStatus`,
        ).toBe(c.label.underhallsplanStatus);

        // (b) D-02 soft signals extract as labelled.
        expect(
          parsed.stambytePlanerat.value,
          `${c.file}: stambytePlanerat`,
        ).toBe(c.label.expectedStambyte);

        // storreRenoveringar / ovrigaAnmarkningar: presence matches the label.
        const hasRenov = parsed.storreRenoveringar.value !== null;
        expect(
          hasRenov,
          `${c.file}: storreRenoveringar present=${hasRenov}, expected ${c.label.expectedStorreRenovering}`,
        ).toBe(c.label.expectedStorreRenovering);
        const hasAnmark = parsed.ovrigaAnmarkningar.value !== null;
        expect(
          hasAnmark,
          `${c.file}: ovrigaAnmarkningar present=${hasAnmark}, expected ${c.label.expectedAnmarkning}`,
        ).toBe(c.label.expectedAnmarkning);

        // (b cont.) T-04-05: every NON-NULL soft signal must carry a supporting
        // verbatim citation. A surfaced stambyte/renovation/anmärkning without a
        // sourceQuote + pageRef is an invented signal — fail the gate.
        for (const [name, field] of [
          ["stambytePlanerat", parsed.stambytePlanerat],
          ["storreRenoveringar", parsed.storreRenoveringar],
          ["ovrigaAnmarkningar", parsed.ovrigaAnmarkningar],
        ] as const) {
          // "ej_nämnt" is the explicit not-present stambyte value — no citation required.
          const isPresentSignal =
            field.value !== null &&
            !(name === "stambytePlanerat" && field.value === "ej_nämnt");
          if (isPresentSignal) {
            expect(
              field.sourceQuote != null && field.sourceQuote.length > 0,
              `${c.file}: ${name} surfaced without a sourceQuote (T-04-05 invented-signal guard)`,
            ).toBe(true);
            expect(
              field.pageRef != null,
              `${c.file}: ${name} surfaced without a pageRef (T-04-05 invented-signal guard)`,
            ).toBe(true);
          }
        }
      }
    }, 120_000); // live multi-PDF extraction — generous timeout.
  });
});
