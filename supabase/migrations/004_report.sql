-- AI report persistence layer.
-- Adds report_* columns to analyses. Additive only: the new columns are covered
-- by the EXISTING per-user RLS (SELECT from 001_analyses.sql, UPDATE from
-- 002_brf.sql), so this migration defines NO new RLS policy. Re-declaring the
-- "Users can update own analyses" UPDATE policy would error on a duplicate
-- declaration and leave the schema half-applied (same precedent as 003). No
-- storage bucket this phase (the report is synthesized + persisted, not uploaded).
--
-- 1. AI-report columns on the existing analyses row (idempotent).
--    report_data            : RPRT-01 persisted snapshot — the schema-validated
--                             synthesis output (AiReport) plus the deterministic
--                             flags, cited soft-signal context, fingerprint, cost,
--                             model and prompt version (reportDataSchema, read-path
--                             guarded by safeParseReportData, schemas/report.ts).
--    report_status          : null | 'generating' | 'done' | 'failed' (mirrors
--                             brf_status / market_status, D-13).
--                             STATE MACHINE:
--                               null        = never generated -> the page shows the
--                                             "Generera AI-rapport" affordance,
--                                             mirroring brf_status null = upload
--                                             affordance (002_brf.sql).
--                               'generating'= the single Sonnet call is in flight
--                                             (in-flight lock — no double-spend).
--                               'done'      = a schema-valid report is persisted.
--                               'failed'    = synthesis refused/truncated/over-cap;
--                                             nothing usable persisted.
--    report_cost_sek        : persisted per-analysis Sonnet synthesis cost
--                             (mirrors brf_cost_sek / market_cost_sek), for the
--                             < 5 SEK cost guard (Plan 04, Sonnet rates).
--    report_data_fingerprint: hash of the stable-key-order fact-sheet inputs the
--                             report was generated from -> drives D-08 staleness
--                             (current input fingerprint != stored -> "uppdatera").
--    report_prompt_version  : the REPORT_SYNTHESIS_PROMPT_VERSION the report was
--                             generated with (trace, AI-SPEC §7).
alter table public.analyses add column if not exists report_data jsonb;
alter table public.analyses add column if not exists report_status text;
alter table public.analyses add column if not exists report_cost_sek numeric;
alter table public.analyses add column if not exists report_data_fingerprint text;
alter table public.analyses add column if not exists report_prompt_version text;
