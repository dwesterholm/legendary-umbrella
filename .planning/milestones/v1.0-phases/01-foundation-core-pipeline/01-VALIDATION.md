---
phase: 01
slug: foundation-core-pipeline
status: validated
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
classification: partial (manual-by-construction)
retroactive: true
retroactive_note: "Reconstructed retroactively (State B) during the v1.0 milestone audit — Phase 1 shipped without a VALIDATION.md. Operator decision 2026-07-06: mark Phase 1 verifications manual-only rather than generate deterministic tests now. Mirrors Phase 3's accepted manual-by-construction posture."
---

# Phase 1 — Validation Strategy

> Per-phase validation contract. Retroactive: reconstructed from artifacts during the v1.0 audit.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.* (present) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~1 second (175 tests) |

*Note: the suite covers Phases 2–4. Phase 1's own code (listing normalization, analyze action, Booli scraper, UI) has no dedicated unit tests — see Manual-Only and Deferred below.*

---

## Per-Task Verification Map

| Behavior | Requirement | Test Type | Automated | Status |
|----------|-------------|-----------|-----------|--------|
| Paste URL → trigger analysis (url-input) | LSTG-01 | manual (UI interaction) | ❌ | manual-only |
| Booli scrape → extract listing fields (scrapeBooli/Apify) | LSTG-01 | manual (live external network) | ❌ | manual-only |
| Listing normalization + `listingDataSchema` partial-tolerance + `missingFields` detection | LSTG-01/02 | unit (deterministic) | ❌ | **deferred** (coverable; see below) |
| Structured listing summary render (listing-summary) | LSTG-02 | manual (visual) | ❌ | manual-only |
| Dashboard list of own analyses (auth + safeParse guard) | LSTG-02 | manual (auth/visual) | ❌ | manual-only |
| Scrape failure / partial → error or partial result, not crash | LSTG-01/02 | manual (live + UI) | ❌ | manual-only |

**Classification: PARTIAL.** No automated coverage for Phase 1's own code.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Paste Booli URL → analysis | LSTG-01 | UI interaction + live Apify scrape; non-deterministic external dependency | Paste a real Booli URL in the dashboard input, submit, confirm redirect to the analysis page with extracted fields |
| Structured listing summary | LSTG-02 | Visual rendering | Open an analysis; confirm address/price/pris-per-kvm/rooms/size/BRF name render clearly |
| Dashboard previous analyses | LSTG-02 | Auth + session + visual | Log in; confirm own analyses list newest-first; other users' analyses not visible (RLS) |
| Scrape failure / partial data | LSTG-01/02 | Requires triggering a real Booli failure/partial | Submit an invalid/partial listing URL; confirm a Swedish error or partial result — never a crash (verified in code: analyze.ts:47-49 try/catch + partial path; dashboard safeParse guard) |

---

## Deferred (coverable, not done this pass)

The one genuinely automatable gap — **unit tests for the deterministic listing pipeline**
(scraper-output → `listingDataSchema` normalization, partial-tolerance, and `missingFields`
computation in `analyze.ts` / `listing.ts`) — was left uncovered by operator decision on
2026-07-06 (chose "mark all manual-only"). This is tracked v1.0 tech debt: a focused
`src/lib/schemas/listing.test.ts` (+ a normalization test) would move Phase 1 from PARTIAL
toward COMPLIANT without touching the manual-only UI/scrape paths. Re-run
`/gsd-validate-phase 1` and choose "Fix the gap" to close it.

---

## Validation Sign-Off

- [x] Input state detected (State B — reconstructed from artifacts)
- [x] Requirement→behavior map built (LSTG-01/02)
- [x] Manual-only behaviors documented with instructions
- [x] Deferred deterministic gap recorded as tracked tech debt
- [ ] `nyquist_compliant: true` — NOT set; Phase 1 is PARTIAL (manual-by-construction + one deferred deterministic test)

**Approval:** validated (partial) 2026-07-06 — operator accepted manual-only posture.
