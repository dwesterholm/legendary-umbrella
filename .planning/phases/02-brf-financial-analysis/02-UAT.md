---
status: partial
phase: 02-brf-financial-analysis
source: [02-VERIFICATION.md]
started: 2026-06-14T15:20:00Z
updated: 2026-06-16T06:33:17Z
blocked_by: third-party
blocker_summary: "Booli scraping actor (Apify lexis-solutions/booli-se-scraper, bpf1JaYRBbia2nQU9) free trial expired — now a $29/mo rental, returns 403 actor-is-not-rented. No analysis can be created without it, which gates all 7 UI tests. Decision deferred (rent vs. switch actor)."
---

## Current Test

[paused — blocked on third-party prerequisite]

All 7 tests require a successful Booli fetch to first create an analysis (the
page that hosts the BRF section). The Booli scraper actor's free trial has
expired; running it now requires renting it ($29/mo) or switching to another
actor. UAT is paused pending that decision. No code defect — Phase 1/2 code is
correct; this is an external Apify marketplace rental state.

Resume after the actor is rentable (or replaced): `/gsd-verify-work 2`

## Tests

### 1. Guest access + login gate
expected: Logged out, the BRF section shows only the "Logga in för BRF-analys" teaser — no dropzone. The other three "Kommer snart" sections are unchanged. (D-05 / BRF-03)
result: blocked
blocked_by: third-party
reason: "Cannot reach an analysis page — Booli fetch fails (Apify actor bpf1JaYRBbia2nQU9 trial expired, 403 actor-is-not-rented, $29/mo rental)."

### 2. PDF upload validation (client-side)
expected: Logged in, a non-PDF file triggers "Endast PDF-filer stöds" and a >20 MB PDF triggers "Filen är för stor – max 20 MB", both before any server call. (D-14)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1)."

### 3. Upload-to-progress flow with a real årsredovisning
expected: A valid PDF starts analyzeBrf; the section transitions dropzone → BrfProgress, cycling Läser dokumentet → Extraherar nyckeltal → Beräknar betyg. Reloading mid-run resumes at the current step (server-persisted brf_status). On completion it advances to the score card. (D-13 / BRF-01 / BRF-03)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1)."

### 4. Score card — grade + breakdown + confidence flags
expected: BrfScoreCard shows a colour-coded A–F grade (A/B sage, C/D terracotta, E/F red); four metric rows with value, mini-rating, and weight %; a "Säkerhet N%" badge for in-band fields; and a destructive "Osäker — kontrollera själv" badge for low-confidence / sanity-downgraded fields. (D-07 / D-10 / BRF-02)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1)."

### 5. Source quote disclosure
expected: Each extracted metric has an expandable "Visa källa (sid N)" reveal showing the verbatim PDF quote + page number. Null fields show no reveal. (D-11 / BRF-02)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1)."

### 6. Inline field correction (no Claude re-call)
expected: "Ändra" → enter a new value → "Spara" triggers correctBrfField (NOT analyzeBrf). Grade + breakdown re-render; the edited field shows a "Manuellt angiven" badge; brf_cost_sek does NOT increase. An empty value is rejected (not silently saved as 0). (D-12 / BRF-02 / WR-01)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1)."

### 7. Public methodology page without login
expected: Visiting /sa-raknar-vi logged OUT loads (no /login redirect) and shows all four metrics with threshold bands + weights matching the live scorer, plus the A–F and "Osäker" explanations. (D-09 / BRF-02)
result: blocked
blocked_by: third-party
reason: "Prerequisite Booli fetch fails (see Test 1). NOTE: this page has no Booli dependency and could be spot-checked independently by visiting /sa-raknar-vi directly while logged out — left blocked for a single clean UAT pass."

## Summary

total: 7
passed: 0
issues: 0
pending: 0
skipped: 0
blocked: 7

## Gaps

[none — blocker is a third-party prerequisite (Apify actor rental), not a code gap]

## Blocker Detail

**What:** `analyzeListing` (Phase 1) calls Apify actor `bpf1JaYRBbia2nQU9`
(`lexis-solutions/booli-se-scraper`) via `src/lib/apify/booli-scraper.ts`.

**Diagnosis (2026-06-16):** Direct API reproduction returned
`403 actor-is-not-rented` — the actor's 24h free trial expired after the
June 6 dev runs. It is a `FLAT_PRICE_PER_MONTH` rental at **$29/mo**. The call
fails before any run is created (confirmed: no actor runs exist since
2026-06-06), so `scrapeBooli` throws and `analyze.ts` returns the generic
"Kunde inte hämta data från Booli." Token, account standing (STARTER, paid),
actor availability, deps, and `.env.local` were all verified healthy — this is
solely the rental state.

**Resolution options (user decision pending):**
1. Rent the actor ($29/mo) at https://console.apify.com/actors/bpf1JaYRBbia2nQU9 — zero code change.
2. Switch to a free / pay-per-result Booli scraper actor — change actor ID + field mapping in `booli-scraper.ts`, re-test.

**Not a Phase 2 defect.** Phase 2 verification is `human_needed` only for the 7
UI walkthroughs above; the blocker is an upstream Phase 1 external dependency.
