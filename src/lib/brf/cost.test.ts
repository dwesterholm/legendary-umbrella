import { describe, it, expect } from "vitest";
// RED: implemented in Plan 03 (src/lib/brf/cost.ts).
import { costSek, USD_PER_MTOK, USD_SEK_RATE } from "@/lib/brf/cost";

// Haiku 4.5 rates verified 2026-06-07 (RESEARCH §Cost & Limits):
// input $1/MTok, output $5/MTok, 5-min cache-write $1.25/MTok, cache-read $0.10/MTok.
// USD/SEK ≈ 11 (config constant, not hardcoded in logic — assumption A1).

describe("USD_PER_MTOK / USD_SEK_RATE — published rate constants", () => {
  it("matches the verified Haiku 4.5 per-MTok rates", () => {
    expect(USD_PER_MTOK.input).toBe(1.0);
    expect(USD_PER_MTOK.output).toBe(5.0);
    expect(USD_PER_MTOK.cacheWrite5m).toBe(1.25);
    expect(USD_PER_MTOK.cacheRead).toBe(0.1);
  });

  it("exposes the USD/SEK rate as a configurable constant", () => {
    expect(typeof USD_SEK_RATE).toBe("number");
    expect(USD_SEK_RATE).toBeGreaterThan(0);
  });
});

describe("costSek — budget adherence (<5 SEK per analysis)", () => {
  it("computes a typical 80k-input / 1k-output run under 5 SEK (~0.94 SEK)", () => {
    const cost = costSek({ input_tokens: 80_000, output_tokens: 1_000 });
    expect(cost).toBeLessThan(5);
    // RESEARCH says ~0.94 SEK at USD/SEK ≈ 11.
    expect(cost).toBeCloseTo(0.94, 1);
  });

  it("never exceeds the 5 SEK hard cap even for a heavy scanned run", () => {
    // Worst case from RESEARCH: ~40-page scanned with one cached retry ~2.3 SEK.
    const cost = costSek({
      input_tokens: 160_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 80_000,
      cache_read_input_tokens: 80_000,
    });
    expect(cost).toBeLessThan(5);
  });
});

describe("costSek — cache accounting (§4b.5)", () => {
  it("reads cache_creation_input_tokens and cache_read_input_tokens when present", () => {
    const withoutCache = costSek({ input_tokens: 80_000, output_tokens: 1_000 });
    const withCache = costSek({
      input_tokens: 80_000,
      output_tokens: 1_000,
      cache_creation_input_tokens: 80_000,
      cache_read_input_tokens: 40_000,
    });
    // Cache tokens add billable cost, so the cached-fields run must cost more.
    expect(withCache).toBeGreaterThan(withoutCache);
  });

  it("makes a cache-read-heavy retry cheaper than a cold full-document run", () => {
    // Cold run: full document billed at input rate ($1/MTok).
    const coldRun = costSek({ input_tokens: 80_000, output_tokens: 1_000 });
    // Cached retry: the document is read from cache at $0.10/MTok instead of $1.
    const cachedRetry = costSek({
      input_tokens: 0,
      output_tokens: 1_000,
      cache_read_input_tokens: 80_000,
    });
    expect(cachedRetry).toBeLessThan(coldRun);
  });
});
