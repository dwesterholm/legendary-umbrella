// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { BrfSection } from "@/components/brf-section";

const resolveOrgNrAction = vi.fn();
const confirmAndAnalyze = vi.fn();

vi.mock("@/actions/fetch-brf-auto", () => ({
  resolveOrgNrAction: (...args: unknown[]) => resolveOrgNrAction(...args),
  confirmAndAnalyze: (...args: unknown[]) => confirmAndAnalyze(...args),
}));

// BrfUpload imports analyzeBrf from this module, which transitively imports
// run-extraction.ts -> extract.ts, which constructs `new Anthropic()` at
// module scope (dangerouslyAllowBrowser guard trips under jsdom). Mock the
// module boundary so this component test never touches that chain — BrfUpload
// itself is not under test here (it renders unchanged in the "upload" view).
vi.mock("@/actions/analyze-brf", () => ({
  analyzeBrf: vi.fn(),
  correctBrfField: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { brf_status: null } }),
        }),
      }),
    }),
  }),
}));

describe("BrfSection", () => {
  beforeEach(() => {
    resolveOrgNrAction.mockReset();
    confirmAndAnalyze.mockReset();
  });

  it("guest sees the teaser and resolveOrgNrAction is never called", () => {
    render(
      <BrfSection
        analysisId="a1"
        isGuest={true}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: "Brf Solkatten" }}
      />,
    );

    expect(screen.getByText(/Logga in for BRF-analys/)).toBeInTheDocument();
    expect(resolveOrgNrAction).not.toHaveBeenCalled();
  });

  it("owner with no brfName lands on upload view with no error banner", async () => {
    render(
      <BrfSection
        analysisId="a1"
        isGuest={false}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: null }}
      />,
    );

    // No brfName -> resolution is never attempted -> upload view immediately.
    expect(screen.getByText("BRF Analys")).toBeInTheDocument();
    expect(resolveOrgNrAction).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/kunde inte hitta en säker matchning/i),
    ).not.toBeInTheDocument();
  });

  it("owner + low confidence falls through to manual upload with no banner", async () => {
    resolveOrgNrAction.mockResolvedValue({
      ok: true,
      confidence: "low",
      fallThrough: true,
    });

    render(
      <BrfSection
        analysisId="a1"
        isGuest={false}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: "Brf Solkatten" }}
      />,
    );

    await waitFor(() => expect(resolveOrgNrAction).toHaveBeenCalledWith("a1"));
    await waitFor(() =>
      expect(screen.getByText("BRF Analys")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/kunde inte hitta en säker matchning/i),
    ).not.toBeInTheDocument();
  });

  it("owner + high confidence renders BrfMatchConfirmation", async () => {
    resolveOrgNrAction.mockResolvedValue({
      ok: true,
      confidence: "high",
      orgNr: "769600-1234",
      matchedName: "Brf Solkatten",
      fiscalYear: 2024,
      brfName: "Brf Solkatten",
    });

    render(
      <BrfSection
        analysisId="a1"
        isGuest={false}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: "Brf Solkatten" }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Stämmer detta med din bostad?"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("769600-1234")).toBeInTheDocument();
  });

  it("reject on the confirm view routes straight to upload with zero friction", async () => {
    resolveOrgNrAction.mockResolvedValue({
      ok: true,
      confidence: "high",
      orgNr: "769600-1234",
      matchedName: "Brf Solkatten",
      fiscalYear: 2024,
      brfName: "Brf Solkatten",
    });

    render(
      <BrfSection
        analysisId="a1"
        isGuest={false}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: "Brf Solkatten" }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Stämmer detta med din bostad?"),
      ).toBeInTheDocument(),
    );

    const rejectBtn = screen.getByText("Nej, ladda upp manuellt");
    rejectBtn.click();

    await waitFor(() =>
      expect(screen.getByText("BRF Analys")).toBeInTheDocument(),
    );
    expect(confirmAndAnalyze).not.toHaveBeenCalled();
  });

  it("confirm on the confirm view calls confirmAndAnalyze", async () => {
    resolveOrgNrAction.mockResolvedValue({
      ok: true,
      confidence: "high",
      orgNr: "769600-1234",
      matchedName: "Brf Solkatten",
      fiscalYear: 2024,
      brfName: "Brf Solkatten",
    });
    confirmAndAnalyze.mockResolvedValue({
      ok: false,
      fallThrough: true,
      error: "En hämtning pågår redan eller är redan klar.",
    });

    render(
      <BrfSection
        analysisId="a1"
        isGuest={false}
        brfStatus={null}
        brfData={null}
        listingData={{ brfName: "Brf Solkatten" }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Stämmer detta med din bostad?"),
      ).toBeInTheDocument(),
    );

    const confirmBtn = screen.getByText("Ja, stämmer — analysera");
    confirmBtn.click();

    await waitFor(() =>
      expect(confirmAndAnalyze).toHaveBeenCalledWith("a1", "769600-1234", 2024),
    );
  });

  describe("WR-04: resolution effect reacts to prop updates without looping", () => {
    it("attempts resolution at most once per analysisId even when brfStatus/listingData props change on a re-render", async () => {
      resolveOrgNrAction.mockResolvedValue({
        ok: true,
        confidence: "low",
        fallThrough: true,
      });

      const { rerender } = render(
        <BrfSection
          analysisId="a1"
          isGuest={false}
          brfStatus={null}
          brfData={null}
          listingData={{ brfName: "Brf Solkatten" }}
        />,
      );

      await waitFor(() => expect(resolveOrgNrAction).toHaveBeenCalledTimes(1));

      // Re-render with a NEW listingData object reference (same analysisId) —
      // a naive `useRef`/effect-deps mistake could either (a) never notice
      // this update (the old stale-closure bug) or (b) re-fire resolution on
      // every render (an infinite-loop risk if resolution itself triggered a
      // state update feeding back into the deps). Neither happens: the ref
      // guard keys on analysisId, so no second resolution attempt fires.
      await act(async () => {
        rerender(
          <BrfSection
            analysisId="a1"
            isGuest={false}
            brfStatus={null}
            brfData={null}
            listingData={{ brfName: "Brf Solkatten" }}
          />,
        );
      });

      // Still exactly one call — no loop, no duplicate re-trigger.
      expect(resolveOrgNrAction).toHaveBeenCalledTimes(1);
    });

    it("does not re-attempt resolution once brfStatus advances past the resolvable window on a re-render", async () => {
      resolveOrgNrAction.mockResolvedValue({
        ok: true,
        confidence: "low",
        fallThrough: true,
      });

      const { rerender } = render(
        <BrfSection
          analysisId="a2"
          isGuest={false}
          brfStatus={null}
          brfData={null}
          listingData={{ brfName: "Brf Granen" }}
        />,
      );

      await waitFor(() => expect(resolveOrgNrAction).toHaveBeenCalledTimes(1));

      // A live status update arrives (e.g. a lifted-state parent) — the
      // effect re-evaluates against the CURRENT brfStatus (no longer a stale
      // closure over the mount-time value), sees `done`, and does not
      // attempt a second resolution regardless.
      await act(async () => {
        rerender(
          <BrfSection
            analysisId="a2"
            isGuest={false}
            brfStatus="done"
            brfData={null}
            listingData={{ brfName: "Brf Granen" }}
          />,
        );
      });

      expect(resolveOrgNrAction).toHaveBeenCalledTimes(1);
    });
  });
});
