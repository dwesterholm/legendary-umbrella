# API Coverage — Anthropic Messages API and Booli (Phase 14.5)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Anthropic is used only by the layout experiments (plans 05, 08, 09) and, if a variant wins, by the weekly layout read it replaces (plan 12). The existing vision call, its schema, prompt and cache are not touched (D-14). Booli is read through the free local browser rung and the image CDN; 0 USD Apify for the whole phase (D-13).

| capability | decision | reason |
|---|---|---|
| Anthropic: messages (client.beta.messages.parse) with image blocks by URL | INTEGRATE | The four Booli pictures of each truth-set flat (plan picture plus 3 photos), host-allowlisted by `isAllowedImageHost` before any URL reaches the API |
| Anthropic: messages with base64 image blocks | INTEGRATE | Only the committed synthetic floor plan in the variant-b smoke; broker photos are not sent by any experiment (Pitfall 8) |
| Anthropic: strict structured output (output_config.format via zodOutputFormat) | INTEGRATE | Variant schemas stay flat (enums, booleans, plain numbers; no nullable, no union, no bounds); each new shape gets a live smoke at most 1 kr before its round (V2 twelve fields, Opus call shape, step-B array); a pre-defined slim schema is the HTTP 400 fallback |
| Anthropic: model claude-sonnet-4-6 | INTEGRATE | Production layout read today; variants a, b and d-sonnet |
| Anthropic: model claude-opus-5-5 (new tier) | INTEGRATE | Variants c and d-opus (D-10 "the Opus tier"); id defined in layout-read.ts, never in the locked vision-prompt.ts; own call shape: no temperature, output_config.effort "low", max_tokens 4000 |
| Anthropic: effort parameter (output_config.effort) | INTEGRATE | Opus variants only, "low"; "medium" not planned (a variant change after the lock would be tuning) |
| Anthropic: thinking on Opus 5.5 | INTEGRATE (implicit) | Always on for Opus 5.5 and cannot be disabled; budgeted inside max_tokens 4000 and billed from usage.output_tokens; no thinking parameter is sent |
| Anthropic: usage-based cost accounting (message.usage) | INTEGRATE | New per-model rate table in layout-cost.ts (Sonnet 4.6 $3/$15, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5 per million tokens, 11 kr per USD); fixes the 14.4 ledger that billed the Sonnet read at Haiku rates (R-04); caps: 1 kr per smoke, 40 kr per round, 40 kr per weekly run |
| Anthropic: model claude-sonnet-5-5 | OPT-OUT | Not needed: D-10 names Sonnet (today's read) against the Opus tier; adding a fifth variant after the lock would be a variant chosen with results in view. Priced in the rate table for completeness only |
| Anthropic: streaming | OPT-OUT | Not needed: each answer is a short JSON object (at most a few thousand tokens with Opus thinking) |
| Anthropic: Message Batches API | OPT-OUT | Not needed: a round is at most 45 flats and 40 kr; batching would save at most about 20 kr per round but adds polling, a second failure mode and breaks the per-call cap check that stops a round at 40 kr |
| Anthropic: tool use | OPT-OUT | Not needed: the output is a strict schema; no tool is called |
| Anthropic: Files API | OPT-OUT | Explicitly out of scope: pictures are analyse-only and are never stored (GDPR rule; truth set is data only) |
| Anthropic: token counting endpoint | OPT-OUT | Not needed: cost is estimated per flat before each call (estSekPerFlat per variant) and measured after from usage |
| Anthropic: prompt caching | OPT-OUT | Not needed: every call carries different pictures and the system prompt is short, so cache hits would be rare |
| Anthropic: citations, web search, code execution, computer use, MCP connector | OPT-OUT | Explicitly out of scope: no document grounding, browsing or tool environment is involved |
| Booli: sold-detail pages (/annons/<id>) via the local browser | INTEGRATE | The enrichment that started 2026-10-17 12:02 UTC stopped on a Booli challenge at 3 849 of 5 469 rows; R-07: one restart in plan 10, not before 2026-10-18 13:15 UTC, concurrency 1 and at least 2 s between page starts (new `--start-gap-secs`, added in the gap when no process runs); a second challenge ends ENR-01 as partly met |
| Booli: public BRF pages via the local browser | INTEGRATE | The BRF pass of the same restart, same concurrency and spacing; skipped if the restart stops before it |
| Booli: sold-detail broker text for ceiling height | OPT-OUT | Not available: sold-detail payloads carry no description (R-03, three dumps checked), so no sold row can state a height and the hedonic ceiling feature is not built |
| Booli: for-sale detail and broker page text | INTEGRATE | Already read in memory by watch-enrich for sun phrases; the new ceiling parser reads the same text and stores only a number, a literal and a flag (plans 01, 04); first measured on plan 13's live run |
| Booli: search and for-sale listing pages | INTEGRATE (unchanged) | Plan 13's single live run with --no-vision, local browser, after the restart's END line, gated by booli-gate.mjs (R-07 time, not in the Monday job window) |
| Booli: image CDN (bcdn.se) | INTEGRATE | Picture URLs passed to Anthropic for the rounds; the truth-set judging downloads the four pictures per flat over https, one request per second, no browser, into a scratch directory that is deleted (plans 06-07), not before 2026-10-18 13:15 UTC (R-07, booli-gate.mjs) |
| Booli: any new page type | OPT-OUT | Not needed: every number this phase needs is in pages already read |
| Booli: any page through Apify | OPT-OUT | Explicitly out of scope: 0 USD Apify; no command passes --allow-apify |
