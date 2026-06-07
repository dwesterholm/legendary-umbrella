/**
 * Claude Haiku 4.5 per-million-token (MTok) USD rates, verified 2026-06-07
 * (RESEARCH §Cost & Limits): input $1, output $5, 5-minute cache write $1.25,
 * cache read $0.10. The extraction runs on Haiku to stay under the per-analysis
 * budget (AI-SPEC §4b).
 */
export const USD_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite5m: 1.25,
  cacheRead: 0.1,
} as const;

/**
 * USD→SEK conversion rate, exposed as a named config constant rather than
 * hardcoded inline (assumption A1, RESEARCH). Update this single value when the
 * FX rate moves materially; the < 5 SEK budget cap (Plan 04) reads `costSek`.
 */
export const USD_SEK_RATE = 11;

/** Token usage as reported by the Anthropic SDK `message.usage`. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written into the prompt cache (billed at cacheWrite5m). */
  cache_creation_input_tokens?: number;
  /** Tokens read from the prompt cache (billed at the cheaper cacheRead rate). */
  cache_read_input_tokens?: number;
}

const ONE_MTOK = 1_000_000;

/**
 * Computes the SEK cost of a single Claude analysis from its token usage.
 *
 * Sums input, output, cache-write and cache-read token costs at their
 * respective per-MTok USD rates, then converts to SEK via `USD_SEK_RATE`.
 * Cache fields default to 0 when absent. A cache-read-heavy retry is cheaper
 * than a cold full-document run because cached tokens bill at $0.10/MTok
 * instead of $1/MTok. Pure function — no side effects, no network.
 *
 * @param usage - token counts from `message.usage`
 * @returns the analysis cost in SEK
 */
export function costSek(usage: ClaudeUsage): number {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const usd =
    (usage.input_tokens * USD_PER_MTOK.input +
      usage.output_tokens * USD_PER_MTOK.output +
      cacheWrite * USD_PER_MTOK.cacheWrite5m +
      cacheRead * USD_PER_MTOK.cacheRead) /
    ONE_MTOK;

  return usd * USD_SEK_RATE;
}
