-- Shared macro-indicator cache (MACRO-01/MACRO-02, Phase 7 Plan 1).
--
-- macro_snapshots is a NEW SHARED (non-owner-scoped) cache table — UNLIKE every
-- prior migration in this project (003/004/005 only ever added columns to the
-- already-RLS'd `analyses` table and therefore declared NO new RLS policy,
-- correctly relying on the existing per-user policies from 001/002). This
-- table has NO user_id column: it caches Riksbank policy-rate / SCB CPIF /
-- SCB regional-price figures that are IDENTICAL for every analysis resolving
-- to the same (scope, region_code) within a TTL window, so it cannot be
-- owner-scoped without defeating its own purpose as a cross-user cache.
--
-- Because this is the first genuinely shared table, the "no new policy
-- needed" convention does NOT transfer. If RLS were enabled here with no
-- explicit policy, Postgres default-denies ALL access (select AND
-- insert/update) and the macro branch in enrichMarketContext would silently
-- fail every cache read/write — not a data leak, but a total, hard-to-debug
-- lockout (see 07-RESEARCH.md Pitfall 2 + Security Domain V4 Access Control).
--
-- The data cached here is non-sensitive, non-PII, publicly-sourced macro
-- statistics (Riksbank policy rate, SCB CPIF, SCB regional BRF price
-- figures) — there is no confidentiality reason to restrict it beyond
-- "must be an authenticated app user." There is also no service-role
-- Supabase client anywhere in this codebase (every write goes through the
-- authenticated user's session client, src/lib/supabase/server.ts), so the
-- pragmatic and deliberate policy is: any authenticated user may SELECT and
-- upsert (INSERT + UPDATE) this table (RESEARCH Assumption A4). This is a
-- deliberate first-in-project "any authenticated user" shared-table pattern,
-- not an oversight — flagged here for future reviewers.
create table if not exists public.macro_snapshots (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  region_code text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (scope, region_code)
);

alter table public.macro_snapshots enable row level security;

-- Any authenticated user may read the shared cache (A4 — non-PII public data).
create policy "Authenticated users can read macro snapshots"
  on public.macro_snapshots for select
  using (auth.uid() is not null);

-- Any authenticated user may insert a fresh cache row (read-through cache miss).
create policy "Authenticated users can insert macro snapshots"
  on public.macro_snapshots for insert
  with check (auth.uid() is not null);

-- Any authenticated user may update a stale cache row (read-through cache
-- refresh uses .upsert(), which requires BOTH insert and update policies).
create policy "Authenticated users can update macro snapshots"
  on public.macro_snapshots for update
  using (auth.uid() is not null);
