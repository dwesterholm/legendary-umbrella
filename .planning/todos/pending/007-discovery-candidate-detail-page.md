---
title: "Discovery results IA — clicking a candidate dumps you on the paste-a-URL page, and AI insights pile up below the grid unattached to any object"
status: pending
priority: P1
source: "captured 2026-08-11 — operator, after the first successful live discovery run"
created: 2026-08-11
theme: ux
area: frontend
---

## Two defects, one root cause

Discovery candidates have **no detail page**, so both the click-through and the analysis output have nowhere correct to go.

**1. Clicking a card sends you to the paste-a-Booli-link screen.**
`src/components/discovery-candidate-card.tsx:52` sets:

```
href = `/dashboard?url=${encodeURIComponent(candidate.sourceListingUrl)}`
```

So the whole card links into the *single-listing analyze* flow, pre-filled. Intentional as a hand-off, but it reads as a dead end: the user clicked a result they had already waited minutes for and landed back at an input box. Whatever the query param does, it is not "show me this object".

**2. AI insights render as a separate list below the grid.**
`src/components/discovery-results.tsx:219` renders `GalleryConditionVision` cards in their own wrapper *after* the ranking grid, keyed by index. Operator's reaction:

> "at the bottom of the grid it all of a sudden starts listing the AI insights (for which object?). E.g. image analysis, sun analysis, etc."

Exactly right — there is no visual binding between insight N and card N. This layout traces to 11-UI-SPEC.md and the structural-separation constraint (the grid must not import vision types), and the comments at `discovery-results.tsx:190-211` show it was deliberate. It works for a handful of results and breaks down completely at 25.

## The fix

A per-candidate detail route — e.g. `/discover/[jobId]/[candidateId]` — that owns everything about one object: the listing facts, the holistic brief, the condition/vision read, the sun-path block, the comps positioning, the BRF summary. The grid card then links **there**, and the insight section below the grid disappears entirely because each insight lives with its object.

Constraint to respect: the separation rule is real and static-grep enforced (`niche-score.test.ts` forbids `niche-score.ts`/`flags.ts` importing vision/value-gap/area-comps/sun-path). The detail page is a *read* surface, so it is allowed to compose these — but the ranking path must stay clean. Do not solve this by importing vision types into the grid.

## Why it matters now

Phase 14 put real work into the holistic brief — comps positioning, BRF debt/avgift/stambyte prose, the confounder guard's "low kr/m² ≠ renovation object" reasoning. A user currently cannot attribute any of it to a specific apartment. Phases 15–17 (ROI brief, value-gap ranking, proposed planritning) all produce **per-object** output and will make this strictly worse — each one needs this page to exist.

Related: todo 002 (feature picker) — same underlying theme of navigation never keeping up with capability. Worth doing both in one UI phase.
