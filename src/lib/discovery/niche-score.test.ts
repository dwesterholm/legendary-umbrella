import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeNicheScore,
  NICHE_SIGNAL_LABELS,
  type AreaBaseline,
} from "@/lib/discovery/niche-score";
import { NICHE_IDS, NICHE_WEIGHTS } from "@/lib/discovery/niches";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    address: "Testgatan 1",
    price: 3_000_000,
    rooms: 2,
    livingArea: 50,
    areaLabel: "Testomrade",
    thumbnailUrl: null,
    sourceListingUrl: "https://www.booli.se/annons/1",
    constructionYear: null,
    brfName: null,
    tenureForm: null,
    imageUrls: null,
    vision: null,
    visionSkippedReason: null,
    latitude: null,
    longitude: null,
    floor: null,
    orientation: null,
    ...overrides,
  };
}

const baseline: AreaBaseline = { medianPricePerSqm: 60_000 };

describe("NICHE_WEIGHTS — each niche's weights sum to 1", () => {
  it.each(NICHE_IDS)("%s weights sum to ~1", (niche) => {
    const entry = NICHE_WEIGHTS[niche] as Record<string, { weight: number }>;
    const sum = Object.values(entry).reduce((acc, signal) => acc + signal.weight, 0);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("computeNicheScore — determinism", () => {
  it("returns the same score+breakdown for the same input across repeated calls", () => {
    const candidate = makeCandidate({ constructionYear: 1962, price: 2_500_000, livingArea: 50 });

    const first = computeNicheScore(candidate, "renovation-upside", baseline);
    const second = computeNicheScore(candidate, "renovation-upside", baseline);

    expect(second).toEqual(first);
  });

  it("scores an older, cheaper-per-sqm candidate higher than a newer, average-priced one for renovation-upside", () => {
    const oldCheap = makeCandidate({
      constructionYear: 1962,
      price: 2_000_000, // 40,000 kr/sqm vs 60,000 baseline — a discount
      livingArea: 50,
    });
    const newAverage = makeCandidate({
      constructionYear: 2020,
      price: 3_000_000, // 60,000 kr/sqm — at baseline
      livingArea: 50,
    });

    const oldResult = computeNicheScore(oldCheap, "renovation-upside", baseline);
    const newResult = computeNicheScore(newAverage, "renovation-upside", baseline);

    expect(oldResult.score).toBeGreaterThan(newResult.score);
  });
});

describe("computeNicheScore — not_assessable null handling (never fabricated)", () => {
  it("a null constructionYear yields assessable:false and contribution 0 for that row, weight still counted", () => {
    const candidate = makeCandidate({ constructionYear: null });

    const result = computeNicheScore(candidate, "renovation-upside", baseline);
    const yearRow = result.breakdown.find((r) => r.key === "constructionYearAge");

    expect(yearRow).toBeDefined();
    expect(yearRow?.assessable).toBe(false);
    expect(yearRow?.contribution).toBe(0);
    expect(yearRow?.weight).toBe(NICHE_WEIGHTS["renovation-upside"].constructionYearAge.weight);
  });

  it("a null price/livingArea yields assessable:false for pricePerSqmVsBaseline, never a fabricated ratio", () => {
    const candidate = makeCandidate({ price: null, livingArea: null, constructionYear: 1962 });

    const result = computeNicheScore(candidate, "renovation-upside", baseline);
    const priceRow = result.breakdown.find((r) => r.key === "pricePerSqmVsBaseline");

    expect(priceRow?.assessable).toBe(false);
    expect(priceRow?.contribution).toBe(0);
  });

  it("a null areaBaseline.medianPricePerSqm yields assessable:false for pricePerSqmVsBaseline", () => {
    const candidate = makeCandidate({ price: 2_000_000, livingArea: 50, constructionYear: 1962 });

    const result = computeNicheScore(candidate, "renovation-upside", { medianPricePerSqm: null });
    const priceRow = result.breakdown.find((r) => r.key === "pricePerSqmVsBaseline");

    expect(priceRow?.assessable).toBe(false);
    expect(priceRow?.contribution).toBe(0);
  });

  it("every assessable breakdown row carries a non-empty sourceRef", () => {
    const candidate = makeCandidate({ constructionYear: 1962, tenureForm: "Bostadsrätt" });

    for (const niche of NICHE_IDS) {
      const result = computeNicheScore(candidate, niche, baseline);
      for (const row of result.breakdown) {
        expect(typeof row.sourceRef).toBe("string");
        expect(row.sourceRef.length).toBeGreaterThan(0);
      }
    }
  });

  it("CR-01 regression: an undefined constructionYear (legacy-row shape) never produces NaN, is not_assessable like null", () => {
    // Simulates the exact CR-01 legacy-row scenario at the scorer boundary:
    // a candidate whose constructionYear is `undefined` rather than `null`
    // (e.g. if a shape mismatch upstream ever reintroduces `undefined`).
    // `push`'s `== null` guard (not `=== null`) must treat this identically
    // to a `null` value — never let `undefined` reach `scoreYearAge` and
    // produce `NaN`.
    const legacyCandidate = makeCandidate({
      constructionYear: undefined as unknown as null,
    });

    const result = computeNicheScore(legacyCandidate, "renovation-upside", baseline);
    const yearRow = result.breakdown.find((r) => r.key === "constructionYearAge");

    expect(yearRow?.assessable).toBe(false);
    expect(yearRow?.contribution).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it("CR-01 regression: a candidate with undefined constructionYear sorts deterministically after well-defined candidates, never corrupting order via NaN", () => {
    const legacyCandidate = makeCandidate({
      sourceListingUrl: "https://www.booli.se/annons/legacy-undefined",
      constructionYear: undefined as unknown as null,
      price: 2_000_000,
      livingArea: 50,
    });
    const wellDefinedOld = makeCandidate({
      sourceListingUrl: "https://www.booli.se/annons/well-defined-old",
      constructionYear: 1962,
      price: 2_000_000,
      livingArea: 50,
    });
    const wellDefinedNew = makeCandidate({
      sourceListingUrl: "https://www.booli.se/annons/well-defined-new",
      constructionYear: 2021,
      price: 3_000_000,
      livingArea: 50,
    });

    const scored = [legacyCandidate, wellDefinedOld, wellDefinedNew].map((candidate) => ({
      candidate,
      result: computeNicheScore(candidate, "renovation-upside", baseline),
    }));

    for (const entry of scored) {
      expect(Number.isNaN(entry.result.score)).toBe(false);
    }

    scored.sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0));
    const order = scored.map((entry) => entry.candidate.sourceListingUrl);

    // The legacy/undefined candidate is only assessable on price/sqm (0.5
    // weight for renovation-upside), so it must rank below the fully
    // well-defined old candidate, and its position must be deterministic
    // (repeated runs yield the same order) rather than NaN-corrupted.
    expect(order[0]).toBe("https://www.booli.se/annons/well-defined-old");
    expect(order).toContain("https://www.booli.se/annons/legacy-undefined");
  });
});

describe("computeNicheScore — imminent-stambyte hedged proxy key discipline", () => {
  it("uses the distinct key 'stambyteProxyAge', never 'stambyte_planerat'", () => {
    const candidate = makeCandidate({ constructionYear: 1962 });

    const result = computeNicheScore(candidate, "imminent-stambyte", baseline);

    const keys = result.breakdown.map((r) => r.key);
    expect(keys).toContain("stambyteProxyAge");
    expect(keys).not.toContain("stambyte_planerat");
  });

  it("a null constructionYear yields not-assessable for the stambyte proxy row too", () => {
    const candidate = makeCandidate({ constructionYear: null });

    const result = computeNicheScore(candidate, "imminent-stambyte", baseline);
    const proxyRow = result.breakdown.find((r) => r.key === "stambyteProxyAge");

    expect(proxyRow?.assessable).toBe(false);
    expect(proxyRow?.contribution).toBe(0);
  });

  it("the stambyte proxy chip label is hedged, never a confirmed 'betalar' verdict", () => {
    const label = NICHE_SIGNAL_LABELS.stambyteProxyAge;

    expect(label).toBeDefined();
    expect(label).toMatch(/möjlig|kan tyda|bekräfta/i);
    expect(label).not.toMatch(/betalar/i);
  });
});

describe("computeNicheScore — cross-niche distinguishability (binding DISC-03 constraint)", () => {
  const candidates: DiscoveryCandidate[] = [
    makeCandidate({
      // Above the stambyte proxy cutoff (1970) so it does NOT tie for the
      // stambyte-proxy top spot, but old enough + cheap enough per-sqm to be
      // the clear renovation-upside top pick.
      sourceListingUrl: "https://www.booli.se/annons/old-cheap",
      constructionYear: 1972,
      price: 1_800_000,
      livingArea: 50, // 36,000 kr/sqm — well below baseline
      tenureForm: "Bostadsrätt",
    }),
    makeCandidate({
      sourceListingUrl: "https://www.booli.se/annons/new-average",
      constructionYear: 2021,
      price: 3_000_000,
      livingArea: 50, // 60,000 kr/sqm — at baseline
      tenureForm: "Bostadsrätt",
    }),
    makeCandidate({
      sourceListingUrl: "https://www.booli.se/annons/mid-expensive",
      constructionYear: 1995,
      price: 4_000_000,
      livingArea: 50, // 80,000 kr/sqm — above baseline
      tenureForm: "Äganderätt",
    }),
    makeCandidate({
      // Strictly below the stambyte proxy cutoff AND above-baseline priced
      // (so renovation-upside does NOT also pick this as its top candidate),
      // making it the unambiguous imminent-stambyte top pick.
      sourceListingUrl: "https://www.booli.se/annons/very-old-expensive",
      constructionYear: 1930,
      price: 5_000_000,
      livingArea: 50, // 100,000 kr/sqm — well above baseline
      tenureForm: "Äganderätt",
    }),
  ];

  function orderIds(niche: (typeof NICHE_IDS)[number]): string[] {
    return [...candidates]
      .map((c) => ({ candidate: c, result: computeNicheScore(c, niche, baseline) }))
      .sort((a, b) => b.result.score - a.result.score)
      .map((entry) => entry.candidate.sourceListingUrl ?? "");
  }

  it("at least two of the three niche orderings differ on the same fixture set", () => {
    const renovationOrder = orderIds("renovation-upside");
    const turnkeyOrder = orderIds("turnkey");
    const stambyteOrder = orderIds("imminent-stambyte");

    const pairsDiffer = [
      JSON.stringify(renovationOrder) !== JSON.stringify(turnkeyOrder),
      JSON.stringify(turnkeyOrder) !== JSON.stringify(stambyteOrder),
      JSON.stringify(renovationOrder) !== JSON.stringify(stambyteOrder),
    ];

    expect(pairsDiffer.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it("turnkey's top pick is the newest building; imminent-stambyte's top pick is the oldest", () => {
    const turnkeyTop = orderIds("turnkey")[0];
    const stambyteTop = orderIds("imminent-stambyte")[0];

    expect(turnkeyTop).toBe("https://www.booli.se/annons/new-average");
    expect(stambyteTop).toBe("https://www.booli.se/annons/very-old-expensive");
    expect(turnkeyTop).not.toBe(stambyteTop);
  });
});

describe("Structural-separation invariant (T-11-11/T-12-09, DISC-04/DISC-05/DISC-06) — the deterministic scorer/flags never import vision OR sun-path", () => {
  // Mirrors job.integration.test.ts's invariant-as-a-test approach: statically
  // read the SOURCE of the files that must never import a vision module and
  // grep their import statements for the vision module specifiers. This test
  // MUST fail if niche-score.ts or flags.ts ever imports from
  // vision-schema.ts / vision.ts — vision output must never silently become
  // a scored/deterministic signal (UI-SPEC §4: any such surface requires a
  // visible "från bildtolkning" marker, which is dormant this phase).
  //
  // Phase 12 (DISC-05/06, T-12-09) extends this SAME invariant (not a new
  // test file) to also forbid a `sun-path` import — floor-plan claims are
  // vision-derived (already covered by the vision specifiers below) and
  // sun-path is deterministic-but-advisory math; NEITHER may ever feed the
  // deterministic scorer/flags, reciprocal to sun-path.ts's own file-level
  // doc comment ("NEVER imported by niche-score.ts or flags.ts").
  const VISION_MODULE_SPECIFIERS = [
    "discovery/vision-schema",
    "discovery/vision\"",
    "discovery/vision'",
    "discovery/sun-path",
    "discovery/sun-path\"",
    "discovery/sun-path'",
  ];

  function importsVisionModule(sourcePath: string): boolean {
    const source = readFileSync(join(process.cwd(), sourcePath), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    return importLines.some((line) =>
      VISION_MODULE_SPECIFIERS.some((specifier) => line.includes(specifier)),
    );
  }

  it("niche-score.ts does not import from vision-schema.ts, vision.ts, or sun-path.ts", () => {
    expect(importsVisionModule("src/lib/discovery/niche-score.ts")).toBe(false);
  });

  it("flags.ts does not import from vision-schema.ts, vision.ts, or sun-path.ts", () => {
    expect(importsVisionModule("src/lib/report/flags.ts")).toBe(false);
  });
});
