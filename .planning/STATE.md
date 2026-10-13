---
gsd_state_version: "1.0"
milestone: v1.2
milestone_name: Renovator-Grade Discovery Analysis (Phases 13–17) — IN PROGRESS
current_phase: "14.4"
current_phase_name: Valuation Gaps, Layout & Livability
status: executing
stopped_at: Completed 14.4-05-PLAN.md
last_updated: "2026-10-13T20:31:43.371Z"
last_activity: 2026-10-13
last_activity_desc: Phase 14.3 execution started
state_head: eb67768e4878bd3e7a286f3567a2354dde850eaa
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 52
  completed_plans: 47
  percent: 17
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-17)

**Core value:** Give Swedish home buyers an independent, data-driven analysis of any listing -- the one thing their maklare won't provide.
**Current focus:** Phase 14.3 — Sun & Orientation

## Current Position

Phase: 14.4 (Valuation Gaps, Layout & Livability) — READY TO EXECUTE
Plan: 8 of 8
Status: Ready to execute
Last activity: 2026-10-13 — Phase 14.3 execution started
Next step: /gsd-plan-phase 14.2 --auto — autonomous until a trustworthy weekly table exists; plan 1 = local browser rung (Daniel 2026-10-13). 14.1 is human_needed (12/13); decisions for its 4 UAT items are recorded in RESUME.md.

## Roadmap Summary (v1.2 — CURRENT)

5 phases (13–17), standard granularity, 15/15 requirements mapped. Numbering **continues** from v1.1's Phase 12 — no reset; Phases 1–12 untouched. Cores already built + merged on `main`; this milestone wires them live.

| Phase | Goal | Requirements | Depends on | UI |
|-------|------|--------------|------------|----|
| 13. Discovery UX / Poll-Timeout Fix | Live discovery finishes inside the client poll window (no forced reload) + Swedish label for every job state | DXUX-01/02 | Nothing new (independent) | yes |
| 14. Holistic Analysis Brain | Fold re-resolved comps (R_med/U_med) + per-candidate BRF into the value case; no empty `claims: []`; low kr/m² normalized vs confounders | ANL-01/02/03/04 | Merged cores on `main` | yes |
| 15. ROI-Aware Opportunity Brief | Prioritized, buyer-tailored opportunities; tiered cost/uplift; profit ±22% tax; freshness-based bathroom; designer specifics; live strict-output smoke | ROI-01/02/03/04/05 | Phase 14 (comps/BRF payload) | — |
| 16. Value-Gap Scoring & Ranking | §2.6 value-gap headline re-orders results on the separate read path + "från bildtolkning" marker; separation grep extended | VGAP-01/02/03 | Phase 14 (R_med/U_med), Phase 15 | yes |
| 17. Proposed Planritning Generation | Image-gen floor plan for HIGH value-gap only, daylight/bearing caveats stamped, cost-capped; source images never persisted (GDPR) | DRAW-01 | Phase 16 (HIGH flag) | — |

**Sequencing:** DXUX (13) is independent and goes first. A.4 comps/BRF wiring (14) must land before value-gap ranking (16). Opportunity brief (15) needs 14's holistic payload. Drawing (17) is gated on 16's HIGH value-gap flag. **Locked guards to carry into every phase:** `niche-score.ts`/`flags.ts` never import vision/value-gap/area-comps (static-grep test — extend for value-gap in Phase 16); "low kr/m² ≠ reno object"; no DB migration (JSONB `results`); slim schema + **live** Anthropic strict-output smoke; `DISCOVERY_ENABLED` fail-closed + cost caps (`CAP_VISION_SEK_MAX=10`, `VISION_ENRICH_LIMIT=8`, `CAP_CANDIDATES_MAX=25`); GDPR — source images analyze-only, only generated drawings persist.

## Roadmap Summary (v1.1 — SHIPPED)

8 phases (5–12), standard granularity, 16/16 requirements mapped.

| Phase | Goal | Requirements | Spike/Gate |
|-------|------|--------------|------------|
| 5. Owned Booli Acquisition | Owned client + fallback tree for single + area listings | ACQ-01/02/03 | BLOCKING spike: single-listing-by-URL retrieval |
| 6. Deeper Listing Extraction | Recover floor/balcony/BRF-name/renovation/description via broker page | LSTG-03/04 | Informational spike: broker-CMS coverage |
| 7. Macro Price Context | Descriptive Riksbank/SCB macro indicators, no prediction | MACRO-01/02 | None (independent) |
| 8. BRF Auto-Fetch | Auto-fetch årsredovisning by org.nr, manual upload fallback | ENRICH-01/02 | Informational spike: Bolagsverket/Allabrf access |
| 9. Discovery Foundation | Free-text → area search as bounded cost-capped background job | DISC-01/02/07 | BLOCKING spike + NAMED legal go/no-go gate |
| 10. Niche Ranking | Rank candidates by configurable niches | DISC-03 | — |
| 11. Gallery Condition Vision | Hedged, image-cited soft condition attributes | DISC-04 | Validation gate: 20–30 real listings |
| 12. Floor-Plan & Sun-Path | Floor-plan investigation-prompts + theoretical sun exposure | DISC-05/06 | — |

**Milestone checkpoint:** after Phase 5 + one low-risk win (6 or 7), before committing to discovery (9–12). Phases 9–12 each carry an explicit kill criterion.

## Performance Metrics

**Velocity (v1.0, for reference):**

- Total plans completed (v1.0): 21 across 4 phases
- v1.0 phase durations: P1 ~1wk, P2 ~10d, P3 ~6d, P4 ~15d (5–10h/week cadence)

*Updated after each plan completion during v1.2.*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 14.1 P01 | 7 min | 3 tasks | 8 files |
| Phase 14.1 P02 | 12 min | 2 tasks | 11 files |
| Phase 14.1 P03 | 7 min | 2 tasks | 10 files |
| Phase 14.1 P04 | 3h | 2 tasks | 3 files |
| Phase 14.1 P05 | 12 min | 2 tasks | 2 files |
| Phase 14.1 P06 | 10 min | 3 tasks | 9 files |
| Phase 14.1 P07 | 7 min | 2 tasks | 3 files |
| Phase 14.1 P08 | 50min | 2 tasks | 6 files |
| Phase 14.1 P09 | 13 min | 2 tasks | 7 files |
| Phase 14.2 P01 | 12 min | 3 tasks | 13 files |
| Phase 14.2 P02 | 25 min | 3 tasks | 11 files |
| Phase 14.2 P03 | 6 min | 3 tasks | 6 files |
| Phase 14.2 P04 | 14 min | 3 tasks | 7 files |
| Phase 14.2 P05 | 14 min | 2 tasks | 7 files |
| Phase 14.2 P06 | 22 min | 2 tasks | 10 files |
| Phase 14.2 P07 | 14 min | 3 tasks | 13 files |
| Phase 14.2 P08 | 30min | 3 tasks | 14 files |
| Phase 14.2 P09 | 28 min | 3 tasks | 7 files |
| Phase 14.3 P01 | 25 min | 2 tasks | 13 files |
| Phase 14.3 P02 | 12 min | 2 tasks | 6 files |
| Phase 14.3 P03 | 8 min | 2 tasks | 7 files |
| Phase 14.3 P04 | 7 min | 2 tasks | 4 files |
| Phase 14.3 P05 | 5 min | 2 tasks | 2 files |
| Phase 14.3 P06 | 4 min | 2 tasks | 4 files |
| Phase 14.3 P07 | 24 min | 3 tasks | 7 files |
| Phase 14.3 P08 | 20 min | 2 tasks | 7 files |
| Phase 14.4 P01 | 6 min | 2 tasks | 9 files |
| Phase 14.4 P02 | 14 min | 3 tasks | 10 files |
| Phase 14.4 P03 | 12 min | 3 tasks | 10 files |
| Phase 14.4 P04 | 15 min | 2 tasks | 9 files |
| Phase 14.4 P05 | 8 min | 3 tasks | 10 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap v1.2]: 5-phase structure (13–17) derived from the 15 v1.2 requirements, sequenced by dependency. Numbering CONTINUES from v1.1's Phase 12 (no reset; Phases 1–12 untouched). Mirrors the SPEC's Phase A/B/C decomposition plus a post-merge-E2E-surfaced Discovery UX fix.
- [Roadmap v1.2]: SPEC "Phase A" split into TWO roadmap phases — Phase 14 (holistic INPUTS: A.3 no-empty fallback + A.4 comps/BRF wiring, ANL-*) and Phase 15 (holistic OUTPUT: A.5 prompt + `OpportunityBrief` schema + live strict-output smoke, ROI-*). Distinct verification surfaces (data plumbing vs. make-or-break live Anthropic smoke) and balanced phase size (4+5 reqs, not one 9-req phase).
- [Roadmap v1.2]: Phase 13 (Discovery UX) placed FIRST — independent of the analysis chain, unblocks confidence in the now-live discovery surface, and the poll-timeout was surfaced by the post-merge E2E (the richer scrape is slower).
- [Roadmap v1.2]: Phase 17 (proposed drawing, single req DRAW-01) kept STANDALONE rather than folded into Phase 16 — it is a distinct user-observable capability (generative image output that PERSISTS) with a separate risk/cost profile (image-gen provider TBD, GDPR persistence boundary, HIGH-only cost gate) and a clean dependency on Phase 16's HIGH flag; a coherent last phase that can be independently deferred/cut if cost demands.
- [Roadmap v1.2]: This milestone is WIRING, not math — cores (`flip-economics.ts` valueGap/buyerSegment/RENO_COST_MATRIX/applyRot/taxLines, `area-comps.ts` computeAreaComps, A.1 pre-filter flip, A.2 Haiku triage flip) are already built, tested, and merged on `main`. No phase re-builds them.
- [Roadmap v1.2]: A.4 (comps + BRF wiring, in Phase 14) must precede Phase 16's ranking wiring — VGAP needs R_med/U_med from A.4. The model computes NO money (avoids hallucinated numbers + keeps the strict-output schema slim); code attaches deterministic economics after the qualitative deep pass.

**Carried-forward v1.1 decisions still load-bearing for v1.2:**

- [Roadmap v1.1]: 8-phase structure (5–12) derived from 16 v1.1 requirements, sequenced by dependency + risk. Numbering continues from v1.0's Phase 4 (no reset).
- [Roadmap v1.1]: 999.7 (AI discovery + vision) split into FOUR independently-shippable/killable sub-phases (9 Foundation, 10 Ranking, 11 Gallery Vision, 12 Floor-Plan/Sun-Path) — mitigates solo-dev scope overrun (Pitfall 8); each has its own kill criterion.
- [Roadmap v1.1]: Phase 5 (999.6) is the foundational gate — everything depends on it. BLOCKING spike on single-listing-by-URL retrieval before build; generalize the PROVEN sold-source.ts Playwright/__APOLLO_STATE__ transport, NOT a new keyless GraphQL client.
- [Roadmap v1.1]: Phase 8 (BRF auto-fetch) sequenced AFTER Phase 6 despite the "more independent" framing — it soft-depends on brfName/org.nr that Phase 6 recovers.
- [Roadmap v1.1]: Phase 7 (macro) is technically independent (separate free APIs, third independent branch in enrichMarketContext) — could parallelize; kept in user order.
- [Roadmap v1.1]: Phase 9 carries a NAMED legal go/no-go gate BEFORE implementation — area-wide proactive scraping shifts the legal posture v1.0's user-initiated model relied on (Pitfall 1). No-go cancels Phases 10–12.
- [Roadmap v1.1]: Design constraints baked into criteria — deterministic-in-code / LLM+vision synthesis only; vision output structurally separate from deterministic flags + image-cited + hedged; floor-plan = investigation-prompt (never wall-removal verdict); sun-path = theoretical/unobstructed; macro strictly descriptive; hard per-search cost/candidate/image caps; additive-nullable migrations only; reuse generateReport atomic-lock + BrfProgress polling.

**Carried-forward v1.0 decisions still load-bearing:**

- Sold source = Booli SSR HTML (__NEXT_DATA__ → __APOLLO_STATE__) via apify/playwright-scraper + RESIDENTIAL/SE proxy, NOT the /graphql API (separate stricter CF zone). This is the transport Phase 5 generalizes.
- Actor does NOT provide brfName or floor — Phase 6 (broker extraction) is the first source expected to populate them; Phase 8 depends on that.
- generateReport CAS in-flight lock (report_status + started_at, stale-reclaim after 5min) — the template for Phase 9's FOR UPDATE SKIP LOCKED job claim.
- Cost caps are post-call persistence gates today (costSek Haiku / costSekSonnet Sonnet) — Phase 9/11 must generalize to per-slice incremental checks across N listings.
- PostgREST NULL filter trap: use .is(col,null) / .or(...), never .eq(col,null), when querying the new nullable columns.
- Additive-nullable, no-backfill posture for all new fields/columns (latitude/longitude/booliId/breadcrumbs precedent).
- [Phase 05]: listPrice (not price) carries the { raw } detail-page shape in normalizeScraperOutput's fallback (num(raw.price) ?? rawOf(raw.listPrice)) — regression test fixture built to match this real contract
- [Phase 05]: Rung-2 distinctness (RESEARCH Pitfall 5) resolved via fallback-tree.ts doc comment: walkFallbackTree stays a generic rung-array walker; Plan 04's caller must construct rung 2 as a second independent runPlaywrightRender() invocation site, never a duplicate of rung 1
- [Phase 05]: fetchAreaListings has no rung 3 -- scrapeBooli is single-listing shaped and cannot serve an area query; area search degrades to the two own-render rungs only
- [Phase 05]: Fixed shared apify-client mock's ApifyClient constructor (arrow fn cannot be invoked with new) on first real use
- [Phase ?]: Phase 6 Plan 1: Sourced<T>/ListingSource co-located in listing.ts (not a broker module) since analyze.ts + listing-summary.tsx both import listing types from there — Keeps provenance types alongside the model they annotate for both current and future (Plan 02) consumers
- [Phase ?]: Phase 6 Plan 1: kept reshapeListingEntity's existing floor:entry.floor passthrough unchanged instead of adding a literal-plan-specified duplicate floor: key — A second same-named key in the same object literal silently shadows the first (JS semantics); normalizeScraperOutput's existing num()??rawOf() chain already unwraps the {raw:3} shape correctly, so no behavior was lost
- [Phase 06]: Phase 6 Plan 2: cheerio checkpoint auto-approved by orchestrator pre-verification; proceeded directly to install and remaining tasks without stopping
- [Phase 06]: Phase 6 Plan 2: renovationStatus is DOM-section-sourced only (no schema.org JSON-LD field exists for it), independent of the description JSON-LD path
- [Phase 06]: Phase 6 Plan 2: mergeListingFields includes floor/balcony/brfName in its provenance map for uniform UI consumption even though only renovationStatus/description are broker-suppliable
- [Phase 06-03]: fieldSources + brokerFetchFailed added as new additive-nullable JSONB fields on listingDataSchema (no migration) so ListingSummary can render per-field Kalla provenance captions and the broker-fetch-failed banner for both guest and authenticated flows
- [Phase ?]: macro_snapshots uses explicit any-authenticated-user RLS (SELECT+INSERT+UPDATE) since the table has no user_id and there is no service-role client (RESEARCH A4)
- [Phase ?]: CPIF (not plain CPI) is the persisted inflation figure, matching the Riksbank policy target (RESEARCH Pitfall 3)
- [Phase ?]: Single conservative 24h TTL for all three macro indicators (RESEARCH Open Q2)
- [Phase ?]: Regional scope keyed by 21 län codes, not storstad aggregates (RESEARCH Open Q3)
- [Phase ?]: Migration 007 adds analyses.macro_data (additive-nullable jsonb); pushed live, confirmed applied
- [Phase ?]: Wired FactSheetInput.macro into both real assembleFactSheet call sites (generate-report.ts, page.tsx D-08 fingerprint recompute), not just the type
- [Phase ?]: Fixed live CPIF ContentsCode (PR0101G1 was wrong, 400s; corrected to 000007ZM)
- [Phase 07-03]: MacroContextCard's regional-price sublabel renders the raw län code ("Län {code}") — no län-code-to-name lookup exists anywhere in the codebase; adding one was out of scope
- [Phase 07-03]: generate-report.ts needed no changes — Plan 02 already wired `macro` (object-shorthand) into its assembleFactSheet call, byte-matching page.tsx's fingerprint recompute (T-04-24)
- [Phase 08-01]: runBrfExtraction owns the ownership re-check internally; analyzeBrf keeps a fast-fail ownership check before buffering the uploaded file (belt-and-suspenders per T-08-03)
- [Phase 08-01]: iXBRL D-06 cache hashes UTF-8 text directly (not converted to bytes) rather than reusing the PDF byte-hash path
- [Phase 08-01]: v1 auto-fetch stores no raw HTML for audit -- only the extracted result + text content hash; uploadBrfPdf is skipped entirely for ixbrl-text sources
- [Phase 08-02]: resolveOrgNr is 100% pure (no network) -- candidates injected by the action layer, keeping the wrong-BRF confidence decision deterministically testable and source-agnostic
- [Phase 08-02]: assertAllowedHost exported from allabrf.ts and walkBrfSources/BrfRung exported from fetch-document.ts purely to unit-test security-critical branches unreachable via the hardcoded-URL public API
- [Phase 08-02]: A rung's null return is logged identically to a thrown error in the fallback walker so the failure trail is equally visible regardless of failure mode
- [Phase 08-03]: kommunFromBreadcrumbs derives geography from the genitive-form breadcrumb label (Stockholms kommun -> Stockholms) which may not byte-match a registry's nominative kommun name -- fails closed to low confidence on mismatch (safe direction), accepted v1 limitation
- [Phase 08-03]: confirmAndAnalyze's redundant-work guard is a simple brf_status pre-check (auto_fetching/done -> early return), lighter than generateReport's full CAS-with-stale-lock-reclaim, appropriate for auto_fetching's sub-few-second window
- [Phase 08-03]: Tasks 1+2 (resolveOrgNrAction, confirmAndAnalyze) committed as a single atomic commit since both live in the same new tightly-coupled file with no independent test-passing intermediate state
- [Phase 08-brf-auto-fetch]: Component-test infra (jsdom + RTL + jest-dom) added, scoped per-file via @vitest-environment docblocks — node stays the global default
- [Phase ?]: [Phase 08-05 gap-closure]: Persisted fiscalYear/isMostRecent inside existing brf_data JSONB (BrfData interface) instead of adding a new analyses column/migration -- avoided an unnecessary migration 010
- [Phase ?]: [Phase 08-05 gap-closure]: runBrfExtraction's new fetchMeta param is optional/additive -- manual path (analyzeBrf) passes nothing, so BrfData.fiscalYear/isMostRecent stay absent there with zero change to the manual regression suite
- [Phase ?]: [Phase 08-05 gap-closure]: confirmAndAnalyze persists fetchArsredovisning's actual doc.fiscalYear/isMostRecent, never the client-supplied preview value -- confirm-time fetch stays the source of truth
- [Phase 09-01]: discovery_jobs RLS includes an owner-only UPDATE policy (beyond 001_analyses.sql's select+insert-only shape) since the client-tick path updates running counters under the user's own session; claim_discovery_slice itself runs SECURITY DEFINER and bypasses RLS for the atomic claim
- [Phase 09-01]: CAP_CANDIDATES_MAX=25 (mid-point of locked 20-30 band), CAP_SEK_MAX=5, CAP_IMAGES_PER_LISTING=0 declared now as a Phase 9 no-op contract placeholder (real vision image fetch is Phase 11)
- [Phase 09-01]: discovery_jobs.status is a bare text column with no check constraint, mirroring the brf_status convention from migration 009 so new status words never require DDL
- [Phase ?]: [Phase 09-02]: Shipping v1 area resolution is seed-primary (3-entry Stockholm-region AREA_SEED), not probe-primary -- live search-box probe implemented but its checkpoint (Task 2) deferred per operator pre-approval; run steps recorded in 09-02-SUMMARY.md Operator Next Steps
- [Phase 09-03]: JOBS_PER_DAY_CAP=5 added in startDiscovery.ts as a new constant (not pre-locked by Plan 01/02) closing the rapid-job-creation dimension of the cost-DoS surface, complementing the per-slice incremental caps
- [Phase 09-03]: DiscoveryJobsWriter type derived from Awaited<ReturnType<typeof createClient>> (mirrors generate-report.ts's StatusWriter) rather than a hand-rolled interface -- the real Supabase PostgrestFilterBuilder is thenable, not a plain Promise
- [Phase 09-03]: job.integration.test.ts uses a service-role Supabase client (bypasses RLS) deliberately to prove the RPC's own FOR UPDATE SKIP LOCKED atomicity, not the RLS policy layer (separate, already-covered concern)
- [Phase ?]: [Phase 09-04]: TICK_DISCOVERY_MAX_DURATION_SEC moved to src/lib/discovery/tick-config.ts rather than an export const maxDuration inside tick-discovery.ts -- Next.js's Server Actions bundler rejects non-async exports from a use-server file at build time, invisible to vitest
- [Phase ?]: [Phase 09-04]: discoveryCandidateSchema (Zod) added additively to candidate.ts as the read-path guard for /discover/[jobId], mirroring the dashboard's listingDataSchema.safeParse CR-01 discipline
- [Phase ?]: [Phase 09-04]: DiscoveryCandidateCard's Se full analys link routes to /dashboard?url=<encoded source URL> rather than a nonexistent /analysis/[id] -- Phase 9 is retrieval-only, no analysis id exists yet for a raw discovery candidate
- [Phase 10-01]: imminent-stambyte niche v1 ships as a hedged construction-year proxy keyed 'stambyteProxyAge', deliberately distinct from FLAG_IDS.STAMBYTE_PLANERAT; the real per-candidate BRF-backed signal is deferred (would blow CAP_SEK_MAX if run for every discovery candidate)
- [Phase 10-01]: computeNicheScore's internal [0,1] score is used only for sorting and is never rendered bare -- the UI (Plan 10-02) always renders the breakdown as cited chips
- [Phase 10-02]: Area baseline computed as a PURE client-side median price/sqm over the candidate set itself, NOT via server-side compare.ts/fetchSoldComps reuse as RESEARCH.md originally planned -- discovery jobs persist no lat/lng or breadcrumbs, only filters + the PII-safe results allowlist, so compare.ts's SoldSourceQuery cannot be constructed from a stored job (RESEARCH Assumption A4 did not hold). [v1.2 UPDATE — SPEC finding 2026-07-10: `fetchSoldComps` resolves area from breadcrumbs/areaId, NOT lat/lng, and the job already resolves an areaId that can be cheaply RE-RESOLVED via cached `resolveArea` at analysis time — so Phase 14 A.4 CAN wire real comps without a migration. A4 holds via re-resolution, not via persisted lat/lng.]
- [Phase 10-02]: Radix Select's jsdom gaps (scrollIntoView, pointer-capture methods) polyfilled locally inside discovery-results.test.tsx (first Select-driven RTL test in the repo), not added to the shared vitest.setup.ts
- [Phase ?]: The live Apollo images( ref probe (scripts/probe-booli-images.ts) is written but deliberately not run this plan; extractImageUrls implements RESEARCH's assumed shape with a graceful never-throwing fallback
- [Phase ?]: CAP_IMAGES_PER_LISTING activated from Phase 9's 0-placeholder to 4 (1 floor plan + up to 3 gallery); CAP_VISION_SEK_MAX=10 kept strictly separate from CAP_SEK_MAX=5
- [Phase ?]: vision-schema.ts's Claude-facing schemas use extract.ts's single-nullable-leaf discipline (3 nullable leaves, zero numeric constraints), statically asserted by a Zod-def-tree-walking test, to avoid the anthropic-structured-output-limits 400 trap
- [Phase 11]: [Phase 11-02]: runVisionForJob added as a separate export in job.ts (not a runSlice modification) -- called from tickDiscovery/sweep route only once a slice leaves the job "done", keeping runSlice's own incremental-cap/kill-switch/persist behavior and tests completely unchanged
- [Phase 11]: [Phase 11-02]: Vision SEK spend (CAP_VISION_SEK_MAX) is tracked entirely separately from cost_sek_total (the scrape cap) -- a job hitting its scrape cap still gets vision, a job hitting its vision cap only stops vision, never the whole job
- [Phase 11-03]: GalleryConditionVision uses border-warm-gray-200/bg-warm-white + a terracotta Eye-icon badge (never severityChip/sage/destructive) so a buyer can tell image-interpreted claims from ReportFlags' verified chips at a glance; wired into discovery-results.tsx spatially separate (space-y-6) and AFTER the ranking grid, never feeding computeNicheScore
- [Phase 11-03]: Structural-separation invariant (niche-score.ts/flags.ts must never import a vision module) implemented as a static source-grep test (mirrors job.integration.test.ts's invariant-as-a-test precedent) rather than a dependency-graph tool -- verified to fail on a manually-injected violation, then reverted. [v1.2: Phase 16 EXTENDS this grep to forbid the value-gap module too.]
- [Phase 12-01]: suncalc v2.0.0's azimuth convention confirmed live (degrees, north-zero, clockwise; solar noon via getTimes().solarNoon -> getPosition ~180 at Stockholm lat/lon) -- matches the v2.0.0 README, not the stale v1.x radians/south-zero convention; confirmed both at install time and by a committed mandatory smoke test that must pass before any facade-bucketing test is trusted
- [Phase 12-01]: computeSunExposure's grid cells are qualitative Swedish descriptors only (never a numeric hour count) per UI-SPEC's no-false-precision rule; 3 season buckets sampled at winter solstice/an equinox/summer solstice (spring and autumn share one symmetric sun path at a given latitude)
- [Phase 12-01]: suncalc package-legitimacy checkpoint auto-approved per plan pre-approval (225k weekly downloads, maintainer mourner, zero deps, ships own types, no postinstall, slopcheck OK) -- not stopped on, mirrors the Phase 06 cheerio precedent
- [Phase 12]: remodelPotential disclaimer suffix and kill-criterion CUT documented in 12-02 — Kept the phase kill-criterion posture (one-tuple-entry removal) explicit and testable
- [Phase ?]: floor unwrap uses num(raw.floor) ?? rawOf(raw.floor), not num(raw.floor) alone -- toCandidate receives reshapeListingEntity's un-normalized {raw:N} FormattedValue directly on the fetchAreaListings/job.ts path
- [Phase ?]: raw description is read as a direct expression argument to extractOrientationFromDescription inside toCandidate's returned object literal (never a local variable), keeping the PII-safe derived-only contract structurally enforced
- [Phase ?]: [Phase 12-04]: SunPathExposure computes computeSunExposure in-component (not upstream) since the 4 raw inputs are already threaded through discovery-results.tsx
- [Phase ?]: [Phase 12-04]: Sun-path grid renders only KNOWN facades (season columns, one row per known facade) -- never fabricates missing facades as ej-tillganglig rows, per UI-SPEC binding constraint
- [Phase 13]: AREA_PAGE_WAIT_SECS=120 chosen as a conservative first D-02 value, exported from client.ts for test assertions — pending calibration by the 13-03 live smoke against real Apify per-page render timing
- [Phase 13]: runSlice's area loop iterated by index (settled[i]/areaIds[i]) mirroring client.ts's page-level Promise.allSettled pattern exactly, preserving D-03's cost-cap invariant by construction
- [Phase ?]: [Phase 13-02]: SOFT_THRESHOLD_MS=90_000 / ABSOLUTE_CEILING_MS=15*60_000 chosen as tunable constants pending calibration by the 13-03 live smoke
- [Phase ?]: [Phase 13-02]: STATUS_LABELS/KNOWN_STATUSES exported directly from discovery-progress.tsx so the exhaustiveness test enumerates the single canonical source of truth
- [Phase ?]: 13-04: processed_count during vision enrichment counts enriched-so-far (1..N), not a continuation of the scrape-phase processed_count -- runVisionForJob only receives the candidate array, threading the true base value was out of scope; strict monotonic increase holds by construction (plan-sanctioned choice).
- [Phase ?]: 13-04: onProgress fires only on a SUCCESSFUL per-candidate detail-enrichment attempt (never from the catch branch) -- keeps the pre-existing single-update runVisionForJob test passing unmodified.
- [Phase ?]: 13-04: DETAIL_ENRICH_WAIT_SECS=90 / DETAIL_ENRICH_MAX_RETRIES=2 bound the vision-enrichment detail-page render (midpoint of the 13-SMOKE-FINDINGS.md 60-90s/1-2-retry envelope), tunable pending live-smoke calibration; /analyze's fetchListing(url) call site stays byte-for-byte at the 240s/3-retry default.
- [Phase 13-05]: Counter is monotonic clamped component state (analyzed = 0 until done, then candidate_count) rather than a persisted mid-run column -- no DB migration; liveness during vision_processing is carried by the 13-04 badge advancement + soft-notice, not this numeric counter.
- [Phase 13-05]: Reverted only 13-04 Task 2's onProgress/processed_count-during-vision wiring -- 13-04 Task 1 (decoupled read) and Task 3 (bounded fetchListing opts) remain fully intact.
- [Phase 14-01]: tomtrattFromTenureForm never returns false — tenureForm cannot disprove tomträtt (the BRF, not the unit, holds it); unknown stays null rather than a silently-wrong false
- [Phase 14-01]: holisticBriefSchema restricts confidence to low|medium at the schema level — a stored 'high' fails safeParse rather than being trusted (D-14-04 mandatory downgrade)
- [Phase 14-01]: kommunFromBreadcrumbs relocated to client.ts as the SINGLE shared implementation (was a private near-duplicate in fetch-brf-auto.ts) — both the discovery scrape path and single-listing BRF path now call the same function
- [Phase 14-02]: canAttributeToCondition is structurally always false in Phase 14 (D-14-05) — elevator/micro-location/sub-area are unconditionally unknown every run, so the expression's unknownConfounders.length===0 term never holds; written as a real formula (not a literal) so a later phase flips it with zero shape change.
- [Phase 14-02]: buildHolisticBrief gates its confounder items on comps!==null||brf!==null (not unconditional per the plan's literal wording) so an all-null input correctly falls through to the single insufficient-data item, satisfying the ANL-01 non-empty guarantee.
- [Phase 14-03]: normalizeKommun's genitive-stripping chain is applied symmetrically to both sides of resolveOrgNr's comparison — lossy but safe by construction; no real Swedish kommun pair collapses
- [Phase 14-03]: brf-lookup.ts's D-14-12 reuse-boundary doc comments/tests paraphrase the forbidden identifiers (never literally spell out analyses/runBrfExtraction/resolveOrgNrAction/confirmAndAnalyze) to avoid tripping the plan's own zero-occurrence grep acceptance criteria
- [Phase 14-04]: The visionSkippedReason !== null && hasHolisticBrief branch is one combined condition (not three near-duplicates) since only one visionSkippedReason value can be true at a time, satisfying the truth table without triplicating JSX
- [Phase 14-04]: The pre-vision not-yet-run state (vision===null && visionSkippedReason===null) is outside the six enumerated content states and correctly renders nothing new regardless of holisticBrief
- [Phase ?]: [Phase 14-05]: resolveCompsForCandidates resolves each candidate's OWN areaLabel and de-dupes the fetch set BY resolved areaId, running both resolve and fetch steps concurrently via Promise.allSettled
- [Phase ?]: [Phase 14-05]: runVisionForJob pipeline is now enrich -> comps -> vision -> persist; comps spend seeds runVisionPass's initialSpentSek so comps/BRF/vision share ONE CAP_VISION_SEK_MAX pool (D-14-08)
- [Phase ?]: [Phase 14-05]: resolveCompsForCandidates uses resolution == null (loose) not === null when checking a resolveArea outcome, so a test double or future caller returning undefined degrades identically rather than crashing into the whole-body catch
- [Phase 14-06]: Comps run BEFORE BRF in the pipeline (D-14-08 front-load-the-cheap ordering); comps needed by every candidate's brief, BRF only covers the top-N
- [Phase 14-06]: Drove vision_error/claims:[] test states by mocking @anthropic-ai/sdk directly (mirrors vision.test.ts), not by mocking vision.ts itself, to exercise the real runVisionPass code path
- [Phase 14-07]: fieldConfidence required-on-interface, defaulted-in-schema — Interface requires it so no writer can silently omit it; Zod .nullable().default(null) lets a legacy persisted row (nested inside discoveryCandidateSchema, whose consumer drops the whole candidate on nested parse failure) still parse, degrading to untrusted null.
- [Phase 14-07]: brfFieldTrusted fails closed on every axis (null summary/value/map/sub-threshold) — D-14-05 default posture is cannot-attribute — absent confidence is absence of evidence, never a silent trust assumption.
- [Phase 14-07]: CLAUDE_CALL_FAILED stays charged at 0 SEK in BILLED_CALLS_BY_EXTRACTION_CODE — It is extract.ts's catch-all for a transport/auth/rate-limit failure that never completed a billed model call, so there is nothing real to charge.
- [Phase ?]: [Phase 14-08] Statement-level matcher's real-file positive controls (candidate.ts, confounder-guard.ts) did not independently falsify against the pre-WR-01 line filter — both files already contain an unrelated single-line import of a different registered specifier that the old filter already matched — Recorded per task acceptance criteria's falsification-count instruction; core WR-01 invariant is still proven by the isolated fixture tests, which fail cleanly against the old implementation
- [Phase 14-holistic-analysis-brain]: [Phase 14-09]: Accepted the ANL-03 soliditet deferral via a frontmatter overrides entry in 14-VERIFICATION.md (accepted_by Daniel Westerholm, 2026-08-08T14:51:40Z) rather than implementing it — no field exists on brfExtractionSchema, debt/m2 already carries most of the balance-sheet signal (D-14-02). — CR-01/02/03/04 remain open defects (not override candidates); soliditet alone was a disclosed, reasoned scope call.
- [Phase 14-holistic-analysis-brain]: [Phase 14-09]: Left REQUIREMENTS.md's ANL-03/ANL-04 traceability table rows ('Complete') untouched — that bookkeeping is owned by the re-verification that follows this gap-closure run, not by this documentation-only plan.
- [Phase 14-10]: brf_debt_high is now effectively extraction-unreachable (HIGH_BRF_DEBT_PER_SQM === BRF_SANITY_BANDS.skuldPerKvm.max) — an untrusted-but-high debt figure routes to brf_unknown instead, since that is true either way and strictly more conservative for attribution (D-14-05).
- [Phase 14-10]: The avgift sentence states avgiftsniva's real SEK/m2/ar unit unconditionally and appends a derived kr/man clause only when livingArea is known and positive — never relabels the raw figure as monthly.
- [Phase 14-10]: STAMBYTE_PROSE maps the bounded stambytePlanerat enum to Swedish prose with ej_namnt -> null (no item); WR-09's narrowing to StambyteStatus stays deferred since the map fails closed via ?? null for any unmapped value.
- [Phase 14.1]: 14.1-01: broker description wins for sun phrases; sydost matches only with a direction suffix; o-initial east keywords fixed with (?<!\p{L})
- [Phase 14.1]: 14.1-02: sold detail pages expose build year, balcony, list price (enrich sold sample in 14.1-08); slutpriser page cap 30, newest-first; real Apify spend 0.3821 USD
- [Phase 14.1]: 14.1-03: model/snapshot JSON zod-parsed on load; replay default model path data/hedonic-model.json; taste fields wired as zeros for 14.1-07
- [Phase 14.1]: 14.1-04: an empty slutpriser page needs 3 empty looks before it counts as end of results; upper size bands (60-120 m2) are capped at 4 pages and cover only the latest 2.5-6 months — Half-loaded Booli pages returned data with no sold card and ended slices early; the 4-page cap is the R-12 cost trade-off
- [Phase 14.1]: 14.1-04: Apify monthly headroom is 11.73 USD after the 18.43 USD slutpris pull; size the 14.1-08 sold-detail enrichment from real headroom — Plan 14.1-08 estimates 6-13 USD, which may not fit
- [Phase 14.1]: 14.1-05: sign guard replaces the worst coefficient first and refits the rest; slope bid premium uses median intercepts so flat is the b = 0 case — Overruling floor must re-estimate ground floor against the value actually used; mean-vs-median would favour slope for the wrong reason
- [Phase 14.1]: 14.1-05: real-cache smoke fit zeroes the size coefficient (wrong sign, size and recency tangled in upper bands); decide in 14.1-08 whether to pull more months for 60-120 m2 — Not a bug; guard rule from D-18 applied, no study value exists for size
- [Phase 14.1]: 14.1-06: vision claims classified by negation-first regexes, worst state wins, priced from RENO_COST_MATRIX; vision cap 25 SEK; taste bonus table-driven (3 % sun + 2 % hubs)
- [Phase 14.1]: 14.1-07: pre-rank covers ALL comparable rows (D-10 'cap 60' read as expected count, not truncation); no automatic model-level offset; dominance check treats larger flat as better - Daniel to confirm
- [Phase 14.1]: 14.1-08: size effect stays zeroed by the D-18 direction rule; per-band check shows larger flats really cost +3-5 % more per m2 (60-120 m2) and about 0 between 35-50 m2. Daniel to confirm.
- [Phase 14.1]: 14.1-08: only 35 sold-detail pages enriched (4.23 USD); too thin for build year, so balcony = study +1.9 % and no build-year term. Booli returns the sold object only for sales from Oct 2025 on.
- [Phase 14.1]: 14.1-09: fit-score live exit codes 0 done, 1 error, 2 only for Apify headroom below the worst-case estimate (5.90 USD for 4 districts x window 20); --dry-run stops after the check — The wallet guard must be testable without spending; exit 2 must mean one thing
- [Phase 14.1]: 14.1-09: listing links are printed only in the table, so live log and snapshot replay list links in the same order (plan 10 diff) — Replay-equals-live check
- [Phase 14.2]: 14.2-01: local headed Chromium is the default renderer for the headless scripts; Apify is an opt-in fallback only with --allow-apify, capped at --apify-max-renders (default 10); no display and no explicit choice is an error
- [Phase 14.2]: 14.2-02: district completeness counts new-construction items Booli counts but never draws as cards (unlistedProjects) as in hand; page count refined from page 2's size — Real runs: bare collected >= totalCount reads ofullstandig on 3 of 4 districts; page-1 size undercounted Kungsholmen by 32
- [Phase 14.2]: 14.2-03: WR-03 uses layout-noun-only THROUGH_FLAT_RE (missed phrase costs nothing, false hit costs ~35 000 kr); NO_RENOVATION_NEED is stripped, not short-circuited
- [Phase 14.2]: 14.2-04: D-10 applied - size direction rule dropped; size coefficient +0,0461 (t 8,4) now comes from data; Daniel can overturn by reverting cdbbf63 + 15335c0
- [Phase 14.2]: 14.2-05: window 'all' reads two candidates at a time (the local browser opens two pages at once); 'all' is refused under --renderer apify (checked at argument parsing and after the renderer is resolved)
- [Phase 14.2]: 14.2-05: coverage measured on 77 comparable flats before pictures: detail/balcony/avgift 100 %, tenure 98,7 %, description 41,6 %, sun/orientation 2,6 %, condition 0 % (no pictures yet); Booli detail pages carry no description, so text coverage depends on broker direct GET only
- [Phase 14.2]: 14.2-06: vision runs in 3 lanes capped at 20 SEK each (60 SEK per run), cached by listing path + picture-set hash; local browser opens broker pages only via the broker page function (one attempt, no Apify)
- [Phase 14.2]: 14.2-07: BRF debt per kvm = Booli BRF page loans / boarea (label and value on separate lines); 2 of 30 pages show no Lån line so debt stays null; reasons are pure rules with one thresholds table, snart till salu last and informational; 'ovanlig planlösning' fires on 10 of 35 (1-room flats over 30 kvm) and is flagged for review
- [Phase 14.2]: 14.2-08: a fingerprint match (same-run twin or URL-form switch) also needs an equal-or-unknown asking price and non-contradicting floor; found live (Gyllenborgsgatan 15, two flats at 38 kvm)
- [Phase 14.2]: 14.2-08: nodemailer pinned exactly to 9.0.5 (published 2026-08-07), dynamic import only; watch memory is written only after delivery (mail accepted or HTML file written)
- [Phase 14.2]: 14.2-09: D-17 measured on the first real local run: condition 93,5 %, balcony 100 %, sun 2,6 % (not met, 14.3 scope per R-05); 0 USD Apify, 33,01 kr picture reading; LaunchAgent documented, not installed
- [Phase 14.2]: 14.2-09: the evidence run filled the default watch-state.json (77 flats), so the first scheduled Monday mail carries only new or changed flats
- [Phase 14.3]: 14.3-01: Folkungagatan 61 resolves to south (166.2 deg, conf 1.00) from the OSM footprint; boundary comparisons run at stored 1-decimal precision; normalizeStreetName lives in osm-buildings.ts and is re-exported from sun-facade.ts
- [Phase 14.3]: 14.3-02: OSM cache stores only type/id/tags/geometry/members (bounds dropped); 31-day refresh rule inclusive; real cache 12,9 MB downloaded 2026-10-13 via lz4/z mirrors
- [Phase 14.3]: 14.3-03: floor-plan compass route closed. Model read a north arrow on 6 of 11 plans (54,5 %) but all 6 are front-door entrance arrows on inspection; 0 real compasses (research: 0 of 69). FLOORPLAN_ROUTE_ENABLED=false; plan 08 must not run the compass pass. — Entrance arrows misread as north would put wrong facades above correct footprint ones (T-14.3-08); spend 0,37 kr of 2,00 kr
- [Phase 14.3]: 14.3-04: heights follow the locked formula (levels x 3 + 2, no roof allowance); estimated heights are flagged and every obstructed figure is a +-3 m range — The envelope covers an attic storey; the flag shows when a neighbour's height is our estimate
- [Phase 14.3]: 14.3-04: wallsNear and the neighbour median share one 150 m bounding-box grid; heights are lazy and memoised per building — A centroid-only grid would miss long buildings; all 15 415 heights resolve in 49 ms
- [Phase 14.3]: 14.3-05: stated 1,00 > planritning > fastighet/gata; konflikt strictly above 90 degrees halves confidence; footprint-only conflicts need non-opposite sides
- [Phase 14.3]: 14.3-06: sun taste = best-side facade weight x March obstruction factor x confidence, halved (streetOnlyFactor 0.5, assumption A4) when only the footprint is known; stated keeps 1.0; 3 % cap unchanged
- [Phase 14.3]: 14.3-08: 14.2 D-17 sun clause met - live sol härledd 74 av 76 (97,4 %), replay 75 av 77 (97,4 %); street-side factor 0,5 left as shipped (mean taste move 24 931 kr, max 79 273 kr between 0,5 and 1,0)
- [Phase 14.4]: 14.4-01: run record keeps flags as plain strings and rows loose so deleted/added fields still parse; frozen before = 77 comparable, 17 creditCapped, Folkungagatan 61 rank 29 / 778 545 kr
- [Phase 14.4]: 14.4-03: R-06 no extension; avgift (t -3,3) and BRF debt (t -2,9) fitted as hedonic features, tomträtt zeroed (absent); model file version 2
- [Phase 14.4]: 14.4-04: days on market kept in the bid premium (CV 0,0736 -> 0,0727, coefficient -0,0351 per ln-day, 837 sales); not a resale feature — Strict CV drop on identical held-out rows and expected sign
- [Phase 14.4]: 14.4-05: credit is the full gap; residual flag 'ovanligt långt under modellpris' defaults to the expected-final basis (10 of 77 rows; asking basis would flag 26), RESIDUAL_FLAG_BASIS selects
- [Phase 14.4]: 14.4-05: a residual-flagged row's reason line counts as an explanation, so 'oförklarat fynd' now means hidden-defect flag with no fact to point at (12 of 35, was 13)

### Pending Todos

- Customize Supabase auth email templates (currently "powered by Supabase" boilerplate).
- Build labeled BRF extraction eval dataset (4–6 årsredovisningar + labels.json) and run brf-extract/v2 regression eval — harness ready at evals/extractor.eval.ts (deferred from Phase 4).
- README.md has uncommitted create-next-app boilerplate — decide keep/revert.
- Design polish pass (overall UX approved, deeper design work wanted).
- Run `/gsd-secure-phase 4` "Verify all" before production (v1.0 security closed via operator acceptance).
- [v1.2] Create `evals/opportunity-brief.eval.ts` (gated `RUN_LLM_EVALS=1 && ANTHROPIC_API_KEY`, ~2 frozen fixtures) — the mandatory LIVE strict-output smoke for Phase 15's `OpportunityBrief` schema (mocked tests hide 400s).

### Blockers/Concerns

- **[Cost]** Every v1.2 discovery/analysis run spends real Apify (area search + up to 8 detail renders + 1–2 comps renders) and Anthropic (Haiku triage + Sonnet deep pass × up to 8). Caps: `VISION_ENRICH_LIMIT=8`, `CAP_VISION_SEK_MAX=10`, `CAP_CANDIDATES_MAX=25`. Phase 14 folds comps + BRF fetches into the vision cost gate; Phase 17 image-gen is HIGH-value-gap-only to bound spend. One verification run is cheap; don't loop it.
- **[Phase 15 — make-or-break]** Anthropic strict-output 400 risk on the `OpportunityBrief` schema — mocked tests hide it. Keep the model's fields slim (single-nullable-leaf, numbers unconstrained); code attaches all money deterministically. Run the live smoke and slim further if it 400s BEFORE touching UI.
- Supabase free tier pauses after 7 days inactivity — old project was permanently frozen after 90+ days. Visit dashboard periodically or upgrade.

**Resolved (v1.1):**

- ~~[Phase 5/9 BLOCKING spikes]~~ Resolved during v1.1 build (owned acquisition + discovery foundation shipped code-complete).
- ~~[Phase 9 legal gate]~~ **RESOLVED — GO (operator, 2026-07-08).** `DISCOVERY_ENABLED` set ON in the operator env; per-query/per-day caps enforced in code; flag retained as the runtime kill switch. (v1.1 live validation gates below still stand as separate operator checks.)

### Roadmap Evolution

- Phase 14.1 inserted after Phase 14: Reshaped around Daniel's apartment hunt (buy by mid-April 2027); 15–17 deferred (URGENT)
- Phase 14.2 inserted after Phase 14: Reshaped around Daniel's apartment hunt (buy by mid-April 2027); 15–17 deferred (URGENT)
- Phase 14.3 inserted after Phase 14: Reshaped around Daniel's apartment hunt (buy by mid-April 2027); 15–17 deferred (URGENT)

## Session Continuity

**Resume file:** None

Last session: 2026-10-13T20:31:43.222Z
Stopped at: Completed 14.4-05-PLAN.md
Next step: Operator live-smoke re-run of Phase 13 (confirm the counter now reads "N av N" at done with no "350 av 25" / backward jump), then `/gsd-verify-phase 13`. The v1.1 operator live-validation backlog below (Phases 9–12 kill-criteria, 05/07/08 live smokes) remains outstanding but does not block v1.2 phase planning — the discovery surface is live on `main` and `DISCOVERY_ENABLED` is ON.

**Shipped 2026-07-08:** v1.1 (Phases 5–12) opened as PR #1 → main, merged. Discovery cores + analysis cores (`flip-economics.ts`, `area-comps.ts`, pre-filter flip A.1, Haiku triage flip A.2) are on `main` as of the 2026-07-17 discovery overhaul merge (11a3c7a). v1.2 wires them live.

## Operator Next Steps

> The v1.1 operator live-validation backlog is retained below — these are separate operator checks that do not block v1.2 phase planning.

- **[Phase 12 Task 4 — BLOCKING kill-criterion checkpoint, NEW, auto-approved-but-deferred]** Live floor-plan hedging validation + one live 4-leaf-schema API smoke + live sun-path render:
  1. Set env: Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON. Start the app (`npm run dev`).
  2. (Cheapest first) `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` on one fixture — confirm the extended 4-leaf schema does NOT 400 (project memory `anthropic-structured-output-limits`).
  3. Run one real discovery job through to completion on `/discover/[jobId]`.
  4. **KILL CRITERION:** on a candidate with a planritning, confirm the PLANLÖSNING row is safely hedged (verbs "antyder"/"kan vara värt att undersöka"/"eventuellt", always ending "kräver konstruktör / väggutredning", NEVER stating bärande/icke-bärande as fact). If floor-plan output repeats confidently-wrong load-bearing claims → CUT: remove the `["remodelPotential", parsed.remodelPotential]` tuple entry in `vision.ts` (one-line flag flip, schema/tests stay in place) and stop rendering the PLANLÖSNING row — ship sun-path alone.
  5. Confirm the sun-path sub-block renders the Compass/warm-gray grid (stated orientation) or the exact "ej tillgänglig" line (no stated orientation) — never a guessed orientation.
  6. Confirm sun-path is visually distinct (Compass/warm-gray, never Eye/terracotta) and neither floor-plan nor sun-path appears in any rank badge/niche chip.
  - Report back "approved" or a CUT decision. Full steps: `.planning/phases/12-floor-plan-sun-path/12-04-SUMMARY.md`.

- **[Phase 11 — live-render check + 20-30-listing kill-criterion validation gate]**
  1. Set env: Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON. Start the app (`npm run dev`).
  2. (Recommended first, cheap) run `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` on ONE fixture to confirm the slim vision schema doesn't 400 before spending on a full run (per project memory `anthropic-structured-output-limits`).
  3. Run one real discovery job (free-text area search) through to completion on `/discover/[jobId]`.
  4. On a candidate that had a gallery, confirm "AI-bedömning av bilder — kan vara fel" renders hedged Swedish claims ("verkar"/"ser ut att", never "är"/verdicts), each with a "Bild {n}" citation + thumbnail, visually distinct from the ranking chips (terracotta Eye header, no severity chips).
  5. Confirm the three degraded states are distinguishable where they occur: "Inga bilder tillgängliga…" (no gallery) vs "Bildbedömning kördes inte… (sökgränsen…)" (cost cap) vs "För osäkert för att visa…" (all suppressed).
  6. Confirm NO claim references a person or personal document, and per-search vision cost stayed under `CAP_VISION_SEK_MAX`.
  7. **Kill criterion (hard gate):** run the full 20-30-listing accuracy gate per `.planning/phases/11-gallery-condition-vision/11-RESEARCH.md` — directional accuracy ≥ 70%, citation validity ≥ 90%, zero-hallucination = 100%. Below threshold → CUT gallery vision, ship discovery text-ranking-only (the UI already degrades to `vision: null` gracefully by construction, so a CUT requires no UI rework, only stopping the `runVisionForJob` call sites).
  8. Also note: the Plan 01-deferred live Apollo `images(` ref probe (`scripts/probe-booli-images.ts`) has not been run — until it is, `imageUrls` is `null` for every real candidate, so step 4 will show the `no_images` degraded state for all real listings regardless of gallery presence. **(v1.2 Phase 14/15 real E2E runs need this probe run first, else comps/BRF wiring can be verified but the vision deep pass sees no images.)**
  - Report back "approved" once verified, or describe any issue / a CUT decision. Full steps: `.planning/phases/11-gallery-condition-vision/11-03-SUMMARY.md`.

- **[Phase 10 — manual UAT kill-criterion check]** Confirm niche ranking actually distinguishes candidates on real data:
  1. Ensure env is set (Supabase + `APIFY_API_TOKEN` + `DISCOVERY_ENABLED=true`). Start the app (`npm run dev`).
  2. Run one real discovery job (free-text area search) through to completion.
  3. On `/discover/[jobId]`, switch between the 3 niche options ("Renoveringspotential", "Inflyttningsklar", "Stambyte planerat — föreningen betalar") and confirm the card order visibly changes each time, with the rank badge (#1, #2...) and cited-signal chips defensible against the actual listing data shown.
  4. If the 3 niches produce near-identical orderings on real data, the recommendation is to ship filtering-only and defer ranking (revisit before wider rollout).
  - Report back "approved" once verified, or describe any issue. Full steps: `.planning/phases/10-niche-ranking/10-02-SUMMARY.md`.

- **[07-03 Task 3 — deferred live-render checkpoint]** Confirm the Makroekonomisk kontext section on a real analysis:
  1. Ensure the app has env for Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY`. Start the app (`npm run dev`).
  2. Open an existing owner analysis detail page (or run a fresh analysis on a real Booli listing URL, then open it).
  3. Trigger "Hämta marknadsdata" if shown. Wait for a terminal state.
  4. Confirm "Makroekonomisk kontext" renders, visually separate from price/area panels, showing Styrränta, Inflation (KPIF), and Regional prisutveckling each with source + reference period (and "(preliminär)" if applicable).
  5. Confirm the "ingen prognos eller rekommendation" sub-label and NO directional/color-coded language.
  6. Confirm independent degradation: any single unavailable indicator shows "Ej tillgänglig" without blanking the others or the price/area panels.
  - Report back "approved" once verified, or describe any specific issue. Full steps: `.planning/phases/07-macro-price-context/07-03-SUMMARY.md`.

- **[08-04 Task 4 — BLOCKING checkpoint, still outstanding]** Live auto-fetch + fall-through + manual-regression smoke test (auto-approved-but-deferred per execution instructions; NOT performed — live Allabrf calls are operator-only):
  1. Ensure env: Supabase + `ANTHROPIC_API_KEY` (+ any Allabrf access if configured). Start the app (`npm run dev`).
  2. Open (or run) an analysis for a real Booli listing whose BRF has a recoverable brfName (Phase 6) and an Allabrf årsredovisning with a resolvable org.nr.
  3. Confirm "Stämmer detta med din bostad?" shows the org.nr + räkenskapsår (+ BRF name); confirm the reject button is equally prominent (not ghost/smaller).
  4. Click "Ja, stämmer — analysera"; confirm the auto-fetch pre-step progress then the existing extraction steps, ending in the SAME A–F score card as manual, now with "Räkenskapsår {year}" + "Källa: Allabrf".
  5. Staleness: if the fetched year is not the latest Allabrf has, confirm the terracotta staleness caption renders (now live end-to-end as of 08-05 gap closure — `fiscalYear`/`isMostRecent` are persisted in `brf_data` and read by `page.tsx`, no longer hardcoded null).
  6. Fall-through: a no-resolvable-org.nr or low-confidence listing lands directly on manual upload with NO error banner; an ambiguous/failed fetch shows the banner + manual upload. Never a wrong-BRF analysis.
  7. Manual regression: upload a PDF manually and confirm the A–F score card renders exactly as before, now with "Källa: Manuellt uppladdad".
  8. Check server logs for `[brf-source]` lines on any rung failure; confirm no scraped HTML/financials/PII are logged.
  - Report back "approved" once verified, or describe any issue. Full steps: `.planning/phases/08-brf-auto-fetch/08-04-SUMMARY.md`.

- **[05-05 Task 3 — BLOCKING checkpoint, still outstanding]** Verify the full owned-acquisition flow end to end on a live listing:
  1. Ensure `APIFY_API_TOKEN` is set. Start the app (`npm run dev`).
  2. Paste a real, currently-active Booli listing URL into the analyze form and submit.
  3. Confirm the analysis renders the same structured fields as v1.0 (address, price, living area, rooms, pris/kvm) — no regression.
  4. Confirm the sold-price comparison panel (PRICE-01) still populates for the same listing.
  5. Check server logs for the ACQ-03 observability line(s) (`[booli-client] fetchListing served by rung N (source, health=...)`) — confirm `own-playwright` on the happy path and any fallthrough to `paid-actor` is visibly logged, never silent.
  6. (Optional) Confirm a forced rung-1 failure surfaces a `[booli-client] rung 1 ... failed` log and still completes via a later rung.
  - Report back "approved" once verified, or describe any regression.

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 05 P01 | 12min | 2 tasks | 2 files |
| Phase 05 P03 | 3min | 2 tasks | 4 files |
| Phase 05 P04 | 35min | 2 tasks | 3 files |
| Phase 06 P01 | 25min | 2 tasks | 5 files |
| Phase 06 P02 | 20min | 3 tasks | 9 files |
| Phase 06 P03 | 26min | 2 tasks | 7 files |
| Phase 07 P01 | 25min | 3 tasks | 8 files |
| Phase 07 P02 | 20min | 3 tasks | 13 files |
| Phase 07 P03 | 18min | 2 tasks | 3 files |
| Phase 08 P01 | 10min | 3 tasks | 9 files |
| Phase 08 P02 | 14min | 3 tasks | 6 files |
| Phase 08 P03 | 18min | 2 tasks | 2 files |
| Phase 08-brf-auto-fetch P04 | 52min | 3 tasks | 10 files |
| Phase 08 P05 | 35min | 3 tasks | 6 files |
| Phase 09 P01 | 25min | 3 tasks | 7 files |
| Phase 09 P02 | 20min | 1 tasks | 4 files |
| Phase 09 P03 | 35min | 3 tasks | 9 files |
| Phase 09 P04 | 45min | 3 tasks | 13 files |
| Phase 10 P01 | 12min | 3 tasks | 6 files |
| Phase 10 P02 | 18min | 3 tasks | 8 files |
| Phase 11 P01 | 34min | 3 tasks | 14 files |
| Phase 11 P02 | 47min | 3 tasks | 13 files |
| Phase 11 P03 | 24min | 2 tasks | 4 files |
| Phase 12 P01 | 14min | 2 tasks | 3 files |
| Phase 12 P02 | 25min | 3 tasks | 8 files |
| Phase 12 P03 | 55min | 2 tasks | 9 files |
| Phase 12 P04 | 6min | 3 tasks | 6 files |
| Phase 13 P01 | 25min | 2 tasks | 5 files |
| Phase 13 P02 | 20min | 2 tasks | 2 files |
| Phase 13 P04 | 26min | 3 tasks | 6 files |
| Phase 13 P05 | 8min | 2 tasks | 4 files |
| Phase 14 P01 | 45min | 3 tasks | 12 files |
| Phase 14 P02 | 40min | 3 tasks | 2 files |
| Phase Phase 14 P03 P03 | 20min | 3 tasks | 5 files |
| Phase 14 P04 | 20min | 3 tasks | 4 files |
| Phase 14 P05 | 17min | 3 tasks | 6 files |
| Phase 14-holistic-analysis-brain P06 | 25min | 3 tasks | 2 files |
| Phase 14 P07 | 22min | 3 tasks | 7 files |
| Phase 14 P08 | 8min | 2 tasks | 1 files |
| Phase 14-holistic-analysis-brain P09 | 3min | 2 tasks | 2 files |
| Phase 14 P10 | 20min | 3 tasks | 3 files |
