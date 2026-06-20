-- Market-context persistence layer.
-- Adds market_* / *_data columns to analyses. Additive only: the new columns
-- are covered by the EXISTING per-user RLS (SELECT from 001_analyses.sql,
-- UPDATE from 002_brf.sql), so this migration defines NO new RLS policy.
-- Re-declaring the "Users can update own analyses" UPDATE policy would error
-- on a duplicate declaration and leave the schema half-applied. No storage
-- bucket this phase (no file upload — market data is fetched, not uploaded).
--
-- 1. Market-context columns on the existing analyses row (idempotent).
--    price_data  : PRICE-01 sold-price comparison result (computed ±%, comps,
--                  tier, confidence, source + freshness labels). Carries a
--                  `reason` discriminator: ok | thin | source_unavailable |
--                  listing_pris_okand (see Plan 04). `source_unavailable` is
--                  how a dead/unreachable sold source is recorded distinctly
--                  from a genuinely-thin area (HIGH-1) — it is a runtime-degrade
--                  reason, NOT the default state (the Booli SSR source is
--                  confirmed working, 03-SPIKE.md). When price is
--                  source_unavailable, market_status stays 'done' because the
--                  area panel may still be populated.
--    area_data   : AREA-01 SCB demographics result (four metrics, geo level,
--                  source + freshness labels).
--    market_status: null | 'fetching' | 'done' | 'failed' (mirrors brf_status, D-13).
--                  STATE MACHINE:
--                    null      = never enriched yet -> the page shows the
--                                "Hämta marknadsdata" fetch affordance, exactly
--                                mirroring how brf_status null = upload affordance
--                                (002_brf.sql).
--                    'fetching'= enrichment in flight.
--                    'done'    = enriched (ANY partial success counts, including
--                                a price_data.reason of source_unavailable — the
--                                dead-source distinction lives in
--                                price_data.reason, NOT in a separate status).
--                    'failed'  = nothing usable persisted.
--    market_source: which sold-source produced price_data (03-SPIKE.md decision),
--                  for the D-09 source label / freshness auditing.
--    market_cost_sek: persisted per-analysis sold-source cost (mirrors
--                  brf_cost_sek), for the cost guard in Plan 05.
alter table public.analyses add column if not exists price_data jsonb;
alter table public.analyses add column if not exists area_data jsonb;
alter table public.analyses add column if not exists market_status text;
alter table public.analyses add column if not exists market_source text;
alter table public.analyses add column if not exists market_cost_sek numeric;
