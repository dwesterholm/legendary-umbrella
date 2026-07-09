---
phase: 05-owned-booli-acquisition
plan: 05
status: complete
completed: 2026-07-06
tasks_completed: 3
tasks_total: 3
---

# Plan 05-05 Summary — Unification + Call-Site Swap

## Outcome: complete ✓ (live e2e approved by operator)

The unified owned client now serves single listings, area search, AND sold comps behind one transport + fallback tree. `analyzeUrl` sources single listings through owned `fetchListing` by default; the paid actor is demoted to the rung-3 last resort.

## Tasks

| Task | Result | Commit |
|------|--------|--------|
| 1: Absorb fetchSoldComps → unified client; sold-source.ts becomes re-export shim | PRICE-01 no-op migration — `enrich-market-context.ts` + `sold-source.test.ts` byte-identical, 23/23 sold tests green | `a40e4d7` |
| 2: Swap analyzeUrl call site scrapeBooli → fetchListing (ACQ-01 default, per GO) | Owned client is now the default single-listing path | `8e2e9a5` |
| 3: [BLOCKING] Live end-to-end verification | **APPROVED** by operator — see below | (checkpoint) |

## Live verification (operator, 2026-07-06)

Operator ran the app against a real active Booli listing and confirmed:
- Analysis renders the same fields as v1.0 (address, price, living area, rooms, pris/kvm) — **no regression**.
- Sold-price comparison panel (PRICE-01) still populates.
- **Observed log line:** `[booli-client] fetchListing served by rung 1 (own-playwright, health=ok)` — confirming the owned Playwright transport serves the happy path (rung 1), source/rung/health surfaced per ACQ-03, and the paid actor is only a fallback.

## Automated gates (all green)

- `npx vitest run src/lib/market/sold-source.test.ts src/lib/market/sold-schema.test.ts` — 23/23
- `npm run test` — 198 passed, 1 skipped, 6 todo, no regressions
- `npx tsc --noEmit` — zero errors
- `npm run build` — succeeded

## Net effect (Phase 5 goal)

Active listings, area search, and sold comps all flow through ONE `src/lib/booli/client.ts` (`runPlaywrightRender` transport + `walkFallbackTree`). The product no longer silently depends on the paid Apify actor — it's the observable last resort. ACQ-01/02/03 satisfied.
