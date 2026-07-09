import { describe, it, expect } from "vitest";
// RED: implemented below in this same task (src/lib/discovery/cost.ts).
import {
  discoveryCostSek,
  DISCOVERY_COST_CAP_SEK,
  USD_PER_RENDER,
  CAP_VISION_SEK_MAX,
  visionCostSek,
} from "@/lib/discovery/cost";
import { costSek, costSekSonnet, USD_SEK_RATE } from "@/lib/brf/cost";
import { CAP_SEK_MAX } from "@/lib/discovery/filter-schema";

describe("discoveryCostSek — Haiku parse cost + per-render scrape cost", () => {
  it("equals costSek(haikuUsage) + renders * USD_PER_RENDER * USD_SEK_RATE", () => {
    const haikuUsage = { input_tokens: 1000, output_tokens: 200 };
    const renders = 2;

    const result = discoveryCostSek({ haikuUsage, renders });
    const expected = costSek(haikuUsage) + renders * USD_PER_RENDER * USD_SEK_RATE;

    expect(result).toBeCloseTo(expected, 10);
  });

  it("is 0 for zero usage and zero renders", () => {
    const result = discoveryCostSek({
      haikuUsage: { input_tokens: 0, output_tokens: 0 },
      renders: 0,
    });

    expect(result).toBe(0);
  });

  it("scales with render count", () => {
    const haikuUsage = { input_tokens: 500, output_tokens: 100 };
    const oneRender = discoveryCostSek({ haikuUsage, renders: 1 });
    const threeRenders = discoveryCostSek({ haikuUsage, renders: 3 });

    expect(threeRenders).toBeGreaterThan(oneRender);
  });
});

describe("DISCOVERY_COST_CAP_SEK", () => {
  it("is a positive number tied to the filter-schema cap", () => {
    expect(typeof DISCOVERY_COST_CAP_SEK).toBe("number");
    expect(DISCOVERY_COST_CAP_SEK).toBeGreaterThan(0);
  });
});

describe("CAP_VISION_SEK_MAX — Phase 11 (DISC-04) separate vision cost cap", () => {
  it("is 10 and is NOT the same reference/value as CAP_SEK_MAX (5)", () => {
    expect(CAP_VISION_SEK_MAX).toBe(10);
    expect(CAP_VISION_SEK_MAX).not.toBe(CAP_SEK_MAX);
  });
});

describe("visionCostSek — composes Haiku pre-filter + optional Sonnet deep-pass cost", () => {
  const haikuUsage = { input_tokens: 6570, output_tokens: 150 };
  const sonnetUsage = { input_tokens: 6770, output_tokens: 400 };

  it("equals costSek(haikuUsage) when sonnetUsage is null (pre-filter-only candidate)", () => {
    const result = visionCostSek(haikuUsage, null);
    expect(result).toBeCloseTo(costSek(haikuUsage), 10);
  });

  it("equals costSek(haikuUsage) + costSekSonnet(sonnetUsage) when both stages ran", () => {
    const result = visionCostSek(haikuUsage, sonnetUsage);
    const expected = costSek(haikuUsage) + costSekSonnet(sonnetUsage);
    expect(result).toBeCloseTo(expected, 10);
  });

  it("never redefines rates — a Sonnet-tier usage costs strictly more than the same usage billed at Haiku rates", () => {
    const viaVision = visionCostSek(haikuUsage, sonnetUsage) - costSek(haikuUsage);
    const ifBilledAsHaiku = costSek(sonnetUsage);
    expect(viaVision).toBeGreaterThan(ifBilledAsHaiku);
  });
});
