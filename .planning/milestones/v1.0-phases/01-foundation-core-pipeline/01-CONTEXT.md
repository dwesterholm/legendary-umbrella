# Phase 1: Foundation + Core Pipeline - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

User can paste a Booli listing URL and see a structured summary of the property's key data. Includes app shell, Booli scraping pipeline, listing display, authentication, and a dashboard of previous analyses. BRF financial analysis, price comparisons, area statistics, and AI reports are out of scope (Phases 2-4).

</domain>

<decisions>
## Implementation Decisions

### Analysis flow
- Skeleton placeholder loading while scraping (3-10 seconds) — progressive reveal as data arrives
- When scraping fails or returns partial data, show whatever was extracted with clear markers on missing fields (e.g., "Ej tillganglig")
- App UI language is Swedish; all code (variables, comments, etc.) in English
- Try-once guest access: first analysis works without account, then login wall to save or run more

### Listing summary layout
- Data only, no listing images in Phase 1
- Display required fields (price, size, avgift, rooms, byggar, address, BRF name) plus calculated pris/kvm
- Include grayed-out placeholder sections for future phases (BRF Analys, Prisjamforelse, Omradesstatistik, AI Rapport) with "Kommer snart" labels
- Exact layout style (cards vs sections vs grid) at Claude's discretion

### Dashboard & history
- Card grid layout showing address, price, key metrics, and analysis date per card
- No delete functionality in Phase 1 — all analyses are kept
- Click card to re-open full analysis

### Authentication
- Email + password signup/login
- First analysis available without account (guest access), then login required to save or continue

### Brand & visual direction
- Warm & approachable visual style — soft grays, warm whites, earthy accents (sage/terracotta palette)
- Hemnet-inspired: familiar to Swedish property buyers, property-focused layout
- Light mode only
- Tool-first, minimal chrome — no landing page, minimal nav, just input/results/dashboard
- Friendly rounded typography direction (e.g., DM Sans)
- Comfortable, airy spacing

### Claude's Discretion
- Page flow pattern (same-page inline vs dedicated analysis page)
- Exact layout structure for listing summary (hero card + grid vs sectioned list)
- Loading skeleton design details
- Error state messaging and styling
- Typography and spacing specifics
- Navigation structure

</decisions>

<specifics>
## Specific Ideas

- Hemnet as the primary visual reference — clean, warm, familiar to Swedish property buyers
- "Kommer snart" sections to create anticipation for future product capabilities
- Guest access model similar to many SaaS tools: try before you sign up, reduces friction

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-core-pipeline*
*Context gathered: 2026-02-24*
