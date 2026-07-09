# Phase 4: AI Report + Delivery - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-23
**Phase:** 4-ai-report-delivery
**Areas discussed:** Flagglogik (RPRT-02), Rapportens röst (RPRT-01), PDF + delning (RPRT-03), Trigger + partiell data

---

## Flagglogik (RPRT-02)

### Q1 — How should the red/green flags be decided?

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic in code | Rule-based threshold checks in code; Claude only narrates | |
| Hybrid: code + AI signals | Numeric flags in code; soft textual signals surfaced by Claude | ✓ |
| AI decides all flags | Claude decides all flags; breaks D-08, not reproducible | |

**User's choice:** Hybrid: code + AI signals

### Q2 — Where do the soft signals come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Re-read BRF PDF + listing text | Second free-text pass at synthesis time | |
| Extend Phase 2 extraction | Capture soft signals as structured cited fields in the existing extraction | ✓ |
| Only structured data for now | No text mining; defer stambyte/renovation flags | |

**User's choice:** Extend Phase 2 extraction
**Notes:** Keeps everything in the existing extraction + citation + confidence pipeline; touches Phase 2 schema/prompt (migration + prompt-version bump + eval update).

### Q3 — Who raises a flag vs narrates it (now that soft signals are structured)?

| Option | Description | Selected |
|--------|-------------|----------|
| Code raises, AI narrates | Code maps all structured fields → flags; Claude only references/prioritizes | |
| Code numeric, AI raises soft | Code raises numeric flags; Claude decides if a soft signal rises to a flag | |
| You decide | Let planning choose based on field cleanliness | ✓ |

**User's choice:** You decide (Claude's discretion)
**Notes:** Numeric flags stay deterministic regardless; the code-vs-AI split for soft flags is deferred to research/planning.

---

## Rapportens röst (RPRT-01)

### Q1 — How opinionated should the summary be?

| Option | Description | Selected |
|--------|-------------|----------|
| Opinionated, no verdict | Clear stance + prioritization, but no buy/don't-buy call | ✓ |
| Verdict + reasoning | Explicit overall take backed by data; closest to advice line | |
| Neutral synthesis | Organize/explain without ranking; risks generic | |

**User's choice:** Opinionated, no verdict

### Q2 — What structure should the summary take?

| Option | Description | Selected |
|--------|-------------|----------|
| Prioritized bullets | Lead sentence + ranked data-tied list | |
| Short narrative prose | 2–4 flowing paragraphs | |
| Themed sections | Grouped under Ekonomi / Pris / Område | ✓ |

**User's choice:** Themed sections

### Q3 — How do themed sections avoid echoing the cards?

| Option | Description | Selected |
|--------|-------------|----------|
| Lead synthesis + sections | Cross-source lead, then per-theme interpretation | ✓ |
| Interpretation-only sections | No lead; sections add implication only | |
| You decide | Let planning balance it | |

**User's choice:** Lead synthesis + sections

---

## PDF + delning (RPRT-03)

### Q1 — What does "download and share" deliver?

| Option | Description | Selected |
|--------|-------------|----------|
| PDF download only | File the user saves/shares; no hosting/links | ✓ |
| PDF + shareable link | Adds public read-only URL; privacy/RLS surface | |
| You decide | Defer to planning | |

**User's choice:** PDF download only

### Q2 — What does the PDF contain?

| Option | Description | Selected |
|--------|-------------|----------|
| Full analysis | All cards + flags + summary, standalone document | ✓ |
| Summary + flags only | Takeaways without underlying data | |
| Full, minus heavy detail | Collapses long lists into summaries | |

**User's choice:** Full analysis

---

## Trigger + partiell data

### Q1 — When/how should the report generate?

| Option | Description | Selected |
|--------|-------------|----------|
| Manual button, partial-aware | User clicks "Generera"; works from available data, states gaps | ✓ |
| Auto when listing ready | Auto-generate + regenerate as data arrives | |
| Manual, requires minimum data | Manual but gated on e.g. BRF upload | |

**User's choice:** Manual button, partial-aware

### Q2 — How to handle staleness when source data changes?

| Option | Description | Selected |
|--------|-------------|----------|
| Mark stale + regenerate | Keep report, show "äldre data" marker, one-click regenerate | ✓ |
| Auto-invalidate | Auto clear/regenerate on any change | |
| Snapshot, no tracking | Point-in-time; manual regenerate only | |

**User's choice:** Mark stale + regenerate

### Q3 — Who can generate the report?

| Option | Description | Selected |
|--------|-------------|----------|
| Login-only, like BRF | Account required; guests see teaser (D-05 consistency) | ✓ |
| Free, like the listing | Anyone; exposes priciest call to anonymous use | |
| You decide | Defer; default login-only | |

**User's choice:** Login-only, like BRF

---

## Final framing (free-text, on "ready for context?")

**User:** "What's important here is that everything feels like an integrated experience, not 4 different features."

Captured as **D-00 (overarching cohesion principle)** in CONTEXT.md: the summary is connective tissue (not another card), flags are the visible surface of existing card data, the PDF is the same experience made portable, and the trust posture is consistent end-to-end. Cohesion is treated as a phase requirement / acceptance dimension.

## Claude's Discretion

- Soft-flag raise mechanism (code vs AI-with-context) — pending extraction-field cleanliness (D-03).
- On-page placement of the summary (lead vs capstone) + visual integration of flags into existing cards (subject to D-00).
- PDF generation mechanism (print CSS vs render library vs serverless) — no PDF dep yet; research directive.
- Synthesis model tiering + per-report cost guard — confirm in research (Phase 2 AI-SPEC: Haiku extract / Sonnet synthesize).
- Regeneration UX details.

## Deferred Ideas

- Public shareable report link — v1 is PDF-download-only.
- Forward-looking/predictive BRF risk (rate stress, refinancing, maintenance-cycle/stambyte prediction, new-build inversion) — backlog 999.4 / ADV-01/02.
- Auto-generation / always-fresh report — rejected for cost + agency.
- Buyer due-diligence checklist orchestrating the whole flow — backlog 999.5.
