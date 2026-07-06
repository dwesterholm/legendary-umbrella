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
