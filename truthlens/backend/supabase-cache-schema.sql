create table if not exists public.truthlens_cache (
  cache_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists truthlens_cache_updated_at_idx
  on public.truthlens_cache (updated_at desc);