# Phase 9: Discovery Foundation - Pattern Map

**Mapped:** 2026-07-07
**Files analyzed:** 14 (new) + 0 (modified — this phase is purely additive)
**Analogs found:** 11 / 14 (3 explicitly flagged as genuinely new — no codebase precedent)

## File Classification

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|-----------------|----------------|
| `supabase/migrations/010_discovery_jobs.sql` (table) | migration | CRUD | `supabase/migrations/001_analyses.sql` | role-match |
| `supabase/migrations/010_discovery_jobs.sql` (`claim_discovery_slice` RPC) | migration/RPC | event-driven (atomic claim) | `src/actions/generate-report.ts` CAS lock (partial) + RESEARCH SQL | **genuinely new** |
| `src/lib/discovery/filter-schema.ts` | model/schema | transform | `src/lib/schemas/brf.ts` (canonical schema) | role-match |
| `src/lib/discovery/parse-intent.ts` | service | request-response | `src/lib/brf/extract.ts` | exact |
| `src/lib/discovery/resolve-area.ts` | service | streaming (browser interaction) | `src/lib/booli/client.ts` (`resolveAreaId`) + `src/lib/booli/page-functions.ts` | role-match (new interaction mode) |
| `src/lib/discovery/candidate.ts` | transform/utility | transform | `src/lib/booli/client.ts` (`extractListingEntities`/shape mapping) | role-match |
| `src/lib/discovery/cost.ts` | utility | transform | `src/lib/market/cost.ts` | exact |
| `src/lib/discovery/job.ts` | service | event-driven | `src/actions/generate-report.ts` (orchestration/lock shape) | role-match |
| `src/actions/start-discovery.ts` | controller (Server Action) | request-response | `src/actions/analyze.ts` / `src/actions/generate-report.ts` | exact |
| `src/actions/tick-discovery.ts` | controller (Server Action) | event-driven (queue advance) | `src/actions/generate-report.ts` (lock-acquire shape) | **genuinely new** (tick-driven queue advancement) |
| `src/app/(app)/discover/page.tsx` | route | request-response | `src/app/(app)/analysis/[id]/page.tsx` (server component + auth + notFound) | role-match |
| `src/app/(app)/discover/[jobId]/page.tsx` | route | request-response | `src/app/(app)/analysis/[id]/page.tsx` | exact |
| `src/components/discovery-progress.tsx` | component | streaming (polling) | `src/components/brf-progress.tsx` | exact |
| `src/components/discovery-input.tsx` | component | request-response | `src/components/url-input.tsx` | exact |
| `src/components/discovery-candidate-card.tsx` | component | CRUD (read) | `src/components/analysis-card.tsx` | exact |
| `src/app/api/discovery/sweep/route.ts` | route (cron target) | batch | none in codebase (first Route Handler / cron target) | **genuinely new** |

## Pattern Assignments

### `supabase/migrations/010_discovery_jobs.sql` (migration, table)

**Analog:** `supabase/migrations/001_analyses.sql`

**Table + RLS pattern** (001_analyses.sql lines 1-25):
```sql
create table public.analyses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  ...
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index analyses_user_id_created_at_idx
  on public.analyses (user_id, created_at desc);

alter table public.analyses enable row level security;

create policy "Users can view own analyses"
  on public.analyses for select
  using (auth.uid() = user_id);

create policy "Users can insert own analyses"
  on public.analyses for insert
  with check (auth.uid() = user_id);
```
Copy this shape verbatim for `discovery_jobs`: `user_id`, RLS owner-only SELECT/INSERT, indexed by `(user_id, created_at desc)`. Add `status text not null default 'pending'`, `claimed_at timestamptz`, `processed_count int not null default 0`, `candidate_count int not null default 0`, `cost_sek_total numeric not null default 0`, `cap_candidates int not null`, `cap_sek numeric not null`, `filters jsonb not null`, `free_text text not null`, `results jsonb not null default '[]'`. Follow the numbering convention documented in `009_brf_auto_fetch.sql`'s header comment — **never edit an already-applied migration**; this is migration 010, the next free slot (memory: "Supabase migration already applied").

**Additive-nullable / never-edit-applied convention** (009_brf_auto_fetch.sql lines 1-7):
```sql
-- 002_brf.sql is ALREADY APPLIED/pushed — per project convention we never
-- edit an already-applied migration to add a column (db push will not
-- re-run it), we add a new numbered one (see .claude memory: "Supabase
-- migration already applied"). 008 is the latest applied migration, so 009
-- is the free slot.
```

---

### `supabase/migrations/010_discovery_jobs.sql` (RPC `claim_discovery_slice`) — GENUINELY NEW MECHANISM

**No true analog exists.** `generate-report.ts`'s CAS lock (lines 256-274) is the closest *conceptual* precedent (an atomic "acquire the lock, only if not already held" flip) but it is a single-row conditional `UPDATE ... WHERE ... RETURNING`, which PostgREST's query builder CAN express because there's exactly one candidate row. `FOR UPDATE SKIP LOCKED` over a CTE is NOT expressible via PostgREST's query builder at all — it requires a `SECURITY DEFINER` Postgres function. Use RESEARCH.md's SQL verbatim as the starting point (already vetted against 3+ external sources):

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

revoke all on function claim_discovery_slice(uuid, integer) from public;
grant execute on function claim_discovery_slice(uuid, integer) to authenticated;
```

**PostgREST NULL-filter trap (reuse the discipline, not the mechanism)** — `generate-report.ts` lines 238-274 show the exact three-valued-logic bug this project already hit twice (memory: `postgrest-eq-null.md`). The RPC sidesteps it entirely by doing the predicate in SQL (`claimed_at is null`, `.is()`-equivalent), but any OTHER status read/write path added around discovery (e.g. a manual admin query) must use `.is(col, null)` / `.or(...)`, never `.eq(col, null)`.

**Caller pattern** (RESEARCH.md, to live in `tick-discovery.ts`):
```typescript
const { data: claimed, error } = await supabase
  .rpc("claim_discovery_slice", { p_job_id: jobId })
  .maybeSingle();
if (error) { /* fail closed, log { jobId, code }, return */ }
if (!claimed) { /* another tick already owns this slice — benign no-op */ return; }
// proceed using claimed.cost_sek_total / claimed.processed_count — the
// SAME row version returned by the claim, never a fresh SELECT (Pitfall 4).
```

---

### `src/lib/discovery/parse-intent.ts` (service, request-response)

**Analog:** `src/lib/brf/extract.ts`

**Imports + module-scope client pattern** (extract.ts lines 1-20):
```typescript
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";

const client = new Anthropic();
const MODEL = "claude-haiku-4-5-20251001";
```
Reuse exactly — same model id, same module-scope singleton reading `ANTHROPIC_API_KEY` server-only (never reaches the browser).

**Slim Claude-facing schema discipline** (extract.ts lines 29-89, comment lines 32-46):
```typescript
// ONLY `value` is nullable (28→7 unions) and there are NO numeric
// range/int constraints — avoids the two documented Anthropic strict-output
// 400s: "grammar too large" and "too many union-type params".
```
Apply directly to `intentFilterSchema` (per RESEARCH.md Code Examples): no `.min()/.max()/.int()` chains, minimal nullable fields. This project's own memory file (`anthropic-structured-output-limits.md`) makes this a hard constraint, not a style preference.

**Call pattern:**
```typescript
const result = await client.beta.messages.parse({
  model: MODEL,
  max_tokens: 512,
  system: INTENT_PARSE_SYSTEM_PROMPT,
  messages: [{ role: "user", content: freeText }],
  output_config: { format: zodOutputFormat(intentFilterSchema) },
});
```
Free text is sent as **user-message content only**, never concatenated into the system prompt (prompt-injection mitigation — mirrors the existing T-08-01 discipline).

---

### `src/lib/discovery/resolve-area.ts` (service, new interaction mode on owned transport)

**Analog:** `src/lib/booli/client.ts` (`resolveAreaId`, lines ~482+) + `src/lib/booli/page-functions.ts` (`APOLLO_PAGE_FUNCTION`)

`resolveAreaId` today only derives an areaId from an EXISTING listing's breadcrumb ladder — it does NOT resolve a free-text place name. This phase needs a **new** page-function/interaction (Wave 0 exploratory task per RESEARCH Open Question 1/4): extend the `runPlaywrightRender` transport to type into `#area-search-field`, click the first suggestion, and capture the resulting `areaIds=` param. Reuse:
- `isBooliUrl` (client.ts line 298) for any URL construction/validation in this new file — do not hand-roll a new hostname allowlist.
- `runPlaywrightRender`'s existing `waitSecs: 240` transport (transport.ts line 79) as the render primitive; write a new page-function sibling to `APOLLO_PAGE_FUNCTION` rather than modifying it in place.

**Fallback (if live probe fails):** a small, human-curated, v1-scoped seed list of Stockholm-region kommun/neighborhood IDs rendered as a dropdown — explicitly NOT a comprehensive hardcoded `AREA_ID_MAP` (RESEARCH Pitfall 3 warns against this pattern appearing in a diff).

---

### `src/lib/discovery/candidate.ts` (transform, PII-safe shape)

**Analog:** `src/lib/booli/client.ts`'s `extractListingEntities`/rung-walk result shaping (used inside `fetchAreaListings`)

**Core pattern:** deterministic, in-code filtering of the Apollo entity array against the structured filter (`filter-schema.ts` output) — never Claude-driven. Persist an **explicit allowlist** shape only:
```typescript
// PII/GDPR guardrail (locked decision) — never a passthrough of the Apollo
// entity or broker-page text. Mirrors "v1 auto-fetch stores no raw HTML for
// audit" convention from Phase 8 (STATE.md).
interface DiscoveryCandidate {
  address: string;
  price: number;
  rooms: number;
  livingArea: number;
  areaLabel: string;
  thumbnailUrl: string | null;
  sourceListingUrl: string; // for the "Se full analys" link, not raw scrape payload
}
```
Never store the raw Apollo `Listing:` entity or broker description text (which may contain seller/occupant PII).

---

### `src/lib/discovery/cost.ts` (utility, exact copy pattern)

**Analog:** `src/lib/market/cost.ts` (mirrors `src/lib/brf/cost.ts`)

**Full pattern** (market/cost.ts lines 1-30):
```typescript
export const USD_PER_RENDER = 0.0055 as const;
export const USD_SEK_RATE = 11;
export const SOLD_SOURCE_COST_CAP_SEK = 1.0;

export interface SoldSourceUsage {
  renders: number;
}

export function soldSourceCostSek(usage: SoldSourceUsage): number {
  // renders * USD_PER_RENDER converted via USD_SEK_RATE
}
```
`discoveryCostSek` (RESEARCH Code Examples) composes `costSek` (Haiku intent-parse cost, from `brf/cost.ts`) + `renders * USD_PER_RENDER * USD_SEK_RATE`:
```typescript
export function discoveryCostSek(usage: {
  haikuUsage: ClaudeUsage;
  renders: number;
}): number {
  const haikuSek = costSek(usage.haikuUsage);
  const renderSek = usage.renders * USD_PER_RENDER * USD_SEK_RATE;
  return haikuSek + renderSek;
}
```
**Generalize to incremental per-slice checks** (new discipline, no direct precedent): existing `COST_CAP_SEK`/`SOLD_SOURCE_COST_CAP_SEK` gates are checked ONCE at persist time. This phase must check `cost_sek_total` (read from the claim RPC's `RETURNING` row, never a stale snapshot — Pitfall 4) BEFORE each render inside a tick, not only at job completion.

---

### `src/lib/discovery/job.ts` + `src/actions/tick-discovery.ts` (orchestration) — TICK-DRIVEN QUEUE ADVANCEMENT IS GENUINELY NEW

**Analog (partial, lock/orchestration shape only):** `src/actions/generate-report.ts`

**Stale-lock reclaim window pattern** (generate-report.ts lines 32-39):
```typescript
const STALE_LOCK_MS = 5 * 60 * 1000;
```
Mirror this constant shape for `p_stale_ms` default in the RPC (RESEARCH uses `300000` = 5 min, same value).

**Auth + ownership check pattern** (generate-report.ts lines ~163-186):
```typescript
const { data: { user } } = await supabase.auth.getUser();
if (!user) return { ok: false, error: "Logga in för AI-rapport" };

const { data: row, error: rowError } = await supabase
  .from("analyses")
  .select("id, user_id, ...")
  .eq("id", analysisId)
  .single();
if (rowError || !row || row.user_id !== user.id) {
  return { ok: false, error: "Analysen hittades inte." };
}
```
Copy directly into both `start-discovery.ts` (auth + feature-flag-first, per Pitfall 5) and `tick-discovery.ts` (ownership check before claim).

**What is genuinely new (no precedent anywhere in codebase):** the client-tick-drives-the-queue architecture itself — each client poll round-trip both reads status AND invokes a Server Action that claims-and-executes ONE bounded slice of server-side work. `BrfProgress` only *reads* state; nothing in the codebase today has a client poll that *also* advances a job. Build per RESEARCH.md Pattern 1 and the sequence diagram — this is new composition, not a copy.

---

### `src/actions/start-discovery.ts` (controller, request-response)

**Analog:** `src/actions/generate-report.ts` (auth-first ordering) + `src/actions/analyze.ts` (form validation shape)

**Feature-flag-first-line discipline (NEW, no direct precedent — see below)** must be the literal first check, before auth, mirroring how `generate-report.ts` puts its auth check before any work:
```typescript
"use server";
export async function startDiscovery(formData: FormData) {
  if (process.env.DISCOVERY_ENABLED !== "true") {
    return { ok: false, error: "Funktionen är inte tillgänglig." };
  }
  // ...then auth check, then Haiku parse, then insert
}
```

---

### `src/app/api/discovery/sweep/route.ts` (cron target) — GENUINELY NEW

**No analog exists** — this is the first Vercel Cron Route Handler in the codebase (`grep` for `crons` in `vercel.json` and for `export async function GET` under `src/app/api/` found nothing comparable). Build per RESEARCH.md's `vercel.json` config and sequence diagram: a `GET` handler that finds jobs stuck `processing` with stale `claimed_at`, reclaims via the SAME `claim_discovery_slice` RPC's stale branch. Declare `export const maxDuration = 300;` explicitly (Pitfall 2).

---

### `src/app/(app)/discover/page.tsx` + `[jobId]/page.tsx` (routes)

**Analog:** `src/app/(app)/analysis/[id]/page.tsx`

**Server component + auth + notFound pattern** (analysis/[id]/page.tsx lines 1-22):
```typescript
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// ownership check -> notFound() if missing/not-owned, mirrors RLS defense-in-depth
```
For the feature-flag-off case, the UI-SPEC (lines 112-116) locks: direct URL access to `/discover` or `/discover/[jobId]` while OFF resolves via the SAME `notFound()` path as a missing analysis row — never a "feature disabled" message (avoid leaking the hidden feature's existence).

---

### `src/components/discovery-progress.tsx` (component, streaming/polling)

**Analog:** `src/components/brf-progress.tsx` (full file read, 120+ lines)

**Exact polling shape to copy** (brf-progress.tsx lines 1-100):
```typescript
"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const POLL_MS = 1500;
const MAX_POLL_MS = 90_000; // DISCRETION: raise to 5*60_000 for discovery (UI-SPEC line 131)

useEffect(() => {
  const supabase = createClient();
  let active = true;

  async function poll() {
    const { data } = await supabase
      .from("analyses") // -> "discovery_jobs"
      .select("brf_status") // -> "status, processed_count, candidate_count, cost_sek_total"
      .eq("id", analysisId)
      .single();
    if (!active) return;
    // ...set state, terminal-status check -> onComplete + clearInterval/clearTimeout
  }

  void poll();
  const interval = setInterval(poll, POLL_MS);
  const timeout = setTimeout(() => { /* MAX_POLL_MS safety ceiling */ }, MAX_POLL_MS);
  return () => { active = false; clearInterval(interval); clearTimeout(timeout); };
}, [analysisId, onComplete]);
```
**Extension needed (new, per RESEARCH Pattern 1):** each `poll()` call must ALSO invoke `tickDiscovery(jobId)` server action before/alongside the `select` — this is the one place `discovery-progress.tsx` diverges from `brf-progress.tsx`'s pure read.

**Terminal-state / `initialStatus` resume pattern** (brf-progress.tsx lines 11-13, 55): server-resolved initial status prop so a reload doesn't flash "queued" — copy directly.

**Status vocabulary difference:** `BrfProgress` uses a 3-step `STEPS` list; UI-SPEC (line 132) explicitly chooses a single live counter line instead ("{n} av {total} annonser analyserade") + a status `Badge`, not a step-dot list — do not copy the `STEPS`/`stepIndex` machinery, only the polling/cleanup skeleton.

---

### `src/components/discovery-input.tsx` (component, request-response)

**Analog:** `src/components/url-input.tsx` (full file, 103 lines)

**Full pattern to copy** (url-input.tsx lines 1-103): `useTransition` + `FormData` + client-side required-field validation with inline `text-sm text-terracotta-600` error caption + `Button` with `animate-spin` pending state:
```typescript
"use client";
import { useState, useTransition } from "react";
// ...
const [isPending, startTransition] = useTransition();
function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  if (!freeText.trim()) {
    setError("Beskriv vad du letar efter för att starta sökningen.");
    return;
  }
  startTransition(async () => {
    const result = await startDiscovery(formData);
    if (result.error) { setError(result.error); return; }
    // redirect to /discover/[jobId] on success
  });
}
```
Submit button classes copy verbatim: `bg-sage-600 text-white hover:bg-sage-700 h-11 px-6`, label "Starta sökning" per Copywriting Contract. Add the new `Select`/`Textarea` shadcn primitives (`npx shadcn add select textarea`) for the hard-filter row and free-text field, per UI-SPEC lines 28, 124-125.

---

### `src/components/discovery-candidate-card.tsx` (component, CRUD-read)

**Analog:** `src/components/analysis-card.tsx` (full file read)

**Full pattern to copy** (analysis-card.tsx lines 1-60+): `Link` + `Card`/`CardHeader`/`CardContent`, `group-hover:shadow-md group-hover:border-sage-200`, `formatSEK` from `src/lib/utils.ts`, 3-column metrics grid with the `"---"` missing-value convention:
```typescript
<Link href={`/analysis/${id}`} className="group block">
  <Card className="h-full border-warm-gray-200 bg-warm-white transition-all duration-200 group-hover:shadow-md group-hover:border-sage-200">
    <CardHeader className="pb-2">
      <CardTitle className="text-base font-semibold text-warm-gray-900 line-clamp-2">
        {listingData.address}
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-lg font-semibold text-warm-gray-900">{formatSEK(listingData.price)}</p>
      <div className="grid grid-cols-3 gap-2 text-sm"> ... </div>
    </CardContent>
  </Card>
</Link>
```
**New addition (no precedent in `AnalysisCard`):** the "Källa: Booli" provenance caption — reuse the `SOURCE_CAPTIONS`/"Källa: {sourceLabel}" vocabulary from `listing-summary.tsx`/`report-flags.tsx` (per UI-SPEC line 100). No match score/ranking badge (Phase 10 scope).

---

## Shared Patterns

### Auth + ownership check
**Source:** `src/actions/generate-report.ts` lines 163-186
**Apply to:** `start-discovery.ts`, `tick-discovery.ts`, both `discover` routes
```typescript
const { data: { user } } = await supabase.auth.getUser();
if (!user) return { ok: false, error: "..." };
const { data: row } = await supabase.from(TABLE).select("...").eq("id", id).single();
if (!row || row.user_id !== user.id) return { ok: false, error: "Hittades inte." };
```

### PostgREST NULL-filter trap avoidance
**Source:** `.claude` memory `postgrest-eq-null.md` + `generate-report.ts` lines 238-274
**Apply to:** any status/claimed_at write path outside the RPC (reads are safe; only conditional UPDATEs are the danger zone). The RPC itself sidesteps this by doing the predicate in raw SQL.

### Cost-cap gate (generalized to incremental)
**Source:** `src/lib/brf/cost.ts` (`COST_CAP_SEK` pattern) + `src/lib/market/cost.ts` (`SOLD_SOURCE_COST_CAP_SEK`)
**Apply to:** `discovery/cost.ts` + `job.ts` — same pure-function-plus-named-constant shape, but checked BEFORE each render inside a tick using the claim RPC's `RETURNING` row (never a stale snapshot), not only once at persist time.

### Terracotta "calm warning" banner
**Source:** `src/components/listing-summary.tsx` / `src/components/report-flags.tsx` (`bg-terracotta-50` + `text-terracotta-600`)
**Apply to:** `discovery-progress.tsx` cap-reached banner, kill-switch banner, failed/killed terminal states — never `destructive`-red.

### Feature-flag gate (env-driven, server-only) — GENUINELY NEW
**No existing precedent found** (`grep` across `src/actions`, `src/lib`, `src/app` for non-infra `process.env.*` checks returned nothing). Must be built fresh per RESEARCH Pitfall 5 / UI-SPEC Feature Flag Contract: check `DISCOVERY_ENABLED` (server-only, NOT `NEXT_PUBLIC_*`) as the literal first line of `startDiscovery`, AND gate the UI entry point + route access via `notFound()` — defense in depth, both surfaces independently enforce it.

## No Analog Found (genuinely new — flagged explicitly)

| File/Mechanism | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `claim_discovery_slice` RPC (010 migration) | migration/RPC | event-driven | PostgREST query builder cannot express `FOR UPDATE SKIP LOCKED`; no prior RPC exists in this codebase at all (`generate-report.ts`'s CAS is a plain conditional UPDATE, not a Postgres function) |
| Client-tick-drives-queue architecture (`tick-discovery.ts` + `discovery-progress.tsx`'s tick-on-poll) | service + component | event-driven | `BrfProgress` only reads state; nothing currently combines "poll" with "also advance the job" in one round-trip |
| `src/app/api/discovery/sweep/route.ts` (Vercel Cron target) | route | batch | First Route Handler / `vercel.json` cron config in the codebase — no analog Route Handler under `api/` was found serving a cron target |
| Feature-flag env-gate pattern | middleware/config | request-response | No existing `process.env.*`-driven feature flag anywhere in `src/actions`, `src/lib`, or `src/app` (confirmed via grep) — this phase establishes the convention |
| Free-text area-name → Booli `areaId` resolution (browser-interaction probe) | service | streaming | `resolveAreaId` only derives from an existing listing's breadcrumbs; typing-and-clicking a search box via Playwright is a new interaction mode for the owned transport — Wave 0 exploratory task, not assumed to "just work" |

## Metadata

**Analog search scope:** `supabase/migrations/`, `src/lib/booli/`, `src/lib/market/`, `src/lib/brf/`, `src/actions/`, `src/components/`, `src/app/(app)/`
**Files scanned:** ~25 (migrations 001-009, client.ts, transport.ts, page-functions.ts, extract.ts, cost.ts ×2, generate-report.ts, analyze.ts, url-input.tsx, brf-progress.tsx, analysis-card.tsx, analysis/[id]/page.tsx, listing-summary.tsx references)
**Pattern extraction date:** 2026-07-07
