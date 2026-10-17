// @vitest-environment node
import { describe, expect, it } from "vitest";
import { USD_SEK_RATE } from "@/lib/brf/cost";
import { LAYOUT_MODEL_RATES_USD_PER_MTOK, layoutCallCostSek } from "@/lib/discovery/layout-cost";
import { LAYOUT_MODEL } from "@/lib/discovery/layout-read";

describe("layoutCallCostSek (R-04)", () => {
  it("prices Sonnet 4.6 at $3 in and $15 out", () => {
    const sek = layoutCallCostSek("claude-sonnet-4-6", { input_tokens: 5500, output_tokens: 150 });
    expect(sek).toBeCloseTo(((5500 * 3 + 150 * 15) / 1e6) * USD_SEK_RATE, 10);
    expect(sek).toBeGreaterThan(0.2);
    expect(sek).toBeLessThan(0.22);
  });

  it("prices Opus 5.5 at $4 in and $20 out", () => {
    const sek = layoutCallCostSek("claude-opus-5-5", { input_tokens: 5500, output_tokens: 150 });
    expect(sek).toBeCloseTo(((5500 * 4 + 150 * 20) / 1e6) * USD_SEK_RATE, 10);
  });

  it("holds the four rates of the model table", () => {
    expect(LAYOUT_MODEL_RATES_USD_PER_MTOK["claude-haiku-4-5-20251001"]).toEqual({ input: 1, output: 5 });
    expect(LAYOUT_MODEL_RATES_USD_PER_MTOK["claude-sonnet-4-6"]).toEqual({ input: 3, output: 15 });
    expect(LAYOUT_MODEL_RATES_USD_PER_MTOK["claude-sonnet-5-5"]).toEqual({ input: 2, output: 10 });
    expect(LAYOUT_MODEL_RATES_USD_PER_MTOK["claude-opus-5-5"]).toEqual({ input: 4, output: 20 });
  });

  it("prices cache creation and cache read tokens as input", () => {
    const withCache = layoutCallCostSek("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 3000,
    });
    const plain = layoutCallCostSek("claude-sonnet-4-6", { input_tokens: 6000, output_tokens: 100 });
    expect(withCache).toBeCloseTo(plain, 12);
  });

  it("treats null cache fields and non-finite counts as zero, never NaN", () => {
    const sek = layoutCallCostSek("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: Number.NaN,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    expect(Number.isFinite(sek)).toBe(true);
    expect(sek).toBeCloseTo((1000 * 3 * USD_SEK_RATE) / 1e6, 12);
  });

  it("throws on an unknown model id instead of guessing a price", () => {
    expect(() => layoutCallCostSek("claude-unknown-9", { input_tokens: 1, output_tokens: 1 })).toThrow(/Okänd modell/);
  });

  it("has a rate for the production layout model", () => {
    expect(() => layoutCallCostSek(LAYOUT_MODEL, { input_tokens: 1, output_tokens: 1 })).not.toThrow();
  });
});
