import type { Sourced, ListingSource } from "@/lib/schemas/listing";
import type { BrokerFields } from "./parse-broker-page";

/**
 * merge-listing-fields.ts — gap-fill-only merge with provenance tagging
 * (LSTG-04's central contract).
 *
 * This is genuinely new code: no existing function in the codebase tracks
 * per-field data provenance (booli vs mäklare). The nearest ancestor idiom
 * is `normalizeScraperOutput`'s `??` fallback chain (src/lib/schemas/
 * listing.ts) — "prefer source A, else source B" — but that chain does not
 * tag which source ultimately won. `fillGap` copies ONLY the null-first-wins
 * philosophy, not the implementation, and adds the `Sourced<T>` provenance
 * tag Plan 01 defined for this exact purpose.
 */

/**
 * Fills a single field's gap: a non-null Booli value always wins (source
 * "booli") and is NEVER overwritten by a broker value, even when the broker
 * also supplied a non-null value. Only when the Booli value is null does a
 * non-null broker value fill the gap (source "maklare"). When both are
 * null, the field stays null with no source.
 */
export function fillGap<T>(booliValue: T | null, brokerValue: T | null): Sourced<T> {
  if (booliValue !== null) return { value: booliValue, source: "booli" as ListingSource };
  if (brokerValue !== null) return { value: brokerValue, source: "maklare" as ListingSource };
  return { value: null, source: null };
}

/**
 * The subset of `NormalizedListing` fields the broker page can genuinely
 * supply. floor/balcony/brfName are Apollo-derived (client.ts) and always
 * carry source "booli" when present — they are included here only so the
 * caller gets a uniform per-field provenance map for the UI, not because
 * the broker page is ever consulted for them (RESEARCH Anti-Pattern).
 */
export interface BooliRecoverableFields {
  floor: number | null;
  balcony: boolean | null;
  brfName: string | null;
  renovationStatus: string | null;
  description: string | null;
}

export interface MergedListingFields {
  floor: Sourced<number>;
  balcony: Sourced<boolean>;
  brfName: Sourced<string>;
  renovationStatus: Sourced<string>;
  description: Sourced<string>;
}

/**
 * Merges Booli-derived fields with (optional) broker-derived fields.
 * `brokerFields` is `null` when the broker fetch failed/was skipped
 * (independent-degradation, T-06-07) — every field then simply falls back
 * to its Booli value (or null/null when Booli also lacks it).
 *
 * Only `renovationStatus` and `description` can ever be filled from the
 * broker side; `floor`/`balcony`/`brfName` always resolve to source "booli"
 * when non-null (the "maklare" branch is structurally unreachable for them
 * since brokerFields never carries values for these keys), matching the
 * Anti-Pattern guidance that Apollo is the sole source for these three.
 */
export function mergeListingFields(
  booliFields: BooliRecoverableFields,
  brokerFields: BrokerFields | null,
): MergedListingFields {
  return {
    floor: fillGap(booliFields.floor, null),
    balcony: fillGap(booliFields.balcony, null),
    brfName: fillGap(booliFields.brfName, null),
    renovationStatus: fillGap(booliFields.renovationStatus, brokerFields?.renovationStatus ?? null),
    description: fillGap(booliFields.description, brokerFields?.description ?? null),
  };
}
