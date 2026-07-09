-- Tighten write-side RLS on the shared macro_snapshots cache table (CR-01,
-- defense-in-depth alongside the mandatory read-side re-validation added in
-- macro.ts's readThroughMacroCache).
--
-- 006_macro_snapshots.sql is ALREADY APPLIED/pushed — per project convention
-- we never edit an already-applied migration to change its behavior, we add
-- a new numbered one (see .claude memory: "Supabase migration already
-- applied"). This migration REPLACES the INSERT/UPDATE policies from 006
-- with equivalent-but-tightened versions; it does not touch the SELECT
-- policy or the table's shape.
--
-- The gap (CR-01): both the INSERT policy's `with check` and the UPDATE
-- policy's implicit reused `using` clause (Postgres reuses `using` as the
-- check on the new row when an UPDATE policy omits `with check`) only assert
-- `auth.uid() is not null` — there is no constraint on `scope`, `region_code`,
-- or `payload` at all. Any authenticated user's session can upsert an
-- arbitrary JSON payload under any scope/region_code value directly via
-- PostgREST. This migration adds a real structural `with check` matching the
-- known `scope` enum and a well-formed `region_code`, on BOTH policies.
--
-- This is explicitly DEFENSE-IN-DEPTH, not the primary control: the primary
-- control is the mandatory read-side `safeParse` re-validation in
-- `readThroughMacroCache` (macro.ts) added in the same fix pass, which
-- rejects a poisoned/shape-drifted row regardless of what RLS allowed to be
-- written. RLS cannot validate the shape of `payload` (a jsonb blob) against
-- a Zod schema — it can only constrain the known scalar columns
-- (`scope`, `region_code`), which is what this migration does.
--
-- region_code covers: the 21 SCB län codes ("01"-"25", 2 digits) and the
-- literal "SE" national/no-coords fallback key used by both the national and
-- (no-coords) regional cache scopes (macro.ts's NATIONAL_CACHE_KEY /
-- `lanCode ?? "SE"`). The pattern below accepts 2-25 alphanumeric chars,
-- which is intentionally slightly looser than an exact enum (a stricter
-- CHECK constraint on the column itself is a larger, separate change,
-- out of scope for this fix pass) but still closes the "any string of any
-- shape" gap entirely.

drop policy if exists "Authenticated users can insert macro snapshots"
  on public.macro_snapshots;

create policy "Authenticated users can insert macro snapshots"
  on public.macro_snapshots for insert
  with check (
    auth.uid() is not null
    and scope in ('national', 'regional')
    and region_code ~ '^[A-Za-z0-9]{2,25}$'
    and payload is not null
  );

drop policy if exists "Authenticated users can update macro snapshots"
  on public.macro_snapshots;

create policy "Authenticated users can update macro snapshots"
  on public.macro_snapshots for update
  using (auth.uid() is not null)
  with check (
    auth.uid() is not null
    and scope in ('national', 'regional')
    and region_code ~ '^[A-Za-z0-9]{2,25}$'
    and payload is not null
  );
