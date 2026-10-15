-- Creator discovery ("search first"): the ugc-discover Edge Function searches Instagram through
-- Apify and upserts every creator it finds into ugc_discover with the service role. The dashboard
-- filters this pool; "Save" turns a row into a tracked creator (ci_competitors kind = 'creator').
create table if not exists public.ugc_discover (
  username        text primary key check (username ~ '^[a-z0-9._]{1,30}$'),
  full_name       text,
  biography       text,
  followers       integer,
  follows         integer,
  posts_count     integer,
  is_business     boolean,
  category        text,
  verified        boolean,
  private         boolean,
  external_url    text,
  profile_pic_url text,
  email           text,
  phone           text,
  er              numeric,
  fer             numeric,
  median_views    integer,
  avg_likes       numeric,
  avg_comments    numeric,
  last_post_at    timestamptz,
  video_share     numeric,
  ar_share        numeric,
  sponsored_posts integer,
  recent_posts    jsonb not null default '[]',
  found_by        text[] not null default '{}',
  dismissed       boolean not null default false,
  first_seen      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ugc_discover_followers_idx on public.ugc_discover(followers);

create table if not exists public.ugc_searches (
  id          bigint generated always as identity primary key,
  query       text not null,
  kind        text not null check (kind in ('user','hashtag')),
  requested   integer not null,
  found       integer,
  error       text,
  user_id     uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  status      text not null default 'running' check (status in ('running','done','failed')),
  stage       text not null default 'search' check (stage in ('search','profiles')),
  run_id      text,
  usernames   text[] not null default '{}',
  finished_at timestamptz
);

alter table public.ugc_discover enable row level security;
alter table public.ugc_searches enable row level security;
-- Members read; admins dismiss or delete. Inserts come only from the Edge Function (service role).
create policy ugc_discover_read on public.ugc_discover for select to authenticated using (public.ci_is_member());
create policy ugc_discover_upd on public.ugc_discover for update to authenticated using (public.ci_is_admin()) with check (public.ci_is_admin());
create policy ugc_discover_del on public.ugc_discover for delete to authenticated using (public.ci_is_admin());
create policy ugc_searches_read on public.ugc_searches for select to authenticated using (public.ci_is_member());

-- Business-address city from the profile (a strong country signal for the Egypt filter).
alter table public.ugc_discover add column if not exists city text;
