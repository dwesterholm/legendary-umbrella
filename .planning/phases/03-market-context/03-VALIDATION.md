---
phase: 3
slug: market-context
status: validated
nyquist_compliant: false
wave_0_complete: true
created: 2026-06-17
validated: 2026-06-23
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Reconstructed from artifacts and audited 2026-06-23 (the original file was an
> unfilled template). Deterministic cores are fully automated; orchestration,
> UI, live sources, and the DB migration are MANUAL-ONLY by construction.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.8 (devDependency) |
| **Config file** | `vitest.config.ts` (`environment: node`, `globals: true`, `@` → `./src`) |
| **Quick run command** | `npx vitest run src/lib/market/<file>.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~0.5 s (node env, no DOM, no network) |

---

## Sampling Rate

- **After every task commit:** Run the touched module's test file (`npx vitest run src/lib/market/<file>.test.ts`)
- **After every plan wave:** Run `npx vitest run` (full suite) + `npx tsc --noEmit`
- **Before `/gsd-verify-work`:** Full suite green + `npm run build` succeeds
- **Max feedback latency:** ~1 s (full suite)

---

## Per-Task Verification Map

| Plan | Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|------|-------------|----------|-----------|-------------------|-------------|--------|
| 03-01 | PRICE-01/AREA-01 | RED contracts + listing-schema join key (coords/booliId/breadcrumbs) | unit | `npx vitest run src/lib/market` | ✅ | ✅ green |
| 03-02 | PRICE-01/AREA-01 | migration 003: 5 additive columns under inherited RLS | manual | `supabase migration list` (Local==Remote 001/002/003) | n/a | ⚠️ manual |
| 03-03 | AREA-01 | `resolveGeo` point-in-polygon (kommun baseline, inside-polygon, outside→null) | unit | `npx vitest run src/lib/market/geo.test.ts` | ✅ | ✅ green |
| 03-03 | AREA-01 | `normalizeScbOutput` json-stat2 → 4 metrics; absent→null; tenure (WR-04) | unit | `npx vitest run src/lib/market/scb.test.ts` | ✅ | ✅ green |
| 03-03 | AREA-01 | `safeParseAreaData` persisted read-guard (valid/sparse round-trip, malformed→null) | unit | `npx vitest run src/lib/market/scb-schema.test.ts` | ✅ | ✅ green |
| 03-04 | PRICE-01 | `computePriceComparison` (±%, tier, confidence, trend, thin, HIGH-3, window WR-01, classifyTrend WR-06) | unit | `npx vitest run src/lib/market/compare.test.ts` | ✅ | ✅ green |
| 03-04 | PRICE-01 | cost guard (cap, render scaling) | unit | `npx vitest run src/lib/market/cost.test.ts` | ✅ | ✅ green |
| 03-04 | PRICE-01 | `normalizeSoldOutput` (live array shape, WR-05 variant pick) | unit | `npx vitest run src/lib/market/sold-schema.test.ts` | ✅ | ✅ green |
| 03-04 | PRICE-01 | `resolveAreaId` tier→areaId ladder (distinct tiers, HIGH-1 null) | unit | `npx vitest run src/lib/market/sold-source.test.ts` | ✅ | ✅ green |
| 03-04 | PRICE-01 | `safeParsePriceData` persisted read-guard (ok + non-ok round-trip, malformed→null) | unit | `npx vitest run src/lib/market/sold-schema.test.ts` | ✅ | ✅ green |
| 03-05 | PRICE-01/AREA-01 | `enrichMarketContext` orchestration: auth/ownership, tiered walk (≤3), cost gate, independent persist (D-08), terminal status | manual | live Supabase + Apify + SCB | n/a | ⚠️ manual |
| 03-06 | PRICE-01 | `PriceComparisonCard` reason-branch render (ok/thin/source_unavailable/listing_pris_okand) | manual | Plan 06 live-gate (APPROVED) | n/a | ⚠️ manual |
| 03-06 | AREA-01 | `AreaStatsCard` four-metric render + "Källa: SCB" | manual | Plan 06 live-gate (APPROVED) | n/a | ⚠️ manual |
| 03-06 | PRICE-01/AREA-01 | live Booli SSR + live SCB PxWebApi end-to-end | manual | Plan 06 live-gate (APPROVED) | n/a | ⚠️ manual |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ manual*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — vitest was installed in Phase 2.
Phase 3 added no new framework; Plan 01 wrote the RED contracts (`compare/geo/scb/cost`)
that downstream plans turned GREEN.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `enrichMarketContext` orchestration (auth/ownership gate, ≤3-call tiered walk, recency+count short-circuit, cost gate, independent per-panel persistence D-08, source_unavailable vs thin discrimination, terminal `market_status`) | PRICE-01, AREA-01 | Server action requiring live Supabase auth/RLS + Apify + SCB; internal helpers (`walkSoldTiers`, `recentUsableCount`) are not exported. Matches the Phase 2 `analyze-brf.test.ts` precedent (all server-action behaviors `it.todo`). | Run an enrich on a real owned analysis row; confirm `price_data`/`area_data` persist independently, `market_status` ends `done`/`failed` (never null), and a dead source records `reason:"source_unavailable"` (not `thin`). |
| UI panel rendering — `PriceComparisonCard` four reason branches, `AreaStatsCard` four metrics + "Källa: SCB", independent per-panel degrade (D-08) | PRICE-01, AREA-01 | No DOM test infra (`jsdom`/`@testing-library` absent; vitest `environment: node`). React server/client components. | Plan 06 Task 3 live-gate — APPROVED: 35 live sold comps (reason "ok"), ±% headline, comp-list receipt, sample/tier/distribution/confidence; Södermalm DeSO `0180C3130` four live SCB metrics; one null source never blanks the other. |
| Migration 003 — 5 additive columns (`price_data`, `area_data`, `market_status`, `market_source`, `market_cost_sek`) under inherited per-user RLS | PRICE-01, AREA-01 | Live-DB DDL; verified via Supabase CLI, not a unit test. | `supabase migration list` shows 001/002/003 Local == Remote; no duplicate-RLS error on push. |
| Live Booli SSR + live SCB PxWebApi end-to-end fetch | PRICE-01, AREA-01 | External networks behind Cloudflare; non-deterministic. Unit tests cover the normalize/compare layer on captured fixtures only. | Plan 06 live-gate — APPROVED (real `slutpriser?areaIds=115341` → 35 comps `hasApollo:true`; live SCB DeSO metrics). |

---

## Validation Sign-Off

- [x] All deterministic-core behaviors have `<automated>` verify (compare/cost/sold-schema/sold-source/geo/scb/scb-schema)
- [x] Persisted read-guards (`safeParsePriceData`/`safeParseAreaData`) now automated (gap filled 2026-06-23)
- [x] Sampling continuity: no 3 consecutive deterministic behaviors without automated verify
- [x] Wave 0 covered all RED contracts (now GREEN)
- [x] No watch-mode flags in committed commands
- [x] Feedback latency < 2 s
- [ ] `nyquist_compliant: true` — NOT set: orchestration/UI/live/migration are MANUAL-ONLY by construction (no DOM infra; live external sources). Phase is **validated PARTIAL**.

**Approval:** validated PARTIAL 2026-06-23

---

## Validation Audit 2026-06-23

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved (automated) | 2 |
| Escalated to manual-only | 0 |

**Resolved:** `safeParsePriceData` (PRICE-01) and `safeParseAreaData` (AREA-01) persisted-jsonb
read-guards — 20 new vitest cases (11 PRICE-01 in `sold-schema.test.ts`, 9 AREA-01 in the new
`scb-schema.test.ts`) covering valid round-trip (incl. non-`ok`/all-null-metrics honest states),
null/primitive → null, and malformed → null-never-throws. Full suite: 95 passed | 6 todo (12 files);
the 6 todo are Phase 2's `analyze-brf.test.ts`. `tsc --noEmit` + eslint clean.

**Not resolved (MANUAL-ONLY by construction):** the `enrichMarketContext` orchestration (live
Supabase/Apify/SCB; helpers not exported), the three UI panels (no `jsdom`/`@testing-library`),
the live Booli/SCB fetch, and migration 003 — all verified via the Plan 06 human live-gate
(APPROVED) and `supabase migration list`. Phase 3 is therefore **NYQUIST-COMPLIANT for its
deterministic cores** and **PARTIAL overall**.
