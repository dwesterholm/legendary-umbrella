// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apifyClientMockFactory } from "@/lib/booli/__mocks__/apify-client";

// client.ts loads transport.ts, which constructs an ApifyClient at import time.
vi.mock("apify-client", () => apifyClientMockFactory());

// Imported AFTER the mock above is registered.
import { reshapeListingEntity } from "@/lib/booli/client";
import { toCandidate } from "@/lib/discovery/candidate";
import { candidateFactsSchema, factsFromDetail, type CandidateFacts } from "@/lib/discovery/listing-facts";
import {
  IN_VALUATION_SUFFIX,
  REASON_ORDER,
  REASON_THRESHOLDS,
  UPCOMING_SALE_REASON,
  avgiftPerSqmYear,
  coveredByModelOf,
  districtAvgiftMedians,
  isReasonFlagged,
  reasonCell,
  reasonsFor,
  residualReason,
  type ReasonRow,
} from "@/lib/discovery/watch-reasons";

const NO_MEDIANS = { medians: new Map<string, number | null>() };
const FIXTURE_DIR = join(__dirname, "..", "booli", "__fixtures__");

function facts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return candidateFactsSchema.parse(over);
}

function row(
  over: { facts?: Partial<CandidateFacts> | null; livingArea?: number | null; rooms?: number | null; upcomingSale?: boolean | null; district?: string } = {},
): ReasonRow {
  return {
    district: over.district ?? "Södermalm",
    facts: over.facts === null ? null : facts(over.facts ?? {}),
    candidate: {
      livingArea: over.livingArea === undefined ? 50 : over.livingArea,
      rooms: over.rooms === undefined ? 2 : over.rooms,
      upcomingSale: over.upcomingSale === undefined ? null : over.upcomingSale,
    },
  };
}

describe("REASON_THRESHOLDS", () => {
  it("holds the nine values (the plan's eight plus the R-14 rooms guard) in one table", () => {
    expect(REASON_THRESHOLDS).toEqual({
      daysOnMarketMin: 60,
      avgiftHighRatio: 1.25,
      brfDebtHighPerSqm: 10_000,
      sqmPerRoomMin: 14,
      sqmPerRoomMax: 30,
      sqmPerRoomMinRooms: 2,
      minRowsForMedian: 5,
      priceCutMinSek: 1,
      noElevatorFloorMin: 4,
    });
  });

  it("'snart till salu' is the last entry of REASON_ORDER (W3)", () => {
    expect(REASON_ORDER[REASON_ORDER.length - 1]).toBe("upcomingSale");
    expect(UPCOMING_SALE_REASON).toBe("snart till salu (ej budgivning än)");
    expect(REASON_ORDER).toHaveLength(12);
  });
});

describe("boundaries", () => {
  it.each([
    [59, []],
    [60, ["ute i 60 dagar"]],
    [61, ["ute i 61 dagar"]],
    [0, []],
  ])("days on market %i", (days, expected) => {
    expect(reasonsFor(row({ facts: { daysOnMarket: days } }), NO_MEDIANS)).toEqual(expected);
  });

  it("days on market null gives no reason", () => {
    expect(reasonsFor(row({ facts: { daysOnMarket: null } }), NO_MEDIANS)).toEqual([]);
  });

  // 50 kvm: avgift x 12 / 50. District median 1 000 kr/kvm/år.
  const ctx = { medians: new Map<string, number | null>([["Södermalm", 1000]]) };
  it("avgift ratio exactly 1.25 gives none", () => {
    // 4 167 x 12 / 40 = 1 250.1 would be above; use exact: 5 000 x 12 / 48 = 1 250.
    expect(reasonsFor(row({ livingArea: 48, rooms: 2, facts: { avgiftMonthlySek: 5000 } }), ctx)).toEqual([]);
  });
  it("avgift ratio above 1.25 names both numbers and the district", () => {
    // 5 001 x 12 / 48 = 1 250.25
    expect(reasonsFor(row({ livingArea: 48, rooms: 2, facts: { avgiftMonthlySek: 5001 } }), ctx)).toEqual([
      "hög avgift (1 250 kr/kvm/år mot 1 000 i Södermalm)",
    ]);
  });
  it("avgift 3 329 x 12 / 35 = 1 141.37 prints as '1 141' kr/kvm/år", () => {
    expect(avgiftPerSqmYear({ avgiftMonthlySek: 3329 }, 35)).toBeCloseTo(1141.37, 2);
    const small = { medians: new Map<string, number | null>([["Södermalm", 900]]) };
    expect(reasonsFor(row({ livingArea: 35, rooms: 2, facts: { avgiftMonthlySek: 3329 } }), small)).toEqual([
      "hög avgift (1 141 kr/kvm/år mot 900 i Södermalm)",
    ]);
  });
  it("a district without a median has no avgift reason", () => {
    expect(reasonsFor(row({ livingArea: 48, rooms: 2, facts: { avgiftMonthlySek: 9000 } }), NO_MEDIANS)).toEqual([]);
    const nullMedian = { medians: new Map<string, number | null>([["Södermalm", null]]) };
    expect(reasonsFor(row({ livingArea: 48, rooms: 2, facts: { avgiftMonthlySek: 9000 } }), nullMedian)).toEqual([]);
  });
  it("another district's median is not used", () => {
    const other = { medians: new Map<string, number | null>([["Kungsholmen", 100]]) };
    expect(reasonsFor(row({ livingArea: 48, rooms: 2, facts: { avgiftMonthlySek: 9000 } }), other)).toEqual([]);
  });

  it.each([
    [10_000, []],
    [10_001, ["hög föreningsskuld (10 001 kr/kvm)"]],
    [25_590, ["hög föreningsskuld (25 590 kr/kvm)"]],
    [1_171, []],
  ])("BRF debt %i kr/kvm", (debt, expected) => {
    const brf = { loanSek: 1, areaSqm: 1, reportYear: 2024, debtPerSqm: debt };
    expect(reasonsFor(row({ facts: { brf } }), NO_MEDIANS)).toEqual(expected);
  });
  it("BRF with a null debt gives no reason", () => {
    const brf = { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null };
    expect(reasonsFor(row({ facts: { brf } }), NO_MEDIANS)).toEqual([]);
  });

  it.each([
    [140, 10, []], // 14.0 per room
    [139, 10, ["ovanlig planlösning"]], // 13.9
    [300, 10, []], // 30.0
    [301, 10, ["ovanlig planlösning"]], // 30.1
    [50, 2, []], // 25
    [28, 2, []], // exactly 14 with two rooms
  ])("living area %d over %d rooms", (area, rooms, expected) => {
    expect(reasonsFor(row({ livingArea: area, rooms }), NO_MEDIANS)).toEqual(expected);
  });
  it.each([
    [35, 1], // 35 per room
    [44, 1], // 44 per room
    [10, 1], // 10 per room would be "too small" with 2 rooms, still no reason with 1 (R-14)
    [20, 1.5], // below the 2-room floor: no layout reason
  ])("R-14: %d kvm with %d room(s) never gets the layout reason", (area, rooms) => {
    expect(reasonsFor(row({ livingArea: area, rooms }), NO_MEDIANS)).toEqual([]);
  });
  it("R-14: the rule starts at exactly 2 rooms", () => {
    expect(reasonsFor(row({ livingArea: 27.9, rooms: 2 }), NO_MEDIANS)).toEqual(["ovanlig planlösning"]);
    expect(reasonsFor(row({ livingArea: 61, rooms: 2 }), NO_MEDIANS)).toEqual(["ovanlig planlösning"]);
  });
  it("missing rooms or area gives no layout reason", () => {
    expect(reasonsFor(row({ rooms: null }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ livingArea: null }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ rooms: 0 }), NO_MEDIANS)).toEqual([]);
  });

  it.each([
    [0, []],
    [1, ["prissänkt 1 kr"]],
    [50_000, ["prissänkt 50 000 kr"]],
    [600_000, ["prissänkt 600 000 kr"]],
    [-305_000, []], // the asking price went UP
  ])("price cut %i kr", (cut, expected) => {
    expect(reasonsFor(row({ facts: { priceCutSek: cut } }), NO_MEDIANS)).toEqual(expected);
  });

  it("floor 3 with no elevator on the detail page gives none, floor 4 names the floor", () => {
    expect(reasonsFor(row({ facts: { floor: 3, elevatorListed: false } }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: { floor: 4, elevatorListed: false } }), NO_MEDIANS)).toEqual(["ingen hiss angiven (vån 4)"]);
    expect(reasonsFor(row({ facts: { floor: 6, elevatorListed: false } }), NO_MEDIANS)).toEqual(["ingen hiss angiven (vån 6)"]);
  });
  it("elevator unknown (a card's 'not listed') or listed gives none, whatever the floor", () => {
    expect(reasonsFor(row({ facts: { floor: 5, elevatorListed: null } }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: { floor: 5, elevatorListed: true } }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: { floor: null, elevatorListed: false } }), NO_MEDIANS)).toEqual([]);
  });
});

describe("tenure, tomträtt, new construction, bidding", () => {
  it("Bostadsrätt in any case and a missing tenure give no tenure reason", () => {
    for (const t of ["Bostadsrätt", "bostadsrätt", "BOSTADSRÄTT", " Bostadsrätt ", null]) {
      expect(reasonsFor(row({ facts: { tenureForm: t } }), NO_MEDIANS)).toEqual([]);
    }
  });
  it("Äganderätt is named, lower case", () => {
    expect(reasonsFor(row({ facts: { tenureForm: "Äganderätt" } }), NO_MEDIANS)).toEqual(["upplåtelseform: äganderätt"]);
  });
  it("land lease true gives tomträtt; false and null give nothing", () => {
    expect(reasonsFor(row({ facts: { landLease: true } }), NO_MEDIANS)).toEqual(["tomträtt"]);
    expect(reasonsFor(row({ facts: { landLease: false } }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: { landLease: null } }), NO_MEDIANS)).toEqual([]);
  });
  it("new construction gives nyproduktion", () => {
    expect(reasonsFor(row({ facts: { isNewConstruction: true } }), NO_MEDIANS)).toEqual(["nyproduktion"]);
    expect(reasonsFor(row({ facts: { isNewConstruction: false } }), NO_MEDIANS)).toEqual([]);
  });
  it("bidding open, by flag or by status key, is named once", () => {
    expect(reasonsFor(row({ facts: { biddingOpen: true } }), NO_MEDIANS)).toEqual(["budgivning pågår"]);
    expect(reasonsFor(row({ facts: { statusKey: "biddingOpen" } }), NO_MEDIANS)).toEqual(["budgivning pågår"]);
    expect(reasonsFor(row({ facts: { biddingOpen: true, statusKey: "biddingOpen" } }), NO_MEDIANS)).toEqual(["budgivning pågår"]);
    expect(reasonsFor(row({ facts: { biddingOpen: false } }), NO_MEDIANS)).toEqual([]);
  });
});

describe("snart till salu (W3)", () => {
  it("the card status key gives the informational reason", () => {
    expect(reasonsFor(row({ facts: { statusKey: "upcomingSale" } }), NO_MEDIANS)).toEqual([UPCOMING_SALE_REASON]);
  });
  it("the candidate flag gives the same reason", () => {
    expect(reasonsFor(row({ upcomingSale: true }), NO_MEDIANS)).toEqual([UPCOMING_SALE_REASON]);
  });
  it("the candidate flag works without any facts", () => {
    expect(reasonsFor(row({ facts: null, upcomingSale: true }), NO_MEDIANS)).toEqual([UPCOMING_SALE_REASON]);
  });
  it("both at once give the reason once", () => {
    expect(reasonsFor(row({ facts: { statusKey: "upcomingSale" }, upcomingSale: true }), NO_MEDIANS)).toEqual([
      UPCOMING_SALE_REASON,
    ]);
  });
  it("sorts last, after a price cut", () => {
    expect(reasonsFor(row({ facts: { statusKey: "upcomingSale", priceCutSek: 50_000 } }), NO_MEDIANS)).toEqual([
      "prissänkt 50 000 kr",
      "snart till salu (ej budgivning än)",
    ]);
  });
  it("a flagged row whose only reason is this one shows the reason, not 'oförklarat fynd'", () => {
    const reasons = reasonsFor(row({ facts: { statusKey: "upcomingSale" } }), NO_MEDIANS);
    expect(reasonCell(reasons, true)).toBe("snart till salu (ej budgivning än)");
  });
  it("bidding status or null with the flag false or null gives no such reason", () => {
    expect(reasonsFor(row({ facts: { statusKey: "biddingOpen" }, upcomingSale: false }), NO_MEDIANS)).not.toContain(UPCOMING_SALE_REASON);
    expect(reasonsFor(row({ facts: { statusKey: null }, upcomingSale: null }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: { statusKey: null }, upcomingSale: false }), NO_MEDIANS)).toEqual([]);
  });
});

describe("order and joining", () => {
  it("lists reasons in the fixed order whatever the evaluation order", () => {
    const r = row({
      livingArea: 301,
      rooms: 10,
      facts: {
        // Set in reverse of the print order.
        statusKey: "upcomingSale",
        elevatorListed: false,
        floor: 5,
        brf: { loanSek: 1, areaSqm: 1, reportYear: 2024, debtPerSqm: 12_000 },
        daysOnMarket: 90,
        priceCutSek: 100_000,
        biddingOpen: true,
        isNewConstruction: true,
        landLease: true,
        tenureForm: "Äganderätt",
      },
    });
    expect(reasonsFor(r, NO_MEDIANS)).toEqual([
      "upplåtelseform: äganderätt",
      "tomträtt",
      "nyproduktion",
      "budgivning pågår",
      "prissänkt 100 000 kr",
      "ute i 90 dagar",
      "hög föreningsskuld (12 000 kr/kvm)",
      "ingen hiss angiven (vån 5)",
      "ovanlig planlösning",
      "snart till salu (ej budgivning än)",
    ]);
  });

  it("a row with two reasons shows both, comma-joined", () => {
    const reasons = reasonsFor(row({ facts: { priceCutSek: 50_000, daysOnMarket: 75 } }), NO_MEDIANS);
    expect(reasons).toEqual(["prissänkt 50 000 kr", "ute i 75 dagar"]);
    expect(reasonCell(reasons, true)).toBe("prissänkt 50 000 kr, ute i 75 dagar");
  });

  it("null facts give no reasons and do not crash", () => {
    expect(reasonsFor(row({ facts: null }), NO_MEDIANS)).toEqual([]);
  });
});

describe("reasonCell / isReasonFlagged", () => {
  it("empty reasons: flagged -> 'oförklarat fynd', unflagged -> '-'", () => {
    expect(reasonCell([], true)).toBe("oförklarat fynd");
    expect(reasonCell([], false)).toBe("-");
  });
  it("reasons are joined with a comma and a space", () => {
    expect(reasonCell(["a", "b"], true)).toBe("a, b");
    expect(reasonCell(["a"], false)).toBe("a");
  });
  it("only the residual flag and dold-defekt-risk flag a row", () => {
    expect(isReasonFlagged(["residualFlag"])).toBe(true);
    expect(isReasonFlagged(["hiddenDefectRisk"])).toBe(true);
    expect(isReasonFlagged(["ejBildtolkad"])).toBe(false);
    expect(isReasonFlagged(["expectedFinalOver4M", "renoUnknown", "utanförModellensStorlek", "notComparable"])).toBe(false);
    expect(isReasonFlagged([])).toBe(false);
  });
});

describe("avgiftPerSqmYear / districtAvgiftMedians", () => {
  const withAvgift = (avgift: number | null, area: number | null = 50, district = "Södermalm"): ReasonRow =>
    row({ district, livingArea: area, facts: { avgiftMonthlySek: avgift } });

  it("is monthly x 12 / area, and null when either is missing", () => {
    expect(avgiftPerSqmYear({ avgiftMonthlySek: 3000 }, 36)).toBe(1000);
    expect(avgiftPerSqmYear({ avgiftMonthlySek: null }, 36)).toBeNull();
    expect(avgiftPerSqmYear({ avgiftMonthlySek: 3000 }, null)).toBeNull();
    expect(avgiftPerSqmYear({ avgiftMonthlySek: 3000 }, 0)).toBeNull();
    expect(avgiftPerSqmYear(null, 36)).toBeNull();
  });

  it("4 rows with avgift in a district give no median", () => {
    const m = districtAvgiftMedians([1, 2, 3, 4].map((i) => withAvgift(i * 1000, 50, "Kungsholmen")));
    expect(m.get("Kungsholmen")).toBeNull();
  });

  it("5 rows give the median", () => {
    // per kvm per year: avgift x 12 / 60 = avgift / 5
    const m = districtAvgiftMedians([1000, 2000, 3000, 4000, 9000].map((a) => withAvgift(a, 60, "Kungsholmen")));
    expect(m.get("Kungsholmen")).toBe(600);
  });

  it("an even count gives the mean of the two middle values", () => {
    const m = districtAvgiftMedians([1000, 2000, 3000, 4000, 5000, 100_000].map((a) => withAvgift(a, 60)));
    expect(m.get("Södermalm")).toBe(700); // (600 + 800) / 2
  });

  it("rows with a null avgift or no area are ignored", () => {
    const rows = [
      ...[1000, 2000, 3000, 4000].map((a) => withAvgift(a, 60)),
      withAvgift(null, 60),
      withAvgift(5000, null),
    ];
    expect(districtAvgiftMedians(rows).get("Södermalm")).toBeNull(); // only 4 usable rows
    expect(districtAvgiftMedians([...rows, withAvgift(5000, 60)]).get("Södermalm")).toBe(600);
  });

  it("districts are separate", () => {
    const rows = [
      ...[1000, 2000, 3000, 4000, 5000].map((a) => withAvgift(a, 60, "Södermalm")),
      ...[100, 200].map((a) => withAvgift(a, 60, "Vasastan")),
    ];
    const m = districtAvgiftMedians(rows);
    expect(m.get("Södermalm")).toBe(600);
    expect(m.get("Vasastan")).toBeNull();
    expect(m.has("Kungsholmen")).toBe(false);
  });

  it("rows without facts do not count", () => {
    expect(districtAvgiftMedians([row({ facts: null })]).get("Södermalm")).toBeNull();
  });
});

describe("real anchors: facts built from captured Booli detail pages (2026-10-13)", () => {
  function fromFixture(n: 1 | 2 | 3): ReasonRow {
    const entity = JSON.parse(readFileSync(join(FIXTURE_DIR, `listing-detail-local-${n}.fixture.json`), "utf8"));
    const raw = reshapeListingEntity(entity);
    const c = toCandidate(raw);
    return {
      district: "Södermalm",
      facts: factsFromDetail(raw, { asOf: "2026-10-13" }),
      candidate: { livingArea: c.livingArea, rooms: c.rooms, upcomingSale: c.upcomingSale },
    };
  }

  it("listing 1: a 600 000 kr price cut, listed 53 days, 41 kvm / 2 rooms", () => {
    const reasons = reasonsFor(fromFixture(1), NO_MEDIANS);
    expect(reasonCell(reasons, true)).toBe("prissänkt 600 000 kr");
  });

  it("listing 2: the asking price went UP, nothing else fires, so a flagged row is an unexplained find", () => {
    const reasons = reasonsFor(fromFixture(2), NO_MEDIANS);
    expect(reasons).toEqual([]);
    expect(reasonCell(reasons, true)).toBe("oförklarat fynd");
    expect(reasonCell(reasons, false)).toBe("-");
  });

  it("listing 3: bidding is open", () => {
    expect(reasonCell(reasonsFor(fromFixture(3), NO_MEDIANS), true)).toBe("budgivning pågår");
  });
});

describe("source hygiene", () => {
  const source = readFileSync(join(__dirname, "watch-reasons.ts"), "utf8");
  it("never reads the card's sale-type field", () => {
    expect(source).not.toMatch(/saleType/);
  });
  it("imports no node module (pure)", () => {
    expect(source).not.toMatch(/^import .*node:(fs|path)/m);
  });
  it("has one thresholds table and the literal reason text", () => {
    expect(source.match(/export const REASON_THRESHOLDS/g)).toHaveLength(1);
    expect(source).toContain("snart till salu (ej budgivning än)");
  });
});

describe("'redan i värderingen' only for what the fitted model contains (D-05, R-02, T-14.4-17)", () => {
  const ctxMedian = { medians: new Map<string, number | null>([["Södermalm", 1000]]) };
  const everything = row({
    livingArea: 48,
    rooms: 2,
    facts: {
      avgiftMonthlySek: 5001,
      brf: { loanSek: 1, areaSqm: 1, reportYear: 2024, debtPerSqm: 12_000 },
      landLease: true,
      tenureForm: "Äganderätt",
    },
  });

  it("the suffix is the pinned text", () => {
    expect(IN_VALUATION_SUFFIX).toBe(" (redan i värderingen)");
  });

  it("with avgift and debt both in the model, both reasons end with the suffix", () => {
    const reasons = reasonsFor(everything, { ...ctxMedian, coveredByModel: { avgift: true, brfDebt: true } });
    expect(reasons).toContain("hög avgift (1 250 kr/kvm/år mot 1 000 i Södermalm) (redan i värderingen)");
    expect(reasons).toContain("hög föreningsskuld (12 000 kr/kvm) (redan i värderingen)");
  });

  it("the tomträtt reason is exactly 'tomträtt' and the tenure reason never says it, even with everything covered", () => {
    const reasons = reasonsFor(everything, { ...ctxMedian, coveredByModel: { avgift: true, brfDebt: true } });
    expect(reasons).toContain("tomträtt");
    expect(reasons).toContain("upplåtelseform: äganderätt");
    const others = reasons.filter((r) => r === "tomträtt" || r.startsWith("upplåtelseform"));
    expect(others.some((r) => r.includes("redan i värderingen"))).toBe(false);
  });

  it("a feature the model did not fit gets no suffix; only the covered one does", () => {
    const onlyAvgift = reasonsFor(everything, { ...ctxMedian, coveredByModel: { avgift: true, brfDebt: false } });
    expect(onlyAvgift.filter((r) => r.includes("redan i värderingen"))).toHaveLength(1);
    expect(onlyAvgift.find((r) => r.startsWith("hög föreningsskuld"))).toBe("hög föreningsskuld (12 000 kr/kvm)");
  });

  it("without coveredByModel, or with both false, no reason contains the suffix (today's texts unchanged)", () => {
    for (const ctx of [ctxMedian, { ...ctxMedian, coveredByModel: { avgift: false, brfDebt: false } }]) {
      const reasons = reasonsFor(everything, ctx);
      expect(reasons.some((r) => r.includes("redan i värderingen"))).toBe(false);
    }
  });

  it("coveredByModelOf is true for source 'fit' or 'prior', false for 'zeroed' or a missing feature", () => {
    const feat = (name: string, source: "fit" | "prior" | "zeroed") => ({ name, mean: 0, beta: 0, se: null, source });
    const covered = (features: ReturnType<typeof feat>[]) =>
      coveredByModelOf({ features } as unknown as Parameters<typeof coveredByModelOf>[0]);
    expect(covered([feat("avgiftPerSqmMonth", "fit"), feat("brfDebtPerSqm", "prior")])).toEqual({ avgift: true, brfDebt: true, stambyte: false });
    expect(covered([feat("avgiftPerSqmMonth", "zeroed"), feat("brfDebtPerSqm", "fit")])).toEqual({ avgift: false, brfDebt: true, stambyte: false });
    expect(covered([feat("brfDebtPerSqm", "zeroed")])).toEqual({ avgift: false, brfDebt: false, stambyte: false });
    expect(covered([])).toEqual({ avgift: false, brfDebt: false, stambyte: false });
  });
});

describe("residualReason (R-04)", () => {
  const result = { expectedFinalToPred: 0.75, askToPred: 0.6, gapSek: 812_345.6, residualPct: -0.25 };
  const bothCovered = { avgift: true, brfDebt: true };

  it("expected-final basis, both features in the valuation", () => {
    expect(residualReason(result, { residualSdLog: 0.115, basis: "expectedFinal", covered: bothCovered })).toBe(
      "ovanligt långt under modellpris: förv. slutpris -25,0 % mot modellen (gräns -20,5 %), skillnad 812 346 kr; avgift och föreningsskuld redan i värderingen",
    );
  });

  it("neither feature in the valuation", () => {
    expect(
      residualReason(result, { residualSdLog: 0.115, basis: "expectedFinal", covered: { avgift: false, brfDebt: false } }),
    ).toMatch(/; varken avgift eller föreningsskuld i värderingen$/);
  });

  it("one feature in the valuation names only that one", () => {
    expect(
      residualReason(result, { residualSdLog: 0.115, basis: "expectedFinal", covered: { avgift: true, brfDebt: false } }),
    ).toMatch(/; avgift redan i värderingen$/);
    expect(
      residualReason(result, { residualSdLog: 0.115, basis: "expectedFinal", covered: { avgift: false, brfDebt: true } }),
    ).toMatch(/; föreningsskuld redan i värderingen$/);
  });

  it("the asking basis says utgångspris and measures the asking ratio", () => {
    expect(residualReason(result, { residualSdLog: 0.115, basis: "asking", covered: bothCovered })).toBe(
      "ovanligt långt under modellpris: utgångspris -40,0 % mot modellen (gräns -20,5 %), skillnad 812 346 kr; avgift och föreningsskuld redan i värderingen",
    );
  });

  it("a missing ratio or gap does not crash and does not invent a number", () => {
    const text = residualReason(
      { expectedFinalToPred: null, askToPred: null, gapSek: null, residualPct: null },
      { residualSdLog: 0.115, basis: "expectedFinal", covered: bothCovered },
    );
    expect(text).toBe("ovanligt långt under modellpris");
  });
});

describe("stambyte reason (STAM-03, D-07)", () => {
  const stambyteRow = (over: Partial<CandidateFacts>) => row({ facts: over });
  const modelOf = (stambyteTerm?: { kept: boolean }) =>
    ({ features: [], ...(stambyteTerm === undefined ? {} : { stambyteTerm }) }) as unknown as Parameters<typeof coveredByModelOf>[0];

  it("'pagar' gives 'stambyte pågår' and the flagged cell is no longer an unexplained find", () => {
    const reasons = reasonsFor(stambyteRow({ stambyteStatus: "pagar" }), NO_MEDIANS);
    expect(reasons).toEqual(["stambyte pågår"]);
    expect(reasonCell(reasons, true)).toBe("stambyte pågår");
    expect(reasonCell(reasons, true)).not.toBe("oförklarat fynd");
  });

  it("'planerat' with a year names the year, without a year it says only 'stambyte planerat'", () => {
    expect(reasonsFor(stambyteRow({ stambyteStatus: "planerat", plannedStambyteYear: 2027 }), NO_MEDIANS)).toEqual([
      "stambyte planerat 2027",
    ]);
    expect(reasonsFor(stambyteRow({ stambyteStatus: "planerat", plannedStambyteYear: null }), NO_MEDIANS)).toEqual([
      "stambyte planerat",
    ]);
  });

  it("'genomfort' and an unknown status give no stambyte reason (absence is not 'no')", () => {
    expect(reasonsFor(stambyteRow({ stambyteStatus: "genomfort", lastStambyteYear: 2019 }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(stambyteRow({ stambyteStatus: null }), NO_MEDIANS)).toEqual([]);
    expect(reasonsFor(row({ facts: null }), NO_MEDIANS)).toEqual([]);
  });

  it("a row without any stambyte fact prints exactly what it printed before the reason existed", () => {
    const before = row({ facts: { daysOnMarket: 70, priceCutSek: 100_000 } });
    expect(reasonsFor(before, NO_MEDIANS)).toEqual(["prissänkt 100 000 kr", "ute i 70 dagar"]);
  });

  it("sits after 'hög föreningsskuld' and before 'ingen hiss angiven'; 'snart till salu' is still last", () => {
    const r = row({
      facts: {
        stambyteStatus: "pagar",
        brf: { loanSek: 1, areaSqm: 1, reportYear: 2024, debtPerSqm: 12_000 },
        elevatorListed: false,
        floor: 5,
        statusKey: "upcomingSale",
      },
    });
    const reasons = reasonsFor(r, NO_MEDIANS);
    expect(reasons).toEqual([
      "hög föreningsskuld (12 000 kr/kvm)",
      "stambyte pågår",
      "ingen hiss angiven (vån 5)",
      UPCOMING_SALE_REASON,
    ]);
    expect(REASON_ORDER.indexOf("stambyte")).toBe(REASON_ORDER.indexOf("highBrfDebt") + 1);
    expect(REASON_ORDER[REASON_ORDER.length - 1]).toBe("upcomingSale");
  });

  it("the suffix is added only when the model kept a stambyte term", () => {
    const planned = stambyteRow({ stambyteStatus: "planerat", plannedStambyteYear: 2027 });
    const ongoing = stambyteRow({ stambyteStatus: "pagar" });
    const kept = coveredByModelOf(modelOf({ kept: true }));
    expect(kept.stambyte).toBe(true);
    expect(reasonsFor(ongoing, { ...NO_MEDIANS, coveredByModel: kept })).toEqual(["stambyte pågår (redan i värderingen)"]);
    expect(reasonsFor(planned, { ...NO_MEDIANS, coveredByModel: kept })).toEqual([
      "stambyte planerat 2027 (redan i värderingen)",
    ]);
    for (const model of [modelOf({ kept: false }), modelOf(undefined)]) {
      const covered = coveredByModelOf(model);
      expect(covered.stambyte).toBe(false);
      expect(reasonsFor(ongoing, { ...NO_MEDIANS, coveredByModel: covered })).toEqual(["stambyte pågår"]);
    }
    expect(reasonsFor(ongoing, NO_MEDIANS)).toEqual(["stambyte pågår"]);
    expect(reasonsFor(ongoing, { ...NO_MEDIANS, coveredByModel: { avgift: true, brfDebt: true } })).toEqual(["stambyte pågår"]);
  });
});
