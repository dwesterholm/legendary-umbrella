-- Phase 9 code-review fixes (09-REVIEW.md CR-01, WR-01).
--
-- 010_discovery_jobs.sql is ALREADY APPLIED/pushed — per project convention
-- we never edit an already-applied migration (db push will not re-run it),
-- we add a new numbered one (see .claude memory: "Supabase migration
-- already applied"). 010 is the latest applied migration, so 011 is the
-- free slot.
--
-- This migration is ADDITIVE/REPLACE-FUNCTION ONLY: no table/column is
-- altered and no existing rows are touched.

-- CR-01: claim_discovery_slice had NO ownership check in its body. It is
-- `security definer` (bypasses RLS by design) and granted `execute` to
-- `authenticated` directly, so PostgREST exposes it at
-- `/rest/v1/rpc/claim_discovery_slice` — any authenticated user could call
-- it with an arbitrary `p_job_id` and claim/drive/spend another user's job,
-- entirely bypassing tickDiscovery's app-level ownership pre-check (that
-- check only guards the one call site going through the Server Action, not
-- the independently-reachable, independently-privileged RPC itself).
--
-- Fix: enforce ownership INSIDE the function body (SECURITY DEFINER
-- functions must do their own authorization since RLS is bypassed) — a
-- claim is only allowed when the caller's own `auth.uid()` matches the
-- job's `user_id`, OR the caller is `service_role` (the once-daily cron
-- sweep in /api/discovery/sweep must still be able to reclaim ORPHANED
-- jobs across all users — that is its entire purpose). `auth.role()` reads
-- the `role` claim off the request JWT; the service_role API key IS a JWT
-- with `role: service_role`, which is the standard Supabase idiom for this
-- exact "trusted server-only bypass" check inside a definer function.
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
      -- NEW (CR-01): only the owning user may claim their own job, unless
      -- the caller is the service_role (the cron sweep's cross-user orphan
      -- reclaim path — see /api/discovery/sweep's CRON_SECRET-gated route).
      and (auth.uid() = user_id or auth.role() = 'service_role')
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

-- Grants are unchanged by the CREATE OR REPLACE (grants attach to the
-- function's name+signature, not its body) — re-stated here for clarity
-- and to survive a future signature change.
revoke all on function claim_discovery_slice(uuid, integer) from public;
grant execute on function claim_discovery_slice(uuid, integer) to authenticated;
grant execute on function claim_discovery_slice(uuid, integer) to service_role;

-- WR-01: the per-user-per-day discovery job cap (T-09-09) was enforced in
-- app code as a plain `SELECT count(*) ...` followed by a separate
-- `INSERT`, with no transaction or constraint tying them together — a
-- classic TOCTOU: two concurrent startDiscovery calls from the same user
-- (double-click, two tabs, a scripted burst) can both read `count < 5`
-- before either has inserted, letting the effective cap be exceeded by the
-- degree of concurrency.
--
-- Fix: fold the count-check and the insert into ONE atomic RPC, serialized
-- per-user via `pg_advisory_xact_lock`. A plain COUNT-then-INSERT inside a
-- single plpgsql call is NOT by itself immune to the same race under
-- default READ COMMITTED — two concurrent invocations for the SAME user
-- could still both run their COUNT before either commits its INSERT. The
-- advisory transaction lock (keyed on hashtext(user_id), released
-- automatically at the end of the calling transaction/statement) forces
-- concurrent calls for the SAME user to serialize: the second caller blocks
-- until the first's insert has committed, so its COUNT always sees the
-- first caller's row. Concurrent calls for DIFFERENT users use different
-- lock keys and never block each other. This mirrors
-- claim_discovery_slice's own "atomic RPC over app-level check-then-act"
-- precedent (09-PATTERNS.md), using an advisory lock instead of `FOR UPDATE
-- SKIP LOCKED` since there is no existing row to lock before the first
-- insert.
--
-- SECURITY DEFINER is required because the function must both COUNT across
-- (potentially) rows subject to RLS and INSERT on behalf of the calling
-- user — it enforces its OWN ownership discipline instead (every row it
-- touches or inserts is scoped to auth.uid(), never a caller-supplied
-- user_id), so RLS bypass here does not introduce a new IDOR: the function
-- ignores any caller-supplied identity and always uses auth.uid().
create or replace function insert_discovery_job_if_under_cap(
  p_free_text text,
  p_filters jsonb,
  p_cap_candidates int,
  p_cap_sek numeric,
  p_jobs_per_day_cap int
)
returns table (id uuid, capped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_count int;
  v_new_id uuid;
begin
  if v_user_id is null then
    raise exception 'insert_discovery_job_if_under_cap requires an authenticated caller';
  end if;

  -- Serialize concurrent callers for the SAME user only (WR-01). Held for
  -- the duration of the calling transaction (PostgREST wraps each RPC call
  -- in its own transaction), so it is automatically released when this
  -- call finishes — no explicit unlock needed, and no risk of an orphaned
  -- lock outliving the request.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- Count this user's jobs created in the last 24h. With the advisory lock
  -- held, a second concurrent call for the same user cannot reach this
  -- COUNT until the first call's INSERT (below) has committed, so the
  -- count always reflects any in-flight sibling call.
  select count(*) into v_count
  from discovery_jobs
  where user_id = v_user_id
    and created_at >= now() - interval '24 hours';

  if v_count >= p_jobs_per_day_cap then
    return query select null::uuid, true;
    return;
  end if;

  insert into discovery_jobs (
    user_id, status, free_text, filters, cap_candidates, cap_sek,
    processed_count, candidate_count, cost_sek_total
  ) values (
    v_user_id, 'pending', p_free_text, p_filters, p_cap_candidates, p_cap_sek,
    0, 0, 0
  )
  returning discovery_jobs.id into v_new_id;

  return query select v_new_id, false;
end;
$$;

revoke all on function insert_discovery_job_if_under_cap(text, jsonb, int, numeric, int) from public;
grant execute on function insert_discovery_job_if_under_cap(text, jsonb, int, numeric, int) to authenticated;
