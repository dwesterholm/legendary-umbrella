import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Deterministic test for the `downloadReportPdf` server action (Plan 04-05,
 * RPRT-03 / D-09 / D-10 / D-11).
 *
 * No live Anthropic key, no real PDF render, no real Supabase: the Supabase
 * server client (`@/lib/supabase/server`) and the PDF renderer
 * (`@/lib/report/pdf/render`) are mocked. The action is exercised for its
 * SECURITY + INTEGRITY contract, not the bytes:
 *  - D-09 login gate: no user → Swedish login error, render NOT called;
 *  - T-04-17 IDOR: another user's row → "hittades inte", render NOT called
 *    (no cross-user PDF leak);
 *  - read-path degrade: null/undefined report_data → "rapport ej genererad"
 *    affordance, render NOT called, no crash;
 *  - D-11 single source of truth: a valid owned report renders the persisted
 *    data via the mocked renderReportPdf and returns application/pdf bytes; the
 *    action never re-synthesises (no synthesizeReport import in the source).
 */

// ---- Mock the PDF renderer (no real react-pdf render in this auth/IDOR test) -
const renderReportPdf = vi.fn();
vi.mock("@/lib/report/pdf/render", () => ({
  renderReportPdf: (...args: unknown[]) => renderReportPdf(...args),
}));

// ---- Mock the Supabase server client (chainable fake) ----------------------
let mockUser: { id: string } | null;
let mockRow: Record<string, unknown> | null;
let mockRowError: { code: string } | null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mockRow, error: mockRowError }),
        }),
      }),
    }),
  }),
}));

import { downloadReportPdf } from "@/actions/download-report-pdf";

/** A minimally-valid persisted report_data snapshot (matches reportDataSchema). */
function validReportData() {
  return {
    report: {
      leadSynthesis: "Syntes med å/ä/ö.",
      ekonomi: { status: "bedömd", claims: [] },
      pris: { status: "ej_tillgänglig", claims: [] },
      omrade: { status: "ej_tillgänglig", claims: [] },
      prioritizedFlagIds: [],
    },
    flags: [],
    softSignals: null,
    dataFingerprint: "abc",
    costSek: 0.3,
    model: "claude-sonnet-4-6",
    promptVersion: "report-synth/v1 (2026-06-23)",
  };
}

beforeEach(() => {
  renderReportPdf.mockReset();
  renderReportPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake", "latin1"));
  mockUser = { id: "user-1" };
  mockRow = { id: "a1", user_id: "user-1", report_data: validReportData() };
  mockRowError = null;
});

describe("downloadReportPdf — surface", () => {
  it("exports the downloadReportPdf server action", () => {
    expect(typeof downloadReportPdf).toBe("function");
  });
});

describe("downloadReportPdf — auth gate (D-09)", () => {
  it("returns the Swedish login error for an unauthenticated user and never renders", async () => {
    mockUser = null;
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/logga in/i);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });
});

describe("downloadReportPdf — ownership / IDOR (T-04-17)", () => {
  it("returns 'hittades inte' for another user's analysis and never renders (no cross-user leak)", async () => {
    mockRow = { id: "a1", user_id: "someone-else", report_data: validReportData() };
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/hittades inte/i);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });

  it("returns 'hittades inte' when the row is missing and never renders", async () => {
    mockRow = null;
    mockRowError = { code: "PGRST116" };
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/hittades inte/i);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });
});

describe("downloadReportPdf — null report degrade (D-11 read-path)", () => {
  it("returns a 'rapport ej genererad' affordance when report_data is null and never renders", async () => {
    mockRow = { id: "a1", user_id: "user-1", report_data: null };
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/genererad/i);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });

  it("degrades (no crash) when report_data is shape-drifted garbage", async () => {
    mockRow = { id: "a1", user_id: "user-1", report_data: { nonsense: true } };
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(false);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });
});

describe("downloadReportPdf — happy path (D-10/D-11)", () => {
  it("renders the persisted report_data and returns application/pdf bytes", async () => {
    const result = await downloadReportPdf("a1");
    expect(result.ok).toBe(true);
    expect(renderReportPdf).toHaveBeenCalledTimes(1);
    // The renderer received the persisted report + flags — not a re-fetch.
    const passed = renderReportPdf.mock.calls[0][0];
    expect(passed.report.leadSynthesis).toContain("å/ä/ö");
    if (result.ok) {
      expect(result.blob.type).toBe("application/pdf");
      expect(result.blob.size).toBeGreaterThan(0);
    }
  });
});
