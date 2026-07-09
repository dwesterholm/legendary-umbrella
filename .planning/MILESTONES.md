# Milestones

## v1.0 MVP (Shipped: 2026-07-06)

**Scope:** 4 phases · 21 plans · 36 tasks · ~11.5k LOC (TS/TSX) · timeline 2026-02-24 → 2026-07-06

**Delivered:** An AI-powered property analysis tool for the Swedish market — paste a Booli listing URL and get a structured summary, a BRF financial health score from the årsredovisning, market context (comparable sold prices + area demographics), and a synthesized AI report with risk flags and PDF export.

**Key accomplishments:**

- **Phase 1 — Foundation & core pipeline:** Next.js 16 + Supabase (email/password auth, RLS) app shell; Apify-based Booli scraper → Zod-validated listing extraction → structured listing summary + analysis-history dashboard (LSTG-01/02).
- **Phase 2 — BRF financial analysis:** login-gated årsredovisning PDF upload → Haiku extraction → deterministic A–F health score with transparent per-metric methodology, source quotes/page refs, and inline corrections; public `/sa-raknar-vi` methodology page (BRF-01/02/03).
- **Phase 3 — Market context:** overcame the Booli slutpriser Cloudflare blocker via an Apify Playwright headless browser; pure-arithmetic price-comparison engine (±% vs area, trend, confidence) + live SCB DeSO demographics, with honest dead/thin/missing-source states (PRICE-01, AREA-01).
- **Phase 4 — AI report & delivery:** Sonnet cross-source synthesis ("vad du bör tänka på") with deterministic red/green risk flags, no buy/sell verdict, every claim cited; `@react-pdf/renderer` PDF export with correct å/ä/ö glyphs, login-gated + ownership-checked (RPRT-01/02/03).

**Quality gates:** all 10 v1.0 requirements satisfied; 4/4 phases formally verified; cross-phase integration GREEN (0 hard breaks, 5/5 E2E flows); 175 unit tests passing; Phase 4 UAT 5/5 (three blockers found and fixed during UAT — BRF strict-grammar schema, report-lock PostgREST NULL trap, read-path flag schema).

**Known deferred / tech debt (tracked, non-blocking):**

- Phase 1 Nyquist: deterministic listing-pipeline unit tests deferred (manual-only classification).
- Phase 3 Nyquist: partial by construction (orchestration/UI/live-source/migration are manual).
- Phase 4: live brf-extract/v2 extraction eval deferred (needs labeled dataset); `report_status` NOT NULL backfill + live/integration test recommended; security closed via operator acceptance (run `/gsd-secure-phase 4` "Verify all" before production).
- Misc: dead D-14 scanned-PDF banner; in-session BRF completion needs a reload; Supabase auth email templates still boilerplate.

**Backlog carried forward:** 8 items (999.1–999.8) — promote via `/gsd-review-backlog`.

---

## v1.1 — Owned Data Layer & Intelligent Discovery

**Shipped (code-complete):** 2026-07-07 · **Phases:** 8 (5–12) · **Plans:** 27 · **Tests:** 629 passing · **Migrations:** 006–011 (live)

**Delivered:** Owned the Booli acquisition layer (single + area, observable fallback tree) and built an intelligent-discovery surface on top — deeper broker-page field recovery, descriptive Riksbank/SCB macro context, BRF årsredovisning auto-fetch, a cost-capped background discovery job (free-text → area search), configurable niche ranking, and hedged image-cited gallery/floor-plan vision + theoretical sun-path. The discovery surface (Phases 9–12) ships behind `DISCOVERY_ENABLED` (OFF) pending an operator legal go/no-go and live validation gates.

**Key accomplishments:**

- **Phase 5 — Owned Booli Acquisition:** owned client generalizing the proven Playwright/`__APOLLO_STATE__` transport for single + area listings with an observable fallback tree (own-render → SE-residential proxy → paid actor); no silent dependency on the paid actor (ACQ-01/02/03).
- **Phase 6 — Deeper Listing Extraction:** recovered floor/balcony/BRF-name from the Apollo entity + renovation-status/description via an SSRF-hardened broker-page fetch (DNS-pinned, PII-excluded), gap-fill-only with provenance, never failing the primary analysis (LSTG-03/04).
- **Phase 7 — Macro Price Context:** strictly-descriptive Riksbank policy rate + SCB CPIF + regional price-index in their own labeled section, first shared RLS-protected cache table, banned-predictive-phrase guard (MACRO-01/02).
- **Phase 8 — BRF Auto-Fetch:** shared `runBrfExtraction` core feeding both manual upload and Allabrf auto-fetch (org.nr + geo confidence gate, manual fallback preserved), iXBRL→text, fiscal-year staleness (ENRICH-01/02).
- **Phase 9 — Discovery Foundation:** DB-row job queue + atomic `claim_discovery_slice` RPC (FOR UPDATE SKIP LOCKED, owner-scoped), client-tick slice advancement, hard incremental cost/candidate caps, PII-safe candidates, feature-flag legal gate + kill switch (DISC-01/02/07).
- **Phase 10 — Niche Ranking:** deterministic cited-signal niche scorer (renovation-upside / turnkey / imminent-stambyte proxy), client-side reorder, never an opaque score (DISC-03).
- **Phase 11 — Gallery Condition Vision:** two-pass Haiku→Sonnet vision with a separate incremental cost cap, image-cited hedged claims structurally separate from deterministic flags, RUN_LLM_EVALS-gated eval harness (DISC-04).
- **Phase 12 — Floor-Plan & Sun-Path:** floor-plan remodel-potential as a hedged investigation-prompt with code-enforced "kräver konstruktör" disclaimer + banned-verdict-word rejection, plus deterministic `suncalc` theoretical sun exposure that degrades to "ej tillgänglig" rather than guessing orientation (DISC-05/06).

**Quality gates:** 16/16 requirements satisfied in code + wired (integration audit 9/9 seams, 0 broken flows, both E2E flows intact); every phase code-verified; each phase code-reviewed with all Critical + Warning findings fixed (notably: Phase 6 DNS-rebinding SSRF, Phase 7 shared-cache poisoning, Phase 9 RPC ownership bypass + unauth cron, Phase 11 cost-overshoot + stranded-job + double-spend race, Phase 12 load-bearing-verdict leak).

**Known deferred (tracked, non-blocking — see v1.1-MILESTONE-AUDIT.md + phase *-UAT.md):**

- **Phase 9 legal go/no-go** on proactive area-wide scraping (provisional GO; discovery flag OFF until final sign-off; a no-go retroactively cancels 9–12).
- Kill-criterion validation gates (Phases 10/11/12) + live e2e smokes (6–9) + Phase 11 Booli `images(` probe/image-host confirmation + operator env (`CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) + ~24h orphan-recovery latency acceptance.

**Backlog carried forward:** 999.1/999.4/999.5/999.8 (999.2/999.3/999.6/999.7 were promoted into v1.1).
