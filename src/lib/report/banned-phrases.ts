import type { AiReport } from "@/lib/schemas/report";

/**
 * banned-phrases.ts — shared, reviewable source for the MACRO-02 tertiary
 * no-prediction enforcement layer (07-RESEARCH.md § Wave 0 Gap).
 *
 * Co-locating the banned phrase list here — rather than duplicating it
 * inline inside the prompt's ABSOLUT REGEL 5 wording and inside
 * banned-predictive-phrases.test.ts separately — means the rule and its
 * regression test stay reviewable together: a change to what counts as
 * "predictive" is a one-file diff, not a silent drift between two places.
 *
 * `MACRO_CARD_LABELS` is ALSO exported from here (not from
 * macro-context-card.tsx, Plan 03) so this is the single source of truth
 * both this test AND the Plan 03 card render from — the card can never
 * silently introduce a banned phrase in a label the test doesn't see.
 */

/**
 * Lowercase Swedish (+ English equivalents for any hardcoded UI strings)
 * predictive / timing / buy-sell phrases. Every entry MUST be lowercase —
 * both call sites lowercase their haystack before scanning.
 */
// NOTE: bare words like "prognos"/"forecast" are DELIBERATELY excluded even
// though they are predictive-adjacent, because ABSOLUT REGEL 5's own
// disclaimer text ("aldrig en signal, prognos eller rekommendation") and the
// macro card's own "ingen prognos eller rekommendation" subtitle both
// legitimately use the word to NEGATE prediction — banning the bare word
// would make the disclaimer itself untestable. The concrete directional/
// timing/buy-sell PHRASES below are unambiguous in either polarity, so they
// carry the enforcement weight instead.
export const BANNED_PREDICTIVE_PHRASES: readonly string[] = [
  // Swedish — direction/timing framing
  "kommer att",
  "kommer sjunka",
  "kommer stiga",
  "förväntas stiga",
  "förväntas sjunka",
  "väntas stiga",
  "väntas sjunka",
  "priserna kommer",
  // Swedish — buy/sell framing
  "bra läge att köpa",
  "bra läge att sälja",
  // English equivalents (for any hardcoded UI strings)
  "will rise",
  "will fall",
  "expected to rise",
  "expected to fall",
  "good time to buy",
  "good time to sell",
] as const;

/**
 * BL-2 (PR #1 review): the runtime tertiary no-prediction gate. Until this
 * shipped, `BANNED_PREDICTIVE_PHRASES` was referenced ONLY by its regression
 * test — the "tertiary enforcement layer" the module docs promise did not exist
 * in the running system, so a Sonnet response containing e.g. "priserna kommer
 * stiga" satisfied the schema and was persisted + rendered. `synthesizeReport`
 * now calls this on the parsed report and treats a hit as a guardrail trip
 * (no persist), same as a model refusal.
 *
 * Scans the synthesized narration (leadSynthesis + every themed-section claim
 * text) — the only free-text the model authors — lowercased, against the shared
 * list. Returns true if any banned phrase is present.
 */
export function containsBannedPredictivePhrase(report: AiReport): boolean {
  const haystack = [
    report.leadSynthesis,
    ...report.ekonomi.claims.map((c) => c.text),
    ...report.pris.claims.map((c) => c.text),
    ...report.omrade.claims.map((c) => c.text),
  ]
    .join("\n")
    .toLowerCase();
  return BANNED_PREDICTIVE_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * The macro-context-card's static Swedish labels (Plan 03 renders from this
 * SAME constant — single source of truth for the labels this regression test
 * guards, per the plan's key_links). Purely descriptive: no label here may
 * ever imply direction, magnitude, or a recommendation (MACRO-02).
 */
export const MACRO_CARD_LABELS = {
  title: "Makroekonomisk kontext",
  subtitle: "Aktuella nyckeltal — ingen prognos eller rekommendation",
  policyRate: "Styrränta",
  inflation: "Inflation (KPIF)",
  regionalPrice: "Regional prisutveckling",
  unavailable: "Ej tillgänglig",
  sourceFooterTemplate: "Källa: {source}{period}",
} as const;
