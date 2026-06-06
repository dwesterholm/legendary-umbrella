"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { scrapeBooli } from "@/lib/apify/booli-scraper";
import {
  normalizeScraperOutput,
  scraperOutputSchema,
  type ListingData,
} from "@/lib/schemas/listing";
import { calculatePrisPerKvm } from "@/lib/utils";

export type AnalyzeResult =
  | { data: ListingData; partial: false; error?: undefined; missingFields?: undefined }
  | { data: ListingData; partial: true; missingFields: string[]; error?: undefined }
  | { error: string; data?: undefined; partial?: undefined; missingFields?: undefined };

export async function analyzeUrl(formData: FormData): Promise<AnalyzeResult> {
  const url = formData.get("url") as string;

  // Validate URL format
  if (!url?.includes("booli.se/")) {
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

  // Call Apify scraper
  let rawData: Record<string, unknown>;
  try {
    rawData = await scrapeBooli(url);
  } catch (error) {
    console.error("[analyze] scrapeBooli failed:", error);
    return { error: "Kunde inte hamta data fran Booli. Forsok igen." };
  }

  // Validate scraper output, then map actor field names to our model.
  // Normalization works on the raw object either way -- validation failure
  // just means we skip the typed view, not the data.
  const parsed = scraperOutputSchema.safeParse(rawData);
  const { address, price, livingArea, rooms, monthlyFee, buildYear, brfName, prisPerKvm: scrapedPrisPerKvm } =
    normalizeScraperOutput(parsed.success ? parsed.data : rawData);

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
    brfName,
    prisPerKvm,
  };

  const isPartial = requiredDisplayFields.some((field) =>
    missingFields.includes(field)
  );

  // Authenticated user: save to DB and redirect
  if (user) {
    const { data: analysis } = await supabase
      .from("analyses")
      .insert({
        user_id: user.id,
        url,
        listing_data: listingData as unknown as Record<string, unknown>,
        partial: isPartial,
      })
      .select()
      .single();

    if (analysis) {
      redirect(`/analysis/${analysis.id}`);
    }
  }

  // Guest: set cookie and return data directly
  const cookieStore = await cookies();
  cookieStore.set("guest_analysis_done", "true", {
    maxAge: 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  });

  if (isPartial) {
    return { data: listingData, partial: true, missingFields };
  }

  return { data: listingData, partial: false };
}
