import { describe, it, expect } from "vitest";
import { costSek, costSekSonnet, SONNET_USD_PER_MTOK } from "@/lib/brf/cost";
import { assembleFactSheet } from "@/lib/report/fact-sheet";
import type { FlagSet } from "@/lib/report/flags";

// NOTE: this file is shared with Plan 03 (it adds stop-reason / log-redaction
// describe blocks). Plan 04-01's additions live in the clearly-named blocks
// below so the two plans' tests do not collide.

describe("04-01 Sonnet cost rates (RESEARCH Pitfall 3 / T-04-03)", () => {
  it("publishes the Sonnet 4.6 rates ($3 in / $15 out)", () => {
    expect(SONNET_USD_PER_MTOK.input).toBe(3.0);
    expect(SONNET_USD_PER_MTOK.output).toBe(15.0);
    expect(SONNET_USD_PER_MTOK.cacheWrite5m).toBe(3.75);
    expect(SONNET_USD_PER_MTOK.cacheRead).toBe(0.3);
  });

  it("costSekSonnet bills ~3× the Haiku costSek for the same usage", () => {
    const usage = { input_tokens: 3_000, output_tokens: 1_200 };
    const haiku = costSek(usage);
    const sonnet = costSekSonnet(usage);
    // input 3×, output 3× → exactly 3× for a no-cache run.
    expect(sonnet / haiku).toBeCloseTo(3, 5);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it("a typical synthesis run stays well under the 5 SEK guard", () => {
    // AI-SPEC §4b: ~3k input, ~1.2k output ≈ 0.30 SEK at USD/SEK 11.
    const cost = costSekSonnet({ input_tokens: 3_000, output_tokens: 1_200 });
    expect(cost).toBeLessThan(5);
    expect(cost).toBeCloseTo(0.3, 1);
  });

  it("leaves the Haiku costSek path unchanged (still ~0.94 SEK for 80k/1k)", () => {
    const cost = costSek({ input_tokens: 80_000, output_tokens: 1_000 });
    expect(cost).toBeCloseTo(0.94, 1);
  });
});

describe("04-01 assembleFactSheet — stable key order + ej_tillgänglig (D-07)", () => {
  const flags: FlagSet = [
    { id: "brf_high_debt", severity: "red", sourceRef: "brf.skuldPerKvm" },
  ];

  it("is deterministic: same input → byte-identical string", () => {
    const input = {
      listing: { price: 4_000_000, prisPerKvm: 80_000, address: "Testgatan 1" },
      brf: { normalized: { skuldPerKvm: 13_000 } },
      price: { deltaPct: 8, reason: "ok" },
      area: { metrics: { population: 1200 } },
      flags,
      softSignals: null,
    };
    expect(assembleFactSheet(input)).toBe(assembleFactSheet(input));
  });

  it("is order-insensitive to the caller's object key insertion order", () => {
    const a = assembleFactSheet({
      listing: { price: 4_000_000, address: "Testgatan 1", prisPerKvm: 80_000 },
      brf: null,
      price: null,
      area: null,
      flags,
      softSignals: null,
    });
    const b = assembleFactSheet({
      listing: { prisPerKvm: 80_000, price: 4_000_000, address: "Testgatan 1" },
      brf: null,
      price: null,
      area: null,
      flags,
      softSignals: null,
    });
    expect(a).toBe(b);
  });

  it("marks an absent brf source as status ej_tillgänglig (never omitted)", () => {
    const out = assembleFactSheet({
      listing: { price: 4_000_000 },
      brf: null,
      price: { deltaPct: 8, reason: "ok" },
      area: null,
      flags: [],
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.brf).toEqual({ status: "ej_tillgänglig" });
    expect(parsed.area).toEqual({ status: "ej_tillgänglig" });
    expect(out).toContain('"status":"ej_tillgänglig"');
  });

  it("wraps a present source as status tillgänglig with its data", () => {
    const out = assembleFactSheet({
      listing: { price: 4_000_000 },
      brf: { normalized: { skuldPerKvm: 13_000 } },
      price: null,
      area: null,
      flags: [],
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.brf.status).toBe("tillgänglig");
    expect(parsed.brf.data.normalized.skuldPerKvm).toBe(13_000);
  });

  it("carries the deterministic flags through in order", () => {
    const out = assembleFactSheet({
      listing: null,
      brf: null,
      price: null,
      area: null,
      flags,
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.flags[0].id).toBe("brf_high_debt");
  });
});
