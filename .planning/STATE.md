---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Renovator-Grade Discovery Analysis
status: planning
last_updated: "2026-07-17T13:30:15.674Z"
last_activity: 2026-07-17
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-06)

**Core value:** Give Swedish home buyers an independent, data-driven analysis of any listing -- the one thing their maklare won't provide.
**Current focus:** v1.1 shipped (code-complete) & archived. Legal go/no-go = GO (operator 2026-07-08); `DISCOVERY_ENABLED` now ON (feature flag retained). Remaining: the live validation gates (Phase 11 accuracy gate + Phase 12 floor-plan kill-criterion); then `/gsd-new-milestone`.

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-07-17 — Milestone v1.2 started

## Roadmap Summary (v1.1)

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

*Updated after each plan completion during v1.1.*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap v1.1]: 8-phase structure (5–12) derived from 16 v1.1 requirements, sequenced by dependency + risk. Numbering continues from v1.0's Phase 4 (no reset).
- [Roadmap v1.1]: 999.7 (AI discovery + vision) split into FOUR independently-shippable/killable sub-phases (9 Foundation, 10 Ranking, 11 Gallery Vision, 12 Floor-Plan/Sun-Path) — mitigates solo-dev scope overrun (Pitfall 8); each has its own kill criterion.
- [Roadmap v1.1]: Phase 5 (999.6) is the foundational gate — everything depends on it. BLOCKING spike on single-listing-by-URL retrieval before build; generalize the PROVEN sold-source.ts Playwright/__APOLLO_STATE__ transport, NOT a new keyless GraphQL client.
- [Roadmap v1.1]: Phase 8 (BRF auto-fetch) sequenced AFTER Phase 6 despite the "more independent" framing — it soft-depends on brfName/org.nr that Phase 6 recovers.
- [Roadmap v1.1]: Phase 7 (macro) is technically independent (separate free APIs, third independent branch in enrichMarketContext) — could parallelize; kept in user order.
- [Roadmap v1.1]: Phase 9 carries a NAMED legal go/no-go gate BEFORE implementation — area-wide proactive scraping shifts the legal posture v1.0's user-initiated model relied on (Pitfall 1). No-go cancels Phases 10–12.
- [Roadmap v1.1]: Design constraints baked into criteria — deterministic-in-code / LLM+vision synthesis only; vision output structurally separate from deterministic flags + image-cited + hedged; floor-plan = investigation-prompt (never wall-removal verdict); sun-path = theoretical/unobstructed; macro strictly descriptive; hard per-search cost/candidate/image caps; additive-nullable migrations only; reuse generateReport atomic-lock + BrfProgress polling.

**Carried-forward v1.0 decisions still load-bearing for v1.1:**

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
- [Phase 10-02]: Area baseline computed as a PURE client-side median price/sqm over the candidate set itself, NOT via server-side compare.ts/fetchSoldComps reuse as RESEARCH.md originally planned -- discovery jobs persist no lat/lng or breadcrumbs, only filters + the PII-safe results allowlist, so compare.ts's SoldSourceQuery cannot be constructed from a stored job (RESEARCH Assumption A4 did not hold)
- [Phase 10-02]: Radix Select's jsdom gaps (scrollIntoView, pointer-capture methods) polyfilled locally inside discovery-results.test.tsx (first Select-driven RTL test in the repo), not added to the shared vitest.setup.ts
- [Phase ?]: The live Apollo images( ref probe (scripts/probe-booli-images.ts) is written but deliberately not run this plan; extractImageUrls implements RESEARCH's assumed shape with a graceful never-throwing fallback
- [Phase ?]: CAP_IMAGES_PER_LISTING activated from Phase 9's 0-placeholder to 4 (1 floor plan + up to 3 gallery); CAP_VISION_SEK_MAX=10 kept strictly separate from CAP_SEK_MAX=5
- [Phase ?]: vision-schema.ts's Claude-facing schemas use extract.ts's single-nullable-leaf discipline (3 nullable leaves, zero numeric constraints), statically asserted by a Zod-def-tree-walking test, to avoid the anthropic-structured-output-limits 400 trap
- [Phase 11]: [Phase 11-02]: runVisionForJob added as a separate export in job.ts (not a runSlice modification) -- called from tickDiscovery/sweep route only once a slice leaves the job "done", keeping runSlice's own incremental-cap/kill-switch/persist behavior and tests completely unchanged
- [Phase 11]: [Phase 11-02]: Vision SEK spend (CAP_VISION_SEK_MAX) is tracked entirely separately from cost_sek_total (the scrape cap) -- a job hitting its scrape cap still gets vision, a job hitting its vision cap only stops vision, never the whole job
- [Phase 11-03]: GalleryConditionVision uses border-warm-gray-200/bg-warm-white + a terracotta Eye-icon badge (never severityChip/sage/destructive) so a buyer can tell image-interpreted claims from ReportFlags' verified chips at a glance; wired into discovery-results.tsx spatially separate (space-y-6) and AFTER the ranking grid, never feeding computeNicheScore
- [Phase 11-03]: Structural-separation invariant (niche-score.ts/flags.ts must never import a vision module) implemented as a static source-grep test (mirrors job.integration.test.ts's invariant-as-a-test precedent) rather than a dependency-graph tool -- verified to fail on a manually-injected violation, then reverted
- [Phase 12-01]: suncalc v2.0.0's azimuth convention confirmed live (degrees, north-zero, clockwise; solar noon via getTimes().solarNoon -> getPosition ~180 at Stockholm lat/lon) -- matches the v2.0.0 README, not the stale v1.x radians/south-zero convention; confirmed both at install time and by a committed mandatory smoke test that must pass before any facade-bucketing test is trusted
- [Phase 12-01]: computeSunExposure's grid cells are qualitative Swedish descriptors only (never a numeric hour count) per UI-SPEC's no-false-precision rule; 3 season buckets sampled at winter solstice/an equinox/summer solstice (spring and autumn share one symmetric sun path at a given latitude)
- [Phase 12-01]: suncalc package-legitimacy checkpoint auto-approved per plan pre-approval (225k weekly downloads, maintainer mourner, zero deps, ships own types, no postinstall, slopcheck OK) -- not stopped on, mirrors the Phase 06 cheerio precedent
- [Phase 12]: remodelPotential disclaimer suffix and kill-criterion CUT documented in 12-02 — Kept the phase kill-criterion posture (one-tuple-entry removal) explicit and testable
- [Phase ?]: floor unwrap uses num(raw.floor) ?? rawOf(raw.floor), not num(raw.floor) alone -- toCandidate receives reshapeListingEntity's un-normalized {raw:N} FormattedValue directly on the fetchAreaListings/job.ts path
- [Phase ?]: raw description is read as a direct expression argument to extractOrientationFromDescription inside toCandidate's returned object literal (never a local variable), keeping the PII-safe derived-only contract structurally enforced
- [Phase ?]: [Phase 12-04]: SunPathExposure computes computeSunExposure in-component (not upstream) since the 4 raw inputs are already threaded through discovery-results.tsx
- [Phase ?]: [Phase 12-04]: Sun-path grid renders only KNOWN facades (season columns, one row per known facade) -- never fabricates missing facades as ej-tillganglig rows, per UI-SPEC binding constraint

### Pending Todos

- Customize Supabase auth email templates (currently "powered by Supabase" boilerplate).
- Build labeled BRF extraction eval dataset (4–6 årsredovisningar + labels.json) and run brf-extract/v2 regression eval — harness ready at evals/extractor.eval.ts (deferred from Phase 4).
- README.md has uncommitted create-next-app boilerplate — decide keep/revert.
- Design polish pass (overall UX approved, deeper design work wanted).
- Run `/gsd-secure-phase 4` "Verify all" before production (v1.0 security closed via operator acceptance).

### Blockers/Concerns

- **[Phase 5 spike, BLOCKING]** Single-listing-by-URL retrieval path unresolved — detail GraphQL query vs SSR/Apollo-state HTML scrape vs filtered searchForSale+match. Test SSR-state scrape first (reuses proven infra). Sets cost/latency for the whole milestone.
- **[Phase 9 spike, BLOCKING]** Vercel Cron limits on current hosting tier + free-text→filter reliability + FOR UPDATE SKIP LOCKED prototype + area-scrape cost smoke test.
- ~~**[Phase 9 legal gate]** Area-wide proactive scraping = different legal fact-pattern than v1.0.~~ **RESOLVED — GO (operator, 2026-07-08).** PROJECT.md "Legal" line rewritten to FINAL GO; `DISCOVERY_ENABLED` set ON in the operator env; per-query/per-day caps remain enforced in code and the feature flag is retained as the runtime kill switch. (Live validation gates below still stand as separate checks.)
- **[Phase 8 spike]** Bolagsverket access model + iXBRL format + Allabrf reliability + org-nummer resolution.
- **[Phase 6 spike]** Broker-CMS coverage — fraction of agencyListingUrl that is Vitec vs custom.
- **[Cost]** 999.7 vision scales multiplicatively (N listings × k images) — hard per-search caps + Haiku pre-filter + per-listing cache required before the vision loop, else <$100/mo budget breaks.
- Supabase free tier pauses after 7 days inactivity — old project was permanently frozen after 90+ days. Visit dashboard periodically or upgrade.

## Session Continuity

Last session: 2026-07-07T17:07:44.457Z
Stopped at: Completed 12-04-PLAN.md
Next step: Phase 12 (Floor-Plan & Sun-Path) is code-complete (all 4 plans shipped, green). Milestone v1.1 is now gated ENTIRELY on the accumulated operator live-validation backlog below (Phases 9-12) — no further code execution is queued until the operator runs these checks. Phase 12's own kill-criterion checkpoint (Task 4, listed first below) is the newest addition.

**Shipped 2026-07-08:** v1.1 (Phases 5–12) opened as PR #1 → main (https://github.com/dwesterholm/legendary-umbrella/pull/1), from the squashed clean branch `gsd/phase-12-floor-plan-sun-path-pr` (single commit on origin/main; code + structural planning + milestone archive; live transient `.planning` excluded). The uncommitted legal-gate GO edits (`PROJECT.md`/`STATE.md`/`.env.local.example`) and the gitignored `DISCOVERY_ENABLED=true` flip are NOT in PR #1.

**Code review (2026-07-08):** 5 sharded gsd-code-reviewer passes over the diff → 4 blockers, 28 warnings, 20 info (see `milestones/v1.1-PR1-CODE-REVIEW.md`). All 4 blockers FIXED plus 22 of 28 warnings, with regression tests, across 9 atomic `fix(pr1):` commits on the source branch, folded into the PR #1 squash. Full suite green (647 tests), tsc+eslint clean. 6 warnings deferred + documented (cost-ledger fidelity ×3, BRF CAS stale-reclaim migration, + 2 product/accepted-tradeoff items) and 20 info nits untouched — see `milestones/v1.1-PR1-CODE-REVIEW.md`. Legal go/no-go = GO + `DISCOVERY_ENABLED` ON are now committed (were uncommitted). Merge PR #1 when CI passes; then `/gsd-complete-milestone`.

## Operator Next Steps

- **[Phase 12 Task 4 — BLOCKING kill-criterion checkpoint, NEW, auto-approved-but-deferred]** Live floor-plan hedging validation + one live 4-leaf-schema API smoke + live sun-path render:
  1. Set env: Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON. Start the app (`npm run dev`).
  2. (Cheapest first) `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` on one fixture — confirm the extended 4-leaf schema does NOT 400 (project memory `anthropic-structured-output-limits`).
  3. Run one real discovery job through to completion on `/discover/[jobId]`.
  4. **KILL CRITERION:** on a candidate with a planritning, confirm the PLANLÖSNING row is safely hedged (verbs "antyder"/"kan vara värt att undersöka"/"eventuellt", always ending "kräver konstruktör / väggutredning", NEVER stating bärande/icke-bärande as fact). If floor-plan output repeats confidently-wrong load-bearing claims → CUT: remove the `["remodelPotential", parsed.remodelPotential]` tuple entry in `vision.ts` (one-line flag flip, schema/tests stay in place) and stop rendering the PLANLÖSNING row — ship sun-path alone.
  5. Confirm the sun-path sub-block renders the Compass/warm-gray grid (stated orientation) or the exact "ej tillgänglig" line (no stated orientation) — never a guessed orientation.
  6. Confirm sun-path is visually distinct (Compass/warm-gray, never Eye/terracotta) and neither floor-plan nor sun-path appears in any rank badge/niche chip.
  - Report back "approved" or a CUT decision. Full steps: `.planning/phases/12-floor-plan-sun-path/12-04-SUMMARY.md`.

- **[Phase 11 — live-render check + 20-30-listing kill-criterion validation gate, BLOCKING before Phase 12]**
  1. Set env: Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON. Start the app (`npm run dev`).
  2. (Recommended first, cheap) run `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` on ONE fixture to confirm the slim vision schema doesn't 400 before spending on a full run (per project memory `anthropic-structured-output-limits`).
  3. Run one real discovery job (free-text area search) through to completion on `/discover/[jobId]`.
  4. On a candidate that had a gallery, confirm "AI-bedömning av bilder — kan vara fel" renders hedged Swedish claims ("verkar"/"ser ut att", never "är"/verdicts), each with a "Bild {n}" citation + thumbnail, visually distinct from the ranking chips (terracotta Eye header, no severity chips).
  5. Confirm the three degraded states are distinguishable where they occur: "Inga bilder tillgängliga…" (no gallery) vs "Bildbedömning kördes inte… (sökgränsen…)" (cost cap) vs "För osäkert för att visa…" (all suppressed).
  6. Confirm NO claim references a person or personal document, and per-search vision cost stayed under `CAP_VISION_SEK_MAX`.
  7. **Kill criterion (hard gate):** run the full 20-30-listing accuracy gate per `.planning/phases/11-gallery-condition-vision/11-RESEARCH.md` — directional accuracy ≥ 70%, citation validity ≥ 90%, zero-hallucination = 100%. Below threshold → CUT gallery vision, ship discovery text-ranking-only (the UI already degrades to `vision: null` gracefully by construction, so a CUT requires no UI rework, only stopping the `runVisionForJob` call sites).
  8. Also note: the Plan 01-deferred live Apollo `images(` ref probe (`scripts/probe-booli-images.ts`) has not been run — until it is, `imageUrls` is `null` for every real candidate, so step 4 will show the `no_images` degraded state for all real listings regardless of gallery presence.
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
