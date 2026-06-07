-- BRF financial analysis persistence layer.
-- Adds brf_* columns to analyses, the missing analyses UPDATE policy (001 had none),
-- a private brf-pdfs storage bucket, and per-user RLS on storage.objects.

-- 1. BRF columns on the existing analyses row (idempotent).
--    brf_data    : extraction result + computed grade + per-field confidence/citation
--    brf_status  : 'reading' | 'extracting' | 'scoring' | 'done' | 'failed' (D-13)
--    brf_cost_sek: persisted from message.usage (AI-SPEC §7)
--    brf_pdf_hash: content hash for D-06 replace-identical skip-Claude cache
--    brf_scanned : D-14 scanned-PDF heads-up
alter table public.analyses add column if not exists brf_data jsonb;
alter table public.analyses add column if not exists brf_status text;
alter table public.analyses add column if not exists brf_cost_sek numeric;
alter table public.analyses add column if not exists brf_pdf_hash text;
alter table public.analyses add column if not exists brf_scanned boolean default false;

-- 2. UPDATE RLS policy on analyses (001 omitted it).
--    Load-bearing: analyze-brf.ts writes brf_status via .update() and D-12
--    corrections re-score via .update(); both fail silently under RLS without this.
create policy "Users can update own analyses"
  on public.analyses for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. Private brf-pdfs bucket (public = false is mandatory — GDPR, no public URLs; AI-SPEC §1b/§7).
insert into storage.buckets (id, name, public)
values ('brf-pdfs', 'brf-pdfs', false)
on conflict (id) do nothing;

-- 4. Per-user RLS on storage.objects for brf-pdfs.
--    Path convention is {user_id}/{analysisId}.pdf, so foldername(name)[1] is the user id.
create policy "Users manage own brf pdfs"
  on storage.objects for all
  using (bucket_id = 'brf-pdfs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'brf-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
