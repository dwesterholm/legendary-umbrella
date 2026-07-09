# Phase 2: BRF Financial Analysis - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-07
**Phase:** 02-brf-financial-analysis
**Areas discussed:** PDF acquisition strategy, Upload placement & flow, Score presentation, Trust & uncertainty, Processing experience

---

## PDF Acquisition Strategy

User raised this unprompted when first shown the gray areas: concerned about Allabrf's 99 SEK/report cost ("most people wouldn't want to pay for each listing they want to explore"), noted brokers publish årsredovisningar on listings, asked about Bolagsverket/Allabolag APIs, requested research on the best approach.

Live research during discussion (2026-06-07) established:
- Bolagsverket free API (värdefulla datamängder) serves iXBRL only — BRFs cannot file iXBRL yet → no API coverage
- BRF filing mandatory from FY2025, paper form only (scanned archive, manual ordering)
- Broker listing pages usually publish the PDF for free

| Option | Description | Selected |
|--------|-------------|----------|
| Upload + guided sources | Upload mechanism + UI guidance to free sources (broker page, Bolagsverket) | |
| Attempt broker auto-fetch now | Scrape PDF from broker page via agencyListingUrl, upload fallback | |
| Let researcher decide | Deep feasibility pass on both; planning decides on findings | ✓ |

**User's choice:** Let researcher decide
**Notes:** Hard constraint: never push users toward paid per-report sources.

---

## Upload Placement & Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Inside BRF section | Existing "BRF Analys — Kommer snart" placeholder becomes dropzone + results | ✓ |
| Dedicated step after analysis | Active prompt after listing summary loads | |
| Both + standalone | BRF section + standalone "analyze any årsredovisning" entry | |

**User's choice:** Inside BRF section (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Login-only | Guests see teaser + "Logga in för BRF-analys" | ✓ |
| Guests get it too | Included in guest's one free analysis | |
| You decide | Claude's discretion at planning | |

**User's choice:** Login-only (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| One PDF, replaceable | Replace re-runs analysis, overwrites result; multi-year stays v2 | ✓ |
| Multiple years from start | Trend analysis now; pulls ADV-02 into Phase 2 | |
| One PDF, immutable | No replace | |

**User's choice:** One PDF, replaceable (Recommended)

---

## Score Presentation

| Option | Description | Selected |
|--------|-------------|----------|
| Big letter + metric breakdown | Color-coded A–F + per-metric table with mini-ratings and grade contribution | ✓ |
| Letter + prose explanation | AI-written paragraph explaining grade | |
| Score dial + percentile | 0–100 gauge + "bättre än X%" (needs comparison dataset) | |

**User's choice:** Big letter + metric breakdown (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Rule-based thresholds | Deterministic weighted rules in code; Claude only extracts | ✓ |
| Claude judges holistically | LLM assigns grade with reasoning | |
| Hybrid: rules + AI adjustment | Rule base, Claude adjusts ±1 step with justification | |

**User's choice:** Rule-based thresholds (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, full methodology page | "Så räknar vi BRF-betyget" — every metric, threshold, weight public | ✓ |
| Per-report explanation only | Breakdown explains the grade; thresholds not standalone-documented | |
| You decide | Claude's discretion | |

**User's choice:** Yes, full methodology page (Recommended)

---

## Trust & Uncertainty

| Option | Description | Selected |
|--------|-------------|----------|
| Confidence badges + source quotes | Per-figure confidence, "Osäker — kontrollera själv" flags, quoted source + page ref | ✓ |
| Quotes only on demand | Clean default, hover/tap reveal | |
| Hide low-confidence fields | Only high-confidence shown; rest "Kunde inte läsas" | |

**User's choice:** Confidence badges + source quotes (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, editable fields | Inline correction, score re-computes, "Manuellt angiven" marker | ✓ |
| No edits in v1 | Display-only; re-upload is the only fix | |
| Edits only on low-confidence fields | High-confidence locked | |

**User's choice:** Yes, editable fields (Recommended)

---

## Processing Experience

| Option | Description | Selected |
|--------|-------------|----------|
| Step progress in BRF section | "Läser dokumentet… → Extraherar nyckeltal… → Beräknar betyg…", survives page leave | ✓ |
| Simple skeleton like Phase 1 | Pulsing placeholder until done | |
| Background + notify | Email when ready | |

**User's choice:** Step progress in BRF section (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Accept both, flag scans | Digital + scanned up to ~20 MB; scans get uncertainty heads-up | ✓ |
| Digital PDFs only in v1 | Reject scans; higher accuracy, blocks many users | |
| You decide | Claude's discretion | |

**User's choice:** Accept both, flag scans (Recommended)

---

## Claude's Discretion

- Upload component design (dropzone style, file validation UX)
- Confidence indicator visual treatment
- Source quote reveal pattern (inline vs expandable)
- Exact scoring thresholds and weights (must be documented on methodology page)
- Progress mechanism (Inngest+Realtime vs polling vs streaming) — UX is locked, mechanism is not

## Deferred Ideas

- Multi-year årsredovisning trend analysis — v2 (ADV-02)
- Standalone BRF analysis without a listing — own phase if wanted
- Bolagsverket API auto-fetch when BRF iXBRL filing arrives — v2 (ENRICH-01)
