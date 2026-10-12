-- Districts whose scrape failed inside an otherwise successful search.
-- Until now a failed district was only a server log line; the results page
-- looked complete while silently missing e.g. all of Kungsholmen
-- (observed 2026-10-11). Additive, nullable-by-default: existing rows read [].
alter table public.discovery_jobs
  add column if not exists failed_areas jsonb not null default '[]';
