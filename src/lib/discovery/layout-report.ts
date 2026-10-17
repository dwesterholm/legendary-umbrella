/**
 * layout-report.ts - what one live run of the layout read measured (Phase 14.4, LAY-04, D-11, Pitfall 12).
 *
 * Input: the rows of a written snapshot (each may carry a stored layout fact and the sun fact of 14.3) and the
 * lifetime spend of the layout cache. Output: counts only, so the file it is written to carries ids, enums and
 * numbers, never a URL and never a picture.
 *
 *  - values: how often each answer of each field occurred, and how the confidence is spread (the gate sits at
 *    0,6, so the 0,5-0,7 band shows how much of the answer hangs on that one number);
 *  - usable: how many rows the gate lets through per field (confidence >= 0,6, photo evidence for street or
 *    courtyard), see layout-fact.ts;
 *  - appliedToSun: rows where the layout picked the facade the sun taste used (LAY-02);
 *  - agreement: among rows whose facade was STATED in the listing and whose footprint is known and whose balcony
 *    side the gate lets through as street or courtyard, whether the facade the layout implies (the footprint's
 *    street or courtyard facade) is one of the stated facades. n is small by construction (Pitfall 12);
 *  - consistency: among rows whose windows sit on one side and where the read believes both a balcony side and a
 *    bedroom side and says the bedroom is on the balcony side, how often the two sides differ (a contradiction
 *    inside one read);
 *  - eyeSample: the {@link EYE_SAMPLE_SIZE} rows with a layout and the lowest Booli ids, with the read fields, so
 *    a person can check them against the pictures.
 *
 * Everything here reports what the READ found (the `*When(..., true)` variants), whatever the influence switch
 * LAYOUT_INFLUENCE_ENABLED says, so accuracy work can measure the read while it does not touch the score.
 *
 * Pure: no clock, file, network or environment access.
 */
import { booliIdOf, inferredSunWithLayout, type FitInputRow } from "@/lib/discovery/fit-score";
import { LAYOUT_MIN_CONFIDENCE, korsdragWhen, quietBedroomWhen, usableSideWhen, usablyNoBalconyWhen, type LayoutFact } from "@/lib/discovery/layout-fact";

/** How many flats the by-eye check looks at (D-11). */
export const EYE_SAMPLE_SIZE = 12;

export interface LayoutReport {
  rowsWithLayout: number;
  values: {
    balconySide: Record<string, number>;
    windowSides: Record<string, number>;
    bedroomSide: Record<string, number>;
    streetEvidence: Record<string, number>;
    /** Rows by confidence: below 0,5; 0,5 up to 0,6 (read but gated out); 0,6 up to 0,7 (just through the gate); 0,7 and above. */
    confidence: { below05: number; from05to06: number; from06to07: number; from07: number };
  };
  usable: {
    /** Street, courtyard or a confident "no balcony". */
    balcony: number;
    /** Street or courtyard only (the part that can pick a facade for the sun). */
    balconyStreetOrCourtyard: number;
    /** Korsdrag known: windows one side, two opposite sides or corner. */
    windowSides: number;
    bedroom: number;
  };
  appliedToSun: number;
  agreement: {
    n: number;
    agree: number;
    cases: Array<{ booliId: number | null; layoutSide: "street" | "courtyard"; impliedFacade: string; statedFacades: string[]; agree: boolean }>;
  };
  consistency: { n: number; contradictions: number };
  eyeSample: Array<{
    booliId: number | null;
    balconySide: LayoutFact["balconySide"];
    livingOnBalconySide: boolean;
    kitchenOnBalconySide: boolean;
    bedroomOnBalconySide: boolean;
    windowSides: LayoutFact["windowSides"];
    bedroomSide: LayoutFact["bedroomSide"];
    streetEvidence: LayoutFact["streetEvidence"];
    confidence: number;
    images: LayoutFact["images"];
    korsdrag: boolean | null;
    quietBedroom: boolean | null;
  }>;
  spend: { lifetimeSek: number };
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Builds the report from the snapshot rows (only rows with a layout count) and the lifetime spend. */
export function layoutReportOf(rows: readonly FitInputRow[], lifetimeSek: number): LayoutReport {
  const withLayout = rows.filter((r): r is FitInputRow & { layout: LayoutFact } => r.layout !== null);
  const values: LayoutReport["values"] = {
    balconySide: {},
    windowSides: {},
    bedroomSide: {},
    streetEvidence: {},
    confidence: { below05: 0, from05to06: 0, from06to07: 0, from07: 0 },
  };
  const usable = { balcony: 0, balconyStreetOrCourtyard: 0, windowSides: 0, bedroom: 0 };
  let appliedToSun = 0;
  const cases: LayoutReport["agreement"]["cases"] = [];
  let consistencyN = 0;
  let contradictions = 0;

  for (const r of withLayout) {
    const l = r.layout;
    bump(values.balconySide, l.balconySide);
    bump(values.windowSides, l.windowSides);
    bump(values.bedroomSide, l.bedroomSide);
    bump(values.streetEvidence, l.streetEvidence);
    if (l.confidence < 0.5) values.confidence.below05 += 1;
    else if (l.confidence < LAYOUT_MIN_CONFIDENCE) values.confidence.from05to06 += 1;
    else if (l.confidence < 0.7) values.confidence.from06to07 += 1;
    else values.confidence.from07 += 1;

    const balcony = usableSideWhen(l, "balcony", true);
    const bedroom = usableSideWhen(l, "bedroom", true);
    if (balcony !== null || usablyNoBalconyWhen(l, true)) usable.balcony += 1;
    if (balcony !== null) usable.balconyStreetOrCourtyard += 1;
    if (korsdragWhen(l, true) !== null) usable.windowSides += 1;
    if (quietBedroomWhen(l, true) !== null) usable.bedroom += 1;
    if (inferredSunWithLayout(r.sun, l, true).applied) appliedToSun += 1;

    // Agreement with a STATED facade (the only independent evidence there is in the data, Pitfall 12).
    const sun = r.sun;
    if (balcony !== null && sun !== null && sun.source === "angiven" && sun.footprint !== null) {
      const implied = balcony === "street" ? sun.footprint.streetFacade : sun.footprint.courtyardFacade;
      const stated = sun.sides.map((s) => s.facade);
      cases.push({
        booliId: booliIdOf(r.candidate),
        layoutSide: balcony,
        impliedFacade: implied,
        statedFacades: stated,
        agree: stated.includes(implied),
      });
    }

    // Internal consistency: windows on one side, both sides believed, the bedroom said to be on the balcony side.
    if (l.windowSides === "one" && balcony !== null && bedroom !== null && l.bedroomOnBalconySide) {
      consistencyN += 1;
      if (bedroom !== balcony) contradictions += 1;
    }
  }

  const byId = (a: FitInputRow, b: FitInputRow): number =>
    (booliIdOf(a.candidate) ?? Number.POSITIVE_INFINITY) - (booliIdOf(b.candidate) ?? Number.POSITIVE_INFINITY);
  const eyeSample = [...withLayout]
    .sort(byId)
    .slice(0, EYE_SAMPLE_SIZE)
    .map((r) => ({
      booliId: booliIdOf(r.candidate),
      balconySide: r.layout.balconySide,
      livingOnBalconySide: r.layout.livingOnBalconySide,
      kitchenOnBalconySide: r.layout.kitchenOnBalconySide,
      bedroomOnBalconySide: r.layout.bedroomOnBalconySide,
      windowSides: r.layout.windowSides,
      bedroomSide: r.layout.bedroomSide,
      streetEvidence: r.layout.streetEvidence,
      confidence: r.layout.confidence,
      images: r.layout.images,
      korsdrag: korsdragWhen(r.layout, true),
      quietBedroom: quietBedroomWhen(r.layout, true),
    }));

  return {
    rowsWithLayout: withLayout.length,
    values,
    usable,
    appliedToSun,
    agreement: { n: cases.length, agree: cases.filter((c) => c.agree).length, cases },
    consistency: { n: consistencyN, contradictions },
    eyeSample,
    spend: { lifetimeSek: Number(lifetimeSek.toFixed(4)) },
  };
}
