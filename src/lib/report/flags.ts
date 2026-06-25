import { BRF_SCORE_THRESHOLDS } from "@/lib/brf/score";
import { PRICE_COMPARISON_THRESHOLDS } from "@/lib/market/compare";
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";

/**
 * flags.ts — the DETERMINISTIC, LLM-free flag engine (D-01a, D-03).
 *
 * The trust core (mirrors `computeBrfGrade` in `src/lib/brf/score.ts` and
 * `computePriceComparison` in `src/lib/market/compare.ts`): a PURE function —
 * no clock read, no randomness, no network, no async. The same input
 * always yields the same flag set, so the flags are reproducible and listable
 * on the "Så flaggar vi" page (D-01 spirit).
 *
 * Threshold REUSE, never redefine (T-04-01): every numeric boundary comes from
 * `BRF_SCORE_THRESHOLDS` / `PRICE_COMPARISON_THRESHOLDS`, so a flag can never
 * disagree with the BRF score card or the price card. The only literal this
 * module owns is the price-flag presentation band (`PRICE_FLAG_BAND_PCT`) —
 * the ±% magnitude at which a *meaningful* price comparison becomes worth
 * surfacing as a flag (the comparison itself is computed in compare.ts).
 *
 * Partial-data rule: a null/absent source produces NO flag for it — never a
 * fabricated "missing = bad" flag (mirrors `computeBrfGrade`'s null handling
 * and Phase 3 D-08).
 *
 * Soft-signal split (D-03 hybrid): the `stambytePlanerat` ENUM maps to a
 * deterministic flag here; the free-text `storreRenoveringar`/
 * `ovrigaAnmarkningar` are NEVER minted into a boolean flag — they pass through
 * as narration context for Claude only. A low/null-confidence soft signal (or
 * one without a citation) must not feed a red flag (AI-SPEC §6 citation gate).
 */

/** Stable flag-id string constants. fact-sheet.ts and the UI reference these. */
export const FLAG_IDS = {
  BRF_HIGH_DEBT: "brf_high_debt",
  BRF_LOW_DEBT: "brf_low_debt",
  BRF_AVGIFT_HEALTHY: "brf_avgift_healthy",
  BRF_AVGIFT_LEAN: "brf_avgift_lean",
  BRF_AVGIFT_ELEVATED: "brf_avgift_elevated",
  BRF_KASSAFLODE_DEFICIT: "brf_kassaflode_deficit",
  BRF_KASSAFLODE_WEAK: "brf_kassaflode_weak",
  PRICE_ABOVE_AREA: "price_above_area",
  PRICE_BELOW_AREA: "price_below_area",
  STAMBYTE_PLANERAT: "stambyte_planerat",
  STAMBYTE_NYLIGEN: "stambyte_nyligen_genomfort",
} as const;

/**
 * The ±% band (vs area snitt) at which a price comparison is worth surfacing as
 * a flag. Below this magnitude the listing is "i linje med snittet" and no flag
 * is raised. This is a flag-presentation choice owned by this module — the
 * comparison math (deltaPct, sampleSize, reason) lives in compare.ts.
 */
export const PRICE_FLAG_BAND_PCT = 7;

/** Flag severity for the on-screen + PDF render (D-00 sage/terracotta mapping). */
export type FlagSeverity = "red" | "green" | "neutral";

/**
 * A single deterministic flag. Carries its citation so the on-screen flag and
 * the PDF flag read the same record (D-11). `sourceQuote`/`pageRef`/`confidence`
 * are populated for cited soft signals; numeric flags reference a `sourceRef`
 * data path only.
 */
export interface Flag {
  id: string;
  severity: FlagSeverity;
  sourceRef: string;
  sourceQuote?: string | null;
  pageRef?: number | null;
  confidence?: number | null;
}

/** The ordered set of deterministic flags for one analysis. */
export type FlagSet = Flag[];

/** The normalized BRF figures a flag is derived from (already safeParse'd). */
export interface FlagBrfInput {
  skuldPerKvm: number | null;
  avgiftsniva: number | null;
  kassaflode: number | null;
}

/** The price-comparison figures a flag is derived from (already safeParse'd). */
export interface FlagPriceInput {
  reason: "ok" | "thin" | "listing_pris_okand";
  deltaPct: number | null;
  sampleSize: number;
}

/** A single cited soft-signal figure (the `extractedField` shape). */
export interface SoftSignalField<T> {
  value: T | null;
  confidence: number | null;
  sourceQuote: string | null;
  pageRef: number | null;
}

/** The cited soft signals (D-02/D-03). Only the enum signal feeds a flag. */
export interface FlagSoftSignals {
  stambytePlanerat?: SoftSignalField<
    "planerat" | "nyligen_genomfort" | "ej_nämnt"
  > | null;
  // Free-text signals are carried for narration only — never a flag here.
  storreRenoveringar?: SoftSignalField<string> | null;
  ovrigaAnmarkningar?: SoftSignalField<string> | null;
}

/** The full deterministic flag input: the four sources, each nullable (D-07). */
export interface FlagInput {
  brf: FlagBrfInput | null;
  price: FlagPriceInput | null;
  softSignals: FlagSoftSignals | null;
}

/**
 * Whether a cited soft signal is trustworthy enough to back a red flag: it must
 * carry a verbatim citation AND a confidence at/above the OSAKER threshold
 * (AI-SPEC §6 citation gate). A low/null-confidence or uncited signal is NOT
 * dropped — it simply does not raise a deterministic flag (it can still be
 * narrated by Claude as context).
 */
function isCitationBacked<T>(signal: SoftSignalField<T>): boolean {
  return (
    typeof signal.sourceQuote === "string" &&
    signal.sourceQuote.length > 0 &&
    typeof signal.confidence === "number" &&
    signal.confidence >= OSAKER_THRESHOLD
  );
}

/**
 * Computes the deterministic flag set from already-structured, already-`safeParse`d
 * sources. PURE — no clock, no randomness, no network.
 *
 * @param input - the four nullable sources (brf, price, soft signals)
 * @returns the ordered, reproducible flag set
 */
export function computeFlags(input: FlagInput): FlagSet {
  const flags: FlagSet = [];
  const { brf, price, softSignals } = input;

  // --- BRF numeric flags (thresholds imported from BRF_SCORE_THRESHOLDS) ---
  if (brf) {
    const skuldT = BRF_SCORE_THRESHOLDS.skuldPerKvm;
    if (brf.skuldPerKvm !== null) {
      if (brf.skuldPerKvm > skuldT.weakMax) {
        flags.push({
          id: FLAG_IDS.BRF_HIGH_DEBT,
          severity: "red",
          sourceRef: "brf.skuldPerKvm",
        });
      } else if (brf.skuldPerKvm < skuldT.strongMax) {
        flags.push({
          id: FLAG_IDS.BRF_LOW_DEBT,
          severity: "green",
          sourceRef: "brf.skuldPerKvm",
        });
      }
    }

    const avgiftT = BRF_SCORE_THRESHOLDS.avgiftsniva;
    if (brf.avgiftsniva !== null) {
      if (
        brf.avgiftsniva >= avgiftT.healthyMin &&
        brf.avgiftsniva <= avgiftT.healthyMax
      ) {
        flags.push({
          id: FLAG_IDS.BRF_AVGIFT_HEALTHY,
          severity: "green",
          sourceRef: "brf.avgiftsniva",
        });
      } else if (brf.avgiftsniva < avgiftT.leanMin) {
        // A suspiciously low fee can hide deferred maintenance (AI-SPEC §1b).
        flags.push({
          id: FLAG_IDS.BRF_AVGIFT_LEAN,
          severity: "neutral",
          sourceRef: "brf.avgiftsniva",
        });
      } else if (brf.avgiftsniva > avgiftT.elevatedMax) {
        flags.push({
          id: FLAG_IDS.BRF_AVGIFT_ELEVATED,
          severity: "neutral",
          sourceRef: "brf.avgiftsniva",
        });
      }
    }

    const kassaT = BRF_SCORE_THRESHOLDS.kassaflode;
    if (brf.kassaflode !== null) {
      if (brf.kassaflode < 0) {
        flags.push({
          id: FLAG_IDS.BRF_KASSAFLODE_DEFICIT,
          severity: "red",
          sourceRef: "brf.kassaflode",
        });
      } else if (brf.kassaflode < kassaT.healthyMin) {
        // 0–warningMin and warningMin–healthyMin both read as a weak/warning
        // sparande (below the healthy ≥250 band).
        flags.push({
          id: FLAG_IDS.BRF_KASSAFLODE_WEAK,
          severity: brf.kassaflode < kassaT.warningMin ? "red" : "neutral",
          sourceRef: "brf.kassaflode",
        });
      }
    }
  }

  // --- Pricing flag (only a meaningful 'ok' comparison with a real sample) ---
  if (
    price &&
    price.reason === "ok" &&
    price.deltaPct !== null &&
    price.sampleSize > PRICE_COMPARISON_THRESHOLDS.thinMaxComps
  ) {
    if (price.deltaPct >= PRICE_FLAG_BAND_PCT) {
      flags.push({
        id: FLAG_IDS.PRICE_ABOVE_AREA,
        severity: "neutral",
        sourceRef: "price.deltaPct",
      });
    } else if (price.deltaPct <= -PRICE_FLAG_BAND_PCT) {
      flags.push({
        id: FLAG_IDS.PRICE_BELOW_AREA,
        severity: "neutral",
        sourceRef: "price.deltaPct",
      });
    }
  }

  // --- D-03 enum soft signal: stambytePlanerat (code-raised flag) ---
  const stambyte = softSignals?.stambytePlanerat ?? null;
  if (stambyte && stambyte.value !== null && stambyte.value !== "ej_nämnt") {
    // A red flag (planned stambyte) requires a citation-backed signal; a green
    // "recently done" signal is reassuring but still carries its citation.
    if (stambyte.value === "planerat" && isCitationBacked(stambyte)) {
      flags.push({
        id: FLAG_IDS.STAMBYTE_PLANERAT,
        severity: "red",
        sourceRef: "softSignals.stambytePlanerat",
        sourceQuote: stambyte.sourceQuote,
        pageRef: stambyte.pageRef,
        confidence: stambyte.confidence,
      });
    } else if (
      stambyte.value === "nyligen_genomfort" &&
      isCitationBacked(stambyte)
    ) {
      flags.push({
        id: FLAG_IDS.STAMBYTE_NYLIGEN,
        severity: "green",
        sourceRef: "softSignals.stambytePlanerat",
        sourceQuote: stambyte.sourceQuote,
        pageRef: stambyte.pageRef,
        confidence: stambyte.confidence,
      });
    }
  }

  // storreRenoveringar / ovrigaAnmarkningar are deliberately NOT flagged here —
  // they are free-text narration context only (D-03).

  return flags;
}
