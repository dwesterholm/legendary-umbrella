-- Phase 9 (Discovery Foundation): the discovery_jobs state-machine table +
-- the claim_discovery_slice atomic RPC.
--
-- 009_brf_auto_fetch.sql is ALREADY APPLIED/pushed — per project convention
-- we never edit an already-applied migration (db push will not re-run it),
-- we add a new numbered one (see .claude memory: "Supabase migration
-- already applied"). 009 is the latest applied migration, so 010 is the
-- free slot.
--
-- This migration is ADDITIVE ONLY: a brand-new table + a brand-new
-- function. No existing table/column is altered and no existing rows are
-- touched.

-- discovery_jobs: one row per free-text area search. `status` is a bare
-- `text` column with NO check constraint — mirrors the `brf_status`
-- decision in 009 (a new status word never needs DDL). Vocabulary:
-- pending / processing / done / failed / degraded.
create table public.discovery_jobs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  status text not null default 'pending',
  -- Freshness marker read by claim_discovery_slice's stale-reclaim branch
  -- (mirrors generateReport's STALE_LOCK_MS reclaim window). Nullable: a
  -- 'pending' job has never been claimed yet.
  claimed_at timestamptz,
  free_text text not null,
  filters jsonb not null,
  cap_candidates int not null,
  cap_sek numeric not null,
  processed_count int not null default 0,
  candidate_count int not null default 0,
  cost_sek_total numeric not null default 0,
  -- Orthogonal flag (09-UI-SPEC.md line 134) — composes with a running/done
  -- status rather than being a status value itself.
  cap_reached boolean not null default false,
  -- PII-safe candidate shape only (src/lib/discovery/candidate.ts) — never
  -- raw scraped/Apollo payloads.
  results jsonb not null default '[]',
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index discovery_jobs_user_id_created_at_idx
  on public.discovery_jobs (user_id, created_at desc);

alter table public.discovery_jobs enable row level security;

-- Owner-only RLS. UPDATE is included (unlike 001_analyses.sql's
-- select+insert-only shape) because the client-tick path updates the
-- running counters under the user's own session; the claim RPC itself
-- runs SECURITY DEFINER and bypasses RLS entirely for the atomic claim.
create policy "Users can view own discovery jobs"
  on public.discovery_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert own discovery jobs"
  on public.discovery_jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own discovery jobs"
  on public.discovery_jobs for update
  using (auth.uid() = user_id);

-- claim_discovery_slice: the genuinely-new mechanism this phase requires
-- (09-PATTERNS.md). PostgREST's query builder cannot express `FOR UPDATE
-- SKIP LOCKED` — this is a real atomic claim, not a conditional UPDATE.
-- Verbatim from 09-RESEARCH.md lines 251-282 / 09-PATTERNS.md lines 75-104
-- (pattern cross-verified against 3+ independent Postgres job-queue
-- sources; not re-derived here).
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
