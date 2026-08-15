---
title: "No way to reach /discover from the UI — add a feature picker / landing page as the post-login entry point"
status: done
completed: 2026-08-11
priority: P1
source: "captured 2026-08-11 by operator during the Phase 14 live-smoke setup — logged in and had to be given the URL by hand"
created: 2026-08-11
theme: ux
area: frontend
---

## Goal

Give a signed-in user a real entry point that offers BOTH products. Today login drops you straight onto the paste-a-Booli-link surface ("Klistra in en Booli-länk") and there is **no link anywhere to the area-search flow** — the operator had to be handed `/discover` to paste into the address bar.

## Context

The app has grown two distinct products that share a login, but only one is reachable:

| Route | What it is | Reachable from UI? |
|---|---|---|
| `/dashboard` | Paste a Booli URL → single-listing analysis (v1.0 core flow) | yes — post-login landing |
| `/discover` | Free-text area search → ranked candidates + holistic briefs (v1.1/v1.2) | **no** |
| `/discover/[jobId]` | Progress + results for one discovery job | only from `/discover` |
| `/analysis/[id]` | One completed single-listing analysis | from `/dashboard` |

This is a v1.1/v1.2 accumulation problem: discovery shipped behind `DISCOVERY_ENABLED` (a kill switch, now ON) and nothing ever added navigation for it. Phases 13 and 14 both invested heavily in the discovery surface — parallelized scrapes, holistic BRF/comps analysis, the opportunity brief — that a user literally cannot navigate to.

## Scope sketch (not a plan — plan properly before building)

- A post-login entry surface that presents the two flows as a deliberate choice, rather than defaulting into one.
- Persistent navigation between them once inside, so it is not a one-way door.
- Respect `DISCOVERY_ENABLED`: when the kill switch is OFF the discovery option must not be offered (fail-closed, matching `startDiscovery`'s literal-first-line flag check).
- Decide what `/` and `/dashboard` mean afterwards — whether the picker becomes `/`, or `/dashboard` becomes the picker and the paste-a-link flow moves to its own route. This is the main design decision and it touches the post-login redirect in `src/app/(auth)` and the `(app)` layout.

## Why it matters

Every hour spent on discovery analysis quality in v1.2 is invisible to a real user until this exists. It is also the natural home for whatever Phases 15–17 add (ROI brief, value-gap ranking, proposed planritning) — without it, each new capability lands somewhere equally unreachable.

## Notes

Likely wants a UI phase (`/gsd-ui-phase`) rather than going straight to plan — it is a navigation/IA decision with real design content, not a mechanical change.
