/**
 * layout-fact.ts - the stored layout fact and the deterministic gate that decides when it may be
 * believed (Phase 14.4, LAY-01, LAY-02, D-08, D-09).
 *
 * What it is: for one for-sale flat, what a slim picture read (layout-read.ts) said about the floor
 * plan and the photos: which side the balcony is on (street or courtyard), whether the living room,
 * kitchen and bedroom share that side, whether the windows sit on one side, on two opposite sides
 * (korsdrag, a through-draught) or in a corner, which side the bedroom is on, what in the PHOTOS
 * settled street versus courtyard, and one confidence. The record rides on the snapshot row
 * (`fit-score.ts`, `layout`), beside the sun fact and never inside the candidate.
 *
 * Why the gate lives here and not in the prompt: in 14.3 the model read a north arrow on 6 of 11
 * floor plans although the prompt warned that an arrow at the front door is not north, and all 6 were
 * the door arrow. A model that is told how to behave still behaves wrongly some of the time, so the
 * decision to believe a value is made by plain code that is tested at its boundary:
 *  - street or courtyard counts only when confidence >= {@link LAYOUT_MIN_CONFIDENCE} AND the photos
 *    gave evidence (`streetEvidence` is not "none"); a plan alone cannot tell street from courtyard;
 *  - korsdrag counts when confidence >= {@link LAYOUT_MIN_CONFIDENCE};
 *  - anything else reads as unknown, and unknown changes nothing downstream.
 *
 * Pure: no clock, no randomness, no network, no file or environment access.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it (the
 * "discovery/layout-" specifier in niche-score.test.ts enforces that).
 */
import { z } from "zod/v4";
import { FACADE_LETTER, formatSolCell, type SunFact } from "@/lib/discovery/sun-fact";

/** Below this confidence no value of the layout read counts (D-09). */
export const LAYOUT_MIN_CONFIDENCE = 0.6;

/**
 * Master switch for the INFLUENCE of the layout read on the score and on the table and mail cells.
 *
 * Decision (Daniel, 2026-10-17, UAT 14.4 items 4-5): the layout read misreads flats (Folkungagatan 61 read
 * as courtyard, 2 of 3 "korsdrag ja" wrong by eye), so it stays off until a hand-judged truth set shows the
 * read is at least 75 % reliable (Phase 14.5). While false, {@link usableSide}, {@link korsdragOf} and
 * {@link quietBedroomOf} return null (unknown) and {@link usablyNoBalcony} returns false, so the sun facade,
 * the taste term, the Korsdrag/Sovrum/Sol cells and the mail all behave as if no layout existed. The read
 * itself keeps running and caching, and the coverage line still counts what it found (via the `*When`
 * variants with `enabled` true), so the fix can be measured.
 *
 * Phase 14.5 (2026-10-24): stays false. Five read variants (a Sonnet today, b Sonnet with evidence rules, c Opus,
 * d two steps on Sonnet, e Jev) were measured on the 60 locked flats (82,04 kr). The rule is one variant passing
 * all three fields at 75 % on holdout and pooled, with at least 12 decided truth rows per field. Balcony side
 * passes in c (holdout 6 of 6, pooled 13 of 13, gate 0,40), d and e. Korsdrag passes in none: the truth set holds
 * 4 flats with windows on two opposite sides (3 dev, 1 holdout) and no gate gives the 5 believed "ja" on dev that
 * the rule needs (Opus came closest, 3 of 4 at 0,20). Bedroom side is not measurable: 9 decided rows, 12 needed.
 * The bar was not lowered. The weekly job keeps reading and caching as the measurement (D-11). Numbers and the two
 * options for korsdrag: .planning/phases/14.5-enrichment-layout-accuracy-ceiling/evidence/layout-switch.md.
 */
export const LAYOUT_INFLUENCE_ENABLED = false;

export const BALCONY_SIDES = ["street", "courtyard", "none", "unknown"] as const;
export const WINDOW_SIDES = ["one", "twoOpposite", "corner", "unknown"] as const;
export const BEDROOM_SIDES = ["street", "courtyard", "unknown"] as const;
export const STREET_EVIDENCE = ["cars", "oppositeFacade", "courtyardGreenery", "none"] as const;

/**
 * The stored record: the eight fields of the read (D-08), where it came from, which version of the
 * read produced it and how many pictures it saw. `confidence` is bounded here because this is our own
 * stored record; the API schema in layout-read.ts has no numeric constraint (strict output rejects it).
 */
export const layoutFactSchema = z.object({
  balconySide: z.enum(BALCONY_SIDES),
  livingOnBalconySide: z.boolean(),
  kitchenOnBalconySide: z.boolean(),
  bedroomOnBalconySide: z.boolean(),
  windowSides: z.enum(WINDOW_SIDES),
  bedroomSide: z.enum(BEDROOM_SIDES),
  streetEvidence: z.enum(STREET_EVIDENCE),
  confidence: z.number().min(0).max(1),
  /**
   * Phase 14.5 (optional, so every stored 14.4 fact and every old snapshot still parses; fit-score reads the
   * stored layout with `.catch(null)`, so a REQUIRED key would silently null every stored layout): one
   * confidence per field when a read gives them, and whether a floor plan was among the pictures.
   * {@link believedLayout} uses `fieldConfidence.<field> ?? confidence` and abstains on `planPresent === false`.
   */
  fieldConfidence: z.object({ balcony: z.number().min(0).max(1), windows: z.number().min(0).max(1), bedroom: z.number().min(0).max(1) }).optional(),
  planPresent: z.boolean().optional(),
  /** A display label only ("planritning+foto" in the Sol cell); not one of the SUN_SOURCES. */
  source: z.literal("planritning+foto"),
  version: z.string(),
  images: z.object({ booli: z.number().int().min(0), broker: z.number().int().min(0) }),
});

export type LayoutFact = z.infer<typeof layoutFactSchema>;

const confident = (fact: LayoutFact): boolean => fact.confidence >= LAYOUT_MIN_CONFIDENCE;

/**
 * The side the balcony or the bedroom is on, or null when the read cannot be believed: no fact, a
 * confidence below {@link LAYOUT_MIN_CONFIDENCE}, no photo evidence for street versus courtyard, or
 * the value itself is "none" or "unknown". Boundary: 0,6 counts, 0,59 does not.
 */
export function usableSide(fact: LayoutFact | null, which: "balcony" | "bedroom"): "street" | "courtyard" | null {
  return usableSideWhen(fact, which, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link usableSide} with the switch passed in: `enabled` false is always null. Pure; the tests and the read-coverage use it. */
export function usableSideWhen(
  fact: LayoutFact | null,
  which: "balcony" | "bedroom",
  enabled: boolean,
): "street" | "courtyard" | null {
  if (!enabled || fact === null || !confident(fact) || fact.streetEvidence === "none") return null;
  const side = which === "balcony" ? fact.balconySide : fact.bedroomSide;
  return side === "street" || side === "courtyard" ? side : null;
}

/** True when the read is confident that the flat has no balcony. Needs only the confidence: nothing about street or courtyard is claimed. */
export function usablyNoBalcony(fact: LayoutFact | null): boolean {
  return usablyNoBalconyWhen(fact, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link usablyNoBalcony} with the switch passed in: `enabled` false is always false. */
export function usablyNoBalconyWhen(fact: LayoutFact | null, enabled: boolean): boolean {
  return enabled && fact !== null && confident(fact) && fact.balconySide === "none";
}

/**
 * Korsdrag (windows on two opposite sides): true for "twoOpposite", false for "one" or "corner",
 * null (unknown) for "unknown", for a confidence below {@link LAYOUT_MIN_CONFIDENCE} and for no fact.
 */
export function korsdragOf(fact: LayoutFact | null): boolean | null {
  return korsdragWhen(fact, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link korsdragOf} with the switch passed in: `enabled` false is always null. */
export function korsdragWhen(fact: LayoutFact | null, enabled: boolean): boolean | null {
  if (!enabled || fact === null || !confident(fact)) return null;
  if (fact.windowSides === "twoOpposite") return true;
  if (fact.windowSides === "one" || fact.windowSides === "corner") return false;
  return null;
}

/**
 * Whether the bedroom is on the quiet (courtyard) side: true for a usable courtyard bedroom, false for a
 * usable street bedroom, null (unknown) otherwise.
 */
export function quietBedroomOf(fact: LayoutFact | null): boolean | null {
  return quietBedroomWhen(fact, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link quietBedroomOf} with the switch passed in: `enabled` false is always null. */
export function quietBedroomWhen(fact: LayoutFact | null, enabled: boolean): boolean | null {
  const side = usableSideWhen(fact, "bedroom", enabled);
  if (side === null) return null;
  return side === "courtyard";
}

/**
 * The policy {@link believedLayout} reads a fact under: one gate per money-moving answer, the gate for the
 * negative answers ("nej", "ingen balkong"), the photo evidence that may settle street versus courtyard, and the
 * only read version that is trusted (null = any).
 */
export interface LayoutGatePolicy {
  /** Street or courtyard for the balcony counts from this confidence (the field's own when the fact has one). */
  balconyGate: number;
  /** Korsdrag "ja" counts from this confidence (stricter than the negative gate: a wrong "ja" is the costly error, WR-03). */
  windowsGate: number;
  /** Street or courtyard for the bedroom counts from this confidence. */
  bedroomGate: number;
  /** "nej" for korsdrag and "ingen balkong" count from this confidence. */
  negativeGate: number;
  /** The photo evidence that may settle a side (D-12: cars and courtyardGreenery; oppositeFacade only when measured). */
  sideEvidence: readonly ("cars" | "oppositeFacade" | "courtyardGreenery")[];
  /** A fact from any other read version is not believed; null trusts every version. */
  trustedVersion: string | null;
}

/** What a read is believed to say under a {@link LayoutGatePolicy}: null (or false) is "unknown", which changes nothing. */
export interface BelievedLayout {
  balconySide: "street" | "courtyard" | null;
  noBalcony: boolean;
  korsdrag: boolean | null;
  bedroomSide: "street" | "courtyard" | null;
}

const UNKNOWN_LAYOUT: BelievedLayout = { balconySide: null, noBalcony: false, korsdrag: null, bedroomSide: null };

/**
 * THE one definition of what a stored read is believed to say under a gate policy (Phase 14.5, LAYACC-03). Both
 * the measurement (layout-accuracy.ts counts a "believed call" with this function at the gate under test) and any
 * future production gate use it, so the rule that was measured and the rule that runs cannot drift apart.
 *  - a fact from another version than `trustedVersion`, or one whose pictures held no floor plan
 *    (`planPresent === false`), is all unknown;
 *  - each field uses its own confidence when the fact has one, else the single `confidence`;
 *  - street or courtyard (balcony, bedroom) needs the field gate AND photo evidence in `sideEvidence`
 *    ("none" never counts: a plan alone cannot tell street from courtyard);
 *  - korsdrag "ja" (twoOpposite) needs `windowsGate`, "nej" (one or corner) needs `negativeGate`;
 *  - "ingen balkong" needs `negativeGate`.
 * Boundaries are inclusive: confidence equal to the gate counts. Today's {@link usableSide}, {@link korsdragOf},
 * {@link quietBedroomOf} and the switch are separate and unchanged; plan 12 decides whether they route here.
 * Pure.
 */
export function believedLayout(fact: LayoutFact | null, policy: LayoutGatePolicy): BelievedLayout {
  if (fact === null) return UNKNOWN_LAYOUT;
  if (policy.trustedVersion !== null && fact.version !== policy.trustedVersion) return UNKNOWN_LAYOUT;
  if (fact.planPresent === false) return UNKNOWN_LAYOUT;

  const balconyConfidence = fact.fieldConfidence?.balcony ?? fact.confidence;
  const windowsConfidence = fact.fieldConfidence?.windows ?? fact.confidence;
  const bedroomConfidence = fact.fieldConfidence?.bedroom ?? fact.confidence;
  const evidenceOk = fact.streetEvidence !== "none" && policy.sideEvidence.includes(fact.streetEvidence);
  const sideOf = (side: "street" | "courtyard" | "none" | "unknown", confidence: number, gate: number) =>
    evidenceOk && confidence >= gate && (side === "street" || side === "courtyard") ? side : null;

  let korsdrag: boolean | null = null;
  if (fact.windowSides === "twoOpposite" && windowsConfidence >= policy.windowsGate) korsdrag = true;
  else if ((fact.windowSides === "one" || fact.windowSides === "corner") && windowsConfidence >= policy.negativeGate) korsdrag = false;

  return {
    balconySide: sideOf(fact.balconySide, balconyConfidence, policy.balconyGate),
    noBalcony: fact.balconySide === "none" && balconyConfidence >= policy.negativeGate,
    korsdrag,
    bedroomSide: sideOf(fact.bedroomSide, bedroomConfidence, policy.bedroomGate),
  };
}

/** The Korsdrag cell from {@link korsdragOf}: "ja", "nej" or "okänd". */
export function formatKorsdragCell(korsdrag: boolean | null): string {
  return korsdrag === null ? "okänd" : korsdrag ? "ja" : "nej";
}

/** The Sovrum cell from {@link quietBedroomOf}: "gård" (quiet), "gata" or "okänd". */
export function formatSovrumCell(quietBedroom: boolean | null): string {
  return quietBedroom === null ? "okänd" : quietBedroom ? "gård" : "gata";
}

/** Two decimals with a decimal comma: 0.9 prints "0,90" (the same look as the Sol cell of 14.3). */
const commaDecimals = (n: number): string => n.toFixed(2).replace(".", ",");

const SIDE_WORD = { street: "gata", courtyard: "gård" } as const;

/**
 * The Sol cell with the layout (LAY-02):
 *  - applied (the layout picked the facade, see inferredSunWithLayout in fit-score.ts):
 *    "S gata (planritning+foto, 1,00), balkong gata" - the facade of the balcony side, the sun's own confidence;
 *  - not applied: the unchanged 14.3 cell, plus ", balkong gata|gård" when the layout gives a usable balcony
 *    side, or ", ingen balkong" when it is confident there is none;
 *  - no layout, or one that cannot be believed: exactly {@link formatSolCell}.
 */
export function formatSolCellWithLayout(sun: SunFact | null, layout: LayoutFact | null, applied: boolean): string {
  return formatSolCellWithLayoutWhen(sun, layout, applied, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link formatSolCellWithLayout} with the switch passed in: `enabled` false is exactly {@link formatSolCell}. */
export function formatSolCellWithLayoutWhen(sun: SunFact | null, layout: LayoutFact | null, applied: boolean, enabled: boolean): string {
  const balcony = usableSideWhen(layout, "balcony", enabled);
  if (applied && sun !== null && balcony !== null) {
    const side = sun.sides.find((s) => s.side === SIDE_WORD[balcony]);
    if (side !== undefined) {
      return `${FACADE_LETTER[side.facade]} ${side.side} (planritning+foto, ${commaDecimals(sun.confidence)}), balkong ${SIDE_WORD[balcony]}`;
    }
  }
  const base = formatSolCell(sun);
  if (balcony !== null) return `${base}, balkong ${SIDE_WORD[balcony]}`;
  if (usablyNoBalconyWhen(layout, enabled)) return `${base}, ingen balkong`;
  return base;
}

const WINDOW_WORD = { one: "en sida", twoOpposite: "två motsatta sidor", corner: "hörn", unknown: "okänd" } as const;

/** Suffix on read-only output while the layout does not influence the score ({@link LAYOUT_INFLUENCE_ENABLED} false). */
export const LAYOUT_NO_INFLUENCE_SUFFIX = "(påverkar ej poängen)";

/**
 * The tracked-flat line of the layout: what the READ found, believed values only: "balkong gata, fönster en
 * sida, sovrum gata (säkerhet 0,90)", with "okänd" for what the gate does not let through, and "-" without a
 * layout. While the influence switch is off it ends with {@link LAYOUT_NO_INFLUENCE_SUFFIX}. Pure.
 */
export function formatLayoutSummary(fact: LayoutFact | null): string {
  return formatLayoutSummaryWhen(fact, LAYOUT_INFLUENCE_ENABLED);
}

/** {@link formatLayoutSummary} with the switch passed in. The values always show the read; `enabled` false only adds the suffix. */
export function formatLayoutSummaryWhen(fact: LayoutFact | null, enabled: boolean): string {
  if (fact === null) return "-";
  const balcony = usableSideWhen(fact, "balcony", true);
  const balconyWord = balcony !== null ? SIDE_WORD[balcony] : usablyNoBalconyWhen(fact, true) ? "ingen" : "okänd";
  const windows = confident(fact) ? WINDOW_WORD[fact.windowSides] : WINDOW_WORD.unknown;
  const bedroom = usableSideWhen(fact, "bedroom", true);
  const line = `balkong ${balconyWord}, fönster ${windows}, sovrum ${bedroom !== null ? SIDE_WORD[bedroom] : "okänd"} (säkerhet ${commaDecimals(fact.confidence)})`;
  return enabled ? line : `${line} ${LAYOUT_NO_INFLUENCE_SUFFIX}`;
}
