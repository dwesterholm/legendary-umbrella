"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { scrapeBooli } from "@/lib/apify/booli-scraper";
import { scraperOutputSchema, type ListingData } from "@/lib/schemas/listing";
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
  } catch {
    return { error: "Kunde inte hamta data fran Booli. Forsok igen." };
  }

  // Validate scraper output
  const parsed = scraperOutputSchema.safeParse(rawData);

  // Track missing fields for our required display fields
  const missingFields: string[] = [];
  const requiredDisplayFields = ["address", "price", "livingArea", "rooms"] as const;

  // Build listing data from whatever we got, even if validation failed
  const raw = parsed.success ? parsed.data : rawData;

  const address = typeof raw.address === "string" ? raw.address : null;
  const price = typeof raw.price === "number" ? raw.price : null;
  const livingArea = typeof raw.livingArea === "number" ? raw.livingArea : null;
  const rooms = typeof raw.rooms === "number" ? raw.rooms : null;
  const monthlyFee = typeof raw.monthlyFee === "number" ? raw.monthlyFee : null;
  const buildYear = typeof raw.buildYear === "number" ? raw.buildYear : null;
  const brfName = typeof raw.brfName === "string" ? raw.brfName : null;

  // Check required display fields
  if (!address) missingFields.push("address");
  if (price === null) missingFields.push("price");
  if (livingArea === null) missingFields.push("livingArea");
  if (rooms === null) missingFields.push("rooms");
  if (monthlyFee === null) missingFields.push("monthlyFee");
  if (buildYear === null) missingFields.push("buildYear");
  if (!brfName) missingFields.push("brfName");

  const prisPerKvm =
    price !== null && livingArea !== null
      ? calculatePrisPerKvm(price, livingArea)
      : 0;

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

  const isPartial = requiredDisplayFields.some(
    (field) => !raw[field] || (typeof raw[field] !== "string" && typeof raw[field] !== "number")
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
