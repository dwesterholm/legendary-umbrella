import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression suite for `analyzeBrf`/`correctBrfField` post-runBrfExtraction
 * refactor (08-01-PLAN.md Task 3). NO real Supabase, NO real storage, NO
 * live Claude call: `@/lib/supabase/server`, `@/lib/supabase/storage`, and
 * `@/lib/brf/extract` are all mocked, mirroring the mocking shape
 * established in `analyze.test.ts`/`generate-report.test.ts`.
 *
 * The core contract under test: `analyzeBrf` delegating its body to
 * `runBrfExtraction` must be BYTE-IDENTICAL in observable behavior to the
 * pre-refactor implementation — these were `it.todo` placeholders until now.
 */

let mockUser: { id: string } | null = null;
let mockRow: {
  id: string;
  user_id: string;
  brf_pdf_hash: string | null;
  brf_data: unknown;
} | null = null;
let updateCalls: Array<Record<string, unknown>> = [];
let uploadCalls: Array<{ path: string; bytes: Uint8Array }> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: mockRow,
            error: mockRow ? null : { message: "not found" },
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          updateCalls.push(payload);
          if (mockRow) {
            mockRow = { ...mockRow, ...payload } as typeof mockRow;
          }
          return { error: null };
        },
      }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          uploadCalls.push({ path, bytes });
          return { error: null };
        },
      }),
    },
  }),
}));

const extractBrfFinancials = vi.fn();
vi.mock("@/lib/brf/extract", () => ({
  extractBrfFinancials: (...args: unknown[]) => extractBrfFinancials(...args),
}));

import { analyzeBrf, correctBrfField } from "@/actions/analyze-brf";

const USER_ID = "user-1";
const ANALYSIS_ID = "analysis-1";

/** A minimal, schema-valid extraction fixture Claude would return. */
function baseExtraction() {
  const field = <T,>(value: T) => ({
    value,
    confidence: 0.9,
    sourceQuote: "citat",
    pageRef: 1,
  });
  return {
    skuldPerKvm: field(12000),
    avgiftsniva: field(500),
    kassaflode: field(100000),
    underhallsplanStatus: field("finns_aktuell" as const),
    stambytePlanerat: field("ej_nämnt" as const),
    storreRenoveringar: field("Inga"),
    ovrigaAnmarkningar: field("Inga"),
  };
}

function baseUsage(overrides: Partial<Record<string, number>> = {}) {
  return {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

function pdfFile(bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], "arsredovisning.pdf", {
    type: "application/pdf",
  });
}

function formDataFor(analysisId: string, file: File): FormData {
  const fd = new FormData();
  fd.set("analysisId", analysisId);
  fd.set("file", file);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls = [];
  uploadCalls = [];
  mockUser = { id: USER_ID };
  mockRow = {
    id: ANALYSIS_ID,
    user_id: USER_ID,
    brf_pdf_hash: null,
    brf_data: null,
  };
  extractBrfFinancials.mockResolvedValue({
    parsed: baseExtraction(),
    usage: baseUsage(),
    citations: [],
  });
});

describe("analyze-brf server action — module surface", () => {
  it("exports the analyzeBrf server action", () => {
    expect(typeof analyzeBrf).toBe("function");
  });

  it("exports the correctBrfField server action", () => {
    expect(typeof correctBrfField).toBe("function");
  });
});

describe("analyze-brf — deeper behavior (Plan 04 / 08-01 regression)", () => {
  it("hard-blocks guest (unauthenticated) uploads per D-05", async () => {
    mockUser = null;

    const result = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Logga in för BRF-analys");
    expect(extractBrfFinancials).not.toHaveBeenCalled();
  });

  it("enforces RLS — a user cannot read another user's BRF analysis", async () => {
    mockRow = {
      id: ANALYSIS_ID,
      user_id: "someone-else",
      brf_pdf_hash: null,
      brf_data: null,
    };

    const result = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Analysen hittades inte.");
    expect(extractBrfFinancials).not.toHaveBeenCalled();
  });

  it("D-06 replace: re-running on the same analysis re-extracts and overwrites", async () => {
    const first = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile([1, 2, 3])));
    expect(first.ok).toBe(true);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);

    // Different PDF content (different hash) — re-run must call extraction
    // again and overwrite the stored result, not reuse the cache.
    extractBrfFinancials.mockResolvedValueOnce({
      parsed: { ...baseExtraction(), avgiftsniva: { value: 999, confidence: 0.9, sourceQuote: "citat", pageRef: 1 } },
      usage: baseUsage(),
      citations: [],
    });
    const second = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile([9, 9, 9])));

    expect(second.ok).toBe(true);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(2);
    if (second.ok) {
      expect(second.data.extraction.avgiftsniva.value).toBe(999);
    }
  });

  it("content-hash skip: an identical PDF reuses the prior extraction (no re-bill)", async () => {
    const first = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile([1, 2, 3])));
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.cached).toBe(false);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);

    const second = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile([1, 2, 3])));

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.cached).toBe(true);
    // Zero additional calls — the D-06 cache must skip re-extraction entirely.
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);
  });

  it("correctBrfField re-runs normalize+score only, never the Claude call (D-12)", async () => {
    const initial = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));
    expect(initial.ok).toBe(true);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);

    const fd = new FormData();
    fd.set("analysisId", ANALYSIS_ID);
    fd.set("field", "avgiftsniva");
    fd.set("value", "777");

    const corrected = await correctBrfField(fd);

    expect(corrected.ok).toBe(true);
    if (corrected.ok) {
      expect(corrected.data.extraction.avgiftsniva.value).toBe(777);
      expect(corrected.data.manualFields).toContain("avgiftsniva");
    }
    // No additional extraction calls from the correction.
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);
  });

  it("aborts the run if projected cost exceeds the 5 SEK hard cap", async () => {
    // A huge token count drives costSek() well above COST_CAP_SEK (5).
    extractBrfFinancials.mockResolvedValueOnce({
      parsed: baseExtraction(),
      usage: baseUsage({ input_tokens: 50_000_000, output_tokens: 5_000_000 }),
      citations: [],
    });

    const result = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "Analysen avbröts (kostnadstaket nåddes). Försök igen senare.",
      );
    }
    const failedWrite = updateCalls.find((c) => c.brf_status === "failed");
    expect(failedWrite).toBeDefined();
  });

  it("writes failed status and returns the schema-invalid error when extraction returns malformed output", async () => {
    extractBrfFinancials.mockResolvedValueOnce({
      // Missing required fields — fails brfExtractionSchema.safeParse.
      parsed: {},
      usage: baseUsage(),
      citations: [],
    });

    const result = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "Vi kunde inte läsa dokumentet automatiskt — fyll i uppgifterna manuellt.",
      );
    }
    const failedWrite = updateCalls.find((c) => c.brf_status === "failed");
    expect(failedWrite).toBeDefined();
  });

  it("uploads the PDF via the manual path and persists brf_fetch_source: 'manual'", async () => {
    const result = await analyzeBrf(formDataFor(ANALYSIS_ID, pdfFile()));

    expect(result.ok).toBe(true);
    expect(uploadCalls).toHaveLength(1);
    const terminalWrite = updateCalls.find((c) => c.brf_status === "done");
    expect(terminalWrite?.brf_fetch_source).toBe("manual");
  });
});
