import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brfFieldTrusted } from "@/lib/discovery/holistic-schema";
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";
import { estimateBrfLookupSek } from "@/lib/discovery/cost";
import {
  brfDebtPerSqmUsable,
  normalizeForConfounders,
  buildHolisticBrief,
} from "@/lib/discovery/confounder-guard";

/**
 * brf-lookup.test.ts — mocks ONLY the network/LLM edges
 * (`@/lib/brf-source/allabrf`'s `searchAllabrfByName`/`fetchAllabrfDocument`
 * and `@/lib/brf/extract`'s `extractBrfFinancials`). `@/lib/brf-source/
 * org-nr-resolver`'s `resolveOrgNr`, `@/lib/brf/run-extraction`'s
 * `scoreExtraction`, `@/lib/brf/cost`'s `costSek`, and
 * `@/lib/discovery/holistic-schema` all run for REAL so the confidence gate
 * and the genitive-kommun normalization (plan 14-03 Task 1) are genuinely
 * exercised, not assumed. Mirrors `allabrf.test.ts`'s mock-the-edge style and
 * `job.test.ts`'s file-order discipline (vi.mock factories declared BEFORE
 * the module import).
 */

const searchAllabrfByName = vi.fn();
const fetchAllabrfDocument = vi.fn();
vi.mock("@/lib/brf-source/allabrf", () => ({
  searchAllabrfByName: (...args: unknown[]) => searchAllabrfByName(...args),
  fetchAllabrfDocument: (...args: unknown[]) => fetchAllabrfDocument(...args),
}));

const extractBrfFinancials = vi.fn();
vi.mock("@/lib/brf/extract", () => ({
  extractBrfFinancials: (...args: unknown[]) => extractBrfFinancials(...args),
}));

const { lookupBrfSummary, BRF_TOP_N } = await import("@/lib/discovery/brf-lookup");

const VALID_ORG_NR = "5560360793";
const ANOTHER_VALID_ORG_NR = "2120000142";

/** A minimal, valid `BrfExtraction`-shaped fixture for the "ok" path. */
function extractionFixture() {
  return {
    skuldPerKvm: { value: 5000, confidence: 0.9, sourceQuote: "skuld: 5000", pageRef: 3 },
    avgiftsniva: { value: 600, confidence: 0.9, sourceQuote: "avgift: 600", pageRef: 3 },
    kassaflode: { value: 100000, confidence: 0.8, sourceQuote: null, pageRef: null },
    underhallsplanStatus: {
      value: "finns_aktuell" as const,
      confidence: 0.7,
      sourceQuote: null,
      pageRef: null,
    },
    stambytePlanerat: {
      value: "planerat" as const,
      confidence: 0.6,
      sourceQuote: null,
      pageRef: null,
    },
    storreRenoveringar: { value: "", confidence: 0, sourceQuote: null, pageRef: null },
    ovrigaAnmarkningar: { value: "", confidence: 0, sourceQuote: null, pageRef: null },
  };
}

describe("lookupBrfSummary", () => {
  beforeEach(() => {
    searchAllabrfByName.mockReset();
    fetchAllabrfDocument.mockReset();
    extractBrfFinancials.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"no_name" — a null brfName never calls the search primitive', async () => {
    const result = await lookupBrfSummary({
      brfName: null,
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({ summary: null, costSek: 0, outcome: "no_name" });
    expect(searchAllabrfByName).not.toHaveBeenCalled();
    await expect(
      lookupBrfSummary({ brfName: null, kommun: "Stockholm", tenureForm: null }),
    ).resolves.toBeDefined();
  });

  it('"no_candidates" — an empty search result degrades cleanly', async () => {
    searchAllabrfByName.mockResolvedValue([]);

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({ summary: null, costSek: 0, outcome: "no_candidates" });
    await expect(
      lookupBrfSummary({ brfName: "Brf Björken 3", kommun: "Stockholm", tenureForm: null }),
    ).resolves.toBeDefined();
  });

  it('"low_confidence" (ambiguous) — two same-name candidates never reach the document fetch', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
      { orgNr: ANOTHER_VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result.outcome).toBe("low_confidence");
    expect(result.summary).toBeNull();
    expect(fetchAllabrfDocument).not.toHaveBeenCalled();
  });

  it('"low_confidence" (geo mismatch) — a single name match with a non-corroborating kommun never reaches the document fetch', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Göteborg" },
    ]);

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result.outcome).toBe("low_confidence");
    expect(result.summary).toBeNull();
    expect(fetchAllabrfDocument).not.toHaveBeenCalled();
  });

  it('"no_document" — a high-confidence match whose document fetch fails never reaches extraction', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue(null);

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({ summary: null, costSek: 0, outcome: "no_document" });
    expect(extractBrfFinancials).not.toHaveBeenCalled();
  });

  it('"extract_failed" — CLAUDE_REFUSAL charges ONE billed call and never logs the document text', async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "SECRET_DOCUMENT_TEXT_FIXTURE — should never be logged",
      fiscalYear: 2023,
      availableYears: [2023],
    });
    extractBrfFinancials.mockRejectedValue(new Error("CLAUDE_REFUSAL"));

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({
      summary: null,
      costSek: estimateBrfLookupSek(),
      outcome: "extract_failed",
    });
    expect(errorSpy).toHaveBeenCalled();
    for (const call of errorSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("SECRET_DOCUMENT_TEXT_FIXTURE");
      expect(serialized).toContain("CLAUDE_REFUSAL");
    }
  });

  it('"extract_failed" — CLAUDE_PARSE_EMPTY charges ONE billed call', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2023,
      availableYears: [2023],
    });
    extractBrfFinancials.mockRejectedValue(new Error("CLAUDE_PARSE_EMPTY"));

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({
      summary: null,
      costSek: estimateBrfLookupSek(),
      outcome: "extract_failed",
    });
  });

  it('"extract_failed" — CLAUDE_MAX_TOKENS charges TWO billed calls (the real retry-then-throw path)', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2023,
      availableYears: [2023],
    });
    extractBrfFinancials.mockRejectedValue(new Error("CLAUDE_MAX_TOKENS"));

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({
      summary: null,
      costSek: 2 * estimateBrfLookupSek(),
      outcome: "extract_failed",
    });
  });

  it('"extract_failed" — CLAUDE_CALL_FAILED (no billed call completed) charges 0 SEK', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2023,
      availableYears: [2023],
    });
    extractBrfFinancials.mockRejectedValue(new Error("CLAUDE_CALL_FAILED"));

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result).toEqual({ summary: null, costSek: 0, outcome: "extract_failed" });
  });

  it('"ok" — a genitive listing kommun ("Stockholms") corroborates a nominative registry kommun ("Stockholm") end-to-end', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Bostadsrättsföreningen Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2024,
      availableYears: [2024],
    });
    extractBrfFinancials.mockResolvedValue({
      parsed: extractionFixture(),
      usage: { input_tokens: 1000, output_tokens: 500 },
      citations: [],
    });

    const bostadsrattResult = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholms",
      tenureForm: "Bostadsrätt",
    });

    expect(bostadsrattResult.outcome).toBe("ok");
    expect(bostadsrattResult.summary).not.toBeNull();
    expect(bostadsrattResult.summary?.source).toBe("allabrf");
    expect(bostadsrattResult.summary?.fiscalYear).toBe(2024);
    expect(bostadsrattResult.summary?.skuldPerKvm).toBe(5000);
    expect(bostadsrattResult.summary?.avgiftsniva).toBe(600);
    expect(bostadsrattResult.summary?.kassaflode).toBe(100000);
    expect(bostadsrattResult.summary?.stambytePlanerat).toBe("planerat");
    expect(bostadsrattResult.summary?.tomtratt).toBeNull();
    expect(bostadsrattResult.costSek).toBeGreaterThan(0);
    expect(bostadsrattResult.summary?.fieldConfidence).toEqual({
      skuldPerKvm: 0.9,
      avgiftsniva: 0.9,
      kassaflode: 0.8,
    });

    const tomtrattResult = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholms",
      tenureForm: "Tomträtt",
    });
    expect(tomtrattResult.summary?.tomtratt).toBe(true);
  });

  it('"ok" — an out-of-band skuldPerKvm keeps its value but arrives UNTRUSTED (CR-02)', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2024,
      availableYears: [2024],
    });
    extractBrfFinancials.mockResolvedValue({
      parsed: {
        ...extractionFixture(),
        skuldPerKvm: {
          value: 480_000,
          confidence: 0.95,
          sourceQuote: "total skuld: 480 000",
          pageRef: 3,
        },
      },
      usage: { input_tokens: 1000, output_tokens: 500 },
      citations: [],
    });

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result.outcome).toBe("ok");
    expect(result.summary?.skuldPerKvm).toBe(480_000);
    expect(result.summary?.fieldConfidence?.skuldPerKvm).toBeLessThan(OSAKER_THRESHOLD);
    expect(brfFieldTrusted(result.summary, "skuldPerKvm")).toBe(false);
  });

  it("CR-02 re-review — a REAL high-debt extraction reaches brf_debt_high, the debt-inclusive basis, and the flagged prose", async () => {
    // The point of this test is that NOTHING here is a synthetic confidence
    // fixture: `scoreExtraction` -> `applySanityChecks` runs for real (only
    // the Allabrf/Claude edges are mocked), so the `BrfSummary` fed into the
    // confounder guard below is byte-for-byte what production produces for a
    // genuinely, dangerously indebted förening. 14-VERIFICATION.md's ANL-04
    // gap was precisely that the only test reaching `brf_debt_high` used a
    // hand-set `fieldConfidence: 0.9` that bypassed this chain.
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2024,
      availableYears: [2024],
    });
    extractBrfFinancials.mockResolvedValue({
      parsed: {
        ...extractionFixture(),
        skuldPerKvm: {
          value: 30_000,
          confidence: 0.95,
          sourceQuote: "räntebärande skuld per kvm: 30 000",
          pageRef: 7,
        },
      },
      usage: { input_tokens: 1000, output_tokens: 500 },
      citations: [],
    });

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    // The real pipeline DOES band-downgrade this value — that is the shape.
    expect(result.outcome).toBe("ok");
    expect(result.summary?.skuldPerKvm).toBe(30_000);
    expect(result.summary?.fieldConfidence?.skuldPerKvm).toBeLessThan(OSAKER_THRESHOLD);
    expect(brfFieldTrusted(result.summary, "skuldPerKvm")).toBe(false);
    // ...and it is nonetheless plausible, so the discovery path uses it.
    expect(brfDebtPerSqmUsable(result.summary)).toBe(true);

    const guard = normalizeForConfounders({
      pricePerSqm: 55_000,
      livingArea: 62,
      floor: 2,
      balcony: true,
      tenureForm: "Bostadsrätt",
      comps: null,
      brf: result.summary,
    });

    // (a) normalized INTO the price basis (SPEC §2.6 rule 1), not dropped.
    expect(guard.debtIncluded).toBe(true);
    expect(guard.effectivePricePerSqm).toBe(85_000);
    // (b) named as the SPEC §2.2 red flag (rule 5).
    expect(guard.residualDrivers).toContain("brf_debt_high");
    expect(guard.unknownConfounders).not.toContain("brf_unknown");

    // (c) rendered as FACT with the flag, not hedged as an unreadable figure.
    const brief = buildHolisticBrief({
      guard,
      comps: null,
      brf: result.summary,
      pricePerSqm: 55_000,
      livingArea: 62,
    });
    const brfItem = brief.items.find((i) => i.kind === "brf");
    expect(brfItem).toBeDefined();
    expect(brfItem!.text).toContain("30000 kr/kvm (högre än vanligt)");
  });

  it('"ok" — an out-of-band avgiftsniva keeps its value but arrives UNTRUSTED (CR-02)', async () => {
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2024,
      availableYears: [2024],
    });
    extractBrfFinancials.mockResolvedValue({
      parsed: {
        ...extractionFixture(),
        avgiftsniva: {
          value: 4_200,
          confidence: 0.9,
          sourceQuote: "avgift: 4200/mån",
          pageRef: 3,
        },
      },
      usage: { input_tokens: 1000, output_tokens: 500 },
      citations: [],
    });

    const result = await lookupBrfSummary({
      brfName: "Brf Björken 3",
      kommun: "Stockholm",
      tenureForm: null,
    });

    expect(result.outcome).toBe("ok");
    expect(result.summary?.avgiftsniva).toBe(4_200);
    expect(result.summary?.fieldConfidence?.avgiftsniva).toBeLessThan(OSAKER_THRESHOLD);
    expect(brfFieldTrusted(result.summary, "avgiftsniva")).toBe(false);
  });

  it("WR-06 — an Object.prototype member name as the error code charges 0, never NaN", async () => {
    // `code` is `error.message` — arbitrary. Indexing the billed-calls object
    // literal with "constructor" returned the Object function, which `?? 0`
    // does not catch, so `Object * number` produced NaN. That NaN reached
    // BrfResolution.spentSek and then runVisionPass's initialSpentSek, whose
    // Number.isFinite guard reset the shared pool to 0 — discarding the comps
    // spend with it.
    searchAllabrfByName.mockResolvedValue([
      { orgNr: VALID_ORG_NR, name: "Brf Björken 3", kommun: "Stockholm" },
    ]);
    fetchAllabrfDocument.mockResolvedValue({
      text: "DOC_TEXT_FIXTURE",
      fiscalYear: 2023,
      availableYears: [2023],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      extractBrfFinancials.mockRejectedValue(new Error(inherited));
      const result = await lookupBrfSummary({
        brfName: "Brf Björken 3",
        kommun: "Stockholm",
        tenureForm: null,
      });
      expect(result.outcome).toBe("extract_failed");
      expect(Number.isFinite(result.costSek)).toBe(true);
      expect(result.costSek).toBe(0);
    }

    errorSpy.mockRestore();
  });

  it(`BRF_TOP_N is pinned to 4, within the D-14-01 3-5 band`, () => {
    expect(BRF_TOP_N).toBe(4);
    expect(BRF_TOP_N).toBeGreaterThanOrEqual(3);
    expect(BRF_TOP_N).toBeLessThanOrEqual(5);
  });
});

describe("D-14-12 invariant — the discovery BRF path never touches the single-listing analysis table", () => {
  it("brf-lookup.ts's source contains none of the forbidden analyses-bound substrings", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/discovery/brf-lookup.ts"),
      "utf-8",
    );

    // Cheap structural guarantee (mirrors niche-score.test.ts's static-grep
    // invariant pattern) that the D-14-12 reuse boundary cannot be silently
    // crossed by a later edit: the discovery BRF orchestrator must compose
    // ONLY the reusable brf-source/brf primitives, never the single-listing
    // analysis table or its analysis-bound actions/extraction spine.
    expect(source).not.toContain("analyses");
    expect(source).not.toContain("runBrfExtraction");
    expect(source).not.toContain("resolveOrgNrAction");
    expect(source).not.toContain("confirmAndAnalyze");
    expect(source).not.toContain("@/lib/supabase");
  });
});
