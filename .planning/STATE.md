---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Renovator-Grade Discovery Analysis
status: executing
stopped_at: Completed 13-02-PLAN.md
last_updated: "2026-07-18T14:50:05.908Z"
last_activity: 2026-07-18 -- Phase 13 execution started
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 4
  completed_plans: 2
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-17)

**Core value:** Give Swedish home buyers an independent, data-driven analysis of any listing -- the one thing their maklare won't provide.
**Current focus:** Phase 13 — Discovery UX / Poll-Timeout Fix

## Current Position

Phase: 13 (Discovery UX / Poll-Timeout Fix) — EXECUTING
Plan: 3 of 3
Status: Ready to execute
Last activity: 2026-07-18 -- Phase 13 execution started
Next step: `/gsd-plan-phase 13` (Discovery UX / Poll-Timeout Fix — independent, can go first).

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

## Session Continuity

Last session: 2026-07-18T14:50:05.904Z
Stopped at: Completed 13-02-PLAN.md
Next step: `/gsd-plan-phase 13` (Discovery UX / Poll-Timeout Fix). The v1.1 operator live-validation backlog below (Phases 9–12 kill-criteria, 05/07/08 live smokes) remains outstanding but does not block v1.2 phase planning — the discovery surface is live on `main` and `DISCOVERY_ENABLED` is ON.

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
