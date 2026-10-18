/**
 * http-guards.ts - checks that the city client and the Min Karta resolver share (Phase 14.6).
 *
 * Pure helpers, no network and no file access. Both callers send `redirect: "error"`, so a server that starts
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
