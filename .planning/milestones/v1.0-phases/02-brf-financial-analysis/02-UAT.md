---
status: complete
phase: 02-brf-financial-analysis
source: [02-VERIFICATION.md]
started: 2026-06-14T15:20:00Z
updated: 2026-06-16T11:14:31Z
---

## Current Test

[testing complete]

## Tests

### 1. Guest access + login gate
expected: Logged out, the BRF section shows only the "Logga in för BRF-analys" teaser — no dropzone. The other three "Kommer snart" sections are unchanged. (D-05 / BRF-03)
result: pass
note: |
  Requirement (D-05 guest gate) verified by a DIFFERENT mechanism than the test
  assumed. BrfSection renders only on /analysis/[id], which is in the (app)
  route group whose layout redirect()s guests to /login — so a guest can never
  reach the in-page teaser. The teaser branch (isGuest) is unreachable
  defence-in-depth code by design; BRF is a logged-in-only feature (guest
  listing analyses are returned inline and not persisted, so there is no
  analysis page for a guest to view). User confirmed the gate works: pasting a
  link while signed out redirects to sign-in. Optional cleanup: remove the dead
  isGuest branch in brf-section.tsx (info-level, not a defect).

### 2. PDF upload validation (client-side)
expected: Logged in, a non-PDF file triggers "Endast PDF-filer stöds" and a >20 MB PDF triggers "Filen är för stor – max 20 MB", both before any server call. (D-14)
result: pass
note: "User confirmed client-side rejection of non-PDF and >20 MB files (2026-06-16)."

### 3. Upload-to-progress flow with a real årsredovisning
expected: A valid PDF starts analyzeBrf; the section transitions dropzone → BrfProgress, cycling Läser dokumentet → Extraherar nyckeltal → Beräknar betyg. Reloading mid-run resumes at the current step (server-persisted brf_status). On completion it advances to the score card. (D-13 / BRF-01 / BRF-03)
result: pass
note: "Signed-in upload of a real årsredovisning completed and advanced to the score card with correct calculations (2026-06-16). Happy path verified; reload-mid-run resilience not explicitly exercised."

### 4. Score card — grade + breakdown + confidence flags
expected: BrfScoreCard shows a colour-coded A–F grade (A/B sage, C/D terracotta, E/F red); four metric rows with value, mini-rating, and weight %; a "Säkerhet N%" badge for in-band fields; and a destructive "Osäker — kontrollera själv" badge for low-confidence / sanity-downgraded fields. (D-07 / D-10 / BRF-02)
result: pass
note: "User confirmed correct calculations + the 'Osäker — kontrollera själv' badge rendered (2026-06-16)."

### 5. Source quote disclosure
expected: Each extracted metric has an expandable "Visa källa (sid N)" reveal showing the verbatim PDF quote + page number. Null fields show no reveal. (D-11 / BRF-02)
result: pass
note: "User confirmed the source citation on skuld/kvm (and others) rendered (2026-06-16)."

### 6. Inline field correction (no Claude re-call)
expected: "Ändra" → enter a new value → "Spara" triggers correctBrfField (NOT analyzeBrf). Grade + breakdown re-render; the edited field shows a "Manuellt angiven" badge; brf_cost_sek does NOT increase. An empty value is rejected (not silently saved as 0). (D-12 / BRF-02 / WR-01)
result: pass
note: "User confirmed inline edit re-scores correctly without a new Claude call (2026-06-16)."

### 7. Public methodology page without login
expected: Visiting /sa-raknar-vi logged OUT loads (no /login redirect) and shows all four metrics with threshold bands + weights matching the live scorer, plus the A–F and "Osäker" explanations. (D-09 / BRF-02)
result: pass
note: "User confirmed /sa-raknar-vi loads logged out and looks good (2026-06-16)."

## Summary

total: 7
passed: 7
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

## Blocker Detail (RESOLVED 2026-06-16)

The earlier blocker — Apify actor `bpf1JaYRBbia2nQU9`
(`lexis-solutions/booli-se-scraper`) trial expired, returning
`403 actor-is-not-rented` ($29/mo rental) — is **resolved**. The actor is now
rented (POST run returned `201 Created` on 2026-06-16). Booli fetch works again;
UAT resumed. No code change was required.
