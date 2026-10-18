/**
 * http-guards.ts - checks that the city client and the Min Karta resolver share (Phase 14.6).
 *
 * No network and no file access of its own. Both callers send `redirect: "error"`, so a server that starts
 * redirecting (to a login or terms page) shows up as a thrown fetch error, not as a 3xx answer.
 */

/**
 * True for a fetch error that is a refused redirect. Node's undici throws `TypeError: fetch failed` whose `cause`
 * is `Error("unexpected redirect")`. Only the message texts are read, never a URL.
 */
export function looksLikeRedirect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(`${error.message} ${causeText}`);
}

/**
 * Reads a body. Over `max` bytes (declared or streamed) gives "overflow" - or, with `truncate`, the first `max`
 * bytes. The declared length is checked before reading.
 */
export async function readCapped(response: Response, max: number, truncate = false): Promise<{ text: string; bytes: number } | "overflow"> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return "overflow";
  }
  if (response.body === null) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes <= max) return { text, bytes };
    return truncate ? { text: Buffer.from(text).subarray(0, max).toString("utf8"), bytes: max } : "overflow";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) return "overflow";
      return { text: Buffer.concat(chunks).subarray(0, max).toString("utf8"), bytes: max };
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}
