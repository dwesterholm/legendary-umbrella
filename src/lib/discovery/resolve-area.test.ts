import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * resolve-area.test.ts — proves the probe-then-seed BRANCHING logic + the
 * `pickBestSuggestion` ranker with a mocked transport. The live probe
 * interaction itself is exercised by a real Apify render (operator-approved
 * spend); these tests never invoke one.
 *
 * The suggestion fixtures below are a faithful subset of a REAL
 * `areaSuggestionSearch` response captured live 2026-07-09.
 */

const runPlaywrightRender = vi.fn();
vi.mock("@/lib/booli/transport", () => ({
  runPlaywrightRender: (...args: unknown[]) => runPlaywrightRender(...args),
}));

// Imported AFTER the mock is registered.
import { resolveArea, pickBestSuggestion } from "@/lib/discovery/resolve-area";
import { AREA_SEED, seedResolve } from "@/lib/discovery/area-seed";
import type { AreaSuggestion } from "@/lib/booli/area-suggestion-page-function";

function sug(overrides: Partial<AreaSuggestion>): AreaSuggestion {
  return {
    id: "0",
    type: "userDefined",
    typeDisplayName: "Område",
    displayName: "X",
    parent: "Stockholm",
    parentId: "1",
    parentDisplayName: "Stockholms kommun",
    ...overrides,
  };
}

// Faithful subset of the live "vasastan" capture (order preserved = Booli relevance).
const VASASTAN: AreaSuggestion[] = [
  sug({ type: "SubAdministrativeArea", typeDisplayName: "Stadsdel", id: "115349", displayName: "Vasastan", parent: "Stockholm", parentId: "1", parentDisplayName: "Stockholms kommun" }),
  sug({ type: "locality", typeDisplayName: "Stadsdel", id: "386735", displayName: "Vasastan", parent: "Linköping", parentId: "393", parentDisplayName: "Linköpings kommun" }),
  sug({ type: "userDefined", typeDisplayName: "Område", id: "1012465", displayName: "Vasastan", parent: "Göteborg", parentId: "22", parentDisplayName: "Göteborgs kommun" }),
  sug({ type: "undefined", typeDisplayName: "Område", id: "1015394", displayName: "Östermalm/Vasastan/Norra Djurgården", parent: "Stockholm", parentId: "1", parentDisplayName: "Stockholms kommun" }),
  sug({ type: "Street", typeDisplayName: "Gata", id: "90988", displayName: "Sankt Eriksgatan", parent: "Stockholm", parentId: "1", parentDisplayName: "Stockholms kommun" }),
];

/** Minimal area_cache-capable Supabase stub: one cached row + captured upserts. */
function makeSupabase(cacheRow: { area_id: string; label: string | null } | null) {
  const upserts: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: cacheRow, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  };
  return { client: client as unknown as Parameters<typeof resolveArea>[1], upserts };
}

beforeEach(() => {
  runPlaywrightRender.mockReset();
});

describe("pickBestSuggestion", () => {
  it("prefers the exact-name Stockholm district over same-name matches in other municipalities and over streets", () => {
    const best = pickBestSuggestion("Vasastan", VASASTAN);
    expect(best?.id).toBe("115349"); // Stockholm stadsdel, Booli-ranked first
  });

  it("ignores partial matches (compound area names) in favour of an exact display-name match", () => {
    // Only the compound "Östermalm/Vasastan/..." + a street would match loosely;
    // the exact "Vasastan" entries must win.
    const best = pickBestSuggestion("vasastan", VASASTAN);
    expect(best?.displayName).toBe("Vasastan");
  });

  it("falls back to the type-ranked first entry when no exact match exists", () => {
    const partialOnly: AreaSuggestion[] = [
      sug({ typeDisplayName: "Gata", id: "90988", displayName: "Sankt Eriksgatan" }),
      sug({ typeDisplayName: "Område", id: "1015394", displayName: "Östermalm/Vasastan/Norra Djurgården" }),
    ];
    // No exact "Vasastan" → prefer the Område over the Gata.
    expect(pickBestSuggestion("Vasastan", partialOnly)?.id).toBe("1015394");
  });

  it("returns null for an empty/absent suggestion list", () => {
    expect(pickBestSuggestion("Vasastan", [])).toBeNull();
    expect(pickBestSuggestion("Vasastan", null)).toBeNull();
    expect(pickBestSuggestion("Vasastan", undefined)).toBeNull();
  });
});

describe("resolveArea", () => {
  it("resolves via the probe to the best suggestion's areaId + label (non-seeded area)", async () => {
    // Hornstull is NOT in the seed, so resolution reaches the probe.
    runPlaywrightRender.mockResolvedValue([
      {
        hasApollo: true,
        suggestions: [
          sug({ type: "SubAdministrativeArea", typeDisplayName: "Stadsdel", id: "845555", displayName: "Hornstull", parent: "Stockholm", parentId: "1", parentDisplayName: "Stockholms kommun" }),
          sug({ type: "Street", typeDisplayName: "Gata", id: "90988", displayName: "Hornsgatan", parent: "Stockholm", parentId: "1", parentDisplayName: "Stockholms kommun" }),
        ],
      },
    ]);

    const result = await resolveArea("Hornstull");

    expect(result).toEqual({
      areaId: "845555",
      source: "probe",
      label: "Hornstull, Stockholms kommun",
    });
  });

  it("falls back to the seed list when the probe throws", async () => {
    runPlaywrightRender.mockRejectedValue(new Error("Booli-kallan blev inte klar i tid"));

    const result = await resolveArea("Södermalm");

    expect(result).toEqual({ areaId: AREA_SEED["södermalm"], source: "seed" });
  });

  it("falls back to the seed list when the probe returns no suggestions", async () => {
    runPlaywrightRender.mockResolvedValue([{ hasApollo: true, suggestions: [] }]);

    const result = await resolveArea("nacka");

    expect(result).toEqual({ areaId: AREA_SEED["nacka"], source: "seed" });
  });

  it("returns null when both the probe and the seed list miss", async () => {
    runPlaywrightRender.mockResolvedValue([{ hasApollo: true, suggestions: [] }]);

    const result = await resolveArea("Timbuktu");

    expect(result).toBeNull();
  });

  it("resolves the newly-seeded districts (Östermalm, Vasastan) even when the probe misses", async () => {
    runPlaywrightRender.mockResolvedValue([{ hasApollo: true, suggestions: [] }]);

    expect((await resolveArea("Östermalm"))?.areaId).toBe("115348");
    expect((await resolveArea("Vasastan"))?.areaId).toBe("115349");
  });
});

describe("resolveArea — area_cache (migration 012)", () => {
  it("returns a cached resolution first, without touching the seed or Booli", async () => {
    const { client } = makeSupabase({ area_id: "845555", label: "Hornstull, Stockholms kommun" });

    const result = await resolveArea("Hornstull", client);

    expect(result).toEqual({
      areaId: "845555",
      source: "cache",
      label: "Hornstull, Stockholms kommun",
    });
    expect(runPlaywrightRender).not.toHaveBeenCalled();
  });

  it("persists a probe hit to the cache so the next lookup is free", async () => {
    runPlaywrightRender.mockResolvedValue([
      {
        hasApollo: true,
        suggestions: [
          sug({ typeDisplayName: "Stadsdel", id: "845555", displayName: "Hornstull", parentDisplayName: "Stockholms kommun" }),
        ],
      },
    ]);
    const { client, upserts } = makeSupabase(null); // cache miss

    const result = await resolveArea("Hornstull", client);

    expect(result?.source).toBe("probe");
    expect(result?.areaId).toBe("845555");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ query_key: "hornstull", area_id: "845555", source: "probe" });
  });

  it("does not persist a seed hit (seed is already free, never cost Booli)", async () => {
    const { client, upserts } = makeSupabase(null); // cache miss → seed hit

    const result = await resolveArea("Södermalm", client);

    expect(result?.source).toBe("seed");
    expect(upserts).toHaveLength(0);
    expect(runPlaywrightRender).not.toHaveBeenCalled();
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
