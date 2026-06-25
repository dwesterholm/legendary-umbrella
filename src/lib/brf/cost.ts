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
 * Claude Sonnet 4.6 per-million-token (MTok) USD rates, verified 2026-06-23
 * (04-RESEARCH §Synthesis Model Tiering, Pitfall 3): input $3, output $15,
 * 5-minute cache write $3.75, cache read $0.30. The Phase 4 synthesis call runs
 * on Sonnet, so its cost MUST be computed with these rates — billing Sonnet
 * output at the Haiku $5 rate would under-report the priciest call ~3× and
 * defeat the < 5 SEK budget guard (T-04-03).
 */
export const SONNET_USD_PER_MTOK = {
  input: 3.0,
  output: 15.0,
  cacheWrite5m: 3.75,
  cacheRead: 0.3,
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

/**
 * Computes the SEK cost of a single Claude SONNET call from its token usage.
 *
 * Identical arithmetic and `USD_SEK_RATE` to `costSek`, but billed at the
 * Sonnet rates ($3/$15) instead of the Haiku rates ($1/$5). The Phase 4
 * synthesis call (RPRT-01) MUST use this so the cost guard reads the correctly-
 * rated figure (T-04-03 / RESEARCH Pitfall 3). The Haiku `costSek` path and its
 * rates are left untouched. Pure function — no side effects, no network.
 *
 * @param usage - token counts from `message.usage`
 * @returns the Sonnet call cost in SEK
 */
export function costSekSonnet(usage: ClaudeUsage): number {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const usd =
    (usage.input_tokens * SONNET_USD_PER_MTOK.input +
      usage.output_tokens * SONNET_USD_PER_MTOK.output +
      cacheWrite * SONNET_USD_PER_MTOK.cacheWrite5m +
      cacheRead * SONNET_USD_PER_MTOK.cacheRead) /
    ONE_MTOK;

  return usd * USD_SEK_RATE;
}
