import { describe, it, expect } from "vitest";
import { fillGap, mergeListingFields, type BooliRecoverableFields } from "@/lib/broker/merge-listing-fields";
import type { BrokerFields } from "@/lib/broker/parse-broker-page";

describe("fillGap", () => {
  it("keeps the Booli value and tags source 'booli' when Booli is non-null — the broker value is IGNORED even if also non-null", () => {
    const result = fillGap("Booli description", "Broker description");
    expect(result).toEqual({ value: "Booli description", source: "booli" });
  });

  it("fills the gap with the broker value and tags source 'maklare' when Booli is null and broker is non-null", () => {
    const result = fillGap<string>(null, "Nyrenoverat 2020");
    expect(result).toEqual({ value: "Nyrenoverat 2020", source: "maklare" });
  });

  it("returns {value: null, source: null} when both are null", () => {
    const result = fillGap<string>(null, null);
    expect(result).toEqual({ value: null, source: null });
  });

  it("NEVER overwrites a non-null Booli value with a broker value (LSTG-04 central contract)", () => {
    const booliValue = "Original Booli value";
    const brokerValue = "Should never appear";
    const result = fillGap(booliValue, brokerValue);

    expect(result.value).toBe(booliValue);
    expect(result.value).not.toBe(brokerValue);
    expect(result.source).toBe("booli");
  });
});

describe("mergeListingFields", () => {
  it("returns a per-field Sourced<T> map with correct provenance for a mixed case", () => {
    const booliFields: BooliRecoverableFields = {
      floor: 3,
      balcony: true,
      brfName: "HSB BRF Metern",
      renovationStatus: null,
      description: null,
    };
    const brokerFields: BrokerFields = {
      renovationStatus: "Stambyte 2018, nytt kök 2021",
      description: "En rymlig tvåa med öppen planlösning.",
    };

    const merged = mergeListingFields(booliFields, brokerFields);

    expect(merged.floor).toEqual({ value: 3, source: "booli" });
    expect(merged.balcony).toEqual({ value: true, source: "booli" });
    expect(merged.brfName).toEqual({ value: "HSB BRF Metern", source: "booli" });
    expect(merged.renovationStatus).toEqual({
      value: "Stambyte 2018, nytt kök 2021",
      source: "maklare",
    });
    expect(merged.description).toEqual({
      value: "En rymlig tvåa med öppen planlösning.",
      source: "maklare",
    });
  });

  it("degrades gracefully when brokerFields is null (broker fetch failed) — every field falls back to Booli-or-null", () => {
    const booliFields: BooliRecoverableFields = {
      floor: 3,
      balcony: null,
      brfName: null,
      renovationStatus: null,
      description: null,
    };

    const merged = mergeListingFields(booliFields, null);

    expect(merged.floor).toEqual({ value: 3, source: "booli" });
    expect(merged.balcony).toEqual({ value: null, source: null });
    expect(merged.brfName).toEqual({ value: null, source: null });
    expect(merged.renovationStatus).toEqual({ value: null, source: null });
    expect(merged.description).toEqual({ value: null, source: null });
  });

  it("never lets a broker value overwrite a non-null Booli value for renovationStatus/description", () => {
    const booliFields: BooliRecoverableFields = {
      floor: null,
      balcony: null,
      brfName: null,
      renovationStatus: "Booli-sourced renovation info",
      description: "Booli-sourced description",
    };
    const brokerFields: BrokerFields = {
      renovationStatus: "Broker-sourced renovation info",
      description: "Broker-sourced description",
    };

    const merged = mergeListingFields(booliFields, brokerFields);

    expect(merged.renovationStatus).toEqual({
      value: "Booli-sourced renovation info",
      source: "booli",
    });
    expect(merged.description).toEqual({
      value: "Booli-sourced description",
      source: "booli",
    });
  });
});
