/**
 * layout-typesafe.ts - variant e of the layout experiments: the read done by Jev (TypeSafe System One) instead of a
 * text-generating model (Phase 14.5, R-10). Pure: no SDK import, no network, no file access, no clock.
 *
 * What is different about Jev: it does not write an answer, it answers typed QUESTIONS with PROBABILITIES. A Choice
 * returns one option from a set plus a probability for every option; a Noul returns the probability that a statement is
 * true. So the per-field confidence of this variant is not a number the model reports about itself (variants b and c) but
 * the probability of the answer it gave. The pictures go in the request as image assets in the `state`, and every question
 * about them is evaluated in parallel in the same request.
 *
 * Price: input tokens only, 0,042 USD per million (output is free), so a flat costs about 0,005 kr against about 0,21 kr
 * for Sonnet and 0,46 kr for Opus (R-10).
 *
 * This file holds the part that needs no SDK: the fixed question set (the evidence rules of variant b, written as
 * Choice/Noul criteria), the mapping of the answers to the V2-shaped read every other variant stores (so
 * `factFromVariantRead`, `believedLayout` and the accuracy module work unchanged), and the cost at Jev's rate. The call
 * itself (image preparation, the SDK client, the images header) is in layout-typesafe-call.ts.
 *
 * Only enums, probabilities and ids are stored, never a picture or a URL.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { z } from "zod/v4";
import { USD_SEK_RATE } from "@/lib/brf/cost";
import { BALCONY_SIDES, BEDROOM_SIDES, STREET_EVIDENCE, WINDOW_SIDES } from "@/lib/discovery/layout-fact";
import { layoutReadSchemaV2 } from "@/lib/discovery/layout-read";

/** The model of variant e (R-10). */
export const JEV_MODEL = "jev-1.14.0";

/** USD per million INPUT tokens; output tokens are free (docs.typesafe.ai/models, Jev 1.14). */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

/** The opt-in header for images (experimental on TypeSafe's side); sent with every request. */
export const JEV_IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" } as const;

/** What TypeSafe accepts as a picture (docs.typesafe.ai/images): PNG or JPEG, each side 280 to 1568 pixels. */
export const JEV_IMAGE_LIMITS = { formats: ["png", "jpeg"], minSidePx: 280, maxSidePx: 1568, upright: true } as const;

// ---------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------

/** One question as plain data: the same shape the SDK's `choice()` / `noul()` build. */
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: "noul"; instructions: string };

/**
 * The state text that comes with the pictures. Picture 1 is normally the floor plan, as for the Claude variants; which
 * side is street and which is courtyard is decided by the photos, never by the plan alone.
 */
export const JEV_ABOUT =
  "Pictures from a Swedish apartment listing, in the order the listing shows them. Picture 1 (`pictures[0]`) is normally the floor plan, a drawing of the apartment seen from above, and the rest are photos from the apartment. Whether a side of the apartment faces the street or the courtyard is decided by the PHOTOS, never by the floor plan alone.";

const STREET_RULE =
  "Street is shown by cars, a roadway, street lamps, shopfronts, tram wires, or a continuous line of facades on the other side of a road.";
const COURTYARD_RULE =
  "Courtyard is shown by bicycle racks, a lawn, a sandbox or playground, paving with planters, or the building's own back wall. Artificial grass or decking on the balcony floor is not courtyard greenery. A tree with distant facades, with no road and no yard surface, decides nothing.";
const ARROW_RULE = "The arrow at the front door on the floor plan shows where one enters; it is not a side and says nothing about street or courtyard.";

/**
 * The questions of variant e, keyed by the id the answer comes back under (R-10 mapping). Written and frozen before any
 * paid call, with the same evidence rules as variant b (D-10): nothing here is tuned on the truth set. Option names are the
 * values of the stored enums, so the mapping is the identity.
 */
export const JEV_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  balconySide: {
    type: "choice",
    instructions: `Which side of the building is the apartment's balcony on? Find the balcony on the floor plan in \`pictures\`, then use the photos to see what lies outside it. ${ARROW_RULE}`,
    criteria: {
      street: `The balcony faces the street. ${STREET_RULE}`,
      courtyard: `The balcony faces the courtyard. ${COURTYARD_RULE}`,
      none: "The floor plan clearly shows that the apartment has no balcony.",
      unknown: "There is a balcony, or it is unclear, but the pictures do not show whether it faces the street or the courtyard, or there is no floor plan.",
    },
  },
  windowSides: {
    type: "choice",
    instructions: `How are the windows of the apartment placed in its exterior walls, according to the floor plan in \`pictures\`? Windows count only in an exterior wall; glass between rooms, for example toward a sleeping alcove, does not count. ${ARROW_RULE}`,
    criteria: {
      one: "All windows are in one exterior wall. A bay window on one wall is one side.",
      twoOpposite:
        "Windows in two opposite exterior walls, which gives a through-draught (also when a third wall has windows, as long as two of them are opposite). A long apartment with windows in both short ends is twoOpposite even when the kitchen and the living room are drawn separately.",
      corner: "Windows in two exterior walls that meet at a corner.",
      unknown: "There is no floor plan, or it does not show where the windows are.",
    },
  },
  bedroomSide: {
    type: "choice",
    instructions: `Which side does the main bedroom face? Find the main bedroom's window wall on the floor plan in \`pictures\`, then use the photos to see whether that wall faces the street or the courtyard. ${ARROW_RULE}`,
    criteria: {
      street: `The main bedroom faces the street. ${STREET_RULE}`,
      courtyard: `The main bedroom faces the courtyard. ${COURTYARD_RULE}`,
      unknown: "The pictures do not show which side the main bedroom faces.",
    },
  },
  streetEvidence: {
    type: "choice",
    instructions: "What in the PHOTOS in `pictures` shows whether a side of the apartment faces the street or the courtyard?",
    criteria: {
      cars: STREET_RULE,
      oppositeFacade: "Only a building facade close by, directly opposite, and nothing else. Use this only when that is the one thing you can see.",
      courtyardGreenery: COURTYARD_RULE,
      none: "The photos show neither street nor courtyard.",
    },
  },
  livingOnBalconySide: {
    type: "noul",
    instructions: "According to the floor plan in `pictures`, is the living room on the same side of the apartment as the balcony?",
  },
  kitchenOnBalconySide: {
    type: "noul",
    instructions: "According to the floor plan in `pictures`, is the kitchen on the same side of the apartment as the balcony?",
  },
  bedroomOnBalconySide: {
    type: "noul",
    instructions: "According to the floor plan in `pictures`, is any bedroom on the same side of the apartment as the balcony?",
  },
  planPresent: {
    type: "noul",
    instructions: "Is at least one of the pictures in `pictures` a floor plan drawn from above, that is a drawing of the apartment's rooms and walls and not a photograph?",
  },
};

/** The choice questions and the options each may answer with (they are the stored enums). */
const CHOICE_OPTIONS = {
  balconySide: BALCONY_SIDES,
  windowSides: WINDOW_SIDES,
  bedroomSide: BEDROOM_SIDES,
  streetEvidence: STREET_EVIDENCE,
} as const;

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

/**
 * The stored read of variant e: the twelve fields of variants b and c (so the accuracy module, `factFromVariantRead` and
 * `believedLayout` need no special case), plus the probabilities the answer rested on: for every Choice the probability of
 * each option, for every Noul the probability of yes. No bounds on the numbers here; the stored fact clamps them.
 */
export const layoutReadSchemaE = layoutReadSchemaV2.extend({
  jev: z.object({
    choices: z.record(z.string(), z.record(z.string(), z.number())),
    noul: z.record(z.string(), z.number()),
  }),
});

export type LayoutReadE = z.infer<typeof layoutReadSchemaE>;

/** A Jev answer as the SDK returns it. Only what the mapping reads. */
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Readonly<Record<string, number>> }
  | { type: "noul"; noul: number };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * The confidence of one answer, which IS its probability: for a Choice the probability of the option it chose, for a Noul
 * the probability of the side it came down on, `max(p, 1 - p)`. A near-0,5 Noul is the model not knowing, and reads 0,5.
 */
export function jevAnswerConfidence(answer: JevAnswer): number {
  if (answer.type === "noul") {
    const p = clamp01(answer.noul);
    return Math.max(p, 1 - p);
  }
  return clamp01(answer.probabilities[answer.choice] ?? Number.NaN);
}

/**
 * Maps the answers of one Jev request to the stored read (R-10):
 *  - every Choice answer is its chosen option; every Noul at or above 0,5 is true;
 *  - `balconyConfidence`, `windowsConfidence` and `bedroomConfidence` are the probabilities of the balcony, window and
 *    bedroom Choice answers; `confidence` is the smallest of the three (the money-moving fields);
 *  - `planPresent` is the plan Noul at or above 0,5.
 * Throws on a missing answer, a wrong answer type, a chosen option that is not one of the question's options, or a chosen
 * option without a probability: such an answer is billed but cannot be believed. Pure.
 */
export function layoutReadFromJev(answers: Readonly<Record<string, unknown>>): LayoutReadE {
  const choices: Record<string, Record<string, number>> = {};
  const noul: Record<string, number> = {};
  const picked: Record<string, string> = {};
  const confidence: Record<string, number> = {};
  const answerOf = (id: string): JevAnswer => {
    const a = answers[id] as { type?: unknown } | undefined;
    if (a === undefined || a === null || typeof a !== "object") throw new Error(`Jev: svar saknas för ${id}`);
    return a as JevAnswer;
  };

  for (const [id, options] of Object.entries(CHOICE_OPTIONS)) {
    const a = answerOf(id);
    if (a.type !== "choice") throw new Error(`Jev: ${id} är inte ett val`);
    if (!(options as readonly string[]).includes(a.choice)) throw new Error(`Jev: ${id} gav ett alternativ som inte finns`);
    const p = a.probabilities?.[a.choice];
    if (typeof p !== "number" || !Number.isFinite(p)) throw new Error(`Jev: ${id} saknar sannolikhet för det valda alternativet`);
    picked[id] = a.choice;
    confidence[id] = clamp01(p);
    choices[id] = Object.fromEntries(
      Object.entries(a.probabilities).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => [k, clamp01(v)]),
    );
  }
  const yes = (id: string): boolean => {
    const a = answerOf(id);
    if (a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) throw new Error(`Jev: ${id} är inte ett ja/nej-svar`);
    noul[id] = clamp01(a.noul);
    return a.noul >= 0.5;
  };

  const livingOnBalconySide = yes("livingOnBalconySide");
  const kitchenOnBalconySide = yes("kitchenOnBalconySide");
  const bedroomOnBalconySide = yes("bedroomOnBalconySide");
  const planPresent = yes("planPresent");
  const balconyConfidence = confidence.balconySide;
  const windowsConfidence = confidence.windowSides;
  const bedroomConfidence = confidence.bedroomSide;

  return {
    balconySide: picked.balconySide as LayoutReadE["balconySide"],
    livingOnBalconySide,
    kitchenOnBalconySide,
    bedroomOnBalconySide,
    windowSides: picked.windowSides as LayoutReadE["windowSides"],
    bedroomSide: picked.bedroomSide as LayoutReadE["bedroomSide"],
    streetEvidence: picked.streetEvidence as LayoutReadE["streetEvidence"],
    confidence: Math.min(balconyConfidence, windowsConfidence, bedroomConfidence),
    planPresent,
    balconyConfidence,
    windowsConfidence,
    bedroomConfidence,
    jev: { choices, noul },
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The SEK cost of one Jev request: input tokens at 0,042 USD per million, output free. `input_tokens` already includes the
 * tokens of every picture. A token count that is missing or not a finite non-negative number counts as 0, which the runner
 * then replaces by the variant's estimate (a call whose cost is not a positive number is counted at the estimate). Pure.
 */
export function jevCostSek(usage: { input_tokens?: number | null; output_tokens?: number | null } | null | undefined): number {
  const input = usage?.input_tokens;
  const tokens = typeof input === "number" && Number.isFinite(input) && input > 0 ? input : 0;
  return ((tokens * JEV_USD_PER_MTOK_INPUT) / 1_000_000) * USD_SEK_RATE;
}

/** The environment gate of a paid Jev call: both RUN_LLM_EVALS=1 and a key must be there. The key's value is never read here beyond its length. */
export function jevGate(env: Readonly<Record<string, string | undefined>>): "skip" | "no_key" | "ok" {
  if (env.RUN_LLM_EVALS !== "1") return "skip";
  const key = env.TYPESAFE_API_KEY;
  return typeof key === "string" && key.length > 0 ? "ok" : "no_key";
}
