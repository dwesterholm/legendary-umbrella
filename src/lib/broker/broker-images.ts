import { Agent } from "undici";
import { resolveSafeExternalUrl } from "./url-guard";

/**
 * broker-images.ts — fetches broker-gallery images (on arbitrary broker CDN
 * hosts) as base64 BYTES, through the SAME SSRF guard as `fetch-broker-page.ts`,
 * so they can be sent to Anthropic for vision ANALYSIS ONLY.
 *
 * Why bytes, not URLs (the security decision): broker image hosts are
 * arbitrary and attacker-influenceable (the page URL ultimately comes from
 * Booli's `agencyListingUrl`). We must never hand Anthropic's server-side
 * fetcher an arbitrary URL (open SSRF), nor render such a URL as `<img src>`.
 * Instead WE fetch each image through the resolve-then-pin guard we already
 * trust for the broker page, cap the size, and pass the bytes inline. The
 * bytes are used for the vision call and then discarded — never persisted
 * (GDPR: we store no broker imagery; the user clicks through to the broker to
 * view photos).
 *
 * Never throws — every failure path (guard rejection, non-2xx, redirect,
 * non-image content-type, oversize, network error) skips that image.
 */

/** The image media types Anthropic's base64 image source accepts. */
export type SupportedImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A fetched image ready for an Anthropic base64 image block. */
export interface BrokerImageBytes {
  mediaType: SupportedImageMediaType;
  /** base64-encoded image bytes. */
  data: string;
}

/** Anthropic supports these image media types; anything else is skipped. */
const ALLOWED_MEDIA_TYPES = new Set<SupportedImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isSupportedMediaType(m: string): m is SupportedImageMediaType {
  return (ALLOWED_MEDIA_TYPES as Set<string>).has(m);
}
/** Per-image size cap (Anthropic's own limit is 5 MB pre-base64). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Fetches ONE image URL through the SSRF guard → base64, or null on any failure. */
async function fetchOne(url: string): Promise<BrokerImageBytes | null> {
  const resolved = await resolveSafeExternalUrl(url);
  if (!resolved) return null;

  const pinnedAgent = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const wantFamily = typeof options?.family === "number" ? options.family : 0;
        if (wantFamily !== 0 && wantFamily !== resolved.family) {
          callback(new Error("SSRF_GUARD_FAMILY_MISMATCH"), []);
          return;
        }
        callback(null, [{ address: resolved.address, family: resolved.family }]);
      },
    },
  });

  try {
    const res = await fetch(url, {
      redirect: "manual",
      dispatcher: pinnedAgent,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
      },
    } as RequestInit);

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return null;
    if (!res.ok) return null;

    const mediaType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!isSupportedMediaType(mediaType)) return null;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    return { mediaType, data: Buffer.from(buf).toString("base64") };
  } catch {
    return null;
  } finally {
    await pinnedAgent.destroy().catch(() => undefined);
  }
}

/**
 * Fetches up to `limit` broker-gallery images as base64 bytes, sequentially,
 * through the SSRF guard. Skips any that fail; returns only the successful
 * ones (possibly empty). Never throws.
 *
 * @param urls - broker gallery URLs (from parseBrokerPage's `images`)
 * @param limit - hard cap on how many to fetch (bounds bandwidth + cost)
 */
export async function fetchBrokerImageBytes(
  urls: string[],
  limit: number,
): Promise<BrokerImageBytes[]> {
  const out: BrokerImageBytes[] = [];
  for (const url of urls) {
    if (out.length >= limit) break;
    const img = await fetchOne(url);
    if (img) out.push(img);
  }
  return out;
}
