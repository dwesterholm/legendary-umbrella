---
phase: 02-brf-financial-analysis
plan: 02
subsystem: persistence
tags: [supabase, migration, storage, rls, brf]
requires:
  - "supabase/migrations/001_analyses.sql (analyses table + select/insert RLS)"
provides:
  - "supabase/migrations/002_brf.sql"
  - "analyses.brf_data jsonb"
  - "analyses.brf_status text"
  - "analyses.brf_cost_sek numeric"
  - "analyses.brf_pdf_hash text"
  - "analyses.brf_scanned boolean"
  - "analyses UPDATE RLS policy"
  - "private brf-pdfs storage bucket"
  - "storage.objects per-user RLS for brf-pdfs"
affects:
  - "public.analyses"
  - "storage.objects"
  - "storage.buckets"
tech-stack:
  added: []
  patterns:
    - "Idempotent column adds via add column if not exists"
    - "Storage RLS keyed to path prefix: (storage.foldername(name))[1] = auth.uid()::text"
    - "Private bucket (public = false) — no public URLs (GDPR)"
key-files:
  created:
    - "supabase/migrations/002_brf.sql"
  modified: []
decisions:
  - "jsonb columns on analyses (not a separate brf_analyses table) — locked decision, RESEARCH Open Question 1; multi-year is v2/ADV-02"
  - "Added the analyses UPDATE policy 001 omitted — load-bearing for brf_status writes and D-12 re-score"
metrics:
  duration: ~5min
  completed: 2026-06-07
status: paused-at-checkpoint
---

# Phase 02 Plan 02: BRF Persistence Migration Summary

Migration `002_brf.sql` adds the BRF persistence layer — five `brf_*` jsonb/scalar columns on `analyses`, the previously-missing `analyses` UPDATE RLS policy, a private `brf-pdfs` Storage bucket, and per-user RLS on `storage.objects` — mirroring 001's lowercase, `auth.uid() = user_id` style.

## What Was Built

**Task 1 (complete, commit `2fbfc9b`):** Wrote `supabase/migrations/002_brf.sql` containing exactly four parts:
1. `alter table public.analyses add column if not exists` for `brf_data jsonb`, `brf_status text`, `brf_cost_sek numeric`, `brf_pdf_hash text`, `brf_scanned boolean default false` (idempotent).
2. `create policy "Users can update own analyses" ... for update using (auth.uid() = user_id) with check (...)` — the UPDATE policy 001 lacked. Load-bearing: `analyze-brf.ts` status writes and D-12 corrections re-score both go through `.update()` and fail silently under RLS without it.
3. Private bucket: `insert into storage.buckets (id, name, public) values ('brf-pdfs','brf-pdfs',false) on conflict (id) do nothing;` — `public = false` mandatory (GDPR, no public URLs).
4. `create policy "Users manage own brf pdfs" on storage.objects for all using (bucket_id = 'brf-pdfs' and (storage.foldername(name))[1] = auth.uid()::text) with check (...)` — path convention `{user_id}/{analysisId}.pdf`.

No separate `brf_analyses` table was created (locked decision).

**Task 2 (PAUSED — blocking checkpoint):** Pushing the migration to the live Supabase database (`supabase db push`) is a `checkpoint:human-verify gate="blocking"` step. It requires confirming the free-tier project (ref `nsheegvczxjeeayngqrv`) is not paused, running the push (may prompt for DB password), and verifying the live schema in the dashboard. Auto-advance is not active, so execution stopped here per checkpoint protocol. The migration file is committed but NOT yet applied to the live DB.

## Verification

Task 1 automated verification passed:
- Migration shape OK (`brf-pdfs`, `for update`, `brf_status` all present, comments stripped).
- All five columns present (`brf_data`, `brf_status`, `brf_cost_sek`, `brf_pdf_hash`, `brf_scanned`).
- Private bucket present (`public`/`false`).
- Storage policy keyed to `(storage.foldername(name))[1] = auth.uid()::text`.
- No `brf_analyses` table created.

Task 2 live-DB verification is pending human action (the push).

## Threat Model Coverage

All `mitigate` dispositions in the plan's threat register are implemented in the file:
- **T-02-02 (EoP, storage.objects):** RLS keys path prefix `foldername(name)[1]` to `auth.uid()`.
- **T-02-03 (Info Disclosure, brf-pdfs):** bucket `public = false`.
- **T-02-04 (Tampering/EoP, analyses UPDATE):** new UPDATE policy gated `using (auth.uid() = user_id) with check (...)`.
- **T-02-05 (DoS, free-tier pause):** accepted; surfaced as the Task 2 resume-check.

## Deviations from Plan

None — Task 1 executed exactly as written. Task 2 is a planned blocking checkpoint, not a deviation.

## Known Stubs

None. The migration file is complete; the only outstanding work is the human-gated live push (Task 2), which is by design.

## Self-Check: PASSED

- FOUND: supabase/migrations/002_brf.sql
- FOUND: commit 2fbfc9b
