# Phase 14: Holistic Analysis Brain - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-25
**Phase:** 14-holistic-analysis-brain
**Areas discussed:** BRF depth & coverage, No-empty fallback brief, Confounder handling, Scope boundary & spend

---

## BRF depth & coverage (ANL-03)

### Which candidates get the BRF fetch?
| Option | Description | Selected |
|--------|-------------|----------|
| Top-N by prelim rank | Only strongest by merged `enrichmentPriority` rank (~3–5); comps run for all enriched | ✓ |
| All ≤8 enriched | Every enriched candidate; fullest but 8× Allabrf latency/failure/spend | |
| Only after comps flag it | Comps first, BRF only for below-market; tightest spend, adds sequential latency | |

### Missing metrics (tomträtt / soliditet)
| Option | Description | Selected |
|--------|-------------|----------|
| Existing + tomträtt from listing | debt/m², avgift, cash-flow, stambyte + tomträtt from `tenureForm`; defer soliditet | ✓ |
| Add soliditet extraction now | Extend brf.ts schema + prompt for soliditet; more surface + verification burden | |

**User's choice:** Top-N by prelim rank; existing metrics + tomträtt from listing (soliditet deferred).
**Notes:** BRF fetch is network-expensive per candidate (Allabrf org-nr resolve → fetch → iXBRL→text → LLM extract). A.1 prelim rank is available before comps, so no circular dependency. debt/m² carries most of the balance-sheet signal soliditet would add.

---

## No-empty fallback brief (ANL-01)

### Fallback content
| Option | Description | Selected |
|--------|-------------|----------|
| Comps + hedonic + BRF | Full holistic value case minus image read | ✓ |
| Comps + hedonic only | Leave BRF out to decouple from BRF top-N | |
| Minimal value-positioning line | One line vs area comps; risks meeting ANL-01 in letter not spirit | |

### Framing
| Option | Description | Selected |
|--------|-------------|----------|
| Explicit marker + lower confidence | "Baserat på områdesdata — ingen bildtolkning" + downgraded confidence | ✓ |
| Same presentation, just non-empty | No marker; undercuts trust + the låg-kr/m² guard | |

**User's choice:** Comps + hedonic + BRF; explicit data-only marker + lower confidence.
**Notes:** BRF appears in the fallback only when that candidate is in the BRF top-N. Marker is the mirror image of the existing "från bildtolkning" image-derived marker.

---

## Confounder handling (ANL-04)

### Posture for missing confounders (elevator, micro-location/noise)
| Option | Description | Selected |
|--------|-------------|----------|
| Best-effort + downgrade, no new fetch | Use already-fetched signals; unknown → no attribution + downgrade confidence | ✓ |
| Add elevator backfill, best-effort rest | Elevator from detail HTML (cheap); micro-location best-effort | |
| Fetch both now | Needs a noise/traffic source that doesn't exist; likely its own phase | |

### Guard scope (14 vs 16)
| Option | Description | Selected |
|--------|-------------|----------|
| Guard in 14, number in 16 | §2.6 discount-attribution + UI guard in 14; numeric valueGap ranking in 16 | ✓ |
| Defer whole guard to 16 | Leaner 14, but leaves ANL-04 (a Phase 14 req) formally unmet until 16 | |

**User's choice:** Best-effort + downgrade, no new fetch; discount-attribution guard + UI protection in 14, numeric valueGap ranking stays in 16.
**Notes:** No new scraping protects Phase 13's in-window completion fix. Micro-location/noise has no clean data source (fetching = scope creep).

---

## Scope boundary & spend

### UI boundary (14 vs 15)
| Option | Description | Selected |
|--------|-------------|----------|
| Markers + guard only; rich brief in 15 | 14 = data-only marker + confounder framing + non-empty; comps/BRF persisted in JSONB for 15 | ✓ |
| Surface comps/BRF context now too | Render positioning + BRF summary now; overlaps + reworks Phase 15 | |

### Cost cap for new fetches
| Option | Description | Selected |
|--------|-------------|----------|
| Fold into vision cap, hold at 10 | Count comps + BRF vs runningVisionSek/CAP_VISION_SEK_MAX=10; comps amortized per-area | ✓ |
| Fold in but raise the cap | Higher ceiling (15–20 SEK); more spend | |
| Separate budget for comps/BRF | Distinct cap; more knobs + race-safety surface | |

**User's choice:** Markers + guard only (rich brief in 15); fold spend into vision cap held at 10.
**Notes:** Comps are fetched once per AREA and reused across that area's candidates (amortized) — cost model must not double-count comps; only BRF is per-candidate. Exhausted budget → skip further comps/BRF, degrade gracefully.

---

## Claude's Discretion

- Exact N for BRF top-N (~3–5).
- Mechanism for threading/re-resolving `areaId` into `runVisionForJob` (currently receives none).
- Comps cache/TTL reuse strategy within a run.
- Precise shape of the additive-nullable holistic fields persisted on the candidate.

## Deferred Ideas

- `soliditet` (BRF equity ratio) extraction — deferred (no field, poor iXBRL extractability; debt/m² covers most signal).
- Elevator (`hiss`) + micro-location/noise fetching — deferred (no data source for noise; no new scraping in 14).
- Rich holistic UI (R_med/U_med cards, avgift/debt cards, tiered cost/profit) — Phase 15 (OpportunityBrief).
- Numeric `valueGap()` wired into ranking + marker — Phase 16 (B).
