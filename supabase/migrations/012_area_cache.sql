-- Shared area-name → Booli areaId cache (DISC area-resolution, Phase 9 follow-up).
--
-- Booli exposes no free-text area endpoint we can hit server-side (its
-- areaSuggestionSearch GraphQL is Cloudflare-gated — see
-- src/lib/booli/area-suggestion-page-function.ts), so resolving a free-text
-- area name costs a headless-browser render. This table is a SHARED, learn-as-
-- you-go cache: the first time anyone resolves "Hornstull" we pay the Booli
-- render once and persist the result; every later search for that area is a
-- free DB read. Over time the cache covers the popular areas and Booli's own
-- search is hit less and less.
--
-- Same SHARED-cache posture as macro_snapshots (006): non-PII, publicly-derived
-- data (Booli area ids are public), so any authenticated app user may read and
-- upsert. The area_id CHECK constraint (digits only) is a light integrity guard
-- — the value always originates from Booli's own response in the real flow, but
-- the constraint keeps obviously-junk writes out. The service-role sweep client
-- bypasses RLS; the user-session client (tickDiscovery) relies on the
-- authenticated policies below. This mirrors 008's corrected policy shape
-- (UPDATE carries WITH CHECK, not just USING).
create table if not exists public.area_cache (
  -- normalized lookup key: the free-text area name, trimmed + lowercased.
  query_key text primary key,
  -- the resolved Booli areaId (opaque integer id, stored as text).
  area_id text not null check (area_id ~ '^[0-9]+$'),
  -- human label for the resolved area, e.g. "Vasastan, Stockholms kommun".
  label text,
  -- how it was first resolved ('probe' — the only path that writes here).
  source text not null default 'probe',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.area_cache enable row level security;

-- Any authenticated user may read the shared cache (non-PII public data).
create policy "Authenticated users can read area cache"
  on public.area_cache for select
  using (auth.uid() is not null);

-- Any authenticated user may insert a fresh cache row (resolution cache miss).
create policy "Authenticated users can insert area cache"
  on public.area_cache for insert
  with check (auth.uid() is not null);

-- Any authenticated user may update an existing row (upsert refresh). Carries
-- WITH CHECK as well as USING so a row can never be updated into a state the
-- INSERT policy would have rejected (008's lesson).
create policy "Authenticated users can update area cache"
  on public.area_cache for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
