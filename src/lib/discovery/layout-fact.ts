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
  if (fact === null || !confident(fact) || fact.streetEvidence === "none") return null;
  const side = which === "balcony" ? fact.balconySide : fact.bedroomSide;
  return side === "street" || side === "courtyard" ? side : null;
}

/** True when the read is confident that the flat has no balcony. Needs only the confidence: nothing about street or courtyard is claimed. */
function usablyNoBalcony(fact: LayoutFact | null): boolean {
  return fact !== null && confident(fact) && fact.balconySide === "none";
}

/**
 * Korsdrag (windows on two opposite sides): true for "twoOpposite", false for "one" or "corner",
 * null (unknown) for "unknown", for a confidence below {@link LAYOUT_MIN_CONFIDENCE} and for no fact.
 */
export function korsdragOf(fact: LayoutFact | null): boolean | null {
  if (fact === null || !confident(fact)) return null;
  if (fact.windowSides === "twoOpposite") return true;
  if (fact.windowSides === "one" || fact.windowSides === "corner") return false;
  return null;
}

/**
 * Whether the bedroom is on the quiet (courtyard) side: true for a usable courtyard bedroom, false for a
 * usable street bedroom, null (unknown) otherwise.
 */
export function quietBedroomOf(fact: LayoutFact | null): boolean | null {
  const side = usableSide(fact, "bedroom");
  if (side === null) return null;
  return side === "courtyard";
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
  const balcony = usableSide(layout, "balcony");
  if (applied && sun !== null && balcony !== null) {
    const side = sun.sides.find((s) => s.side === SIDE_WORD[balcony]);
    if (side !== undefined) {
      return `${FACADE_LETTER[side.facade]} ${side.side} (planritning+foto, ${commaDecimals(sun.confidence)}), balkong ${SIDE_WORD[balcony]}`;
    }
  }
  const base = formatSolCell(sun);
  if (balcony !== null) return `${base}, balkong ${SIDE_WORD[balcony]}`;
  if (usablyNoBalcony(layout)) return `${base}, ingen balkong`;
  return base;
}
