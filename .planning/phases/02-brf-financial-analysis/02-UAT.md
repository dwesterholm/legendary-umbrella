---
status: testing
phase: 02-brf-financial-analysis
source: [02-VERIFICATION.md]
started: 2026-06-14T15:20:00Z
updated: 2026-06-14T15:20:00Z
---

## Current Test

number: 1
name: Guest access + login gate
expected: |
  Open an analysis page while logged OUT. The BRF section shows only the
  "Logga in för BRF-analys" teaser; no upload dropzone is visible. The three
  other ComingSoonSection placeholders (Prisjämförelse, Områdesstatistik,
  AI Rapport) are untouched. (D-05 / BRF-03)
awaiting: user response

## Tests

### 1. Guest access + login gate
expected: Logged out, the BRF section shows only the "Logga in för BRF-analys" teaser — no dropzone. The other three "Kommer snart" sections are unchanged. (D-05 / BRF-03)
result: [pending]

### 2. PDF upload validation (client-side)
expected: Logged in, a non-PDF file triggers "Endast PDF-filer stöds" and a >20 MB PDF triggers "Filen är för stor – max 20 MB", both before any server call. (D-14)
result: [pending]

### 3. Upload-to-progress flow with a real årsredovisning
expected: A valid PDF starts analyzeBrf; the section transitions dropzone → BrfProgress, cycling Läser dokumentet → Extraherar nyckeltal → Beräknar betyg. Reloading mid-run resumes at the current step (server-persisted brf_status). On completion it advances to the score card. (D-13 / BRF-01 / BRF-03)
result: [pending]

### 4. Score card — grade + breakdown + confidence flags
expected: BrfScoreCard shows a colour-coded A–F grade (A/B sage, C/D terracotta, E/F red); four metric rows with value, mini-rating, and weight %; a "Säkerhet N%" badge for in-band fields; and a destructive "Osäker — kontrollera själv" badge for low-confidence / sanity-downgraded fields. (D-07 / D-10 / BRF-02)
result: [pending]

### 5. Source quote disclosure
expected: Each extracted metric has an expandable "Visa källa (sid N)" reveal showing the verbatim PDF quote + page number. Null fields show no reveal. (D-11 / BRF-02)
result: [pending]

### 6. Inline field correction (no Claude re-call)
expected: "Ändra" → enter a new value → "Spara" triggers correctBrfField (NOT analyzeBrf). Grade + breakdown re-render; the edited field shows a "Manuellt angiven" badge; brf_cost_sek does NOT increase. An empty value is rejected (not silently saved as 0). (D-12 / BRF-02 / WR-01)
result: [pending]

### 7. Public methodology page without login
expected: Visiting /sa-raknar-vi logged OUT loads (no /login redirect) and shows all four metrics with threshold bands + weights matching the live scorer, plus the A–F and "Osäker" explanations. (D-09 / BRF-02)
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps
