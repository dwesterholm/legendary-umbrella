"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchListing, isBooliUrl } from "@/lib/booli/client";
import {
  normalizeScraperOutput,
  scraperOutputSchema,
  type ListingData,
} from "@/lib/schemas/listing";
import { calculatePrisPerKvm } from "@/lib/utils";
import { fetchBrokerListingPage } from "@/lib/broker/fetch-broker-page";
import { mergeListingFields } from "@/lib/broker/merge-listing-fields";

export type AnalyzeResult =
  | {
      data: ListingData;
      partial: false;
      error?: undefined;
      missingFields?: undefined;
      brokerFetchFailed?: boolean;
    }
  | {
      data: ListingData;
      partial: true;
      missingFields: string[];
      error?: undefined;
      brokerFetchFailed?: boolean;
    }
  | {
      error: string;
      data?: undefined;
      partial?: undefined;
      missingFields?: undefined;
      brokerFetchFailed?: undefined;
    };

export async function analyzeUrl(formData: FormData): Promise<AnalyzeResult> {
  const url = formData.get("url") as string;

  // Validate URL format (WR-03: real hostname check via isBooliUrl, not a
  // bypassable substring match — mirrors fetchListing's own SSRF allowlist).
  if (!url || !isBooliUrl(url)) {
    return { error: "Ange en giltig Booli-lank" };
  }

  // Check auth status
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Guest flow: check if already used free analysis
  if (!user) {
    const cookieStore = await cookies();
    const guestCookie = cookieStore.get("guest_analysis_done");

    if (guestCookie) {
      redirect("/login?reason=guest-limit");
    }
  }

  // Fetch the listing through the owned client (ACQ-01 default, per
  // 05-PROBE-FINDINGS.md GO). fetchListing falls back through own-render
  // retries and, as a last resort, the paid actor (scrapeBooli) internally —
  // this call site no longer needs to know about that fallback tree.
  let rawData: Record<string, unknown>;
  try {
    rawData = await fetchListing(url);
  } catch (error) {
    console.error("[analyze] fetchListing failed:", error);
    return { error: "Kunde inte hamta data fran Booli. Forsok igen." };
  }

  // Validate scraper output, then map actor field names to our model.
  // Normalization works on the raw object either way -- validation failure
  // just means we skip the typed view, not the data.
  const parsed = scraperOutputSchema.safeParse(rawData);
  const {
    address,
    price,
    livingArea,
    rooms,
    monthlyFee,
    buildYear,
    brfName,
    prisPerKvm: scrapedPrisPerKvm,
    latitude,
    longitude,
    booliId,
    breadcrumbs,
    // Phase 6 (LSTG-03) — floor/balcony/brfName recovered from the Apollo
    // entity with no broker fetch (client.ts reshapeListingEntity);
    // renovationStatus/description have no Apollo representation and stay
    // null until Plan 02's broker-page gap-fill populates them.
    floor,
    balcony,
    renovationStatus,
    description,
  } = normalizeScraperOutput(parsed.success ? parsed.data : rawData);

  // Phase 6 Plan 03 (LSTG-04) — broker-page enrichment. This is an
  // INDEPENDENT-DEGRADATION step (RESEARCH Pattern 4, inverted from the
  // fetchListing/fetchSoldComps rethrow shape above): a broker-fetch failure
  // must NEVER become a returned `{ error }` — it can only add fields, never
  // fail the primary analysis (T-06-08). agencyListingUrl is a raw passthrough
  // key from client.ts's reshapeListingEntity, not part of the typed
  // NormalizedListing shape, so it's read directly off rawData.
  // WR-04: validate the protocol at extraction time too (defense-in-depth).
  // fetchBrokerListingPage's resolveSafeExternalUrl/isSafeExternalUrl guard
  // (url-guard.ts) remains the sole authoritative enforcement point for the
  // actual outbound fetch — this check only ensures agencyListingUrl can
  // never carry a javascript:/data: scheme past this point, in case a
  // future call site uses it before/without routing through the guard
  // (e.g. rendering it as a link).
  const agencyListingUrl = ((): string | null => {
    const raw = rawData.agencyListingUrl;
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
      const { protocol } = new URL(raw);
      return protocol === "http:" || protocol === "https:" ? raw : null;
    } catch {
      return null;
    }
  })();

  let brokerFields: Awaited<ReturnType<typeof fetchBrokerListingPage>> = null;
  let brokerFetchFailed = false;

  if (agencyListingUrl) {
    try {
      brokerFields = await fetchBrokerListingPage(agencyListingUrl);
      if (brokerFields === null) {
        brokerFetchFailed = true;
      }
    } catch (error) {
      console.error("[analyze] broker enrichment failed (non-fatal):", error);
      brokerFields = null;
      brokerFetchFailed = true;
    }
  }

  // Gap-fill-only merge (T-06-10): a non-null Booli value always wins;
  // floor/balcony/brfName are Apollo-derived and UNCONDITIONAL — they are
  // never gated on the broker try/catch above (Pitfall 1).
  const merged = mergeListingFields(
    { floor, balcony, brfName, renovationStatus, description },
    brokerFields
  );

  // Track missing fields for our required display fields
  const missingFields: string[] = [];
  const requiredDisplayFields = ["address", "price", "livingArea", "rooms"] as const;

  // Check required display fields
  if (!address) missingFields.push("address");
  if (price === null) missingFields.push("price");
  if (livingArea === null) missingFields.push("livingArea");
  if (rooms === null) missingFields.push("rooms");
  if (monthlyFee === null) missingFields.push("monthlyFee");
  if (buildYear === null) missingFields.push("buildYear");
  if (!brfName) missingFields.push("brfName");

  // Prefer the actor's exact pris/kvm, fall back to computing it
  const prisPerKvm =
    scrapedPrisPerKvm ??
    (price !== null && livingArea !== null
      ? calculatePrisPerKvm(price, livingArea)
      : 0);

  const listingData: ListingData = {
    url,
    address: address ?? "Adress saknas",
    price: price ?? 0,
    livingArea: livingArea ?? 0,
    rooms: rooms ?? 0,
    monthlyFee,
    buildYear,
    // brfName resolves through the gap-fill merge too (Apollo-only source,
    // "maklare" branch structurally unreachable — see merge-listing-fields.ts).
    brfName: merged.brfName.value,
    prisPerKvm,
    // Retained join-key fields for the Phase 3 panels (03-SPIKE.md). New scrapes
    // persist these into analyses.listing_data; existing rows lack them (null).
    latitude,
    longitude,
    booliId,
    breadcrumbs,
    // Phase 6 (LSTG-03/04) — gap-fill-merged, provenance-tagged values.
    // floor/balcony are Apollo-derived and unconditional (Pitfall 1);
    // renovationStatus/description may be filled from the broker page, but
    // ONLY the .value is persisted here — no raw broker object, no PII
    // (T-06-09). The per-field provenance TAG (booli/maklare/null, never
    // a raw broker object) is persisted separately in fieldSources below.
    floor: merged.floor.value,
    balcony: merged.balcony.value,
    renovationStatus: merged.renovationStatus.value,
    description: merged.description.value,
    // Per-field provenance (UI-SPEC Copywriting Contract) — only the
    // "booli" | "maklare" | null tag is persisted, never a raw broker
    // object, so this cannot become a PII leak vector (T-06-09).
    fieldSources: {
      floor: merged.floor.source,
      balcony: merged.balcony.source,
      brfName: merged.brfName.source,
      renovationStatus: merged.renovationStatus.source,
      description: merged.description.source,
    },
    brokerFetchFailed,
  };

  const isPartial = requiredDisplayFields.some((field) =>
    missingFields.includes(field)
  );

  // Authenticated user: save to DB and redirect
  if (user) {
    const { data: analysis, error: insertError } = await supabase
      .from("analyses")
      .insert({
        user_id: user.id,
        url,
        listing_data: listingData as unknown as Record<string, unknown>,
        partial: isPartial,
      })
      .select()
      .single();

    // WR-03: an insert failure must never silently fall through to the
    // guest-cookie path below — that would set a guest cookie on an
    // authenticated user's session and return listingData to the client as
    // if it had been saved, when the row never persisted. Surface the error
    // instead so the user isn't misled into believing their analysis exists.
    if (insertError || !analysis) {
      console.error("[analyze] failed to persist analysis:", insertError);
      return { error: "Kunde inte spara analysen. Forsok igen." };
    }

    redirect(`/analysis/${analysis.id}`);
  }

  // Guest: set cookie and return data directly
  const cookieStore = await cookies();
  cookieStore.set("guest_analysis_done", "true", {
    maxAge: 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  });

  if (isPartial) {
    return { data: listingData, partial: true, missingFields, brokerFetchFailed };
  }

  return { data: listingData, partial: false, brokerFetchFailed };
}
