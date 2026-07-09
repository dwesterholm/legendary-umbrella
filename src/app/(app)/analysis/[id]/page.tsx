import { createHash } from "node:crypto";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ListingSummary } from "@/components/listing-summary";
import { BrfSection } from "@/components/brf-section";
import { MarketContextSection } from "@/components/market-context-section";
import { AiReportSection } from "@/components/ai-report-section";
import { UrlInput } from "@/components/url-input";
import { listingDataSchema } from "@/lib/schemas/listing";
import { safeParseBrfData } from "@/lib/schemas/brf";
import { safeParsePriceData } from "@/lib/market/sold-schema";
import { safeParseAreaData } from "@/lib/market/scb-schema";
import { safeParseMacroData } from "@/lib/market/macro-schema";
import { safeParseReportData } from "@/lib/schemas/report";
import {
  computeFlags,
  type FlagBrfInput,
  type FlagPriceInput,
  type FlagSoftSignals,
} from "@/lib/report/flags";
import { assembleFactSheet } from "@/lib/report/fact-sheet";

/**
 * Maps the persisted, safeParse'd sources onto the deterministic flag-engine
 * inputs — byte-for-byte the SAME mapping `generateReport` uses (toFlagBrf /
 * toFlagPrice / toSoftSignals in generate-report.ts), so the fingerprint
 * recomputed here matches the one the action stored. Diverging here would
 * silently break the D-08 stale detection (T-04-24).
 */
function toFlagBrf(
  brf: ReturnType<typeof safeParseBrfData>,
): FlagBrfInput | null {
  if (!brf) return null;
  return {
    skuldPerKvm: brf.normalized.skuldPerKvm,
    avgiftsniva: brf.normalized.avgiftsniva,
    kassaflode: brf.normalized.kassaflode,
  };
}

function toFlagPrice(
  price: ReturnType<typeof safeParsePriceData>,
): FlagPriceInput | null {
  if (!price) return null;
  const reason: FlagPriceInput["reason"] =
    price.reason === "source_unavailable" ? "thin" : price.reason;
  return { reason, deltaPct: price.deltaPct, sampleSize: price.sampleSize };
}

function toSoftSignals(
  brf: ReturnType<typeof safeParseBrfData>,
): FlagSoftSignals | null {
  if (!brf) return null;
  const e = brf.extraction;
  return {
    stambytePlanerat: e.stambytePlanerat,
    storreRenoveringar: e.storreRenoveringar,
    ovrigaAnmarkningar: e.ovrigaAnmarkningar,
  };
}

interface AnalysisPageProps {
  params: Promise<{ id: string }>;
}

export default async function AnalysisPage({ params }: AnalysisPageProps) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: analysis, error } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !analysis) {
    notFound();
  }

  // Resolve the current user server-side to derive guest state (D-05). The teaser
  // is defence-in-depth — analyzeBrf enforces the authoritative hard gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // CR-01 / T-03-20 (WR-03): re-validate the persisted listing_data against the
  // Zod schema — same safe-parse discipline as brf_data/price_data/area_data
  // below — so a malformed/shape-drifted row degrades to "not found" rather than
  // crashing on the .prisPerKvm dereference.
  const listingData = listingDataSchema.safeParse(analysis.listing_data).data;
  if (!listingData) {
    notFound();
  }
  const isPartial = analysis.partial ?? false;
  // WR-02: missingFields is computed at analyze-time but never persisted into
  // listing_data, so it must be re-derived here from the persisted values —
  // the same required-display-field rules analyze.ts uses — rather than left
  // undefined. Without this, ListingSummary's isMissing() is always false on
  // this page and silently relies on the `=== 0`/`=== null` OR-fallbacks in
  // each MetricCard instead of the intended missingFields signal.
  const missingFields: string[] = [];
  if (!listingData.address) missingFields.push("address");
  if (listingData.price === 0) missingFields.push("price");
  if (listingData.livingArea === 0) missingFields.push("livingArea");
  if (listingData.rooms === 0) missingFields.push("rooms");
  if (listingData.monthlyFee === null) missingFields.push("monthlyFee");
  if (listingData.buildYear === null) missingFields.push("buildYear");
  if (!listingData.brfName) missingFields.push("brfName");
  // CR-01: re-validate the persisted JSONB against the Zod schema before it is
  // handed to the UI. A malformed/partial/shape-drifted row degrades to
  // "no analysis yet" (the upload affordance) rather than crashing the score card.
  const brfData = safeParseBrfData(analysis.brf_data);
  // CR-01 / T-03-20: re-validate the persisted market JSONB before handing it to
  // the client cards. Shape-drifted/malformed rows degrade to null (the fetch
  // affordance / honest marker) rather than crashing the page (Success Criterion 3).
  const priceData = safeParsePriceData(analysis.price_data);
  const areaData = safeParseAreaData(analysis.area_data);
  // Macro is best-effort context (MACRO-01) — same read-path guard as the
  // other three sources; must byte-match generate-report.ts's assembleFactSheet
  // input below or the D-08 fingerprint recompute silently desyncs (T-04-24).
  const macroData = safeParseMacroData(analysis.macro_data);

  // CR-01: re-validate the persisted report_data on READ. null → "not generated
  // yet" affordance, never a crash on a shape-drifted row.
  const reportData = safeParseReportData(analysis.report_data);

  // D-08 staleness: recompute the CURRENT-input fingerprint from the FULL stable
  // fact sheet (the SAME assembleFactSheet bytes generateReport hashed), then
  // compare to the stored report_data_fingerprint. A partial/ad-hoc hash over a
  // subset of fields would silently desync from the action's stored fingerprint
  // and break stale detection (T-04-24) — so we re-run the exact same pipeline.
  const softSignals = toSoftSignals(brfData);
  const currentFlags = computeFlags({
    brf: toFlagBrf(brfData),
    price: toFlagPrice(priceData),
    softSignals,
  });
  const currentFactSheet = assembleFactSheet({
    listing: listingData,
    brf: brfData,
    price: priceData,
    area: areaData,
    macro: macroData,
    flags: currentFlags,
    softSignals,
  });
  const currentFingerprint = createHash("sha256")
    .update(currentFactSheet)
    .digest("hex");
  // Only meaningful once a report exists with a stored fingerprint; a missing
  // stored fingerprint (no report yet) is NOT "stale".
  const isStale =
    reportData !== null &&
    typeof analysis.report_data_fingerprint === "string" &&
    analysis.report_data_fingerprint.length > 0 &&
    analysis.report_data_fingerprint !== currentFingerprint;

  return (
    <div className="flex flex-col items-center gap-8">
      {/* New analysis input */}
      <div className="w-full max-w-2xl">
        <h2 className="mb-4 text-lg font-medium text-warm-gray-700">
          Ny analys
        </h2>
        <UrlInput />
      </div>

      {/* Listing summary */}
      <ListingSummary
        data={listingData}
        partial={isPartial}
        missingFields={missingFields}
        brokerFetchFailed={listingData.brokerFetchFailed ?? false}
      />

      {/* D-00/D-05: the AI report anchors the page as the lead second opinion —
          the connective tissue across pris/BRF/område, not a bolted-on card at
          the bottom. It also carries the manual trigger (D-07), the guest teaser
          (D-09), the stale/regenerate marker (D-08), and the PDF download
          (RPRT-03). The themed flags it surfaces are the same deterministic
          signals the cards below expose, spoken in one trust language (D-00). */}
      <div className="w-full max-w-2xl">
        <AiReportSection
          analysisId={analysis.id}
          report={reportData}
          isGuest={!user}
          reportStatus={analysis.report_status}
          isStale={isStale}
        />
      </div>

      {/* The supporting source cards the report is built from. */}
      <div className="w-full max-w-2xl space-y-3">
        {/* ROADMAP Success Criterion 4: fiscalYear/isMostRecent are read off
            the safeParse'd brf_data JSONB (BrfData, additive-optional fields)
            rather than hardcoded — populated on the auto-fetch path via
            confirmAndAnalyze -> runBrfExtraction's fetchMeta; absent/null on
            the manual-upload path (no auto-detected fiscal year), which the
            score card's existing null handling already degrades gracefully. */}
        <BrfSection
          analysisId={analysis.id}
          isGuest={!user}
          brfStatus={analysis.brf_status}
          brfData={brfData}
          listingData={{ brfName: listingData.brfName }}
          brfFetchSource={analysis.brf_fetch_source}
          fiscalYear={brfData?.fiscalYear ?? null}
          isMostRecent={brfData?.isMostRecent ?? null}
        />
        {/* Phase 3: price comparison + SCB demographics, owner-only, each panel
            degrades independently (no isGuest — the page is owner-only). */}
        <MarketContextSection
          analysisId={analysis.id}
          priceData={priceData}
          areaData={areaData}
          macroData={macroData}
          listingPrisPerKvm={listingData.prisPerKvm}
          marketStatus={analysis.market_status}
        />
      </div>
    </div>
  );
}
