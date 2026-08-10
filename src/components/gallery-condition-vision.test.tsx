// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GalleryConditionVision } from "@/components/gallery-condition-vision";
import type { VisionResult } from "@/lib/discovery/vision-schema";
import {
  HOLISTIC_DATA_ONLY_MARKER,
  type HolisticBrief,
} from "@/lib/discovery/holistic-schema";

function makeVision(overrides: Partial<VisionResult> = {}): VisionResult {
  return {
    claims: [
      {
        attribute: "kitchen",
        claim: "Köket verkar renoverat",
        imageIndex: 2,
        whatWasSeen: "nya vitvaror, kaklat stänkskydd",
        confidence: 0.8,
      },
    ],
    imageUrlsUsed: [
      "https://cdn.booli.se/img1.jpg",
      "https://cdn.booli.se/img2.jpg",
    ],
    model: "claude-sonnet-4-6",
    costSek: 0.42,
    ranAt: "2026-07-07T12:00:00Z",
    ...overrides,
  };
}

/**
 * Phase 14 (ANL-01, D-14-04) fixture factory for `HolisticBrief` — mirrors
 * `makeVision`'s override pattern. Defaults to a realistic hedged
 * comps-positioning item + a confounder item, `confidence: "low"`, and the
 * always-false `canAttributeToCondition` (D-14-05).
 */
function makeHolisticBrief(overrides: Partial<HolisticBrief> = {}): HolisticBrief {
  return {
    marker: HOLISTIC_DATA_ONLY_MARKER,
    confidence: "low",
    items: [
      {
        kind: "comps-positioning",
        text: "Priset per kvadratmeter ligger under områdets median för renoverade bostäder, men det kan bero på flera faktorer — se punkten nedan.",
      },
      {
        kind: "confounder",
        text: "Hiss, exakt läge inom området och delområde är inte kända — de kan påverka prisnivån oavsett skick.",
      },
    ],
    dataSources: ["comps", "hedonic"],
    conditionAttribution: {
      capped: true,
      explainedPct: null,
      residualDrivers: ["läge", "våningsplan"],
      canAttributeToCondition: false,
      effectivePricePerSqm: 85_000,
      debtIncluded: true,
    },
    ...overrides,
  };
}

const DEFAULT_SUN_PROPS = {
  latitude: null,
  longitude: null,
  floor: null,
  orientation: null,
};

describe("GalleryConditionVision", () => {
  it("always renders the Eye/terracotta identity header and locked title", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="no_images"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText("AI-bedömning av bilder — kan vara fel"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tolkat från bilder i annonsen/),
    ).toBeInTheDocument();
  });

  it("renders a claim row with hedged text, 'Bild n' citation, and a resolved thumbnail", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(screen.getByText("Köket verkar renoverat")).toBeInTheDocument();
    expect(screen.getByText("KÖK")).toBeInTheDocument();
    expect(screen.getAllByText("Bild 2").length).toBeGreaterThan(0);

    const thumbnail = screen.getByAltText("Bild 2") as HTMLImageElement;
    expect(thumbnail.src).toBe("https://cdn.booli.se/img2.jpg");

    // Closing disclaimer present whenever at least one claim renders.
    expect(
      screen.getByText(/Kan vara fel — dessa bedömningar är AI:ns tolkning/),
    ).toBeInTheDocument();
  });

  it("falls back to a text 'Bild {n}' label (never a broken-image icon) when the cited image URL cannot be resolved", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "bathroom",
          claim: "Badrummet ser omodernt ut",
          imageIndex: 9, // out of range for imageUrlsUsed (length 2)
          whatWasSeen: "gammalt kakel",
          confidence: 0.7,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(screen.getByText("Badrummet ser omodernt ut")).toBeInTheDocument();
    // Citation still present as text, never omitted.
    expect(screen.getAllByText("Bild 9").length).toBeGreaterThan(0);
    // No <img> element rendered for this claim's fallback.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the distinct 'no_images' empty state copy", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="no_images"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "Inga bilder tillgängliga för den här annonsen — ingen bildbedömning kunde göras.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the distinct 'cost_cap' skipped state copy (never collapsed with no_images)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="cost_cap"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kördes inte för den här annonsen (sökgränsen för bildanalys nåddes).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inga bilder tillgängliga/),
    ).not.toBeInTheDocument();
  });

  it("renders the distinct 'vision_error' skipped state copy (CR-02, never collapsed with no_images/cost_cap)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="vision_error"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kunde inte genomföras för den här annonsen just nu.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inga bilder tillgängliga/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/sökgränsen för bildanalys nåddes/),
    ).not.toBeInTheDocument();
  });

  it("renders the distinct low-confidence-suppressed state when vision ran but every claim was dropped", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "För osäkert för att visa — inga bildbaserade slutsatser kunde dras med rimlig säkerhet.",
      ),
    ).toBeInTheDocument();
  });

  it("never uses severityChip/sage/destructive vocabulary", () => {
    const { container } = render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(container.innerHTML).not.toMatch(/sage-/);
    expect(container.innerHTML).not.toMatch(/destructive/);
  });

  it("renders a remodelPotential claim as a PLANLÖSNING row, cited to its floor-plan image, in the same row shell as kitchen/bathroom/overall", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "remodelPotential",
          claim:
            "Planlösningen antyder att väggen mellan kök och vardagsrum eventuellt skulle kunna öppnas upp — kräver konstruktör / väggutredning för att avgöra. Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.",
          imageIndex: 1,
          whatWasSeen: "planritning med kök/vardagsrum intill varandra",
          confidence: 0.6,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(screen.getByText("PLANLÖSNING")).toBeInTheDocument();
    expect(
      screen.getByText(/Planlösningen antyder att väggen/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bild 1").length).toBeGreaterThan(0);
  });

  it("renders the floor-plan section-level reinforcement line once when ≥1 remodelPotential claim is shown", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "remodelPotential",
          claim:
            "Sovrum 2 och 3 ligger intill varandra — kräver konstruktör / väggutredning.",
          imageIndex: 1,
          whatWasSeen: "planritning",
          confidence: 0.6,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getAllByText(
        /Observationerna ovan är AI:ns tolkning av en 2D-planritning/,
      ).length,
    ).toBe(1);
  });

  it("does not render the floor-plan reinforcement line when no remodelPotential claim exists", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.queryByText(
        /Observationerna ovan är AI:ns tolkning av en 2D-planritning/,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders the embedded sun-path sub-block (Compass + Solexponering) given latitude/longitude/floor/orientation props", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        latitude={59.33}
        longitude={18.06}
        floor={3}
        orientation={{ facades: ["south"], confidence: 0.5 }}
        holisticBrief={null}
      />,
    );

    expect(screen.getByText("Solexponering")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the sun-path ej-tillgänglig line when orientation is null, even though vision claims exist", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.",
      ),
    ).toBeInTheDocument();
  });

  it("WR-04: does NOT render a 'Bild 0' citation for a sentinel/invalid imageIndex (claim text still shows)", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({
          claims: [
            {
              attribute: "overall",
              claim: "Bostaden verkar ljus",
              imageIndex: 0, // sentinel — must never render as "Bild 0"
              whatWasSeen: "stora fönster",
              confidence: 0.8,
            },
          ],
        })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(screen.getByText(/Bostaden verkar ljus/)).toBeInTheDocument();
    expect(screen.queryByText("Bild 0")).not.toBeInTheDocument();
  });
});

describe("GalleryConditionVision — holistic-data-only brief (ANL-01, D-14-04)", () => {
  it("renders the brief and NOT the 'För osäkert för att visa' dead end when vision ran with zero claims but a brief exists", () => {
    const brief = makeHolisticBrief();
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={brief}
      />,
    );

    expect(screen.getByText(HOLISTIC_DATA_ONLY_MARKER)).toBeInTheDocument();
    expect(screen.getByText(brief.items[0].text)).toBeInTheDocument();
    expect(screen.getByText(brief.items[1].text)).toBeInTheDocument();
    expect(
      screen.queryByText(/För osäkert för att visa/),
    ).not.toBeInTheDocument();
  });

  it("still renders the dead-end line when vision ran with zero claims and NO brief exists (Ringvägen 122 before/after pin)", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={null}
      />,
    );

    expect(
      screen.getByText(
        "För osäkert för att visa — inga bildbaserade slutsatser kunde dras med rimlig säkerhet.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(HOLISTIC_DATA_ONLY_MARKER),
    ).not.toBeInTheDocument();
  });

  it("coexists with the 'no_images' explanation when a brief exists (renders below it, does not replace it)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="no_images"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    expect(
      screen.getByText(
        "Inga bilder tillgängliga för den här annonsen — ingen bildbedömning kunde göras.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(HOLISTIC_DATA_ONLY_MARKER)).toBeInTheDocument();
  });

  it("coexists with the 'cost_cap' explanation when a brief exists (renders below it, does not replace it)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="cost_cap"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kördes inte för den här annonsen (sökgränsen för bildanalys nåddes).",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(HOLISTIC_DATA_ONLY_MARKER)).toBeInTheDocument();
  });

  it("coexists with the 'vision_error' explanation when a brief exists (renders below it, does not replace it)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="vision_error"
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kunde inte genomföras för den här annonsen just nu.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(HOLISTIC_DATA_ONLY_MARKER)).toBeInTheDocument();
  });

  it("WR-16 — renders the brief for vision === null && visionSkippedReason === null, the cell job.ts attaches to but nothing used to render", () => {
    // job.ts's attach predicate is `c.vision === null || c.vision.claims.length
    // === 0`, so this state DOES get a brief attached. Both previous render
    // cells consulted visionSkippedReason, so it rendered nowhere — an
    // invariant held only by convention across two files, with no test.
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    expect(screen.getByText(HOLISTIC_DATA_ONLY_MARKER)).toBeInTheDocument();
  });

  it("does not render the brief when image-cited claims exist (the brief was never attached in that case)", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    expect(screen.getByText("Köket verkar renoverat")).toBeInTheDocument();
    expect(
      screen.queryByText(HOLISTIC_DATA_ONLY_MARKER),
    ).not.toBeInTheDocument();
  });

  it("renders nothing new when holisticBrief is null, across every visionSkippedReason state", () => {
    const states: Array<{
      vision: VisionResult | null;
      visionSkippedReason: "no_images" | "cost_cap" | "vision_error" | null;
    }> = [
      { vision: null, visionSkippedReason: "no_images" },
      { vision: null, visionSkippedReason: "cost_cap" },
      { vision: null, visionSkippedReason: "vision_error" },
      { vision: makeVision({ claims: [] }), visionSkippedReason: null },
    ];

    for (const state of states) {
      const { unmount } = render(
        <GalleryConditionVision
          vision={state.vision}
          visionSkippedReason={state.visionSkippedReason}
          {...DEFAULT_SUN_PROPS}
          holisticBrief={null}
        />,
      );
      expect(
        screen.queryByText(HOLISTIC_DATA_ONLY_MARKER),
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("renders the 'Låg säkerhet' caption for confidence: 'low'", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief({ confidence: "low" })}
      />,
    );

    expect(
      screen.getByText(/Låg säkerhet — bygger på områdesdata/),
    ).toBeInTheDocument();
  });

  it("renders the 'Måttlig säkerhet' caption for confidence: 'medium', never a high-confidence framing", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief({ confidence: "medium" })}
      />,
    );

    expect(
      screen.getByText(/Måttlig säkerhet — bygger på områdesdata/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hög säkerhet/)).not.toBeInTheDocument();
  });

  it("is visually distinct from the image-interpretation identity — warm-gray container, no terracotta class", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={makeHolisticBrief()}
      />,
    );

    const marker = screen.getByText(HOLISTIC_DATA_ONLY_MARKER);
    const briefContainer = marker.closest("div.rounded-lg") as HTMLElement;
    expect(briefContainer).toBeTruthy();
    expect(briefContainer.className).toContain("warm-gray");
    expect(briefContainer.className).not.toMatch(/terracotta/);
  });
});

describe("ANL-04 UI guard — never implies låg kr/m² ⇒ renoveringsobjekt", () => {
  // Defence-in-depth DUPLICATE of the data-construction-layer guard in
  // confounder-guard.ts (14-02's BANNED_RENO_ATTRIBUTION_PATTERNS /
  // buildHolisticBrief's drop-and-replace — the PRIMARY enforcement point).
  // This component-level assertion is deliberately INDEPENDENT of that
  // module — it does NOT import its runtime patterns — so a regression in
  // either layer is caught on its own; removing one guard does not silently
  // disable the other.
  const LAG_KR_IMPLIES_RENO_PATTERN =
    /l[åa]gt?\s*(kr|pris)[\s/]*kv?m[\s\S]{0,60}renoverings(objekt|behov)/i;

  const deepDiscountBrief = makeHolisticBrief({
    items: [
      {
        kind: "comps-positioning",
        text: "Priset per kvadratmeter ligger tydligt under områdets median för renoverade bostäder — det kan bero på flera faktorer, se punkten nedan.",
      },
      {
        kind: "confounder",
        text: "Hiss, exakt läge inom området och delområde är inte kända — de kan påverka prisnivån oavsett skick.",
      },
    ],
  });

  it("never renders 'renoveringsobjekt' or 'renoveringsbehov', even with a deep-discount-flavoured brief mentioning a low kr/m²", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={deepDiscountBrief}
      />,
    );

    expect(document.body.textContent).not.toMatch(/renoveringsobjekt/i);
    expect(document.body.textContent).not.toMatch(/renoveringsbehov/i);
  });

  it("never matches the låg-kr/m²-implies-renovation pattern in the rendered brief text", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
        holisticBrief={deepDiscountBrief}
      />,
    );

    expect(document.body.textContent).not.toMatch(LAG_KR_IMPLIES_RENO_PATTERN);
  });
});
