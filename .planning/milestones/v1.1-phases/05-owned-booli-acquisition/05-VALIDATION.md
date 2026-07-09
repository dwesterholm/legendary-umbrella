---
phase: 5
slug: owned-booli-acquisition
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 05-RESEARCH.md § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (`environment: node`, `globals: true`) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/lib/booli/` |
| **Full suite command** | `npm run test` (`vitest run`) |
| **Estimated runtime** | ~10–20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/booli/` (or the specific new test file touched)
- **After every plan wave:** Run `npm run test` (full suite — the untouched `sold-schema.test.ts`/`sold-source.test.ts` regression coverage must stay green)
- **Before `/gsd-verify-work`:** Full suite green PLUS the narrow-confirmation manual probe run once and its pass/fail on required-display-fields recorded before ACQ-01 is marked complete
- **Max feedback latency:** ~20 seconds

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| ACQ-01 | `fetchListing(url)` builds the correct detail-page URL; raw payload validates against `scraperOutputSchema` | unit (mocked `ApifyClient`) | `npx vitest run src/lib/booli/client.test.ts -t "fetchListing"` | ❌ W0 | ⬜ pending |
| ACQ-01 | `Listing:<booliId>` Apollo-entity extraction picks by prefix, tolerates `displayAttributes` variants | unit | `npx vitest run src/lib/booli/client.test.ts -t "Apollo"` | ❌ W0 | ⬜ pending |
| ACQ-02 | `fetchAreaListings(areaId)` builds `/sok/till-salu?areaIds=<N>` and extracts multiple `Listing:` entries | unit (mocked) | `npx vitest run src/lib/booli/client.test.ts -t "fetchAreaListings"` | ❌ W0 | ⬜ pending |
| ACQ-03 | `walkFallbackTree` tries rung 1 → rung 2 on throw → rung 3 on second throw; returns correct `{source, rung, health}` | unit (pure, injected fake rungs) | `npx vitest run src/lib/booli/fallback-tree.test.ts` | ❌ W0 | ⬜ pending |
| ACQ-03 | `walkFallbackTree` throws (never returns silently) when ALL rungs fail (HIGH-1 discipline) | unit | `npx vitest run src/lib/booli/fallback-tree.test.ts -t "all rungs fail"` | ❌ W0 | ⬜ pending |
| ACQ-01/02/03 | `normalizeScraperOutput`/`scraperOutputSchema` unchanged; pass against a real detail-page-shaped fixture (no-op-migration regression guard) | unit (fixture) | `npx vitest run src/lib/schemas/listing.test.ts` | ❌ W0 | ⬜ pending |
| PRICE-01 (regression) | `fetchSoldComps` still works after relocating into `client.ts` | unit (existing) | `npx vitest run src/lib/market/sold-schema.test.ts src/lib/market/sold-source.test.ts` | ✅ existing | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/booli/__mocks__/apify-client.ts` (or in-test `vi.mock` factory) — shared `ApifyClient` mock: `{ actor: () => ({ call: vi.fn() }), dataset: () => ({ listItems: vi.fn() }) }`. **No existing test mocks the actor-call chain** — this phase is the first to need it; build one shared shape, don't let each test invent its own.
- [ ] `src/lib/schemas/listing.test.ts` — regression guard for `normalizeScraperOutput`/`scraperOutputSchema` (currently zero direct tests); cheapest proof of the "no-op migration" claim.
- [ ] `src/lib/booli/__fixtures__/listing-detail.json` — ONE real, PII-redacted `Listing:<booliId>` Apollo entity captured from the narrow-confirmation probe (mirrors the `sold-comps.json` redacted-real-payload pattern).
- [ ] Framework install: none — Vitest already configured.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Detail-page Apollo `Listing:` entity carries the required-display-field set (field parity vs paid actor) | ACQ-01 (Narrow Confirmation) | Inherently a live-transport confirmation — cannot be mocked without defeating its purpose; needs a real `APIFY_API_TOKEN` + a real Booli listing URL | One-off `tsx`/`node` probe invoking `runPlaywrightRender` against one real detail URL; inspect output for the four `requiredDisplayFields` + `agencyListingUrl`/`infoPoints`/breadcrumbs; capture the redacted fixture while doing so. Escalate only if a required field is missing. |
| Real Cloudflare clearance on the detail + area-search pages via the owned client | ACQ-01/02 | Live transport | Confirmed alongside the field-parity probe (200 + `hasApollo === true`). |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (ApifyClient mock, listing.test.ts, fixture)
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter (after Wave 0 lands)

**Approval:** pending
