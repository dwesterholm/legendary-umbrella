import { describe, it, expect } from "vitest";
// RED: src/lib/market/cost.ts does not exist yet — implemented in Plan 04.
// Mirrors the src/lib/brf/cost.ts shape: a published-rate const + an FX const
// (USD_SEK_RATE) + a pure cost function. The sold source is the Apify
// playwright-scraper render (spike: ~$0.0055/render, worst case ~$18/mo @ 800).
import {
  soldSourceCostSek,
  USD_SEK_RATE,
  SOLD_SOURCE_COST_CAP_SEK,
} from "@/lib/market/cost";

describe("USD_SEK_RATE / SOLD_SOURCE_COST_CAP_SEK — config constants", () => {
  it("exposes the USD/SEK rate as a configurable constant (not hardcoded in logic)", () => {
    expect(typeof USD_SEK_RATE).toBe("number");
    expect(USD_SEK_RATE).toBeGreaterThan(0);
  });

  it("exposes a documented per-analysis cost cap in SEK", () => {
    expect(typeof SOLD_SOURCE_COST_CAP_SEK).toBe("number");
    expect(SOLD_SOURCE_COST_CAP_SEK).toBeGreaterThan(0);
  });
});

describe("soldSourceCostSek — per-query cost guard (budget adherence)", () => {
  it("a typical single-render analysis (~$0.0055) stays well under the per-analysis cap", () => {
    const cost = soldSourceCostSek({ renders: 1 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(SOLD_SOURCE_COST_CAP_SEK);
  });

  it("even a 3-render (paginated) analysis stays under the cap", () => {
    const cost = soldSourceCostSek({ renders: 3 });
    expect(cost).toBeLessThan(SOLD_SOURCE_COST_CAP_SEK);
  });

  it("scales with render count (more renders cost more)", () => {
    const one = soldSourceCostSek({ renders: 1 });
    const three = soldSourceCostSek({ renders: 3 });
    expect(three).toBeGreaterThan(one);
  });
});
