import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mocks the Supabase server client with an in-memory `analyses` row + a
 * fake storage bucket, mirroring the mocking shape established in
 * `src/actions/analyze.test.ts`. Mutable per-test state so each test can
 * seed a fresh row without re-registering vi.mock.
 */
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

import { runBrfExtraction, type BrfDocumentSource } from "@/lib/brf/run-extraction";

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

function baseUsage() {
  return {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls = [];
  uploadCalls = [];
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

describe("run-extraction — module surface", () => {
  it("exports the runBrfExtraction shared core", () => {
    expect(typeof runBrfExtraction).toBe("function");
  });

  it("exports the BrfDocumentSource type (compile-time surface check)", () => {
    const pdfSource: BrfDocumentSource = { kind: "pdf", bytes: new Uint8Array() };
    const textSource: BrfDocumentSource = { kind: "ixbrl-text", text: "" };
    expect(pdfSource.kind).toBe("pdf");
    expect(textSource.kind).toBe("ixbrl-text");
  });
});

describe("run-extraction — two-source equivalence", () => {
  it("produces the same BrfData shape for kind:'pdf' and kind:'ixbrl-text' given equivalent Claude output", async () => {
    const pdfResult = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "pdf", bytes: new Uint8Array([1, 2, 3]) },
      "manual",
    );

    // Reset the row for the second source so the D-06 cache doesn't short-circuit.
    mockRow = { id: ANALYSIS_ID, user_id: USER_ID, brf_pdf_hash: null, brf_data: null };

    const textResult = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );

    expect(pdfResult.ok).toBe(true);
    expect(textResult.ok).toBe(true);
    if (!pdfResult.ok || !textResult.ok) throw new Error("expected ok results");

    // Identical extraction/normalized/grade — only brf_scanned/provenance differ.
    expect(textResult.data.extraction).toEqual(pdfResult.data.extraction);
    expect(textResult.data.normalized).toEqual(pdfResult.data.normalized);
    expect(textResult.data.grade).toEqual(pdfResult.data.grade);
  });

  it("persists brf_fetch_source alongside the existing brf_* columns", async () => {
    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "pdf", bytes: new Uint8Array([1, 2, 3]) },
      "auto_bolagsverket",
    );

    expect(result.ok).toBe(true);
    const terminalWrite = updateCalls.find((c) => c.brf_status === "done");
    expect(terminalWrite).toBeDefined();
    expect(terminalWrite?.brf_fetch_source).toBe("auto_bolagsverket");
  });

  it("iXBRL source hard-sets brf_scanned=false", async () => {
    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );

    expect(result.ok).toBe(true);
    const scannedWrite = updateCalls.find((c) => c.brf_status === "extracting");
    expect(scannedWrite?.brf_scanned).toBe(false);
    const terminalWrite = updateCalls.find((c) => c.brf_status === "done");
    expect(terminalWrite?.brf_scanned).toBe(false);
  });

  it("does NOT call uploadBrfPdf for an ixbrl-text source (no raw-HTML storage in v1)", async () => {
    await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );

    expect(uploadCalls).toHaveLength(0);
  });

  it("hashes iXBRL text content (utf8) rather than treating it as bytes for the D-06 cache", async () => {
    const first = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );
    expect(first.ok).toBe(true);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);

    // Re-run with the SAME text — should hit the D-06 cache and skip re-extraction.
    const second = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.cached).toBe(true);
    expect(extractBrfFinancials).toHaveBeenCalledTimes(1);
  });

  it("advances brf_status to 'done' on a cache hit so the caller's CAS lock and the client poller settle (BL-4)", async () => {
    // First run populates brf_pdf_hash + brf_data.
    const first = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );
    expect(first.ok).toBe(true);

    // Second run with identical content hits the D-06 cache.
    updateCalls = [];
    extractBrfFinancials.mockClear();
    const second = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
    );

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.cached).toBe(true);
    // Short-circuited the Claude call…
    expect(extractBrfFinancials).not.toHaveBeenCalled();
    // …but still wrote the terminal `done` status (with this fetch's
    // provenance). Without it, a caller that CAS-locked the row to
    // `auto_fetching` would wedge forever and the poller would false-timeout.
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ brf_status: "done", brf_fetch_source: "auto_allabrf" }),
    );
    // …and did NOT walk the extracting/scoring intermediate writes.
    expect(updateCalls.some((c) => c.brf_status === "extracting")).toBe(false);
    expect(updateCalls.some((c) => c.brf_status === "scoring")).toBe(false);
  });
});

describe("run-extraction — fiscalYear/isMostRecent persistence (ROADMAP Success Criterion 4)", () => {
  it("persists fetchMeta.fiscalYear/isMostRecent into the terminal brf_data write when provided", async () => {
    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
      { fiscalYear: 2024, isMostRecent: false },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fiscalYear).toBe(2024);
      expect(result.data.isMostRecent).toBe(false);
    }

    const terminalWrite = updateCalls.find((c) => c.brf_status === "done");
    expect(terminalWrite).toBeDefined();
    const persisted = terminalWrite?.brf_data as { fiscalYear?: number | null; isMostRecent?: boolean | null };
    expect(persisted.fiscalYear).toBe(2024);
    expect(persisted.isMostRecent).toBe(false);
  });

  it("leaves fiscalYear/isMostRecent absent when fetchMeta is not provided (manual path unaffected)", async () => {
    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "pdf", bytes: new Uint8Array([1, 2, 3]) },
      "manual",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fiscalYear).toBeUndefined();
      expect(result.data.isMostRecent).toBeUndefined();
    }

    const terminalWrite = updateCalls.find((c) => c.brf_status === "done");
    const persisted = terminalWrite?.brf_data as { fiscalYear?: number | null; isMostRecent?: boolean | null };
    expect(persisted.fiscalYear).toBeUndefined();
    expect(persisted.isMostRecent).toBeUndefined();
  });

  it("survives the D-06 cache round-trip via safeParseBrfData (schema accepts the new optional fields)", async () => {
    const first = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
      { fiscalYear: 2022, isMostRecent: true },
    );
    expect(first.ok).toBe(true);

    // Re-run with the SAME text — should hit the D-06 cache and return the
    // cached brfData (which safeParseBrfData re-validates on the way out).
    const second = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld 1234" },
      "auto_allabrf",
      { fiscalYear: 2022, isMostRecent: true },
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
      expect(second.data.fiscalYear).toBe(2022);
      expect(second.data.isMostRecent).toBe(true);
    }
  });
});

describe("run-extraction — ownership + error paths", () => {
  it("returns an error when the row's user_id does not match the caller", async () => {
    mockRow = { id: ANALYSIS_ID, user_id: "someone-else", brf_pdf_hash: null, brf_data: null };

    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "pdf", bytes: new Uint8Array([1]) },
      "manual",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Analysen hittades inte.");
  });
});

describe("run-extraction — cost-cap guardrail (WR-04)", () => {
  it("fails closed on a non-finite (NaN) cost instead of bypassing the cap, and never persists NaN", async () => {
    // A drifted SDK usage shape (missing/NaN token counts) makes costSek NaN;
    // `NaN > COST_CAP_SEK` is false, which previously let an uncosted result
    // persist with brf_cost_sek: NaN.
    extractBrfFinancials.mockResolvedValueOnce({
      parsed: baseExtraction(),
      usage: {
        input_tokens: NaN,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      citations: [],
    });

    const result = await runBrfExtraction(
      ANALYSIS_ID,
      USER_ID,
      { kind: "ixbrl-text", text: "Skuld NaN-cost regression" }, // fresh text → no cache hit
      "auto_allabrf",
    );

    expect(result.ok).toBe(false);
    // No terminal 'done' write happened…
    expect(updateCalls.find((c) => c.brf_status === "done")).toBeUndefined();
    // …and the failed write persisted null, never NaN, for brf_cost_sek.
    const failed = updateCalls.find((c) => c.brf_status === "failed");
    expect(failed).toBeDefined();
    expect(failed?.brf_cost_sek ?? null).toBeNull();
  });
});
