# API Coverage — Anthropic Messages API and Booli pages (Phase 14.4)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Anthropic is used for two new slim picture reads: the layout read (plans 07-08, model `VISION_SONNET_MODEL` = "claude-sonnet-4-6" from vision-prompt.ts) and the sold-photo condition read (plans 09-10, model `VISION_HAIKU_MODEL` = "claude-haiku-4-5-20251001"). The existing vision call, its schema, prompt and cache are not touched. Booli is read only through the existing free local browser rung; 0 USD Apify.

| capability | decision | reason |
|---|---|---|
| Anthropic: messages (client.beta.messages.parse) with image blocks by URL | INTEGRATE | Booli and bcdn.se image URLs, host-allowlisted (layout read, sold-condition read) |
| Anthropic: messages with base64 image blocks | INTEGRATE | broker photos held in memory during a live run, and the synthetic floor-plan fixture in the smoke |
| Anthropic: strict structured output (output_config.format via zodOutputFormat) | INTEGRATE | flat enum/boolean/number schemas, proven by gated live smokes (plans 07 and 09) |
| Anthropic: model claude-sonnet-4-6 | INTEGRATE | layout read (D-07: reading a floor plan is the hard part) |
| Anthropic: model claude-haiku-4-5-20251001 | INTEGRATE | sold-photo condition read (D-12: one enum, ≤ 0,1 kr per flat) |
| Anthropic: usage-based cost accounting (message.usage) | INTEGRATE | per-call cost into the cache ledgers and the per-run / lifetime caps |
| Anthropic: streaming | OPT-OUT | not needed: each answer is under 400 tokens of JSON |
| Anthropic: Message Batches API | OPT-OUT | not needed: the weekly run needs answers in the same run and the one-off 300-row sold read is ≤ 30 kr; batching adds polling and a second failure mode for a saving of about 15 kr |
| Anthropic: tool use | OPT-OUT | not needed: the output is a strict schema, no tools are called |
| Anthropic: Files API | OPT-OUT | explicitly out of scope: pictures are analyse-only and must not be stored anywhere (GDPR rule for broker photos) |
| Anthropic: token counting endpoint | OPT-OUT | not needed: cost is estimated before each call from fixed per-image token figures (src/lib/brf/cost.ts) and measured after from usage |
| Anthropic: prompt caching | OPT-OUT | not needed: system prompts are short and every call carries different images, so cache hits would be rare |
| Anthropic: extended thinking | OPT-OUT | not needed: enum classification; thinking adds cost and latency without a measurable benefit here |
| Anthropic: citations, web search, code execution, computer use, MCP connector | OPT-OUT | explicitly out of scope: no document grounding, browsing or tool environment is involved |
| Booli: sold-detail page (/annons/<id>) via the local browser | INTEGRATE | plan 02: avgift, BRF id, tenure, days on market, build year, list prices, photo ids (sales from 2025-10-01) |
| Booli: public BRF page (/bostadsrattsforening/<id>) via the local browser | INTEGRATE | plan 02: one page per distinct association for debt per kvm (existing parser fetchBrfFacts) |
| Booli: search and for-sale listing pages | INTEGRATE | unchanged from 14.2 (weekly run and the plan 08 live run read them exactly as before) |
| Booli: image CDN (bcdn.se) | INTEGRATE | image URLs built from digit ids are passed to Anthropic; plan 08's by-eye check downloads 12 floor plans to a temp dir and deletes them |
| Booli: any page through Apify | OPT-OUT | explicitly out of scope: 0 USD Apify for this phase; no command passes --allow-apify |
