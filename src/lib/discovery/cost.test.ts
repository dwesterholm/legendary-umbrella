import { describe, it, expect } from "vitest";
// RED: implemented below in this same task (src/lib/discovery/cost.ts).
import {
  discoveryCostSek,
  DISCOVERY_COST_CAP_SEK,
  USD_PER_RENDER,
  CAP_VISION_SEK_MAX,
  visionCostSek,
  renderSek,
  COMPS_MAX_RENDERS_PER_AREA,
  estimateCompsFetchSek,
  estimateBrfLookupSek,
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

describe("renderSek — the single render→SEK conversion (14-05)", () => {
  it("equals renders * USD_PER_RENDER * USD_SEK_RATE", () => {
    expect(renderSek(2)).toBeCloseTo(2 * USD_PER_RENDER * USD_SEK_RATE, 10);
  });

  it("is 0 for 0 renders", () => {
    expect(renderSek(0)).toBe(0);
  });

  it("clamps a negative render count to 0 (never a negative cost)", () => {
    expect(renderSek(-3)).toBe(0);
  });

  it("clamps NaN to 0 (never a NaN cost)", () => {
    expect(renderSek(Number.NaN)).toBe(0);
  });
});

describe("discoveryCostSek — refactor is behaviour-preserving (14-05)", () => {
  it("equals costSek(haikuUsage) + renderSek(renders)", () => {
    const haikuUsage = { input_tokens: 1234, output_tokens: 56 };
    const renders = 3;

    const result = discoveryCostSek({ haikuUsage, renders });
    const expected = costSek(haikuUsage) + renderSek(renders);

    expect(result).toBeCloseTo(expected, 10);
  });
});

describe("estimateCompsFetchSek / COMPS_MAX_RENDERS_PER_AREA — 14-05 (ANL-02)", () => {
  it("COMPS_MAX_RENDERS_PER_AREA is 2 (fetchSoldComps's own-render rung count)", () => {
    expect(COMPS_MAX_RENDERS_PER_AREA).toBe(2);
  });

  it("equals renderSek(COMPS_MAX_RENDERS_PER_AREA)", () => {
    expect(estimateCompsFetchSek()).toBeCloseTo(renderSek(COMPS_MAX_RENDERS_PER_AREA), 10);
  });
});

describe("estimateBrfLookupSek — 14-05 (D-14-08)", () => {
  it("does not under-estimate the observed real per-extraction cost (~0.71 SEK)", () => {
    expect(estimateBrfLookupSek()).toBeGreaterThanOrEqual(0.71);
  });

  it("stays below CAP_VISION_SEK_MAX — a single BRF lookup can never alone exhaust the pool", () => {
    expect(estimateBrfLookupSek()).toBeLessThan(CAP_VISION_SEK_MAX);
  });
});

describe("D-14-08 headroom check — worst-case comps + BRF batch leaves budget for vision", () => {
  it("2 areas' comps + a full BRF_TOP_N(4)-sized BRF batch stays inside CAP_VISION_SEK_MAX", () => {
    const worstCase = 2 * estimateCompsFetchSek() + 4 * estimateBrfLookupSek();
    expect(worstCase).toBeLessThan(CAP_VISION_SEK_MAX);
  });
});
