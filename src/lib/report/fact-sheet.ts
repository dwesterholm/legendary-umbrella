import type { FlagSet, FlagSoftSignals } from "@/lib/report/flags";

/**
 * fact-sheet.ts — the stable-key-order fact-sheet assembler (D-07).
 *
 * Combines the four already-`safeParse`d sources (listing, BRF, price, area) +
 * the deterministic `FlagSet` from `computeFlags` + the cited free-text soft
 * signals into ONE `JSON.stringify`'d bundle. This is the single user-content
 * block handed to the synthesis call (AI-SPEC §4 step 2).
 *
 * Two hard contracts:
 *  1. STABLE KEY ORDER (AI-SPEC §4b.4, prompt-cache hygiene): the output must be
 *     byte-identical for the same input across calls, so the leading cached
 *     block does not silently invalidate. We achieve this by building each
 *     object in a fixed literal key order and recursively sorting nested keys.
 *  2. EXPLICIT absence (D-07): a missing source is marked
 *     `{ status: "ej_tillgänglig" }`, NEVER an omitted key — silent omission
 *     reads as fabrication-by-absence (FM4). Present sources are wrapped
 *     `{ status: "tillgänglig", data: ... }`.
 *
 * Mirrors the pure-assembly discipline of `computeBrfGrade` — no clock, no
 * randomness, no network. Only the already-structured values flow in; never
 * raw årsredovisning text.
 */

/** A source slot: either present with its structured data, or honestly absent. */
type SourceSlot<T> =
  | { status: "tillgänglig"; data: T }
  | { status: "ej_tillgänglig" };

/**
 * The assembler input: the four nullable sources, the deterministic flags, and
 * the cited soft signals. Each source is typed `unknown` because the caller
 * passes the already-`safeParse`d payloads (listing/brf/price/area) — the fact
 * sheet only serializes them in stable order, it does not re-validate.
 */
export interface FactSheetInput {
  listing: unknown | null;
  brf: unknown | null;
  price: unknown | null;
  area: unknown | null;
  macro: unknown | null;
  flags: FlagSet;
  softSignals: FlagSoftSignals | null;
}

/** Wraps a nullable source into an explicit present/absent slot (D-07). */
function slot<T>(value: T | null): SourceSlot<T> {
  return value === null || value === undefined
    ? { status: "ej_tillgänglig" }
    : { status: "tillgänglig", data: value };
}

/**
 * Recursively produces a value with sorted object keys, so `JSON.stringify`
 * emits a deterministic byte string regardless of the insertion order of the
 * caller's parsed payloads (prompt-cache hygiene, §4b.4). Arrays keep their
 * order (it is meaningful — e.g. flag priority); only object keys are sorted.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Assembles the stable-key-order fact-sheet JSON string for the synthesis call.
 * Pure and deterministic: two calls with the same input produce a byte-identical
 * string (prompt-cache hit). Absent sources carry an explicit `ej_tillgänglig`
 * marker (D-07), never an omitted key.
 *
 * @param input - the four sources, the deterministic flags, the soft signals
 * @returns the `JSON.stringify`'d fact-sheet bundle (stable key order)
 */
export function assembleFactSheet(input: FactSheetInput): string {
  const bundle = {
    area: slot(input.area),
    brf: slot(input.brf),
    flags: input.flags,
    listing: slot(input.listing),
    macro: slot(input.macro),
    price: slot(input.price),
    softSignals: input.softSignals ?? null,
  };

  return JSON.stringify(sortKeysDeep(bundle));
}
