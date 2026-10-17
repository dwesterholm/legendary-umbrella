/**
 * layout-cost.ts - what a layout read costs, priced at its own model's rates (Phase 14.5 plan 05, R-04).
 *
 * Why it exists: until 2026-10-17 the layout call billed every read with `costSek` of brf/cost.ts, which is the
 * Haiku 4.5 table ($1 in, $5 out per million tokens), although the read runs on Sonnet 4.6 ($3 / $15). Every stored
 * read was recorded at about a third of its true price (about 0,11 kr instead of about 0,32 kr), so a "40 kr" cap
 * allowed about 120 kr. The rates cannot be added to brf/cost.ts, which the running enrichment imports and which
 * is frozen until its END line (R-06), so they live here, in a new file.
 *
 * Rates are USD per million tokens as of the claude-api model table of 2026-10-06. Cache creation and cache read
 * tokens are priced as plain input (the layout read uses no prompt caching, so this only ever rounds up). Thinking
 * tokens arrive inside `output_tokens` and are billed as output, so an Opus read that thinks is priced right.
 *
 * Pure: no clock, no network, no file access. `USD_SEK_RATE` is imported from brf/cost.ts (read only).
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { USD_SEK_RATE } from "@/lib/brf/cost";

/** USD per million tokens, input and output, per model id. Claude API model table, cached 2026-10-06. */
export const LAYOUT_MODEL_RATES_USD_PER_MTOK = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
} as const satisfies Record<string, { input: number; output: number }>;

/** The token counts of `message.usage`; the cache fields may be absent or null. */
export interface LayoutUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const ONE_MTOK = 1_000_000;

/** A token count that is not a finite non-negative number counts as 0, so a malformed usage never makes the cost NaN. */
const tokens = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The SEK cost of one call at the rates of `model`. Throws on a model id with no rate: guessing would put a wrong
 * number in a ledger that stops spending.
 */
export function layoutCallCostSek(model: string, usage: LayoutUsage): number {
  const rates = (LAYOUT_MODEL_RATES_USD_PER_MTOK as Record<string, { input: number; output: number } | undefined>)[model];
  if (rates === undefined) throw new Error(`Okänd modell för layoutpris: ${model}`);
  const input = tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens) + tokens(usage.cache_read_input_tokens);
  const usd = (input * rates.input + tokens(usage.output_tokens) * rates.output) / ONE_MTOK;
  return usd * USD_SEK_RATE;
}
