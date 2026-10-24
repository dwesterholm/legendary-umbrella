/**
 * layout-typesafe-call.ts - the Jev (TypeSafe) call of variant e (Phase 14.5, R-10). Script-side only: the one file that
 * loads the TypeSafe SDK, as layout-call.ts is the one that loads the Anthropic SDK. The client is INJECTED
 * ({@link JevClientLike}), so the unit tests need no network and no key; the gate {@link jevGate} decides before a real
 * client is ever created.
 *
 * What it does for one flat, given the picture blocks the runner hands every variant (the plan first, then up to three
 * Booli photos, as URLs or bytes):
 *  1. fetches each URL block through the Booli image-host allowlist, one picture at a time with a pause between them
 *     (bcdn.se, polite, no redirects), never persisting a byte;
 *  2. prepares every picture the way TypeSafe needs it: PNG or JPEG, rotated upright (EXIF applied to the pixels), longest
 *     side at most 1568 px, both sides at least 280 px;
 *  3. sends ONE request with the pictures as image assets in the `state` and all questions of {@link JEV_QUESTIONS} (they
 *     are evaluated in parallel), with the images header;
 *  4. prices it from `usage.input_tokens` at Jev's rate and maps the answers to the stored read.
 * A picture that cannot be fetched or prepared fails the whole flat before any money is spent (no partial picture set is
 * ever read and cached). Errors are reported by class and HTTP status only, never a message (it can carry a URL).
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import sharp from "sharp";
import { TypeSafeClient, image, type Question } from "@typesafe-ai/sdk";
import { isAllowedImageHost } from "@/lib/booli/image-host";
import type { LayoutVariantSpec, VariantCallFn } from "@/lib/discovery/layout-experiment";
import { LayoutCallError, type LayoutImageBlock } from "@/lib/discovery/layout-read";
import {
  JEV_ABOUT,
  JEV_IMAGES_HEADER,
  JEV_IMAGE_LIMITS,
  JEV_IMAGE_PREP,
  JEV_MODEL,
  JEV_QUESTIONS,
  jevCostSek,
  jevGate,
  layoutReadFromJev,
} from "@/lib/discovery/layout-typesafe";

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** A picture as bytes, ready for TypeSafe. */
export interface PreparedImage {
  data: Uint8Array;
  format: "png" | "jpeg";
  width: number;
  height: number;
}

/**
 * Prepares one picture for TypeSafe (docs.typesafe.ai/images, "Preparing images"): any input format sharp reads (Booli
 * serves WebP) becomes PNG (`format: "png"`, for the floor plan, so thin lines stay sharp) or a baseline JPEG at quality 90
 * (photos). The EXIF orientation is applied to the pixels, the longest side is scaled down to 1568 px (never up), and an
 * image with a side under 280 px is padded with white to that size (the API rejects, never resizes). Throws on bytes that
 * are not an image.
 */
export async function prepareJevImage(input: Uint8Array, format: "png" | "jpeg"): Promise<PreparedImage> {
  const { minSidePx, maxSidePx } = JEV_IMAGE_LIMITS;
  let pipeline = sharp(input).rotate().resize({ width: maxSidePx, height: maxSidePx, fit: "inside", withoutEnlargement: true });
  const upright = await pipeline.toBuffer({ resolveWithObject: true });
  let { width, height } = upright.info;
  let bytes: Buffer = upright.data;
  if (width < minSidePx || height < minSidePx) {
    const w = Math.max(width, minSidePx);
    const h = Math.max(height, minSidePx);
    pipeline = sharp(bytes).resize({ width: w, height: h, fit: JEV_IMAGE_PREP.padFit, background: JEV_IMAGE_PREP.padBackground });
    const padded = await pipeline.toBuffer({ resolveWithObject: true });
    bytes = padded.data;
    width = padded.info.width;
    height = padded.info.height;
  }
  // flatten: JPEG has no transparency, and a transparent PNG corner should not turn black.
  const encoded =
    format === JEV_IMAGE_PREP.planFormat
      ? await sharp(bytes).png().toBuffer()
      : await sharp(bytes).flatten({ background: JEV_IMAGE_PREP.padBackground }).jpeg({ quality: JEV_IMAGE_PREP.jpegQuality, progressive: false }).toBuffer();
  return { data: new Uint8Array(encoded), format, width, height };
}

/** The most one picture may weigh as downloaded (TypeSafe's own limit is 16 MiB per file). */
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Fetches one Booli picture: only an https URL on the Booli image-host allowlist (SSRF), no redirect followed, an image
 * content type, at most 15 MiB. Returns null on every failure. Never persists anything.
 */
export async function fetchBooliImage(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!isAllowedImageHost(url)) return null;
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: "image/webp,image/png,image/jpeg,*/*;q=0.8" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > 0 && buf.byteLength <= MAX_DOWNLOAD_BYTES ? buf : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** What the call needs of the TypeSafe client; the real `TypeSafeClient` satisfies it, a test passes a fake. */
export interface JevClientLike {
  systemOne(
    request: { state: unknown; questions: Record<string, Question>; model?: string },
    options?: { headers?: Record<string, string>; timeout?: number },
  ): PromiseLike<{ model?: string; answers: Record<string, unknown>; usage?: { input_tokens?: number | null; output_tokens?: number | null } }>;
}

/** The parts of a call a test replaces: how a URL becomes bytes, how bytes become a picture, and the pause between downloads. */
export interface JevCallDeps {
  fetchImage?: (url: string) => Promise<Uint8Array | null>;
  prepare?: (input: Uint8Array, format: "png" | "jpeg") => Promise<PreparedImage>;
  /** Pause between two downloads in ms (default 300: sequential and polite toward the CDN). */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The HTTP status an SDK error carries, or null. */
const statusOf = (error: unknown): number | null => {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
};

/** The SDK request: the pictures and the context text in `state`, every question of the variant. Exported for the tests. */
export function buildJevRequest(pictures: readonly unknown[], model: string = JEV_MODEL) {
  return {
    state: { about: JEV_ABOUT, pictures },
    questions: JEV_QUESTIONS as unknown as Record<string, Question>,
    model,
  };
}

/** Per-attempt timeout of the request, ms: several pictures go up as multipart, the SDK default of 10 s is too short. */
export const JEV_REQUEST_TIMEOUT_MS = 90_000;

/**
 * The injected call of `runVariantReads` for variant e. See the file header. A failure before the request (picture not
 * fetched or not preparable) is a {@link LayoutCallError} billed 0; an SDK error is a LayoutCallError `JEV_<class>` billed 0
 * carrying the HTTP status (so the smoke can see a 400); an answer that cannot be mapped is `JEV_BAD_ANSWER` billed what the
 * request cost.
 */
export function makeJevLayoutCall(client: JevClientLike, spec: LayoutVariantSpec, deps: JevCallDeps = {}): VariantCallFn {
  const fetchImage = deps.fetchImage ?? ((url: string) => fetchBooliImage(url));
  const prepare = deps.prepare ?? prepareJevImage;
  const pauseMs = deps.pauseMs ?? 300;
  return async (blocks: LayoutImageBlock[]) => {
    if (blocks.length === 0) throw new LayoutCallError("NO_IMAGES", 0);
    const pictures: unknown[] = [];
    let downloads = 0;
    for (const [index, block] of blocks.entries()) {
      let bytes: Uint8Array | null;
      if (block.source.type === "base64") {
        bytes = new Uint8Array(Buffer.from(block.source.data, "base64"));
      } else {
        if (downloads > 0 && pauseMs > 0) await sleep(pauseMs);
        downloads += 1;
        bytes = await fetchImage(block.source.url);
      }
      if (bytes === null || bytes.byteLength === 0) throw new LayoutCallError("IMAGE_DOWNLOAD", 0);
      let prepared: PreparedImage;
      try {
        prepared = await prepare(bytes, index === 0 ? JEV_IMAGE_PREP.planFormat : JEV_IMAGE_PREP.photoFormat);
      } catch {
        throw new LayoutCallError("IMAGE_PREPARE", 0);
      }
      pictures.push(image(prepared.data));
    }

    let response;
    try {
      response = await client.systemOne(buildJevRequest(pictures, spec.model), {
        headers: { ...JEV_IMAGES_HEADER },
        timeout: JEV_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      const wrapped = new LayoutCallError(`JEV_${error instanceof Error ? error.name : "UNKNOWN"}`, 0);
      const status = statusOf(error);
      if (status !== null) Object.assign(wrapped, { status });
      throw wrapped;
    }
    const costSek = jevCostSek(response.usage);
    try {
      const inputTokens = response.usage?.input_tokens;
      return {
        result: layoutReadFromJev(response.answers),
        costSek,
        ...(typeof inputTokens === "number" && Number.isFinite(inputTokens) ? { inputTokens } : {}),
      };
    } catch {
      throw new LayoutCallError("JEV_BAD_ANSWER", costSek);
    }
  };
}

/**
 * The real client, created only when the gate passes (RUN_LLM_EVALS=1 and a key in the environment); otherwise throws
 * without constructing anything, so no request can be made by accident. `make` exists for tests.
 */
export function createJevClient(
  env: Readonly<Record<string, string | undefined>>,
  make: () => JevClientLike = () => new TypeSafeClient({ logLevel: "error" }) as unknown as JevClientLike,
): JevClientLike {
  if (jevGate(env) !== "ok") throw new Error("JEV_GATE_CLOSED");
  return make();
}
