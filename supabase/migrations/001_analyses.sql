-- Analyses table: stores each scraping result linked to the user
create table public.analyses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  url text not null,
  listing_data jsonb not null,
  partial boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Index for dashboard queries (user's analyses sorted by newest first)
create index analyses_user_id_created_at_idx
  on public.analyses (user_id, created_at desc);

-- Enable Row Level Security
alter table public.analyses enable row level security;

-- RLS policies: users can only access their own analyses
create policy "Users can view own analyses"
  on public.analyses for select
  using (auth.uid() = user_id);

create policy "Users can insert own analyses"
  on public.analyses for insert
  with check (auth.uid() = user_id);
