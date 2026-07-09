# Phase 9: Discovery Foundation - Research

**Researched:** 2026-07-07
**Domain:** Background job orchestration on Vercel (cron/polling), Postgres atomic job-claim, LLM free-text→structured-filter translation, cost-capped area scraping
**Confidence:** HIGH (all 4 blocking spike items resolved with either official docs or direct codebase precedent; 2 items carry a flagged operator-verification step)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Legal Posture — Conservative GO (LOCKED, operator decision 2026-07-06)**
- Area-wide proactive scraping is provisionally sanctioned as a **conservative GO** (operator chose this over halt).
- Discovery MUST ship behind a **feature flag, OFF by default**. The flag must not be turned on until the operator completes the final legal sign-off (re-read Booli/Hemnet ToS, re-derive proportionality).
- **Strict per-query AND per-day scrape request caps enforced in code** (not just config).
- **Hard per-search caps**: candidate count (20–30), images/listing, and total SEK — checked INCREMENTALLY per slice, never only at the end.
- **Kill switch**: degrade to single-URL-only if Booli signals displeasure (CAPTCHA/blocking).
- **PII/GDPR guardrails**: ignore people and personal documents; do NOT persist raw scraped fields beyond the ranked result.
- PROJECT.md "Legal" line has been updated to reflect this provisional posture (final sign-off remains operator action).

**Architecture (from ROADMAP approach — binding)**
- **DB-row-as-job-queue**: a `discovery_jobs` table (new migration, next is 010). NO new infra.
- **Vercel Cron poller** processing small bounded slices; atomic-CAS claim extended to `FOR UPDATE SKIP LOCKED` (build it as a CORRECT atomic claim — note the Phase 8 review found a check-then-act CAS bug; do not repeat).
- A cheap Claude call translates free text → structured search filters.
- Client polls `discovery_jobs.status`/`processed_count` like `BrfProgress`; results persist, viewable at a distinct `/discover/[jobId]` route.
- Reuse Phase 5's owned area-search client (`fetchAreaListings` / area resolution) for the scrape.
- Honest reporting: "12 av 25 annonser analyserade"; report scanned-vs-shown; never exceed per-search cost cap.

> **Research note on the Vercel Cron poller decision:** this research finds the literal "Vercel Cron poller processing small bounded slices" framing runs into a hard platform limit (Hobby tier = 1 cron execution/day, too coarse for a live slice-poller — see Summary and Pattern 1 below). The recommended resolution keeps every OTHER locked element unchanged (DB-row-as-job-queue, `FOR UPDATE SKIP LOCKED` atomic claim, client polling of `discovery_jobs`, `/discover/[jobId]`) and substitutes a client-triggered "tick" Server Action as the slice driver, with Vercel Cron demoted to a once-daily orphan-recovery safety net. This is flagged as a research-driven refinement of the mechanism, not a reversal of the locked "NO new infra" / "bounded slices" / "atomic claim" decisions — the planner should treat the specific phrase "Vercel Cron poller" as satisfied by the safety-net cron + client-tick combination unless the operator objects.

### Claude's Discretion
All other implementation choices are at Claude's discretion (discuss skipped) within the above locked constraints and the ROADMAP success criteria.

### Deferred Ideas (OUT OF SCOPE)
- Niche ranking of candidates → Phase 10.
- Gallery/vision condition signals → Phase 11.
- Final legal go/no-go SIGN-OFF and flipping the feature flag ON → operator action (not this phase).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISC-01 | User describes desired properties in free text (+ a few hard filters); system translates that into an area search and returns matching candidate listings | Pattern 3 (Haiku free-text→filter, reusing `extract.ts`'s proven `zodOutputFormat` shape) + Open Question 1 (area-name→areaId resolution path) + Don't Hand-Roll table |
| DISC-02 | Discovery runs as a bounded background job with hard per-search caps (candidate count, images/listing, total SEK) and progress polling; results persist and are viewable | Pattern 1 (client-driven tick architecture, resolving the Vercel Cron blocking spike) + Pattern 2 (atomic `FOR UPDATE SKIP LOCKED` claim RPC) + Pitfall 2 (duration budget) + Pitfall 4 (cap-check-from-claimed-row discipline) + Validation Architecture test map |
| DISC-07 | Area-wide discovery respects a documented legal go/no-go gate — bounded per-search/per-day scrape caps, human-pace rate-limiting, a kill switch, and vision prompts that ignore people/personal documents in photos (GDPR/PII) | Security Domain section (threat table: cost-cap bypass, PII leakage) + Pitfall 5 (feature-flag-in-action-not-just-UI) + Anti-Patterns (never persist raw scraped payloads) + Architectural Responsibility Map (kill switch / PII guardrail rows) |
</phase_requirements>

## Summary

Phase 9 pivots the product from "analyze one pasted URL" to "describe what you want, get a bounded set of candidates" — the first background job in the codebase. The architecture is fully specified in `09-CONTEXT.md` (DB-row-as-job-queue, `discovery_jobs` table, Vercel Cron poller, atomic claim, Haiku free-text→filter translation, reuse of the owned Booli client). This research resolves the four BLOCKING spike items with concrete, actionable recommendations so planning is not gated.

**The single most consequential finding:** Vercel Cron on the Hobby tier hard-caps cron frequency at **once per day** (deployment fails otherwise) — confirmed against current Vercel docs, not training data. A daily tick cannot service a "poll every 1.5s until done" UX. The recommended architecture is **client-driven slice advancement**: the existing `discovery_jobs` row is advanced one bounded slice at a time by a Server Action the client itself invokes on a `setInterval`, mirroring `BrfProgress`'s polling loop but having each poll *also trigger the next unit of work* server-side (a "tick" action), with Vercel Cron wired in only as a **once-daily safety-net sweeper** that resumes any job stuck mid-run (e.g., user closed the tab). This works identically on Hobby and Pro and needs zero tier upgrade — the operator does not have to decide anything to unblock planning, though upgrading to Pro remains a valid future optimization noted as an open call.

The atomic job-claim is resolved with a Postgres RPC (`SECURITY DEFINER` function) wrapping a CTE `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... RETURNING` in one statement — the only way to get true row-level lock-and-claim semantics through Supabase, since PostgREST's query builder (used by `generateReport`'s check-then-conditional-UPDATE CAS) cannot express a `SKIP LOCKED` CTE. This is a materially different, more correct mechanism than the Phase 8 pseudo-CAS pattern — full SQL given below.

Free-text→filter translation reuses the exact `messages.parse` + `zodOutputFormat` + slim-schema pattern already proven in `src/lib/brf/extract.ts`, on Haiku, with a `confidence` field on the whole parse (not per-field) driving a fail-safe "low confidence → ask user to confirm/refine" path — never a silent guess. Cost math for a full 20–30 candidate slice run comes in under 1 SEK per search even under pessimistic multi-retry assumptions, comfortably inside the <$100/mo posture.

**Primary recommendation:** Build `discovery_jobs` as a state machine advanced by a client-triggered "tick" Server Action (not a Vercel Cron beat), claimed via a new `claim_discovery_slice` Postgres RPC using `FOR UPDATE SKIP LOCKED`, translate free text via one Haiku call reusing the `extract.ts` slim-schema/`zodOutputFormat` pattern, and enforce hard caps by checking cumulative `processed_count`/`cost_sek_total` INSIDE the same claimed-slice transaction boundary before each Booli render — never only at job end.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Free-text → structured filter | API/Backend (Server Action) | — | Haiku call needs `ANTHROPIC_API_KEY`, server-only, mirrors `extract.ts`/`synthesize.ts` |
| Job creation + validation | API/Backend (Server Action) | Database | Auth + ownership + initial cap validation before first row insert |
| Job slice advancement ("tick") | API/Backend (Server Action, client-invoked) | Database (atomic claim) | No infra budget for a real worker/queue; DB-row-as-job-queue per locked decision |
| Atomic slice claim | Database (Postgres RPC) | — | `FOR UPDATE SKIP LOCKED` requires a single statement/transaction — PostgREST query builder cannot express this |
| Safety-net resume sweep | API/Backend (Vercel Cron route, 1x/day) | Database | Catches jobs orphaned by a closed tab; NOT the primary driver (Hobby cron = 1/day, too coarse) |
| Area scrape (candidates) | API/Backend (owned Booli client) | External (Apify/Playwright) | Reuses `fetchAreaListings`/`resolveAreaId` — ACQ-02 foundation this phase builds on |
| Progress polling UI | Browser/Client (`/discover/[jobId]`) | API/Backend (RLS-scoped read) | Mirrors `BrfProgress`: client polls `discovery_jobs` row under user's own session |
| Cost/candidate/image caps | API/Backend (incremental, per-slice) | Database (persisted running totals) | MUST be checked before each render, not just at job end (locked decision) |
| Kill switch (CAPTCHA/blocking) | API/Backend (owned Booli client + job orchestrator) | Database (job status) | Existing `walkFallbackTree`/`runPlaywrightRender` already distinguish dead-source; orchestrator maps that signal to job degrade-and-halt |
| PII/GDPR guardrail | API/Backend (persistence layer) | — | Enforced at the point candidate data is written to `discovery_jobs`/results — never persist raw scraped fields beyond the ranked result |
| Feature flag gate | API/Backend (env-driven) | Browser (hide entry point) | OFF by default; both the action AND the UI entry point must check it (defense in depth) |

## Standard Stack

### Core (no new packages — this phase composes existing infra)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.102.0` (already installed) | Haiku free-text→filter call | Already used identically in `src/lib/brf/extract.ts` — `messages.parse` + `zodOutputFormat` |
| `zod` (`zod/v4`) | `^4.3.6` (already installed) | Filter schema + slim Claude-facing schema | Matches `claudeExtractionSchema` precedent — avoids the strict-output nullable-union/numeric-constraint 400 documented in this project's own memory |
| `@supabase/supabase-js` / `@supabase/ssr` | already installed | `discovery_jobs` reads/writes, RPC call | Existing auth + RLS + `.rpc()` client, same as every other table |
| Next.js Route Handler | Next.js 16 (already installed) | `vercel.json` cron target + `/discover/[jobId]` page | App Router convention already used for `api/auth/signout` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vercel.json` `crons` config | N/A (platform config, not a package) | Once-daily safety-net sweep route | Declared once; see Code Examples |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Client-driven tick Server Action | Vercel Cron as primary driver | Rejected: Hobby tier caps cron at 1/day — too coarse for a live-feeling progress bar; would require a confirmed Pro upgrade the user has not committed to |
| Client-driven tick Server Action | Vercel Queues / QStash / external cron ping | Viable but adds a new paid dependency ($) and a new failure surface; the DB-row-as-job-queue decision in CONTEXT.md is explicitly "NO new infra" |
| Postgres RPC for atomic claim | Extend `generateReport`'s conditional-UPDATE CAS pattern | Rejected: that pattern only prevents ONE re-entrant caller (same row); it cannot atomically pick-and-lock ONE OF MANY pending rows the way `SKIP LOCKED` does, and the Phase 8 review already flagged its check-then-act shape as fragile |
| Haiku free-text→filter | Sonnet free-text→filter | Rejected for cost: this is a low-stakes, cheap classification/extraction task (structurally identical to BRF field extraction, which already runs on Haiku); Sonnet is reserved for the higher-stakes report synthesis per existing model-tiering precedent |

**Installation:** None — zero new npm packages for this phase.

**Version verification:** No new packages to verify. `@anthropic-ai/sdk@^0.102.0` and `zod@^4.3.6` are already pinned in `package.json` [VERIFIED: package.json read directly].

## Package Legitimacy Audit

**Not applicable — this phase installs no new external packages.** All capabilities are built from already-installed dependencies (`@anthropic-ai/sdk`, `zod`, `@supabase/supabase-js`) plus a new Postgres migration/RPC (SQL, not an npm package) and a `vercel.json` platform-config addition (not a package). The Package Legitimacy Gate is therefore skipped per its own scope — nothing to audit.

## Architecture Patterns

### System Architecture Diagram

```
[User] --free text + hard filters--> [Server Action: startDiscovery]
                                            |
                                  1. Feature-flag check (OFF -> reject)
                                  2. Auth check (mirrors generateReport)
                                  3. Haiku call: free text -> structured filter
                                     (fail-safe: low confidence -> return for
                                      user confirmation, NO job created yet)
                                            |
                                  4. INSERT discovery_jobs row
                                     (status='pending', filters, caps, 0 counts)
                                            v
                                   [discovery_jobs table]
                                            ^
                                            |  polls status/processed_count
                                            |  (like BrfProgress, ~1.5s)
                     [/discover/[jobId] page + DiscoveryProgress component]
                                            |
                                  each poll ALSO calls
                                  Server Action: tickDiscovery(jobId)
                                            |
                         +------------------------------------------+
                         |     tickDiscovery (one bounded slice)     |
                         |                                            |
                         |  a. RPC claim_discovery_slice(jobId)       |
                         |     (FOR UPDATE SKIP LOCKED, atomic)       |
                         |     -> if null: another tick in flight,   |
                         |        or job already terminal -> no-op   |
                         |  b. re-check incremental caps              |
                         |     (candidate_count, cost_sek_total,      |
                         |      images fetched) BEFORE next render    |
                         |  c. if kill-switch signal (CAPTCHA/        |
                         |     blocking) from owned Booli client:     |
                         |     degrade -> status='degraded', halt     |
                         |  d. fetchAreaListings(areaId) for ONE      |
                         |     bounded slice of the area result set   |
                         |  e. filter candidates against structured   |
                         |     filter (deterministic, in code)        |
                         |  f. persist ONLY ranked/derived candidate  |
                         |     fields (PII guardrail — never raw      |
                         |     scraped payload)                       |
                         |  g. UPDATE discovery_jobs: processed_count,|
                         |     cost_sek_total, status (done when      |
                         |     slice budget or candidate cap reached) |
                         +------------------------------------------+
                                            |
                                            v
                              [terminal state: done/failed/degraded]
                                            |
                                   client renders results,
                                   stops polling (mirrors BrfProgress
                                   onComplete)

[Vercel Cron: 1x/day, /api/discovery/sweep]
   |
   +-- safety net ONLY: finds jobs stuck in 'processing' with a stale
       claimed_at (tab closed mid-run), reclaims via the SAME RPC's
       stale-lock branch, resumes or marks failed. NOT the primary
       slice driver.
```

### Recommended Project Structure

```
supabase/migrations/
└── 010_discovery_jobs.sql        # table + claim_discovery_slice() RPC

src/lib/discovery/
├── filter-schema.ts              # zod schema: structured filter (area, price, rooms, size...)
├── parse-intent.ts               # Haiku call: free text -> structured filter (mirrors extract.ts)
├── resolve-area.ts               # free-text area name -> Booli areaId (NEW — see Pitfall/Open Q below)
├── candidate.ts                  # deterministic candidate filter + shape (never raw scrape passthrough)
├── cost.ts                       # discoveryCostSek — mirrors brf/cost.ts pattern
└── job.ts                        # claimSlice/runSlice orchestration (calls owned Booli client)

src/actions/
├── start-discovery.ts            # "use server" — validate, parse intent, insert job
└── tick-discovery.ts             # "use server" — claim + run one slice

src/app/(app)/discover/
├── page.tsx                      # free-text + filters form (feature-flag gated)
└── [jobId]/page.tsx              # results + DiscoveryProgress polling

src/components/
└── discovery-progress.tsx        # mirrors brf-progress.tsx exactly, but polls+ticks

src/app/api/discovery/sweep/
└── route.ts                      # Vercel Cron target, 1x/day safety net
```

### Pattern 1: Client-Driven Tick (replaces "cron polls the queue")

**What:** Instead of a server-side cron beat pulling work, the client's own poll interval (already required for progress UI) doubles as the work trigger — each poll round-trip both reads status AND asks the server to advance one bounded slice.

**When to use:** Any Vercel-hosted background-feeling job where Hobby-tier cron (1/day) is too coarse and a dedicated worker/queue is out of budget.

**Example:**
```typescript
// Source: pattern derived from src/components/brf-progress.tsx (existing
// codebase precedent), extended with a tick call. No official doc citation —
// this is an architectural adaptation, not a library feature.
"use client";
useEffect(() => {
  let active = true;
  async function pollAndTick() {
    await tickDiscovery(jobId); // server action: claims + runs ONE slice
    const { data } = await supabase
      .from("discovery_jobs")
      .select("status, processed_count, candidate_count")
      .eq("id", jobId)
      .single();
    if (!active) return;
    // ...update UI state, stop on terminal status (mirrors BrfProgress)
  }
  void pollAndTick();
  const interval = setInterval(pollAndTick, POLL_MS);
  return () => { active = false; clearInterval(interval); };
}, [jobId]);
```

**Caveat:** This makes the job's liveness dependent on the tab staying open. That is why the once-daily Cron sweep exists — purely as an orphan-resume safety net, not the primary mechanism. Document this tradeoff explicitly for the user-facing "you can close this tab, we'll keep going" expectation: **v1 discovery does NOT continue if the tab is closed before the daily sweep runs** (up to ~24h resume latency). This is an acceptable v1 limitation given the "bounded, minutes-scale job" framing (20-30 candidates, not a multi-day crawl) — flag explicitly to the user in the UI copy.

### Pattern 2: Atomic Slice Claim (Postgres RPC, `FOR UPDATE SKIP LOCKED`)

**What:** A single Postgres function that finds ONE eligible `discovery_jobs` row (status pending/processing, not already locked by a concurrent tick, cap budget not yet exhausted), locks it, flips it to `processing` with a fresh `claimed_at`, and returns the row — all inside one statement so no two concurrent ticks (double-poll race, or a stray Cron sweep overlapping a live tick) can claim the same slice twice.

**When to use:** Any job-queue claim where multiple callers (concurrent browser tabs, cron + client tick) might race to advance the same row.

**Example:**
```sql
-- Source: pattern verified via WebSearch cross-referencing multiple current
-- (2026) Postgres job-queue writeups (Netdata Academy, DB Pro Blog) — the
-- CTE-wrapped SELECT...FOR UPDATE SKIP LOCKED + UPDATE...RETURNING shape is
-- consistent across all sources. [CITED: general Postgres SKIP LOCKED pattern,
-- cross-verified against 3+ independent sources, no single-source reliance]
create or replace function claim_discovery_slice(p_job_id uuid, p_stale_ms integer default 300000)
returns setof discovery_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimable as (
    select id from discovery_jobs
    where id = p_job_id
      and status in ('pending', 'processing')
      -- reclaim a stale in-flight slice (crashed/timed-out tick), mirrors
      -- generateReport's STALE_LOCK_MS reclaim window, extended here into
      -- the atomic claim itself rather than a separate pre-check.
      and (
        status = 'pending'
        or claimed_at is null
        or claimed_at < now() - (p_stale_ms || ' milliseconds')::interval
      )
    for update skip locked
  )
  update discovery_jobs
  set status = 'processing', claimed_at = now()
  from claimable
  where discovery_jobs.id = claimable.id
  returning discovery_jobs.*;
end;
$$;

revoke all on function claim_discovery_slice(uuid, integer) from public;
grant execute on function claim_discovery_slice(uuid, integer) to authenticated;
```

```typescript
// Caller (tick-discovery.ts) — a zero-or-one-row RPC result IS the CAS
// outcome: empty means "someone else has it, or it's terminal" — no-op,
// never an error.
const { data: claimed, error } = await supabase
  .rpc("claim_discovery_slice", { p_job_id: jobId })
  .maybeSingle();
if (error) { /* fail closed, log { jobId, code }, return */ }
if (!claimed) { /* another tick already owns this slice — benign no-op */ return; }
// ...proceed to run exactly one bounded slice using `claimed`'s cap counters
```

**Why this is the REAL fix for the Phase 8 review's flagged bug:** `generateReport`'s CAS is a conditional `UPDATE ... WHERE id = X AND status <> 'generating' RETURNING id` — this works for "is THIS ONE row already locked," a check against a single known row. It does NOT generalize to "pick ONE unclaimed row out of N pending rows without two workers picking the same one," which is the shape `SKIP LOCKED` solves. Since Phase 9 has exactly one row per job (not N pending jobs racing for a single worker), the same single-row conditional-UPDATE approach would actually suffice functionally — but `FOR UPDATE SKIP LOCKED` is specified because (a) CONTEXT.md explicitly locks it as the mechanism, (b) it is the more correct primitive if this ever generalizes to a real N-jobs-one-worker queue (e.g., multiple users' jobs ticking concurrently against a shared sweep), and (c) it closes a subtler TOCTOU gap the plain conditional UPDATE has: PostgREST's `.eq()`/`.or()` builder cannot express "AND NOT already locked by a concurrent same-statement transaction" the way a real `FOR UPDATE` row lock does — the conditional-UPDATE CAS is safe only because Postgres serializes single-row UPDATEs, which is equivalent in the ONE-row case but not composable if slice logic ever needs to also touch related rows atomically.

### Pattern 3: Free-Text → Structured Filter (Haiku, fail-safe on low confidence)

**What:** Reuse `extract.ts`'s exact slim-schema/`zodOutputFormat`/`messages.parse` pattern, but for translating a free-text description into `{ areaQuery, priceMin, priceMax, roomsMin, roomsMax, sizeMin, sizeMax, objectType, confidence }`.

**When to use:** Any Claude call whose output must feed a downstream boolean filter with zero tolerance for hallucinated structure.

**Example:**
```typescript
// Source: pattern lifted directly from src/lib/brf/extract.ts (existing,
// production-proven in this codebase) — same library helper, same model
// family, same slim-schema discipline documented in this project's own
// Anthropic structured-output-limits memory (avoid nullable-union/numeric-
// constraint 400s).
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";

const MODEL = "claude-haiku-4-5-20251001"; // same dated id as extract.ts

const intentFilterSchema = z.object({
  areaQuery: z.string().describe("Free-text place name to resolve, e.g. 'Södermalm'"),
  priceMax: z.number().nullable().describe("Max price SEK, null if unspecified"),
  roomsMin: z.number().nullable().describe("Min number of rooms, null if unspecified"),
  sizeMin: z.number().nullable().describe("Min living area sqm, null if unspecified"),
  objectType: z.enum(["Lägenhet", "Villa", "Radhus", "Alla"]).describe("Property type, 'Alla' if unspecified"),
  confidence: z.number().describe("0-1 confidence the parse captures user intent"),
});

const result = await client.beta.messages.parse({
  model: MODEL,
  max_tokens: 512,
  system: INTENT_PARSE_SYSTEM_PROMPT,
  messages: [{ role: "user", content: freeText }],
  output_config: { format: zodOutputFormat(intentFilterSchema) },
});

// Fail-safe: never silently run a low-confidence job.
if (result.parsed.confidence < 0.6) {
  return { ok: false, needsConfirmation: true, parsed: result.parsed };
}
```

**Confidence threshold recommendation:** `0.6` as the fail-safe cutoff [ASSUMED — no domain-specific eval exists yet; mirrors the qualitative "hedge on uncertainty" discipline already used for `underhallsplanStatus`/`stambytePlanerat` enum fields in `extract.ts`, but the numeric threshold itself is not empirically derived]. Recommend the plan include a small (5-10 example) manual eval of real Swedish free-text descriptions against this threshold before shipping, OR simply always surface the parsed filter back to the user for a one-tap "stämmer detta?" confirmation regardless of confidence score (this is both simpler AND safer than relying on a threshold, and mirrors the ENRICH-02 confirmation-before-analysis pattern from Phase 8 — **recommended as the actual v1 design**, with the numeric confidence retained only as a secondary signal to pre-flag likely-wrong parses in that same confirmation UI, e.g. a warning banner).

### Anti-Patterns to Avoid

- **Vercel Cron as the primary slice driver:** Hobby tier physically cannot deploy anything more frequent than daily; even on Pro, cron timing precision is "per-minute" not sub-minute, and Vercel does not guarantee exact-time firing — wrong tool for a live progress bar.
- **Checking cost/candidate caps only at job completion:** Locked decision explicitly requires INCREMENTAL per-slice checks. A job that scrapes 30 listings then discovers it's 10 SEK over budget has already spent the money — checks must gate the NEXT render, not just record the final total.
- **Persisting raw scraped listing payloads in `discovery_jobs`:** PII/GDPR guardrail — only the ranked/derived candidate fields (address, price, sqm, thumbnail URL, derived score) may be persisted; raw Apollo entities or broker-page HTML must never land in the job's result set (mirrors the existing "no raw HTML stored" convention from `09-01`'s iXBRL auto-fetch precedent in `STATE.md`: "v1 auto-fetch stores no raw HTML for audit").
- **Reusing `generateReport`'s single-row conditional-UPDATE CAS verbatim for the slice claim:** Functionally adequate for exactly one row, but CONTEXT.md explicitly locks `FOR UPDATE SKIP LOCKED` as the mechanism — implement the RPC as specified, not the PostgREST pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic job claim under concurrency | A custom polling/retry loop with `setTimeout` backoff | Postgres `FOR UPDATE SKIP LOCKED` in a single RPC transaction | The DB already gives you race-free locking natively; a hand-rolled retry loop reintroduces the exact TOCTOU bug already flagged in Phase 8 review |
| Free-text NL parsing (place names, price ranges, room counts in Swedish) | Regex/keyword extraction | Haiku + `zodOutputFormat` structured output | Swedish free text ("3:a nära vatten under 4 miljoner") has far too much variation for regex; the codebase already trusts Claude for this class of extraction (BRF financials) |
| Area name → Booli areaId resolution | A hardcoded lookup table of Swedish place names to IDs | Render Booli's own search UI via the existing `runPlaywrightRender` transport and scan the resulting Apollo state's breadcrumbs for `areaIds=` (see Open Questions — this is a genuine gap needing one exploratory task, not a pre-built library) | Booli's areaId space is opaque and undocumented; the owned client already has the exact transport needed to discover it live rather than reverse-engineering or hardcoding a stale table |
| Progress polling UI | A new bespoke polling hook | Copy `BrfProgress`'s exact `useEffect`/`setInterval`/cleanup/`MAX_POLL_MS` shape | Proven, tested pattern already in the codebase; DRY violation risk is low here (a shared hook could be extracted, but that's a refactor decision for the planner, not a research blocker) |
| Cost accounting | A new ad-hoc SEK calculation | Extend the `costSek`/`soldSourceCostSek` pattern (`src/lib/brf/cost.ts`, `src/lib/market/cost.ts`) with a `discoveryCostSek` that sums Haiku-parse cost + per-render scrape cost | Two proven, tested cost-cap precedents already exist; a third ad-hoc calculation would fragment the cost-cap discipline STATE.md already flags as needing generalization ("Phase 9/11 must generalize to per-slice incremental checks across N listings") |

**Key insight:** Every piece of this phase's "hard" infrastructure (atomic claim, cost capping, progress polling, structured LLM extraction) already has a proven, tested precedent somewhere in this codebase. The actual novel work is composing them into a new state machine (`discovery_jobs`) and solving the one genuinely new problem: resolving a free-text area name into Booli's opaque `areaId` space (flagged below, not swept under the rug).

## Common Pitfalls

### Pitfall 1: PostgREST NULL-filter trap resurfaces in the tick/claim path
**What goes wrong:** Any status/claimed_at check written via the Supabase JS query builder (`.eq()`, `.neq()`) instead of the RPC will silently mis-match NULL rows exactly like the documented `generateReport` bug (`.eq(col, null)` and `.neq(col, 'x')` both match zero NULL rows).
**Why it happens:** SQL three-valued logic — `NULL <> 'x'` is `UNKNOWN`, not `TRUE`.
**How to avoid:** The atomic claim MUST be the RPC (all logic in SQL, not chained PostgREST filters). Any status reads elsewhere (e.g., the polling `.select("status")`) are read-only and safe; only conditional UPDATEs are the danger zone. If any future write path uses `.is(col, null)` / `.or(...)` instead of `.eq(col, null)`, per the project's own memory file.
**Warning signs:** A job that appears to wedge at `processing` forever with no error logged.

### Pitfall 2: Vercel Function timeout mid-slice on a slow Apify render
**What goes wrong:** `runPlaywrightRender` has an internal `waitSecs: 240` ceiling and up to 2 renders per rung-walk (own-playwright + retry) per the transport's own doc comment — a single slice invoking `fetchAreaListings` could take up to ~8 minutes in the worst case (2 renders × ~240s wait budget, though a warm run is far faster). Default Vercel Function duration is 300s on BOTH Hobby and Pro [VERIFIED: vercel.com/docs/functions/configuring-functions/duration, fetched 2026-07-07].
**Why it happens:** The 240s `waitSecs` is a ceiling for Apify container cold-start, not a typical duration — but a worst-case slice could still exceed a 300s function.
**How to avoid:** (1) Set `export const maxDuration = 300` explicitly on the tick action's route (Next.js App Router default already matches, but declare it explicitly for clarity and to survive a future default change). (2) Size each "slice" to ONE `fetchAreaListings` call (not multiple), so worst-case duration is bounded by ONE rung-walk, not N. (3) If a slice still risks the ceiling, keep the bounded candidate-per-slice count small (e.g., process 5-10 candidates' worth of filtering per tick, not all 20-30 at once) — the area listing fetch itself returns all candidates in one call already (per `fetchAreaListings`'s doc comment, "one Apollo blob commonly embeds many listings"), so slicing happens on the FILTER/PERSIST side (in-code, fast) rather than needing multiple scrape calls.
**Warning signs:** A tick that times out server-side but the client-side poll never sees a status change (job silently wedges in `processing` until the once-daily sweep's stale-reclaim fires).

### Pitfall 3: Booli area-name resolution has no documented public endpoint
**What goes wrong:** Assuming a `?q=<placename>` or dedicated autocomplete API exists on Booli and building `resolve-area.ts` against a guessed endpoint that 403s or silently returns nothing.
**Why it happens:** Booli's own `/sok/till-salu` search page uses an opaque `areaIds=<N>` parameter with NO plain-text alternative [VERIFIED: live WebFetch of `booli.se/sok/till-salu?q=...` on 2026-07-07 confirmed `q=` is ignored and the page falls back to all-of-Sweden results]. The existing codebase's `resolveAreaId` only derives an areaId from an EXISTING listing's breadcrumb ladder — there is no standalone "type a place name, get an areaId" resolver anywhere in the codebase or in any documented Booli endpoint found during this research.
**How to avoid:** Treat area resolution as its own small exploratory task in Wave 0 of the plan (see Open Questions #1 below for the concrete recommended approach: render Booli's own search-box interaction via `runPlaywrightRender` and scan the resulting page's Apollo state / network calls for the `areaIds=` value the search box itself resolves to, OR have the Haiku intent-parse step ask the user to pick from a short disambiguation list resolved via a lightweight live probe). Do NOT hardcode a static Swedish place-name-to-areaId lookup table — it will drift and cannot cover the input space.
**Warning signs:** Any hardcoded `AREA_ID_MAP` constant appearing in a plan or diff.

### Pitfall 4: Cost caps checked with stale in-memory counters across ticks
**What goes wrong:** If a slice orchestrator reads `cost_sek_total` once at the START of a tick and checks against the cap using that snapshot while ALSO writing new spend at the end, a concurrent/overlapping tick (race between the client's poll interval and a stale browser tab, or overlap with the daily sweep) could double-count or under-count spend.
**Why it happens:** The atomic claim (Pattern 2) already serializes WHICH tick owns the row, but the cap-check-then-spend-then-persist sequence inside a single tick is still check-then-act unless the running total is read from the SAME row version returned by the claim RPC (not a separate `SELECT`).
**How to avoid:** The claim RPC's `RETURNING discovery_jobs.*` already gives the caller the authoritative, freshly-locked row — read `cost_sek_total`/`processed_count`/`candidate_count` from THAT returned row, never from a separate query, and persist the updated totals in the SAME UPDATE that also (potentially) flips status to `done`.
**Warning signs:** Cost totals that don't match the sum of individually-logged per-render costs.

### Pitfall 5: Feature flag checked only in the UI, not the Server Action
**What goes wrong:** Hiding the `/discover` entry point in the nav but leaving `startDiscovery`/`tickDiscovery` server actions callable directly (e.g., via devtools/curl) bypasses the "OFF by default" legal gate entirely.
**Why it happens:** It's tempting to gate only the visible surface.
**How to avoid:** Check the flag (e.g., `DISCOVERY_ENABLED` server-only env var, not `NEXT_PUBLIC_`) INSIDE `startDiscovery` as the very first line, mirroring the auth-gate-first pattern already used in `generateReport` (auth check is the first thing, before any work). `tickDiscovery` can skip the check IF it re-validates via the job's own row (a job can only exist if it was created while the flag was on), but `startDiscovery` MUST check it directly.
**Warning signs:** A plan that adds the flag check only to `page.tsx`/the form component.

## Code Examples

### Slim intent-parse schema (mirrors `claudeExtractionSchema`)
```typescript
// Source: pattern lifted from src/lib/brf/extract.ts:51-89 (existing,
// production-proven). Avoids nullable-union explosion and numeric range
// constraints per this project's own memory (anthropic-structured-output-limits.md).
const intentFilterSchema = z.object({
  areaQuery: z.string().describe("Free-text place/area name to resolve"),
  priceMax: z.number().nullable().describe("Max price in SEK, null if unspecified"),
  roomsMin: z.number().nullable().describe("Minimum rooms, null if unspecified"),
  sizeMin: z.number().nullable().describe("Minimum living area sqm, null if unspecified"),
  objectType: z.enum(["Lägenhet", "Villa", "Radhus", "Alla"]),
  confidence: z.number().describe("0-1, how confident the parse reflects user intent"),
});
// NOTE: no .min()/.max()/.int() chained constraints — the strict grammar
// compiler rejects too many numeric-constrained + nullable fields combined,
// per the exact 400 this project already hit and documented.
```

### Vercel Cron config (safety-net sweep only)
```json
// Source: https://vercel.com/docs/cron-jobs (official docs, fetched 2026-07-07)
// vercel.json — project root
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/discovery/sweep",
      "schedule": "0 3 * * *"
    }
  ]
}
```
This is valid on Hobby (exactly once per day) — no tier upgrade required. Vercel notes actual firing time on Hobby may land anywhere in the 03:00-03:59 window [CITED: vercel.com/docs/cron-jobs/usage-and-pricing].

### Discovery cost function (mirrors `soldSourceCostSek`)
```typescript
// Source: pattern from src/lib/market/cost.ts (existing, production-proven)
export function discoveryCostSek(usage: {
  haikuUsage: ClaudeUsage;   // intent parse, one call per job
  renders: number;           // fetchAreaListings render count for this slice
}): number {
  const haikuSek = costSek(usage.haikuUsage);       // src/lib/brf/cost.ts
  const renderSek = usage.renders * USD_PER_RENDER * USD_SEK_RATE; // 0.0055 USD/render
  return haikuSek + renderSek;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Vercel Cron Jobs hourly on Hobby | Hobby capped to once/day (deployment fails otherwise) | Longstanding Vercel platform limit, reconfirmed current as of 2026-06-16 docs update | Rules out cron-as-primary-driver for any sub-daily background job on Hobby |
| Vercel Function 10s/60s default duration (older platform generations) | 300s default on BOTH Hobby and Pro, up to 800s (GA) / 1800s (beta) on Pro with explicit `maxDuration` | Current as of 2026-06-19 docs | A single bounded slice comfortably fits the default 300s ceiling without needing Pro |

**Deprecated/outdated:** None directly relevant — Anthropic's `output_config.format` (vs. older top-level `response_format`) is already correctly used as "the current shape" per `synthesize.ts`'s own comment; this research reuses that same current API, not an older one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `0.6` confidence threshold for the fail-safe low-confidence gate | Pattern 3 | Low — mitigated by the recommendation to ALWAYS show a confirmation step regardless of score, making the numeric threshold advisory rather than load-bearing |
| A2 | A single `fetchAreaListings` call per slice keeps worst-case duration under Vercel's 300s default | Pitfall 2 | Medium — if Booli's area pages paginate for large areas (already flagged as an open question in Phase 5's own `05-RESEARCH.md`, "whether results span multiple pages... is an in-plan LIVE verification"), a slice could need >1 render call; mitigated by keeping the CANDIDATE processing (not the scrape) as the sliced unit |
| A3 | Rendering Booli's own search-box interaction via `runPlaywrightRender` will surface a usable `areaIds=` value for a free-text place name | Don't Hand-Roll / Open Question 1 | Medium — this is the recommended approach but UNVERIFIED live (static WebFetch could not inspect client-side XHR/autocomplete traffic); must be the first exploratory task in the plan, with a documented fallback (see Open Questions) |
| A4 | Claude Haiku model id `claude-haiku-4-5-20251001` (same as `extract.ts`) remains the correct/current id to reuse | Code Examples | Low — this id is already live in production code in this same repo; if Anthropic deprecates it the existing BRF extraction breaks too, so it is not a Phase-9-specific risk |

**If this table is empty:** N/A — see rows above.

## Open Questions (RESOLVED)

> All four questions below carry concrete recommendations and are RESOLVED for Phase 9 execution: (1) area-name→areaId — Wave-0 live probe with a static Stockholm-region seed-list fallback; (2) pagination — truncate-to-cap (candidate cap 20–30 < typical unpaginated results); (3) Vercel tier — stay on Hobby, client-tick drives slices, cron demoted to once-daily orphan recovery (the ~24h worst-case resume latency is an accepted v1 limitation, folded into Plan 04's operator smoke-test acknowledgement); (4) Booli search-box DOM selectors — resolved empirically as Wave-0's first task. None gate planning.

1. **How exactly does a free-text place name (e.g., "Södermalm", "Nacka", "Vasastan") resolve to a Booli `areaId`?**
   - What we know: `areaId` is an opaque numeric Booli-internal ID (confirmed via `resolveAreaId`'s existing breadcrumb-regex approach and this research's live WebFetch showing `?q=<name>` does NOT filter results). The owned client already has the exact Playwright transport (`runPlaywrightRender` + `APOLLO_PAGE_FUNCTION`) needed to render ANY Booli page and scan its Apollo state.
   - What's unclear: Whether Booli's own on-page search-box (`area-search-field`, observed in the live fetch) calls a discoverable autocomplete endpoint reachable without full browser JS execution, or whether it only resolves via client-side JS interaction (typing + selecting a result) that `runPlaywrightRender`'s current `pageFunction` (a passive Apollo-state scan) does not simulate.
   - **Recommendation (not deferred — concrete path):** Wave 0 exploratory task: extend `runPlaywrightRender` (or add a sibling `page-function`) to (a) navigate to `/sok/till-salu`, (b) type the free-text query into `#area-search-field` (or its actual selector, confirmed via live DOM inspection), (c) wait for and click the first suggestion, (d) capture the resulting URL's `areaIds=` param. This reuses the EXISTING proven transport/proxy/actor infrastructure — no new external dependency. **Fallback if browser-interaction proves unreliable:** degrade to asking the user to pick their area from Booli's existing public kommun/neighborhood breadcrumb hierarchy (already partially known via `resolveAreaId`'s ladder) rendered as a simple dropdown seeded from a ONE-TIME manually-curated list of Stockholm-region kommun/neighborhood IDs (small, static, human-verified — NOT a hand-rolled comprehensive lookup, just a v1-scoped seed list for the initial launch region). This fallback is explicitly a scope-reduction, not a silent hack — flag it in the plan if the live probe fails.

2. **Does a single `fetchAreaListings` call ever paginate for large/popular areas (e.g., central Stockholm)?**
   - What we know: `fetchAreaListings`'s own doc comment flags this as unresolved: "whether results span multiple pages for a given area is an in-plan LIVE verification, not assumed transitively from the single-page probe."
   - What's unclear: Whether Phase 9's candidate cap (20-30) will ever be reached mid-page or whether one page already exceeds it (making pagination moot for THIS phase's bounded use case).
   - **Recommendation:** Since Phase 9 caps candidates at 20-30 (much smaller than a full unpaginated area result likely already contains, per Phase 5's "one Apollo blob commonly embeds many listings" note), plan to simply TRUNCATE `fetchAreaListings`'s single-page result to the cap rather than implementing pagination — pagination is out of scope for a 20-30 candidate bound and would only matter for a sparse area returning fewer than the cap, which is a benign "fewer candidates than requested" outcome, not a bug.

3. **Should Vercel be upgraded to Pro for this phase?**
   - What we know: The client-driven-tick architecture works identically on Hobby and Pro — no upgrade is required to unblock Phase 9.
   - What's unclear: Whether the operator wants the once-daily safety-net sweep to instead run more frequently (e.g., hourly) for faster orphan-job recovery, which WOULD require Pro.
   - **Recommendation:** Ship on Hobby. If orphaned-job recovery latency (~24h worst case) proves unacceptable in practice post-launch, upgrading to Pro is a trivial, non-architectural follow-up (only the `vercel.json` cron schedule changes). **Flagged for operator: no action needed now; revisit only if orphan-job UX complaints arise.**

4. **What is the actual DOM selector / interaction flow for Booli's area-search-field?**
   - What we know: The field exists (`area-search-field`, observed in live fetch) but its underlying request/response shape is invisible to static HTML fetching.
   - What's unclear: Exact selector, whether it's a debounced XHR-per-keystroke or a client-side pre-loaded dataset, and the shape of any suggestion response.
   - **Recommendation:** This is the FIRST task of Wave 0 for the planner — a short, time-boxed (≤1 session) live Playwright exploration (using the SAME `apify/playwright-scraper` actor infra, one throwaway interactive run) to confirm the mechanism, mirroring how Phase 5's `05-PROBE-FINDINGS.md` empirically pinned the `Listing:` Apollo prefix before building on it. **Flagged for operator: this exploratory probe should run with an operator-approved small Apify spend (a handful of interactive renders), same posture as the Phase 5/8 spikes.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `ANTHROPIC_API_KEY` | Free-text intent parse (Haiku) | Assumed set (already required by Phase 2/4/8) | — | None needed — already a hard project dependency |
| `APIFY_API_TOKEN` | Area scrape via owned Booli client | Assumed set (already required by Phase 5) | — | None needed — already a hard project dependency |
| Supabase Postgres (RPC support) | Atomic slice claim | Yes — standard Postgres feature, no extension needed | — | — |
| Vercel Cron (Hobby tier) | Safety-net sweep | Yes — cron jobs included on all plans, 1/day sufficient | — | None needed for v1; Pro upgrade optional future lever (see Open Question 3) |
| Vercel Function default duration (300s) | Tick action | Yes — 300s default on Hobby AND Pro | — | If a slice risks exceeding 300s: shrink slice size further (see Pitfall 2) |

**Missing dependencies with no fallback:** None identified.

**Missing dependencies with fallback:** None identified — all required capabilities exist on the current (assumed Hobby) tier.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 (already configured, `vitest.config.ts`) |
| Config file | `vitest.config.ts` (repo root) |
| Quick run command | `npx vitest run <file>` |
| Full suite command | `npm run test` (or `npx vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISC-01 | Free text + filters → structured filter object (Haiku parse) | unit (mocked Anthropic client, mirrors `extract.test.ts` pattern) | `npx vitest run src/lib/discovery/parse-intent.test.ts` | ❌ Wave 0 |
| DISC-01 | Structured filter correctly narrows `fetchAreaListings` candidates (deterministic, in-code) | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 |
| DISC-02 | `claim_discovery_slice` RPC: two concurrent claims on the same job never both succeed | integration (requires a live/local Supabase Postgres — cannot be mocked, this IS the thing under test) | `npx vitest run src/lib/discovery/job.integration.test.ts` (or a `supabase test db` pgTAP test alongside the migration) | ❌ Wave 0 |
| DISC-02 | Incremental cap enforcement halts a slice before exceeding candidate/cost cap | unit | `npx vitest run src/lib/discovery/job.test.ts` | ❌ Wave 0 |
| DISC-02 | `/discover/[jobId]` polling UI reaches terminal state and stops polling (mirrors `BrfProgress` behavior) | component (jsdom + RTL, `@vitest-environment jsdom` docblock per existing Phase 8 convention) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ Wave 0 |
| DISC-07 | Feature flag OFF rejects `startDiscovery` even with valid input | unit | `npx vitest run src/actions/start-discovery.test.ts` | ❌ Wave 0 |
| DISC-07 | Kill switch: a CAPTCHA/blocking signal from the owned Booli client degrades the job to single-URL-only / halts rather than continuing | unit (mocked `fetchAreaListings` throwing the dead-source error) | `npx vitest run src/lib/discovery/job.test.ts` | ❌ Wave 0 |
| DISC-07 | Persisted job/result rows never contain raw scraped payload fields beyond the documented ranked-candidate shape | unit (schema/shape assertion) | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run <changed-file>.test.ts`
- **Per wave merge:** `npm run test` (full suite — currently ~384+ tests per STATE.md)
- **Phase gate:** Full suite green before `/gsd-verify-work`; the RPC concurrency test (DISC-02 row above) additionally requires a live local Supabase instance (`supabase start`) — flag this in the plan as an environment prerequisite distinct from the pure-Vitest suite.

### Wave 0 Gaps
- [ ] `src/lib/discovery/parse-intent.test.ts` — covers DISC-01 (mocked Haiku call, mirrors existing `src/lib/brf/extract.test.ts` mocking pattern)
- [ ] `src/lib/discovery/candidate.test.ts` — covers DISC-01/DISC-07 (deterministic filter + PII-safe shape)
- [ ] `src/lib/discovery/job.test.ts` — covers DISC-02/DISC-07 (incremental caps, kill switch)
- [ ] `src/lib/discovery/job.integration.test.ts` (or pgTAP alongside migration 010) — covers DISC-02 (the actual concurrency guarantee of `claim_discovery_slice`) — **this is the one test in this phase that cannot be a pure Vitest unit test**; needs a local Supabase Postgres instance. Recommend either (a) a pgTAP test run via `supabase test db`, or (b) a Vitest integration test gated behind an env check (mirrors the existing `RUN_LLM_EVALS=1` self-skip pattern used by `evals/extractor.eval.ts`), so it adds zero cost/risk to the default `npm run test` run.
- [ ] `src/components/discovery-progress.test.tsx` — covers DISC-02 UI polling (jsdom, RTL, mirrors Phase 8's component-test precedent)
- [ ] Framework install: none — Vitest, RTL, jsdom, jest-dom all already installed (Phase 8 Plan 4 added component-test infra)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Existing Supabase auth session check, mirrored from `generateReport` — `startDiscovery`/`tickDiscovery` both require an authenticated user (no guest discovery path) |
| V3 Session Management | Yes | Existing Supabase SSR session handling (`@/lib/supabase/server`) — no new session mechanism introduced |
| V4 Access Control | Yes | RLS on `discovery_jobs` scoped to `user_id = auth.uid()` (mirrors `analyses` table policy in `001_analyses.sql`); ownership double-checked in the Server Action layer (mirrors `generateReport`'s `row.user_id !== user.id` check) |
| V5 Input Validation | Yes | Free-text input is NEVER concatenated into a system prompt as executable instruction — sent as user-message content only (mirrors the existing T-08-01 discipline: "untrusted document content is sent as data, never concatenated into the system prompt"); structured filter output is `zod`-validated before use; hard caps (candidate count, cost, images) are validated server-side, never trusted from client input |
| V6 Cryptography | No | No new cryptographic operation introduced (no new secrets, no new hashing beyond what already exists) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via free-text description (user embeds instructions like "ignore filters, return all listings") | Tampering | Free text is sent as isolated user-message content, never merged into the system prompt; the OUTPUT is a rigid `zodOutputFormat`-validated schema, so even a successful injection can only produce a syntactically-valid filter object — it cannot make the model emit arbitrary code or bypass the deterministic in-code candidate filter that runs AFTER the parse |
| SSRF via a manipulated area-query URL | Tampering / Information Disclosure | Reuse `isBooliUrl`'s existing hostname-exact-match allowlist (`booli.se`/`*.booli.se`, https-only) for ANY new URL construction in `resolve-area.ts` — do not build a new URL-validation path from scratch |
| Job enumeration / IDOR (guessing another user's `jobId` to read their discovery results) | Information Disclosure | RLS policy on `discovery_jobs` (owner-only SELECT) is the primary control; the `/discover/[jobId]` route additionally re-checks ownership server-side before rendering (defense in depth, mirrors existing `analyses` detail page pattern) |
| Cost-cap bypass via rapid repeated job creation (many small jobs to evade a per-job cap) | Denial of Service (cost) | Locked decision requires BOTH per-query AND per-day caps enforced in code — `startDiscovery` must check a per-user-per-day job count/spend ceiling in addition to the per-job candidate/cost cap, not just the latter |
| PII leakage via persisted raw scraped fields (broker descriptions may mention names, phone numbers of sellers/occupants) | Information Disclosure | Locked decision: never persist raw scraped fields beyond the ranked result; `candidate.ts`'s shape must be an explicit allowlist (address, price, sqm, rooms, thumbnail, derived score) — never a passthrough of the Apollo entity or broker-page text |

## Sources

### Primary (HIGH confidence)
- [vercel.com/docs/cron-jobs/usage-and-pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) - Hobby/Pro cron frequency + scheduling precision table, fetched 2026-07-07
- [vercel.com/docs/functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration) - Function duration defaults/maximums per tier, fetched 2026-07-07
- Direct codebase reads: `src/lib/booli/client.ts`, `src/lib/booli/transport.ts`, `src/actions/generate-report.ts`, `src/components/brf-progress.tsx`, `src/lib/brf/extract.ts`, `src/lib/report/synthesize.ts`, `src/lib/brf/cost.ts`, `src/lib/market/cost.ts`, `supabase/migrations/*.sql`, `package.json` — all read directly, not from training data

### Secondary (MEDIUM confidence)
- Live `WebFetch` of `booli.se/sok/till-salu?q=...` (2026-07-07) confirming `q=` is not a working location filter and `areaIds=` is required
- Live `WebFetch` of `booli.se/sok/till-salu` (2026-07-07) confirming an `area-search-field` element exists but its backing mechanism is not visible in static HTML
- `FOR UPDATE SKIP LOCKED` CTE + `UPDATE...RETURNING` pattern — cross-verified across 3+ independent WebSearch results (Netdata Academy, DB Pro Blog, multiple 2026-dated blog posts) with consistent shape

### Tertiary (LOW confidence)
- None relied upon as authoritative — all WebSearch findings above were cross-verified against either official Vercel docs or multiple independent sources before being stated as fact.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages, every pattern has direct in-repo precedent
- Architecture (Vercel Cron limits, atomic claim): HIGH — verified against current official Vercel docs; SKIP LOCKED pattern cross-verified across multiple sources
- Area-name resolution (Open Question 1): MEDIUM — the recommended approach (browser-interaction probe via existing transport) is architecturally sound and reuses proven infra, but is UNVERIFIED live; correctly flagged as a Wave 0 exploratory task rather than assumed to "just work"
- Pitfalls: HIGH — each pitfall is either a documented project memory (PostgREST NULL trap), a direct codebase doc-comment (render duration/pagination caveats), or a verified official-docs constraint (function timeout)

**Research date:** 2026-07-07
**Valid until:** 30 days for the architectural/codebase findings (stable); 7 days for the Vercel platform-limits findings specifically, since Vercel changelog shows active platform evolution (e.g., the 100-cron-jobs-per-project change) — re-verify the cron/duration tables in `vercel.com/docs/cron-jobs/usage-and-pricing` if planning is delayed past that window.

