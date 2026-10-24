// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fetchBooliImage, prepareJevImage } from "@/lib/discovery/layout-typesafe-call";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const startsWith = (data: Uint8Array, magic: number[]) => magic.every((b, i) => data[i] === b);

/** A solid-colour image of a given size and format, as bytes. */
async function sample(width: number, height: number, format: "webp" | "png" | "jpeg", orientation?: number): Promise<Uint8Array> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } });
  if (format === "webp") img = img.webp();
  else if (format === "png") img = img.png();
  else img = orientation !== undefined ? img.withMetadata({ orientation }).jpeg() : img.jpeg();
  return new Uint8Array(await img.toBuffer());
}

describe("prepareJevImage (docs.typesafe.ai/images, Preparing images)", () => {
  it("turns a Booli WebP into a PNG for the plan and a baseline JPEG for a photo", async () => {
    const webp = await sample(1440, 1000, "webp");
    const plan = await prepareJevImage(webp, "png");
    expect(plan.format).toBe("png");
    expect(startsWith(plan.data, PNG_MAGIC)).toBe(true);
    const photo = await prepareJevImage(webp, "jpeg");
    expect(photo.format).toBe("jpeg");
    expect(startsWith(photo.data, JPEG_MAGIC)).toBe(true);
    const meta = await sharp(photo.data).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.isProgressive).toBeFalsy();
  });

  it("scales the longest side down to 1568 px, keeping the aspect ratio, and never scales up", async () => {
    const big = await prepareJevImage(await sample(3000, 1500, "png"), "jpeg");
    expect(big.width).toBe(1568);
    expect(big.height).toBe(784);
    const tall = await prepareJevImage(await sample(1000, 4000, "png"), "jpeg");
    expect(tall.height).toBe(1568);
    expect(tall.width).toBe(392);
    const fits = await prepareJevImage(await sample(800, 600, "png"), "jpeg");
    expect([fits.width, fits.height]).toEqual([800, 600]);
    const meta = await sharp(big.data).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 784]);
  });

  it("pads an image with a side under 280 px to the minimum instead of sending it (the API rejects, never resizes)", async () => {
    const small = await prepareJevImage(await sample(100, 100, "png"), "png");
    expect([small.width, small.height]).toEqual([280, 280]);
    const thin = await prepareJevImage(await sample(1000, 150, "jpeg"), "jpeg");
    expect(thin.width).toBe(1000);
    expect(thin.height).toBe(280);
    const meta = await sharp(thin.data).metadata();
    expect(meta.height).toBe(280);
  });

  it("applies the EXIF orientation to the pixels, because the API strips the metadata and does not rotate", async () => {
    // Stored 600 wide x 400 high with orientation 6 (rotate 90 degrees): upright it is 400 wide x 600 high.
    const sideways = await sample(600, 400, "jpeg", 6);
    const out = await prepareJevImage(sideways, "jpeg");
    expect([out.width, out.height]).toEqual([400, 600]);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([400, 600]);
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("stays inside the total-pixel limit of 78 400 to 2 458 624", async () => {
    for (const [w, h] of [[3000, 3000], [100, 100], [1440, 1000]] as const) {
      const out = await prepareJevImage(await sample(w, h, "png"), "jpeg");
      expect(out.width * out.height).toBeGreaterThanOrEqual(78_400);
      expect(out.width * out.height).toBeLessThanOrEqual(2_458_624);
    }
  });

  it("throws on bytes that are not an image", async () => {
    await expect(prepareJevImage(new Uint8Array([1, 2, 3, 4]), "jpeg")).rejects.toThrow();
  });
});

describe("fetchBooliImage", () => {
  const imageResponse = (over: { status?: number; type?: string; body?: Uint8Array } = {}) =>
    new Response((over.body ?? new Uint8Array([1, 2, 3])) as BodyInit, { status: over.status ?? 200, headers: { "content-type": over.type ?? "image/webp" } });

  it("never calls out for a URL that is not on the Booli image-host allowlist or is not https", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return imageResponse();
    }) as unknown as typeof fetch;
    expect(await fetchBooliImage("https://evil.example/a.webp", fetchImpl)).toBeNull();
    expect(await fetchBooliImage("http://bcdn.se/images/cache/1_1440x0.webp", fetchImpl)).toBeNull();
    expect(await fetchBooliImage("https://bcdn.se.evil.example/a.webp", fetchImpl)).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns the bytes of an allowed image, does not follow a redirect and refuses a non-image or an error status", async () => {
    const seen: RequestInit[] = [];
    const ok = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return imageResponse();
    }) as unknown as typeof fetch;
    const bytes = await fetchBooliImage("https://bcdn.se/images/cache/1_1440x0.webp", ok);
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3]);
    expect(seen[0].redirect).toBe("manual");
    const html = (async () => imageResponse({ type: "text/html" })) as unknown as typeof fetch;
    expect(await fetchBooliImage("https://bcdn.se/images/cache/1_1440x0.webp", html)).toBeNull();
    const redirect = (async () => imageResponse({ status: 302 })) as unknown as typeof fetch;
    expect(await fetchBooliImage("https://bcdn.se/images/cache/1_1440x0.webp", redirect)).toBeNull();
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchBooliImage("https://bcdn.se/images/cache/1_1440x0.webp", boom)).toBeNull();
  });
});
