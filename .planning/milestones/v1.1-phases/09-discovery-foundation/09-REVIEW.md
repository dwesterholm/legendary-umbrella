---
phase: 09-discovery-foundation
reviewed: 2026-07-07T09:53:29Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - src/actions/start-discovery.ts
  - src/actions/tick-discovery.ts
  - src/app/(app)/dashboard/page.tsx
  - src/app/(app)/discover/[jobId]/page.tsx
  - src/app/(app)/discover/page.tsx
  - src/app/api/discovery/sweep/route.ts
  - src/components/discovery-candidate-card.tsx
  - src/components/discovery-input.tsx
  - src/components/discovery-progress.tsx
  - src/lib/booli/area-search-page-function.ts
  - src/lib/discovery/area-seed.ts
  - src/lib/discovery/candidate.ts
  - src/lib/discovery/cost.ts
  - src/lib/discovery/filter-schema.ts
  - src/lib/discovery/job.ts
  - src/lib/discovery/parse-intent.ts
  - src/lib/discovery/resolve-area.ts
  - src/lib/discovery/tick-config.ts
  - supabase/migrations/010_discovery_jobs.sql
findings:
  critical: 3
  warning: 3
  info: 2
  total: 8
status: issues_found
---

# Phase 9: Code Review Report

**Reviewed:** 2026-07-07T09:53:29Z
**Depth:** standard
**Files Reviewed:** 19
**Status:** issues_found

## Summary

The feature-flag discipline is genuinely solid: `DISCOVERY_ENABLED` is checked as the literal first line in both Server Actions and both discovery pages, always fails closed, and is never read from a `NEXT_PUBLIC_` var. The per-slice cost/candidate cap gate in `job.ts` is correctly incremental (checked before the scrape, computed off the atomically-claimed row, never a stale re-SELECT), and the Haiku prompt-injection posture in `parse-intent.ts` is correct (free text is user-message-only, never concatenated into `system`, output is schema-constrained, low-confidence fails safe). The PII allowlist mapper in `candidate.ts` is a genuine field-by-field constructor with no object-spread, so raw Apollo/broker data structurally cannot leak into persisted results.

However, this review found a critical authorization gap in the `claim_discovery_slice` RPC itself (not just in the app-layer callers), and a critical unauthenticated/RLS-defeated cron sweep endpoint that either does nothing (current state, given the anon-key client with no session) or — if the underlying client is ever swapped for a service-role key — becomes a wide-open, unauthenticated cost-exhaustion and cross-user IDOR surface. There is also a real functional bug where the UI's area dropdown is silently discarded by `startDiscovery`, defeating the one input designed to guarantee a resolvable area.

## Critical Issues

### CR-01: `claim_discovery_slice` RPC has no ownership check — any authenticated user can claim/drive/spend another user's job

**File:** `supabase/migrations/010_discovery_jobs.sql:70-98`
**Issue:** The RPC is `security definer` (bypasses RLS by design) and is granted `execute` directly to the `authenticated` role (line 101: `grant execute on function claim_discovery_slice(uuid, integer) to authenticated;`). PostgREST exposes every `SECURITY DEFINER` RPC granted to `authenticated` at `/rest/v1/rpc/claim_discovery_slice` — any logged-in user can call `supabase.rpc("claim_discovery_slice", { p_job_id: <any_jobs_uuid> })` directly from the browser console with an arbitrary `jobId`, entirely bypassing `tickDiscovery`'s app-level ownership pre-check (`tick-discovery.ts:53-58`), because the SQL function body filters only on `id = p_job_id` and `status` — never `user_id = auth.uid()`.

The app-layer defense (`tickDiscovery`'s `row.user_id !== user.id` check) only protects the one call site that goes through the Server Action. It does nothing to stop a direct RPC call, since the RPC is independently reachable and independently privileged. This means:
- Any authenticated user can claim and advance ANY other user's `pending`/`processing` discovery job.
- This burns that other user's `cap_sek`/`cap_candidates` budget, races their own client-tick claims, and can flip their job to `done`/`degraded`/`failed` out from under them.
- The job's `results` (candidate data) become readable to the attacker indirectly if `discovery_jobs.select` RLS is separately bypassed, but even without a read, this is a straightforward resource-griefing / cost-exhaustion primitive against a specific victim's job, exercised entirely at the database layer.

The project's own integration test (`job.integration.test.ts:25-27`) explicitly acknowledges this gap: "The service-role key is used deliberately here (bypasses RLS) — this test proves the RPC's OWN atomicity guarantee, not the RLS policy layer, which is out of scope for this specific concurrency proof." The RLS/ownership layer was never actually verified for the RPC itself.

**Fix:** Add an ownership check inside the function body (SECURITY DEFINER functions must do their own authorization since RLS is bypassed):
```sql
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
      and user_id = auth.uid()  -- NEW: enforce ownership inside the definer function
      and status in ('pending', 'processing')
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
```
Note this also requires the cron sweep path (which has no `auth.uid()`) to use a service-role client and a *different* RPC variant (or a `p_bypass_owner_check` parameter guarded by a role check) — see CR-02, since sweep and per-user ticks currently share one RPC signature.

### CR-02: `/api/discovery/sweep` has no authentication/authorization — publicly reachable, and (given the current client) also non-functional

**File:** `src/app/api/discovery/sweep/route.ts:33-81`
**Issue:** This is a `GET` Route Handler with zero verification that the caller is Vercel Cron (no check for `request.headers.get("authorization")` against a `CRON_SECRET`, nor Vercel's `x-vercel-cron` invocation context). `vercel.json` schedules it, but nothing stops any external party from issuing `GET https://<host>/api/discovery/sweep` directly and repeatedly.

Compounding this, `createClient()` (line 34) is `src/lib/supabase/server.ts`'s cookie-bound anon-key client — there is no `SUPABASE_SERVICE_ROLE_KEY` client anywhere in `src/lib` (confirmed via search: the only reference to a service-role key in the whole `src` tree is the gated integration test). A cron-triggered or externally-triggered request to this route carries no session cookie, so `auth.uid()` is `null` inside the RLS-scoped query at line 43-48 (`.eq("status", "processing").or(...)`) — under the `"Users can view own discovery jobs"` policy (`auth.uid() = user_id`), this returns **zero rows for every invocation**, meaning:
- **As currently deployed, the orphan-resume safety net is dead code** — it will never actually reclaim a stuck job, silently defeating its entire stated purpose (a functional/reliability bug, not just a security one).
- **If a future change swaps in a service-role client** (the obvious "fix" for the above) without also adding a secret/header check, this endpoint becomes a fully public, unauthenticated trigger that can claim and run `runSlice` against *any* user's stuck job, an unbounded number of times (limited only by `MAX_JOBS_PER_SWEEP` per call, but callable in a tight loop with no rate limit) — a direct, externally-triggerable cost-exhaustion vector across the whole cap-per-job budget, and (combined with CR-01's missing ownership check in the RPC) a cross-tenant data-processing vector.

**Fix:** Add a shared-secret check as the literal first line (mirroring the `DISCOVERY_ENABLED` fail-closed discipline already used elsewhere in this phase), and use a service-role client scoped explicitly for this route:
```ts
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createServiceRoleClient(); // new helper, service_role key, bypasses RLS deliberately + intentionally, for this one trusted server-only cron path
  // ... rest unchanged, but now genuinely finds stuck jobs across all users
}
```
This also requires `CRON_SECRET` to be set in the Vercel project env and (per Vercel's own docs) either checked against the `Authorization` header Vercel Cron sends automatically, or configured explicitly. Do not ship the service-role client swap without the secret check landing in the same change — shipping one without the other converts a currently-inert bug into a live, unauthenticated spend/IDOR surface the moment someone "fixes" the RLS issue in isolation.

### CR-03: Area dropdown selection is silently discarded — `startDiscovery` never reads the `areaQuery` FormData field the UI sends

**File:** `src/actions/start-discovery.ts:112-133` (compare `src/components/discovery-input.tsx:52-60`)
**Issue:** `DiscoveryInput.buildFormData()` sets `formData.set("areaQuery", area)` when the user picks an option from the "Område" `<Select>` (seeded exactly from `AREA_SEED`'s keys — i.e., the one input in the whole UI that is *guaranteed* resolvable via `seedResolve`). `startDiscovery` reads FormData overrides for `priceMax`, `roomsMin`, `sizeMin`, and `objectType` (lines 115-133) but never calls `formData.get("areaQuery")` — the merged filter's `areaQuery` is left exactly as Haiku inferred it from free text, even when the user explicitly picked a known-good seeded area from the dropdown.

This is a straightforward, provable logic bug (not a hypothetical edge case): a user who types ambiguous/arealess free text ("3:a nära vattnet, max 4 miljoner") and then explicitly selects "nacka" from the dropdown will still have their job driven by whatever (possibly empty or wrong) `areaQuery` Haiku extracted from the free text — the explicit, structured, guaranteed-correct signal is discarded in favor of the inferred one. This directly undermines the "explicit user filters win over the Haiku-inferred defaults" comment at line 112, which is true for every *other* filter field but not for area — arguably the single most failure-prone field per this phase's own research doc (Pitfall 3 / Open Question 1).

**Fix:**
```ts
const areaQueryOverride = formData.get("areaQuery");
if (typeof areaQueryOverride === "string" && areaQueryOverride.trim() !== "") {
  mergedFilter.areaQuery = areaQueryOverride.trim();
}
```
Insert this alongside the other override blocks (before the `objectTypeOverride` block for consistency), and confirm merge order still matches the documented "explicit user filters win" contract for `areaQuery` too.

## Warnings

### WR-01: `objectType` FormData override bypasses the Zod enum contract via unchecked type assertion

**File:** `src/actions/start-discovery.ts:130-133`
**Issue:** `mergedFilter.objectType = objectTypeOverride as DiscoveryFilter["objectType"]` performs a bare type assertion on a raw string pulled from FormData, with no runtime validation that it's one of `"Lägenhet" | "Villa" | "Radhus" | "Alla"`. Any string value submitted in this field (e.g. via a crafted `fetch` to the Server Action, or a future UI bug that sends the wrong value) is persisted into `discovery_jobs.filters` and later passed straight to `fetchAreaListings(resolution.areaId, filters.objectType)` (`job.ts:133`), which forwards it into `buildTillSaluUrl`'s `URLSearchParams` — not an injection risk since it's URL-encoded, but it silently defeats the type system's guarantee that every other reader of `DiscoveryFilter.objectType` (e.g. `describeFilters` on the results page, any future code branching on the enum) can trust the value is one of the four known strings.

**Fix:** Validate against the actual enum before assigning:
```ts
const OBJECT_TYPES = ["Lägenhet", "Villa", "Radhus", "Alla"] as const;
const objectTypeOverride = formData.get("objectType");
if (
  typeof objectTypeOverride === "string" &&
  (OBJECT_TYPES as readonly string[]).includes(objectTypeOverride)
) {
  mergedFilter.objectType = objectTypeOverride as DiscoveryFilter["objectType"];
}
```
(Or reuse `intentFilterSchema.shape.objectType.safeParse(...)` directly, keeping a single source of truth for the enum.)

### WR-02: Per-day job cap can be bypassed by racing concurrent `startDiscovery` calls (TOCTOU on a non-atomic count-then-insert)

**File:** `src/actions/start-discovery.ts:69-88`
**Issue:** The `JOBS_PER_DAY_CAP` check is a plain `SELECT count(*) ... WHERE user_id = ? AND created_at >= ?` followed later by a separate `INSERT`, with no transaction or unique constraint tying them together. Two concurrent `startDiscovery` invocations from the same user (e.g., a double-click, two browser tabs, or a scripted burst) can both read `count < 5` before either has inserted, and both proceed to insert — allowing the effective cap to be exceeded by the degree of concurrency. This is the same class of check-then-act race the project's own `claim_discovery_slice` RPC exists specifically to avoid at the row level; this cap uses the pattern the RPC was built to replace.

The blast radius is bounded (`CAP_SEK_MAX` per job still applies per job, so this doesn't make cost unbounded — it just weakens the "5 jobs/day" ceiling to "5 + concurrency" jobs/day), so this is a Warning rather than a Blocker, but it's worth noting since T-09-09's whole purpose is bounding rapid-job-creation cost DoS and the current implementation has a real, exploitable race under concurrent requests.

**Fix:** Either wrap count+insert in a single atomic RPC (same pattern as `claim_discovery_slice`), or accept the race as a soft/best-effort limit and document it explicitly as such rather than implying a hard guarantee.

### WR-03: `DiscoveryProgress` polling has no backoff/dedup guard against overlapping `tickDiscovery` calls if a tick takes longer than `POLL_MS`

**File:** `src/components/discovery-progress.tsx:83-116`
**Issue:** `setInterval(poll, POLL_MS)` fires every 1500ms unconditionally; `poll()` is `async` and awaits `tickDiscovery(jobId)` then a `select`, but nothing prevents a *second* interval tick from firing (and calling `tickDiscovery` again) while the first `poll()` call's `await tickDiscovery(...)` is still in flight — e.g. if a slice's scrape takes several seconds (well within the documented up-to-240s Playwright wait ceiling). This is not a correctness bug per se, since `claim_discovery_slice`'s atomic claim makes the redundant concurrent `tickDiscovery` calls benign no-ops (the second claim just returns zero rows) — but it does mean the client can fire many more Server Action invocations (and many more claim RPC calls) than the UI's single-slice-per-poll model implies, adding avoidable load for zero benefit.

**Fix:** Guard with an in-flight flag so overlapping polls skip rather than queue:
```ts
let inFlight = false;
async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    await tickDiscovery(jobId);
    // ...
  } finally {
    inFlight = false;
  }
}
```

## Info

### IN-01: `killSwitchTripped` prop on `DiscoveryInput` is dead — never passed by any caller

**File:** `src/components/discovery-input.tsx:22-24, 39`, `src/app/(app)/discover/page.tsx:39`
**Issue:** `DiscoveryInput` accepts an optional `killSwitchTripped` prop and renders a full disabled-state UI branch for it (lines 93-100, disables every field), but the only call site, `/discover/page.tsx:39`, renders `<DiscoveryInput />` with no props, so this always evaluates to the default `false`. There is no server-resolved kill-switch check anywhere in the reviewed files that would ever flip this to `true` — the "globally-tripped kill switch" the doc comment describes does not appear to be wired to any real signal yet.
**Fix:** Either wire a real server-side kill-switch check into `/discover/page.tsx` (e.g., a recent-failure-rate check against `discovery_jobs`) and pass it down, or remove the unused prop/branch until that mechanism exists, to avoid the dead code implying a protection that isn't actually active.

### IN-02: `priceMax`/`sizeMin`/`roomsMin` FormData overrides accept negative values, silently producing an all-excluding filter

**File:** `src/actions/start-discovery.ts:115-129`
**Issue:** `Number.isFinite(n)` rejects `NaN`/`±Infinity` but not negative numbers. A `priceMax` of `-1` (whether from a UI bug or a crafted request) passes the check and is merged into the filter; `filterCandidates` (`candidate.ts:112-113`) will then reject every real candidate (`candidate.price > -1` is true for any realistic listing price), producing a job that silently completes with zero results rather than surfacing a validation error to the user.
**Fix:** Add a non-negativity check alongside `Number.isFinite`, e.g. `if (Number.isFinite(n) && n >= 0) mergedFilter.priceMax = n;`, consistently across all three numeric overrides.

---

_Reviewed: 2026-07-07T09:53:29Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
