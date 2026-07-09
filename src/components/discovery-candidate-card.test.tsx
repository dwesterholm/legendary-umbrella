// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiscoveryCandidateCard } from "@/components/discovery-candidate-card";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import type { SignalContribution } from "@/lib/discovery/niche-score";

function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    address: "Testgatan 1",
    price: 3_000_000,
    rooms: 2,
    livingArea: 50,
    areaLabel: "Testomrade",
    thumbnailUrl: null,
    sourceListingUrl: "https://www.booli.se/annons/1",
    constructionYear: 1962,
    brfName: null,
    tenureForm: "Bostadsrätt",
    imageUrls: null,
    vision: null,
    visionSkippedReason: null,
    latitude: null,
    longitude: null,
    floor: null,
    orientation: null,
    balcony: null,
    upcomingSale: null,
    isNewConstruction: null,
    ...overrides,
  };
}

describe("DiscoveryCandidateCard", () => {
  it("renders the base card exactly as before when no rankPosition/nicheSignals are passed", () => {
    render(<DiscoveryCandidateCard candidate={makeCandidate()} />);

    expect(screen.getByText("Testgatan 1")).toBeInTheDocument();
    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Inga tydliga signaler för denna sortering"),
    ).not.toBeInTheDocument();
  });

  it("renders the rank badge and mapped Swedish chip labels + Källa caption", () => {
    const signals: SignalContribution[] = [
      {
        key: "constructionYearAge",
        value: 1962,
        weight: 0.5,
        contribution: 0.4,
        assessable: true,
        sourceRef: "candidate.constructionYear",
      },
    ];

    render(
      <DiscoveryCandidateCard
        candidate={makeCandidate()}
        rankPosition={1}
        nicheSignals={signals}
      />,
    );

    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("Byggår")).toBeInTheDocument();
    expect(screen.getByText("Källa: Annonsdata")).toBeInTheDocument();
  });

  it("renders the hedged stambyte proxy chip label, never a confirmed 'betalar' verdict", () => {
    const signals: SignalContribution[] = [
      {
        key: "stambyteProxyAge",
        value: 1962,
        weight: 1,
        contribution: 0.8,
        assessable: true,
        sourceRef: "candidate.constructionYear",
      },
    ];

    render(
      <DiscoveryCandidateCard
        candidate={makeCandidate()}
        rankPosition={1}
        nicheSignals={signals}
      />,
    );

    const chip = screen.getByText(/möjligt stambytesbehov/i);
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).not.toMatch(/betalar/i);
  });

  it("renders the no-signal caption when a niche is active but there are zero assessable signals", () => {
    const signals: SignalContribution[] = [
      {
        key: "constructionYearAge",
        value: null,
        weight: 0.5,
        contribution: 0,
        assessable: false,
        sourceRef: "candidate.constructionYear",
      },
    ];

    render(
      <DiscoveryCandidateCard
        candidate={makeCandidate()}
        rankPosition={2}
        nicheSignals={signals}
      />,
    );

    expect(
      screen.getByText("Inga tydliga signaler för denna sortering"),
    ).toBeInTheDocument();
  });

  it("never renders a bare numeric score or percentage from the ranking", () => {
    const signals: SignalContribution[] = [
      {
        key: "constructionYearAge",
        value: 1962,
        weight: 0.5,
        contribution: 0.437,
        assessable: true,
        sourceRef: "candidate.constructionYear",
      },
    ];

    render(
      <DiscoveryCandidateCard
        candidate={makeCandidate()}
        rankPosition={1}
        nicheSignals={signals}
      />,
    );

    expect(screen.queryByText("0.437")).not.toBeInTheDocument();
    expect(screen.queryByText(/43\.7%|44%/)).not.toBeInTheDocument();
  });
});
