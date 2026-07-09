// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/actions/analyze-brf", () => ({
  correctBrfField: vi.fn(),
}));

import { BrfScoreCard } from "@/components/brf-score-card";
import type { BrfData } from "@/actions/analyze-brf";

/**
 * Regression suite for the ROADMAP Success Criterion 4 gap closure
 * (08-05): "the fetched document's fiscal year is shown prominently in the
 * report, flagged when it isn't the most recent available". These tests
 * exercise ONLY `BrfScoreCard`'s existing (already-correct) fiscal-year +
 * staleness rendering with REAL fiscalYear/isMostRecent props — proving the
 * previously-dormant code path now renders once given real data (the gap was
 * upstream: nothing ever supplied non-null props, not the rendering itself).
 */
function baseField<T>(value: T) {
  return { value, confidence: 0.9, sourceQuote: "citat", pageRef: 1 };
}

function baseBrfData(overrides: Partial<BrfData> = {}): BrfData {
  return {
    extraction: {
      skuldPerKvm: baseField(12000),
      avgiftsniva: baseField(500),
      kassaflode: baseField(100000),
      underhallsplanStatus: baseField("finns_aktuell" as const),
      stambytePlanerat: baseField("ej_nämnt" as const),
      storreRenoveringar: baseField("Inga"),
      ovrigaAnmarkningar: baseField("Inga"),
    },
    normalized: {
      skuldPerKvm: 12000,
      avgiftsniva: 500,
      kassaflode: 100000,
      underhallsplanStatus: "finns_aktuell",
      stambytePlanerat: "ej_nämnt",
      storreRenoveringar: "Inga",
      ovrigaAnmarkningar: "Inga",
    },
    grade: {
      grade: "B",
      breakdown: [
        {
          key: "skuldPerKvm",
          value: 12000,
          rating: "good",
          weight: 0.3,
          contribution: 0.3,
        },
      ],
    },
    perFieldConfidence: { skuldPerKvm: 0.9 },
    citations: [],
    ...overrides,
  };
}

describe("BrfScoreCard — fiscal year + staleness (ROADMAP Success Criterion 4)", () => {
  it("renders the fiscal-year line prominently when fiscalYear is a real value", () => {
    render(
      <BrfScoreCard
        analysisId="analysis-1"
        brfData={baseBrfData()}
        fiscalYear={2024}
        fetchSource="auto_allabrf"
        isMostRecent={true}
      />,
    );

    expect(screen.getByText("Räkenskapsår 2024")).toBeInTheDocument();
    expect(screen.getByText("Källa: Allabrf")).toBeInTheDocument();
  });

  it("shows the terracotta staleness caption when isMostRecent is false", () => {
    render(
      <BrfScoreCard
        analysisId="analysis-1"
        brfData={baseBrfData()}
        fiscalYear={2022}
        fetchSource="auto_allabrf"
        isMostRecent={false}
      />,
    );

    expect(screen.getByText("Räkenskapsår 2022")).toBeInTheDocument();
    expect(
      screen.getByText(/Nyare årsredovisning kan finnas/),
    ).toBeInTheDocument();
  });

  it("does NOT show the staleness caption when isMostRecent is true", () => {
    render(
      <BrfScoreCard
        analysisId="analysis-1"
        brfData={baseBrfData()}
        fiscalYear={2024}
        fetchSource="auto_allabrf"
        isMostRecent={true}
      />,
    );

    expect(
      screen.queryByText(/Nyare årsredovisning kan finnas/),
    ).not.toBeInTheDocument();
  });

  it("does NOT show the staleness caption when isMostRecent is null (unknown, never fabricated)", () => {
    render(
      <BrfScoreCard
        analysisId="analysis-1"
        brfData={baseBrfData()}
        fiscalYear={2024}
        fetchSource="auto_allabrf"
        isMostRecent={null}
      />,
    );

    expect(
      screen.queryByText(/Nyare årsredovisning kan finnas/),
    ).not.toBeInTheDocument();
  });

  it("renders neither the fiscal-year line nor the staleness caption on the manual path (fiscalYear null)", () => {
    render(
      <BrfScoreCard
        analysisId="analysis-1"
        brfData={baseBrfData()}
        fiscalYear={null}
        fetchSource="manual"
        isMostRecent={null}
      />,
    );

    expect(screen.queryByText(/Räkenskapsår/)).not.toBeInTheDocument();
    expect(screen.getByText("Källa: Manuellt uppladdad")).toBeInTheDocument();
  });
});
