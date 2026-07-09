# Phase 3: Market Context - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-17
**Phase:** 3-market-context
**Areas discussed:** "Comparable" definition, Price comparison display, Demographics scope & level, Data-availability & trust

---

## "Comparable" definition

### Comp scope
| Option | Description | Selected |
|--------|-------------|----------|
| Tiered fallback | Same building/BRF → neighborhood → wider area, showing which tier | ✓ |
| Neighborhood only | Always compare against surrounding area | |
| Same building/BRF only | Only exact building/BRF sales | |

**User's choice:** Tiered fallback

### Recency
| Option | Description | Selected |
|--------|-------------|----------|
| Last 12 months | Recent, usually enough sample in cities | |
| Last 6 months | Most current but thin sample | |
| Last 24 months + trend | Wider sample + price trend over time | ✓ |

**User's choice:** Last 24 months + trend

### Match attrs
| Option | Description | Selected |
|--------|-------------|----------|
| Compare on pris/kvm | Normalize to price per m² | |
| Filter by similar size/rooms | Size/room band, then compare | |
| You decide | Best matching approach within pris/kvm-first principle | ✓ |

**User's choice:** You decide
**Notes:** User added — "important things to consider are floor level, balcony or not, avgift, etc." Captured as research directive D-09-RD: richer matching layers on top of pris/kvm baseline, contingent on whether the sold-data source exposes those attributes.

---

## Price comparison display

### Headline
| Option | Description | Selected |
|--------|-------------|----------|
| ±% vs area pris/kvm | Directional verdict + numbers behind it | ✓ |
| Over/under-priced verdict | Worded judgment — edges toward valuation | |
| Just the numbers | Listing pris/kvm vs area average, no delta | |

**User's choice:** ±% vs area pris/kvm

### Detail (multi-select)
| Option | Description | Selected |
|--------|-------------|----------|
| Trend over 24 months | Area price trend (sparkline/arrow + %) | ✓ |
| List of comparable sales | The actual comps as verifiable receipt | ✓ |
| Sample size + tier used | "Baserat på N försäljningar" + fallback tier | ✓ |
| Distribution / range | Min–max spread of area pris/kvm | ✓ |

**User's choice:** All four

---

## Demographics scope & level

### Geo level
| Option | Description | Selected |
|--------|-------------|----------|
| Kommun, with finer if feasible | Kommun baseline, upgrade to DeSO/RegSO if geocoding reliable | ✓ |
| Neighborhood (DeSO/RegSO) | Most relevant but needs reliable small-area geocoding | |
| Kommun only | Simplest, always available, but coarse | |

**User's choice:** Kommun, with finer if feasible

### Metrics (multi-select)
| Option | Description | Selected |
|--------|-------------|----------|
| Income level | Median/average household income (AREA-01) | ✓ |
| Population trend | Growth/decline over recent years (AREA-01) | ✓ |
| Age distribution | Age mix (families/students/retirees) | ✓ |
| Housing/ownership mix | Owned vs rented / apartment vs house | ✓ |

**User's choice:** All four

---

## Data-availability & trust

### Thin data
| Option | Description | Selected |
|--------|-------------|----------|
| Partial + honest markers | Show what we got, mark gaps, never fabricate | ✓ |
| Hide the section | Don't show unreliable sections at all | |
| Show with prompt to help | Partial + prompt user to fill gap | |

**User's choice:** Partial + honest markers

### Trust (multi-select)
| Option | Description | Selected |
|--------|-------------|----------|
| Cite source + freshness | "Källa: Booli/SCB" + how current | ✓ |
| Show the underlying comps | Comp list as verifiable receipt | ✓ |
| Disclaimer (ej värdering) | "statistisk jämförelse, inte en värdering" | ✓ |
| Confidence on the comparison | Sample-size + tier-driven confidence signal | ✓ |

**User's choice:** All four

---

## Claude's Discretion

- Exact matching algorithm within the pris/kvm-first principle (how floor/balcony/avgift weight in, once data availability is known).
- Visual treatment of trend, comp list, distribution, and confidence signal (reuse Phase 2 visual language).
- Presentation of the kommun→neighborhood upgrade when both available.
- Caching/staleness strategy for SCB and sold-price data.

## Deferred Ideas

- BRÅ crime + Skolverket school stats — v2 (ENRICH-02/03).
- Avgiftshöjning / rate stress prediction — v2 (ADV-01/02); overlaps backlog 999.4.
- Cross-source synthesis + red/green flags — Phase 4 (RPRT-01/02).
- Custom valuation / price prediction — explicitly Out of Scope.
