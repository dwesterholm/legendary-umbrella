---
phase: 05-owned-booli-acquisition
plan: 02
status: complete
completed: 2026-07-06
tasks_completed: 2
tasks_total: 2
---

# Plan 05-02 Summary — Narrow-Confirmation Probe

## Outcome: GO ✓

The one open question for the whole 999.6 approach — does the Booli **detail page** carry a field-parity `Listing:` entity via the proven transport — is answered **GO**. Owned `fetchListing` ships as the DEFAULT ACQ-01 path (no partial rollout needed).

## What shipped

| Task | Result | Commit |
|------|--------|--------|
| 1: Write probe script | `scripts/booli-listing-probe.ts` — reproduces the `sold-source.ts` transport verbatim against a `/bostad/<id>` detail page; prints Apollo keys + field-parity diff | `2d06aaa` (+ fix `c3d71db`) |
| 2: Live probe + findings + fixture | Ran live (`bostad/305443` → `Listing:4463691`, SUCCEEDED, hasApollo). Findings recorded; redacted fixture committed | `8c9349d` (findings), this commit (fixture + summary) |

## Key results

- **Apollo prefix pinned: `Listing:`** (single `Listing:<booliId>` entity) — consumed by Plan 04's prefix scan.
- **GO decision:** all four required display requirements satisfied. `price` is absent (expected — realized sale price, only on sold objects); the asking price resolves from `listPrice`, which `normalizeScraperOutput` already handles via `num(price) ?? rawOf(listPrice)`. The probe script's initial literal-`price` NO-GO was a false trigger; corrected to price/listPrice OR (`c3d71db`).
- **Detail entity is RICHER than the paid actor** — structured `floor`, `amenities` (+ top-level `Amenity:{"key":"balcony"}`), `housingCoop`+breadcrumbs (BRF name), `rent` (avgift), `constructionYear`. De-risks Phase 6.
- **Phase 6 broker link confirmed:** `listingUrl` = broker's own page URL; inline `agency({...})` carries broker name. Phase 6's 999.2 dependency is satisfied.
- **Shape note for Plan 04:** the `Listing:` entity uses arg-keyed fields (`displayAttributes({...})`, `agency({...})`) + Apollo refs + nested `priceInfo`/`location`/`areas` — `fetchListing` must reshape into the actor-compatible flat shape before `normalizeScraperOutput` (which stays unchanged).

## Artifacts

- `scripts/booli-listing-probe.ts` — one-off probe (not app-wired).
- `src/lib/booli/__fixtures__/listing-detail.json` — redacted real `Listing:` entity (58 keys; PII scrubbed: address, apartment no., exact coords, broker identity). Feeds Plan 04's Apollo-extraction unit tests.
- `.planning/phases/05-owned-booli-acquisition/05-PROBE-FINDINGS.md` — full findings, parity table, GO rationale, Phase 6 notes.

## Decisions

- Corrected the escalation logic to price/listPrice OR (matches the requirement wording + `normalizeScraperOutput` contract) rather than modifying `listing.ts`.
- Fixture captured by the orchestrator re-running the (fixed) probe against the same confirmed-active listing (~$0.005) rather than a second operator round-trip.
