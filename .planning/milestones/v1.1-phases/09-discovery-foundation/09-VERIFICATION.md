---
phase: 09-discovery-foundation
verified: 2026-07-07T09:49:05Z
status: human_needed
score: 15/15 must-haves verified (code-level); 4 items routed to human verification (operator-deferred by design)
overrides_applied: 0
human_verification:
  - test: "Live discovery end-to-end smoke test with DISCOVERY_ENABLED=true (running app + live Booli + Apify spend)"
    expected: "Full flow works: dashboard entry appears, free-text + filters start a job, /discover/[jobId] shows poll+tick progress, a broad query stops at the cap with the honesty banner, cost_sek_total never exceeds cap_sek, persisted results contain only allowlisted fields, a simulated kill-switch degrades the job with the escape-hatch banner, and another user's jobId 404s."
    why_human: "Requires a running app instance, live ANTHROPIC_API_KEY/APIFY_API_TOKEN spend, and the feature flag actually flipped on — cannot be exercised by static analysis or the mocked test suite. This is 09-04 Task 4, explicitly deferred by the executor per operator pre-approval (see 09-04-SUMMARY.md 'Operator Next Steps')."
  - test: "Live claim_discovery_slice RPC concurrency test (job.integration.test.ts) against a local Supabase"
    expected: "Two concurrent claim_discovery_slice(jobId) calls on the same pending job: exactly one returns a row. A fresh claimed_at row is NOT reclaimable; a stale (>5min) claimed_at row IS reclaimable."
    why_human: "Requires `supabase start` (Docker) + RUN_DB_INTEGRATION=1 + SUPABASE_SERVICE_ROLE_KEY. Docker/local Supabase is not running in this environment (confirmed: `supabase status` fails with 'Cannot connect to the Docker daemon'). The test correctly self-skips in the default suite (verified: full `npx vitest run` shows 2 skipped, 0 failures) — the live assertion itself has never been executed against a real Postgres instance."
  - test: "Live Booli area-search-box probe confirmation (resolveArea's probe path, Task 2 of 09-02-PLAN.md)"
    expected: "resolveArea('Södermalm') returns { areaId: '115341', source: 'probe' } via the live Playwright search-box interaction, confirming the #area-search-field selector and suggestion-list flow against the real DOM; a second area (e.g. 'Nacka') generalizes."
    why_human: "Requires a live Apify Playwright render against booli.se (operator-approved spend) — explicitly deferred per 09-02-PLAN.md's checkpoint pre-approval. Until run, v1 discovery ships SEED-PRIMARY (Stockholm-region only: Södermalm, Stockholm kommun, Nacka — 3 entries), which is documented, intentional, and does not block the phase (resolveArea's contract works correctly either way, per its own design)."
  - test: "Operator acknowledgement of the ~24h orphan-recovery latency tradeoff + final legal go/no-go sign-off"
    expected: "Operator explicitly accepts that a job whose tab closes mid-run resumes only on the next once-daily Vercel Cron sweep (Hobby-tier limit), OR upgrades to Vercel Pro before production enablement; separately, operator completes the final legal go/no-go (re-reading Booli/Hemnet ToS, re-deriving proportionality) before setting DISCOVERY_ENABLED=true in production."
    why_human: "This is an explicit business/legal decision requiring human judgment, not a code-verifiable behavior. PROJECT.md already documents the provisional conservative-GO (2026-07-06) with final sign-off as a named separate operator gate; STATE.md Blockers tracks it as outstanding. DISCOVERY_ENABLED is confirmed OFF/unset in every environment (no .env file sets it), so the flag is correctly fail-closed pending this decision."
---

# Phase 9: Discovery Foundation Verification Report

**Phase Goal:** Let a user describe desired properties in free text (+ a few hard filters) and get back matching candidate listings, produced by a bounded, cost-capped background job with progress polling — behind a documented legal go/no-go gate and PII guardrails.
**Verified:** 2026-07-07T09:49:05Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `discovery_jobs` table + `claim_discovery_slice` atomic RPC exist live in the DB with owner-only RLS | VERIFIED | `supabase migration list --linked` shows 010 applied remotely; `information_schema.tables`/`routines` queries via `supabase db query --linked` each return exactly one row for `discovery_jobs` / `claim_discovery_slice`. Migration SQL contains `for update skip locked`, `security definer`, `grant execute ... to authenticated`, `revoke all ... from public`, and three owner-only RLS policies (`auth.uid() = user_id`) for select/insert/update. |
| 2 | `claim_discovery_slice` is a real atomic claim (FOR UPDATE SKIP LOCKED), not a PostgREST conditional UPDATE | VERIFIED | Migration SQL: CTE `claimable` with `for update skip locked`, then `update ... from claimable ... returning discovery_jobs.*`. `tick-discovery.ts` and the sweep route both call `.rpc("claim_discovery_slice", ...)`, never a hand-rolled check-then-act `.update().eq()`. |
| 3 | The structured filter schema (`intentFilterSchema`) is slim Zod (no `.min()/.max()/.int()` chains, only numeric fields nullable) + hard cap constants exist | VERIFIED | `src/lib/discovery/filter-schema.ts` — `intentFilterSchema` has no constraint chains; `priceMax/roomsMin/sizeMin` are the only `.nullable()` fields; `CAP_CANDIDATES_MAX=25` (in locked [20,30] band), `CAP_SEK_MAX=5`, `CAP_IMAGES_PER_LISTING=0` (documented Phase-9 no-op). Tests green. |
| 4 | `discoveryCostSek` composes Haiku parse cost + per-render scrape cost in SEK | VERIFIED | `src/lib/discovery/cost.ts` — `discoveryCostSek` = `costSek(haikuUsage) + renders * USD_PER_RENDER * USD_SEK_RATE`. Tests assert decomposition + zero-usage case. |
| 5 | The persisted candidate shape is a PII-safe explicit allowlist, never a raw passthrough | VERIFIED | `src/lib/discovery/candidate.ts` — `toCandidate` constructs a fresh object literal (no `...raw` spread anywhere in the file, grep-confirmed); `candidate.test.ts` asserts `Object.keys(result).sort()` equals the exact allowlist even when raw carries extra PII-bearing fields. |
| 6 | The deterministic in-code filter narrows listings against the structured filter (never Claude-driven) | VERIFIED | `filterCandidates` in `candidate.ts` — pure AND of non-null clauses, cap truncation + true `scanned` count returned. Called from `runSlice` AFTER the Haiku parse — the LLM never drives the actual filtering. |
| 7 | A free-text area name resolves to a Booli areaId via probe OR seed fallback; never hard-blocks | VERIFIED | `resolve-area.ts`: `resolveArea` tries `probeResolve` (uses `isBooliUrl` + `runPlaywrightRender`), falls back to `seedResolve` (`area-seed.ts`, 3-entry Stockholm-region set, exact-match only, no `.includes()`), returns `null` only if both miss — never fabricates. Mocked-transport tests (8/8) prove all three branches. `area-seed.ts` header explicitly documents this as a v1 scope-reduction, not a comprehensive `AREA_ID_MAP` (grep confirms no such constant exists). |
| 8 | Free text translates to a structured filter via one Haiku call, sent as user-message content only (never system-prompt) | VERIFIED | `parse-intent.ts` — `client.beta.messages.parse({ system: INTENT_PARSE_SYSTEM_PROMPT (steering only, no user text), messages:[{role:"user",content:freeText}], output_config:{format:zodOutputFormat(intentFilterSchema)} })`. `parse-intent.test.ts` asserts an injection payload stays in the user-message slot. |
| 9 | A low-confidence parse surfaces the filter for user confirmation rather than silently creating a job | VERIFIED | `parseIntent` returns `{ok:false, needsConfirmation:true, filter, confidence}` when `confidence < 0.6`; `startDiscovery` propagates this without inserting a row; `discovery-input.tsx` renders the "Stämmer detta?" inline confirm UI. Tests cover both layers. |
| 10 | `startDiscovery` checks `DISCOVERY_ENABLED` as the literal first line (before auth), fails closed | VERIFIED | `start-discovery.ts` line 46: `if (process.env.DISCOVERY_ENABLED !== "true") return {...}` is the first executable statement, before FormData parsing, auth, cap-check, or parse. Test asserts Anthropic/Supabase mocks are never invoked when the flag is off/unset/any-other-value. Confirmed: no `.env*` file sets `DISCOVERY_ENABLED` anywhere in the repo — OFF by default in every environment today. |
| 11 | `tickDiscovery` uses the atomic RPC (not check-then-act), with ownership pre-check and fail-closed error handling | VERIFIED | `tick-discovery.ts` — auth → ownership pre-check (`row.user_id !== user.id` → return) → `.rpc("claim_discovery_slice",{p_job_id}).maybeSingle()` → error logs+returns (fail closed) → empty claim is benign no-op → `runSlice(supabase, claimed)`. Tests cover no-op, error, happy path, auth gate, IDOR guard. |
| 12 | `runSlice` enforces incremental per-slice caps (candidate + SEK) BEFORE scraping, has a working kill switch, and persists only PII-safe candidates reading counters from the claimed row (never a fresh SELECT) | VERIFIED | `job.ts` — gate 1 (candidate_count/cost_sek_total from `claimedRow`) → area resolve → cost pre-check → try/catch around `fetchAreaListings` (catch → `status='degraded'`, halt, no retry) → `toCandidate`/`filterCandidates` → single UPDATE computed entirely from `claimedRow`'s fields. No `.select()` re-read of the same job appears anywhere in the file (grep-confirmed). Tests cover all six branches explicitly. |
| 13 | The `/discover` routes are flag-gated (notFound when off) and ownership-gated (IDOR → notFound); dashboard entry absent when off | VERIFIED | `discover/page.tsx` and `discover/[jobId]/page.tsx` both check `DISCOVERY_ENABLED !== "true"` as literal first line → `notFound()`. `[jobId]` additionally checks `job.user_id !== user.id` → `notFound()` (same code path as missing, no leak). `dashboard/page.tsx`'s `DiscoveryEntryPoint()` returns `null` (not disabled) when off — verified by reading the source; existing "Ny analys" markup untouched. `npm run build` succeeds and lists `/discover`, `/discover/[jobId]` as dynamic routes. |
| 14 | The progress UI polls-and-ticks, shows the honest counter + cap-reached + kill-switch banners with locked copy | VERIFIED | `discovery-progress.tsx` — `poll()` calls `tickDiscovery(jobId)` BEFORE the `select()` read; renders "{n} av {total} annonser analyserade", terracotta cap banner "Vi stannade vid {cap} annonser (sökgräns)." composing with running/done, calm terracotta degraded banner + link to `/dashboard`. 5/5 component tests green, asserting exact locked copy strings and tick-before-read ordering. |
| 15 | A once-daily Vercel Cron sweep resumes orphaned jobs via the same claim RPC's stale branch | VERIFIED | `vercel.json` declares `{"path":"/api/discovery/sweep","schedule":"0 3 * * *"}` (Hobby-valid). `sweep/route.ts` — `export const maxDuration=300`, queries stuck `processing` jobs via NULL-safe `.or("claimed_at.is.null,claimed_at.lt.<iso>")` (never `.eq(col,null)`), reclaims each via `claim_discovery_slice`'s stale branch (never hand-rolled), bounded to 10/invocation, runs `runSlice` per reclaimed job. |

**Score:** 15/15 code-level truths verified. 4 additional items (see Human Verification below) are explicitly out-of-scope for automated verification by design — they require a running app + live third-party spend + an explicit operator/legal decision, and are correctly deferred per the phase's own plans and PROJECT.md's documented provisional-GO posture.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/010_discovery_jobs.sql` | `discovery_jobs` table + RLS + `claim_discovery_slice` RPC, pushed live | VERIFIED | File matches plan verbatim; confirmed pushed live via `supabase migration list --linked` (010 shown in both Local and Remote columns) and `information_schema` queries against the live linked project. |
| `src/lib/discovery/filter-schema.ts` | `intentFilterSchema` + `DiscoveryFilter` + cap constants | VERIFIED | Exports match exactly; no constraint chains; tests green. |
| `src/lib/discovery/cost.ts` | `discoveryCostSek` + `DISCOVERY_COST_CAP_SEK` | VERIFIED | Composes `costSek` + render term; tests green. |
| `src/lib/discovery/candidate.ts` | `DiscoveryCandidate` + `toCandidate` + `filterCandidates` (+ additive `discoveryCandidateSchema`) | VERIFIED | No-spread allowlist construction confirmed by reading source; exact-key test present and green. |
| `src/lib/discovery/resolve-area.ts` + `area-seed.ts` + `src/lib/booli/area-search-page-function.ts` | `resolveArea(name)` probe-then-seed + seed list + page function | VERIFIED | All present; `isBooliUrl` + `runPlaywrightRender` reused (no new ApifyClient); seed list explicitly documented as v1 scope reduction (3 entries: Södermalm, Stockholm, Nacka). |
| `src/lib/discovery/parse-intent.ts` | `parseIntent` (Haiku, user-message-only, low-confidence fail-safe) | VERIFIED | Matches `extract.ts` pattern exactly; tests green. |
| `src/lib/discovery/job.ts` | `runSlice` orchestration | VERIFIED | Matches spec order (cap gate → resolve → cost pre-check → kill switch → persist); tests green. |
| `src/actions/start-discovery.ts` | `startDiscovery` (flag-first, auth, per-day cap, parse, insert) | VERIFIED | Flag check is literal first line; per-day cap uses safe `.gte()`; tests green. |
| `src/actions/tick-discovery.ts` | `tickDiscovery` (atomic claim + one slice) | VERIFIED | Ownership pre-check + real RPC call; `maxDuration` constant relocated to `tick-config.ts` (documented Next.js Server Actions bundler constraint, verified against `npm run build`). |
| `src/components/discovery-progress.tsx` | Poll+tick loop, counter, badges, banners | VERIFIED | Matches UI-SPEC locked copy; 5/5 tests green. |
| `src/components/discovery-candidate-card.tsx` | PII-safe card, provenance, no score | VERIFIED | Renders only allowlisted fields + "Källa: Booli"; no ranking/score markup present. |
| `src/components/discovery-input.tsx` | Free-text + filters + confirm + kill-switch slot | VERIFIED | Wired to `startDiscovery`; confirm flow present; `tsc`/build clean. |
| `src/app/(app)/discover/page.tsx` + `[jobId]/page.tsx` | Flag+ownership gated routes | VERIFIED | Both `notFound()` on flag-off; `[jobId]` also IDOR-checks; read-path Zod guard present. |
| `src/app/(app)/dashboard/page.tsx` | Discovery entry point absent when off | VERIFIED | `DiscoveryEntryPoint()` returns `null` when flag off; existing markup untouched. |
| `src/app/api/discovery/sweep/route.ts` + `vercel.json` | Once-daily cron orphan sweep | VERIFIED | NULL-safe query, atomic RPC reuse, bounded per invocation, `maxDuration=300`; `vercel.json` declares the exact cron. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `candidate.ts` | `booli/client.ts` reshapeListingEntity output | `toCandidate` field mapping | WIRED | Field names (`streetAddress`, `price`, `rooms`, `livingArea`, `descriptiveAreaName`, `url`) match `reshapeListingEntity`'s flat shape. |
| Migration 010 | `authenticated` Postgres role | `grant execute on function claim_discovery_slice` | WIRED | Grep-confirmed present alongside `revoke all ... from public`. |
| `resolve-area.ts` | `booli/transport.ts` runPlaywrightRender | probe render | WIRED | Imported and called directly; no new ApifyClient instantiation. |
| `resolve-area.ts` | `area-seed.ts` | `seedResolve` fallback | WIRED | Called on probe miss/throw. |
| `tick-discovery.ts` | `claim_discovery_slice` RPC | `.rpc(...).maybeSingle()` | WIRED | Confirmed in source; test asserts the call. |
| `job.ts` | `booli/client.ts` fetchAreaListings | one bounded call per slice | WIRED | Called inside try/catch (kill-switch boundary). |
| `start-discovery.ts` | `process.env.DISCOVERY_ENABLED` | first-line gate | WIRED | Confirmed literal first line; test asserts short-circuit. |
| `discovery-progress.tsx` | `tick-discovery.ts` tickDiscovery | poll-and-tick | WIRED | `await tickDiscovery(jobId)` precedes the `select()` read inside `poll()`; test asserts call. |
| `discover/[jobId]/page.tsx` | `discovery_jobs` ownership + flag | `notFound()` | WIRED | Both checks present and grep/read-confirmed. |
| `api/discovery/sweep/route.ts` | `claim_discovery_slice` RPC (stale branch) | reclaim stale jobs | WIRED | Confirmed; NULL-safe `.or()` filter used, not `.eq(col,null)`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `discovery-progress.tsx` | `status`/`processedCount`/`capCandidates`/`capReached` | live `discovery_jobs` row via `supabase.from("discovery_jobs").select(...).eq("id",jobId).single()`, refreshed by the real `tickDiscovery` RPC-backed action | Yes (schema/DB confirmed live; no mock/static fallback in production code path) | FLOWING |
| `discover/[jobId]/page.tsx` | `candidates` | `job.results` (persisted JSONB from `runSlice`'s real `fetchAreaListings` scrape), Zod-guarded | Yes | FLOWING |
| `discovery-candidate-card.tsx` | `candidate` prop | passed from the results route's real, DB-sourced `candidates` array — no hardcoded/empty prop found at any call site (grep for `candidate={[]}`/`={{}}` at call sites: none) | Yes | FLOWING |
| `dashboard/page.tsx` `DiscoveryEntryPoint` | flag-driven conditional render | `process.env.DISCOVERY_ENABLED` (server env, not a stub) | Yes (correctly renders `null` today since the flag is unset — intended behavior, not a defect) | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Migration 010 pushed live | `supabase migration list --linked` | Local 010 = Remote 010 | PASS |
| `discovery_jobs` table exists live | `supabase db query --linked "select table_name from information_schema.tables where table_name='discovery_jobs'"` | 1 row returned | PASS |
| `claim_discovery_slice` RPC exists live | `supabase db query --linked "select routine_name from information_schema.routines where routine_name='claim_discovery_slice'"` | 1 row returned | PASS |
| Discovery unit/component test suite | `npx vitest run src/lib/discovery/ src/actions/start-discovery.test.ts src/actions/tick-discovery.test.ts src/components/discovery-progress.test.tsx` | 9 files passed, 1 skipped (job.integration.test.ts self-skip), 55 tests passed | PASS |
| Full repo test suite (regression check) | `npx vitest run` | 47 passed / 2 skipped files, 466 passed / 2 skipped tests, 0 failures | PASS |
| Type-check | `npx tsc --noEmit` | clean, no output | PASS |
| Production build | `npm run build` | Compiled successfully; `/discover`, `/discover/[jobId]`, `/api/discovery/sweep` all listed as routes | PASS |
| Lint on discovery files | `npx eslint src/lib/discovery/ src/actions/{start,tick}-discovery.ts src/components/discovery-*.tsx src/app/api/discovery/sweep/route.ts` | exit 0, no output | PASS |
| `DISCOVERY_ENABLED` not leaked as `NEXT_PUBLIC_` | `grep -rn "NEXT_PUBLIC.*DISCOVERY" src/` | no matches | PASS |
| `DISCOVERY_ENABLED` unset in every env file | `grep -rn "DISCOVERY_ENABLED" .env*` | no matches (flag correctly OFF by default everywhere) | PASS |
| No debt markers (TBD/FIXME/XXX) in phase-9 diff | grep across all files changed since `ee95209` | no matches | PASS |
| Live claim_discovery_slice concurrency test | `supabase status` / `docker info` | Docker daemon not running — test cannot be executed in this environment; correctly self-skips in default suite | SKIP (routed to human_verification) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention exists for this phase; the only "probe" language used is the human-language "live area-resolution probe" (an Apify/Playwright spike against Booli, not a `probe-*.sh` script) and is handled under Human Verification below, per the explicit phase framing given in the verification task.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DISC-01 | 09-01, 09-02, 09-03, 09-04 | Free text → area search → candidate listings | SATISFIED | `intentFilterSchema` + `filterCandidates` (09-01), `resolveArea` (09-02), `parseIntent`/`startDiscovery` (09-03), `DiscoveryInput`/results UI (09-04) all present and wired end-to-end. |
| DISC-02 | 09-01, 09-03, 09-04 | Bounded background job, hard caps, progress polling, persisted/viewable results | SATISFIED | `discovery_jobs` + `claim_discovery_slice` (09-01), incremental cap enforcement in `runSlice` + per-day cap in `startDiscovery` (09-03), poll+tick UI + cron safety net (09-04). Live RPC concurrency proof exists as code (`job.integration.test.ts`) but has never been executed against a real Postgres instance in this environment — routed to human verification, not blocking. |
| DISC-07 | 09-01, 09-03, 09-04 | Legal go/no-go gate: caps, rate-limiting, kill switch, PII/GDPR guardrails | SATISFIED (code-level); legal sign-off itself is an explicit separate operator gate, correctly out of phase scope | PII-safe allowlist + owner-only RLS (09-01), flag-first fail-closed gate + per-day cap + kill switch (09-03), flag/ownership defense-in-depth at the UI/route layer + cron safety net (09-04). `DISCOVERY_ENABLED` confirmed unset everywhere. PROJECT.md documents the provisional conservative-GO with final sign-off named as a distinct, still-outstanding operator action — this matches the phase's own design, not a gap. |

**Note on REQUIREMENTS.md staleness:** The requirement bullet descriptions for DISC-01/02/07 are marked `[x]` and accurately describe 09-01 through 09-04 work. However, the Traceability table at the bottom of REQUIREMENTS.md still reads "In Progress (09-01/09-02/09-03 of 4 landed)" for all three IDs — this was not updated after Plan 04 landed. This is a documentation-sync gap only, not a code gap; flagged for the next requirements-doc pass but does not affect this verification's outcome.

### Anti-Patterns Found

None. Scanned every file changed since `ee95209` (start of phase 9 work) for TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/"coming soon"/"not yet implemented" — zero matches in non-test discovery-phase files. No `...raw` spreads in `candidate.ts`. No `.eq(col, null)` NULL-filter traps (the sweep route explicitly uses `.or(...)` per the project's own documented memory). No hardcoded empty-array/object stub returns in any discovery route or component — all data flows from live DB reads or real scrape calls.

### Human Verification Required

#### 1. Live discovery end-to-end smoke test (flag ON, operator-only)

**Test:** With `DISCOVERY_ENABLED=true`, `ANTHROPIC_API_KEY`, and `APIFY_API_TOKEN` set, run the app (`npm run dev`) and walk the full flow: dashboard entry point → free-text + filter input → `/discover/[jobId]` → poll+tick progress to completion → inspect a persisted `results` row → trigger a broad/popular-area query to confirm the cap-reached honesty banner and that `cost_sek_total` never exceeds `cap_sek` → simulate a Booli block to confirm kill-switch degrade → attempt IDOR access to another user's job.
**Expected:** Every step behaves as documented in 09-04-SUMMARY.md's "Operator Next Steps" (11-step checklist).
**Why human:** Requires a running app instance, real third-party API spend, and the feature flag actually flipped on — none of which is safe or appropriate for an automated verifier to trigger. This was already explicitly deferred by the executor per operator pre-approval.

#### 2. Live `claim_discovery_slice` RPC concurrency test

**Test:** With `supabase start` (Docker) running, set `RUN_DB_INTEGRATION=1` + `SUPABASE_SERVICE_ROLE_KEY` and run `npx vitest run src/lib/discovery/job.integration.test.ts`.
**Expected:** Exactly one of two concurrent `claim_discovery_slice` calls on the same pending job succeeds; a fresh lock is not reclaimable; a stale lock is reclaimable.
**Why human:** Docker/local Supabase is not available in this verification environment (confirmed via `supabase status` / `docker info` failures). The test is well-written and self-skips correctly today, but its live assertion has never actually run against a real Postgres instance.

#### 3. Live Booli area-search-box probe confirmation

**Test:** Run a throwaway live invocation of `resolveArea("Södermalm")` against the real Booli DOM (small Apify spend) to confirm the `#area-search-field` selector and suggestion-list interaction flow, and try a second area to confirm generalization.
**Expected:** Returns `{ areaId: "115341", source: "probe" }` for Södermalm, matching the seed list's known id.
**Why human:** Requires live Apify/Playwright spend against a third-party site; explicitly deferred per the plan's own checkpoint (09-02-PLAN.md Task 2), which is designed to never hard-block the phase regardless of outcome. Until run, v1 ships seed-primary and Stockholm-region-limited — a documented, intentional scope reduction, not a defect.

#### 4. Orphan-recovery latency acknowledgement + final legal go/no-go sign-off

**Test:** Operator explicitly acknowledges the ~24h worst-case orphan-recovery latency (Hobby-tier once-daily cron) is acceptable for v1, or decides to upgrade to Vercel Pro; separately, operator completes the final legal go/no-go review (re-reading Booli/Hemnet ToS, re-deriving proportionality) before setting `DISCOVERY_ENABLED=true` in production.
**Expected:** A recorded operator decision in STATE.md/PROJECT.md.
**Why human:** This is a business/legal judgment call, not a code-verifiable fact. PROJECT.md already documents the provisional conservative-GO (2026-07-06 operator decision) with the final sign-off named as a separate, still-outstanding gate — this phase correctly implements the code-side guardrails (flag OFF by default, caps, kill switch, PII allowlist) and defers the human decision exactly where the roadmap intended.

### Gaps Summary

No code-level gaps found. All 15 derived observable truths (covering the ROADMAP goal and DISC-01/02/07 requirements) are verified against the live database, the actual source files, the full test suite (466 passing, 0 failing), a clean `tsc --noEmit`, and a successful `npm run build`. The four items requiring human verification are not implementation gaps — they are explicit, by-design operator-deferred actions (live third-party spend, local Docker dependency unavailable in this environment, and a legal/business sign-off) that the phase's own plans and PROJECT.md correctly scope as separate from the code deliverable. The only non-blocking issue found is a stale status line in REQUIREMENTS.md's Traceability table (still reads "09-01/09-02/09-03 of 4 landed" after Plan 04 shipped) — a documentation-sync nit, not a functional gap.

---

*Verified: 2026-07-07T09:49:05Z*
*Verifier: Claude (gsd-verifier)*
