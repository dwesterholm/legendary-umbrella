---
title: "P0 COST BUG — an unresolvable area silently returns listings from all over Sweden instead of failing fast"
status: pending
priority: P0
source: "captured 2026-08-11 — live smoke, real spend wasted. Query: 'Renoveringsobjekt i innerstan (innanför tullarna) på 30-45 kvm med ett maxpris på 4M kronor.'"
created: 2026-08-11
theme: correctness
area: backend
---

## What happened

The operator ran a real, paid discovery job scoped to Stockholm's inner city. It returned **apartments from all over Sweden**. The job completed "successfully" — no error, no warning, no indication the area scope had been lost. Real Apify and Anthropic spend went into scraping and analyzing listings that could never match the request.

Operator's verdict: *"This was a waste of money honestly."* That is the correct reading. A job whose scope silently collapses to the whole country should not be allowed to spend.

## Root cause (evidence, with one open question)

Two contributing defects, both confirmed by reading source:

**1. The intent parser is told to guess.** `src/lib/discovery/parse-intent.ts:47` instructs Haiku, verbatim:

> `areaQuery: fritextnamnet pa omradet/stadsdelen anvandaren namner (t.ex. "Sodermalm"). Om inget omrade namns, gor en rimlig bedomning eller lamna en tom strang.`

So on an area it cannot map, the model is explicitly licensed to invent one or return an empty string. Neither outcome is surfaced to the user or treated as a failure.

**2. "Innerstan (innanför tullarna)" is unresolvable by construction.** It is a colloquial umbrella covering ~8 stadsdelar, not a Booli area. `resolve-area.ts`'s ladder is probe → seed → null: the live Booli search-box probe finds no single matching suggestion, and `AREA_SEED` contains specific stadsdelar (Södermalm, Vasastan, …), not the umbrella term. So resolution lands on null or on something wrong.

**Open question to confirm before fixing:** trace exactly how a null/empty `areaQuery` becomes a nationwide result set — whether `fetchAreaListings` is being called with a missing/wide areaId, or whether Haiku's "reasonable judgement" produced a resolvable-but-wrong national-tier area. The fix differs. Reproduce cheaply by logging the resolved areaIds for this exact query rather than by running another full paid job.

## Required fix — fail fast, before spending

The load-bearing change is a **guard, not better resolution**. Resolution will always miss some colloquial input; what must never happen is spending money on an unscoped job.

- If `areaQuery` is empty or resolves to null, **do not scrape**. Fail the job with a clear user-facing message ("Vi kunde inte tolka området …") and offer the filter UI as the fallback path.
- Never let a resolution miss degrade into a wider-tier area. A miss must be an error, not a silent widening — this mirrors the transport layer's existing HIGH-1 discipline (`throw`, never return `[]` to mean "dead").
- Consider validating the resolved area against the user's stated intent before spending: if the request said Stockholm and resolution produced a national or non-Stockholm tier, that is a mismatch worth blocking on.
- Stop instructing the model to guess. Change the `parse-intent.ts:47` prompt so an unrecognised area returns an explicit "unresolved" signal rather than a plausible invention or an empty string.

## Follow-on

Teach the seed/resolution layer the common Stockholm umbrella terms — "innerstan", "innanför tullarna", "söderort", "västerort" — by expanding them to their constituent stadsdelar. That is a real improvement but it is **secondary**: the guard above must land first, because it is what bounds the cost of every future miss.

Related: todo 006 (the filter UI can only hold one area, so there is currently no good manual fallback when free text fails).
