import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * resolve-area.test.ts — proves the probe-then-seed BRANCHING logic with a
 * mocked transport (09-02-PLAN.md Task 1's acceptance criteria). The live
 * probe interaction itself is a manual checkpoint (Task 2, operator-approved
 * Apify spend) — these tests never invoke a real Apify render.
 */

const runPlaywrightRender = vi.fn();
vi.mock("@/lib/booli/transport", () => ({
  runPlaywrightRender: (...args: unknown[]) => runPlaywrightRender(...args),
}));

// Imported AFTER the mock is registered.
import { resolveArea } from "@/lib/discovery/resolve-area";
import { AREA_SEED } from "@/lib/discovery/area-seed";
import { seedResolve } from "@/lib/discovery/area-seed";

beforeEach(() => {
  runPlaywrightRender.mockReset();
});

describe("resolveArea", () => {
  it("resolves via the probe when the render returns a usable areaIds= URL", async () => {
    runPlaywrightRender.mockResolvedValue([
      { hasApollo: true, resolvedUrl: "https://www.booli.se/sok/till-salu?areaIds=115341" },
    ]);

    const result = await resolveArea("Södermalm");

    expect(result).toEqual({ areaId: "115341", source: "probe" });
  });

  it("falls back to the seed list when the probe throws", async () => {
    runPlaywrightRender.mockRejectedValue(new Error("Booli-kallan blev inte klar i tid"));

    const result = await resolveArea("Södermalm");

    expect(result).toEqual({ areaId: AREA_SEED["södermalm"], source: "seed" });
  });

  it("falls back to the seed list when the probe returns no usable areaIds= value", async () => {
    runPlaywrightRender.mockResolvedValue([{ hasApollo: false, resolvedUrl: null }]);

    const result = await resolveArea("nacka");

    expect(result).toEqual({ areaId: AREA_SEED["nacka"], source: "seed" });
  });

  it("returns null when both the probe and the seed list miss", async () => {
    runPlaywrightRender.mockResolvedValue([{ hasApollo: false, resolvedUrl: null }]);

    const result = await resolveArea("Timbuktu");

    expect(result).toBeNull();
  });
});

describe("seedResolve", () => {
  it("matches case-insensitively and trims whitespace", () => {
    expect(seedResolve("  SÖDERMALM  ")).toBe(AREA_SEED["södermalm"]);
    expect(seedResolve("Nacka")).toBe(AREA_SEED["nacka"]);
  });

  it("does not false-match a near-miss name (exact match only, no .includes() fuzzy match)", () => {
    expect(seedResolve("Söder")).toBeNull();
    expect(seedResolve("Nack")).toBeNull();
    expect(seedResolve("Södermalmen")).toBeNull();
  });

  it("returns null for an unknown area name", () => {
    expect(seedResolve("Timbuktu")).toBeNull();
  });

  it("returns null for empty/non-string input without throwing", () => {
    expect(seedResolve("")).toBeNull();
    expect(seedResolve("   ")).toBeNull();
  });
});
