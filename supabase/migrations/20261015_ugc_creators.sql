-- UGC creator research: creators are tracked by the same Instagram pipeline as competitors
-- (n8n -> ci_ingest), flagged with ci_competitors.kind = 'creator' and kept out of every
-- competitor view and the AI report. CRM data lives in the ugc_* tables.

-- 1. Account kind --------------------------------------------------------------------------
alter table public.ci_competitors
  add column if not exists kind text not null default 'competitor'
  check (kind in ('competitor','creator'));

-- 2. Creator CRM ----------------------------------------------------------------------------
create table if not exists public.ugc_creators (
  account_id   bigint primary key references public.ci_competitors(id) on delete cascade,
  favorite     boolean not null default false,
  stage        text not null default 'new'
               check (stage in ('new','shortlisted','contacted','replied','negotiating','booked','delivered','rejected')),
  email        text,
  phone        text,
  niches       text[] not null default '{}',
  rating       smallint check (rating between 0 and 5),
  rate_egp     numeric check (rate_egp >= 0),
  location     text,
  notes        text,
  source       text not null default 'manual',
  invite_token text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  contacted_at timestamptz,
  stage_at     timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.ugc_outreach (
  id         bigint generated always as identity primary key,
  account_id bigint not null references public.ci_competitors(id) on delete cascade,
  channel    text not null check (channel in ('email','whatsapp','instagram')),
  subject    text,
  body       text,
  sent_by    uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ugc_outreach_account_idx on public.ugc_outreach(account_id, created_at desc);

create table if not exists public.ugc_applications (
  id            bigint generated always as identity primary key,
  account_id    bigint references public.ci_competitors(id) on delete set null,
  name          text not null,
  instagram     text,
  email         text not null,
  phone         text,
  city          text,
  rate_reel     numeric,
  rate_photo    numeric,
  portfolio_url text,
  content_types text[] not null default '{}',
  message       text,
  status        text not null default 'new' check (status in ('new','reviewed','archived')),
  created_at    timestamptz not null default now()
);
create index if not exists ugc_applications_created_idx on public.ugc_applications(created_at desc);

create table if not exists public.ugc_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.ugc_creators     enable row level security;
alter table public.ugc_outreach     enable row level security;
alter table public.ugc_applications enable row level security;
alter table public.ugc_settings     enable row level security;

-- Function bodies use $fn$ quoting (plain $$ bodies time out through the Supabase MCP gateway).
-- Members read; only admins write (same model as ci_competitors).
create policy ugc_creators_read on public.ugc_creators for select to authenticated using (public.ci_is_member());
create policy ugc_creators_ins  on public.ugc_creators for insert to authenticated with check (public.ci_is_admin());
create policy ugc_creators_upd  on public.ugc_creators for update to authenticated using (public.ci_is_admin()) with check (public.ci_is_admin());
create policy ugc_creators_del  on public.ugc_creators for delete to authenticated using (public.ci_is_admin());

create policy ugc_outreach_read on public.ugc_outreach for select to authenticated using (public.ci_is_member());
create policy ugc_outreach_ins  on public.ugc_outreach for insert to authenticated with check (public.ci_is_admin());
create policy ugc_outreach_del  on public.ugc_outreach for delete to authenticated using (public.ci_is_admin());

-- Applications are inserted only through ugc_submit_application (security definer).
create policy ugc_app_read on public.ugc_applications for select to authenticated using (public.ci_is_member());
create policy ugc_app_upd  on public.ugc_applications for update to authenticated using (public.ci_is_admin()) with check (public.ci_is_admin());
create policy ugc_app_del  on public.ugc_applications for delete to authenticated using (public.ci_is_admin());

create policy ugc_settings_read on public.ugc_settings for select to authenticated using (public.ci_is_member());
create policy ugc_settings_ins  on public.ugc_settings for insert to authenticated with check (public.ci_is_admin());
create policy ugc_settings_upd  on public.ugc_settings for update to authenticated using (public.ci_is_admin()) with check (public.ci_is_admin());

-- 3. Triggers -------------------------------------------------------------------------------
-- Creators skip the full-history backfill (the regular fetch already returns the latest 50
-- posts, plenty to vet a creator) to protect the Instagram API quota.
create or replace function public.ugc_before_account_insert() returns trigger
language plpgsql set search_path to 'public' as $fn$
begin
  if new.kind = 'creator' then new.backfilled := true; end if;
  return new;
end $fn$;
drop trigger if exists ugc_before_account_insert on public.ci_competitors;
create trigger ugc_before_account_insert before insert on public.ci_competitors
  for each row execute function public.ugc_before_account_insert();

create or replace function public.ugc_after_account_insert() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if new.kind = 'creator' then
    insert into public.ugc_creators(account_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $fn$;
drop trigger if exists ugc_after_account_insert on public.ci_competitors;
create trigger ugc_after_account_insert after insert on public.ci_competitors
  for each row execute function public.ugc_after_account_insert();

create or replace function public.ugc_touch() returns trigger
language plpgsql set search_path to 'public' as $fn$
begin
  new.updated_at := now();
  if new.stage is distinct from old.stage then new.stage_at := now(); end if;
  return new;
end $fn$;
drop trigger if exists ugc_touch on public.ugc_creators;
create trigger ugc_touch before update on public.ugc_creators
  for each row execute function public.ugc_touch();

-- 4. Public collaboration form (anon) -----------------------------------------------------------
-- Returns only the handle for a valid invite link, to greet the creator by name.
create or replace function public.ugc_invite_info(p_token text) returns jsonb
language sql stable security definer set search_path to 'public' as $fn$
  select jsonb_build_object('username', c.username, 'display_name', c.display_name)
    from public.ugc_creators u join public.ci_competitors c on c.id = u.account_id
   where p_token is not null and u.invite_token = p_token
$fn$;

create or replace function public.ugc_submit_application(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_name  text := btrim(coalesce(p->>'name',''));
  v_email text := lower(btrim(coalesce(p->>'email','')));
  v_ig    text := lower(regexp_replace(btrim(coalesce(p->>'instagram','')), '^@|^https?://(www\.)?instagram\.com/|/.*$', '', 'g'));
  v_port  text := nullif(btrim(coalesce(p->>'portfolio_url','')), '');
  v_types text[];
  v_acct  bigint;
  v_rr numeric; v_rp numeric;
begin
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'Please enter your name.'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' or length(v_email) > 200 then raise exception 'Please enter a valid email.'; end if;
  if v_ig <> '' and v_ig !~ '^[a-z0-9._]{1,30}$' then raise exception 'Please enter a valid Instagram handle.'; end if;
  if v_port is not null and (v_port !~* '^https?://' or length(v_port) > 300) then raise exception 'Portfolio link must start with http(s)://'; end if;
  if length(coalesce(p->>'message','')) > 2000 then raise exception 'Message is too long.'; end if;
  if coalesce(p->>'rate_reel','') !~ '^([0-9]+([.][0-9]+)?)?$' or coalesce(p->>'rate_photo','') !~ '^([0-9]+([.][0-9]+)?)?$' then raise exception 'Rates must be numbers.'; end if;
  v_rr := nullif(p->>'rate_reel','')::numeric; v_rp := nullif(p->>'rate_photo','')::numeric;
  if coalesce(v_rr,0) > 10000000 or coalesce(v_rp,0) > 10000000 then raise exception 'Rates look wrong.'; end if;
  select coalesce(array_agg(left(t, 40)), '{}') into v_types
    from (select jsonb_array_elements_text(case when jsonb_typeof(p->'content_types')='array' then p->'content_types' else '[]'::jsonb end) t limit 10) x;

  -- abuse limits
  if (select count(*) from public.ugc_applications where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many submissions right now. Please try again later.';
  end if;
  if (select count(*) from public.ugc_applications where email = v_email and created_at > now() - interval '1 day') >= 3 then
    raise exception 'You have already applied today. We will get back to you.';
  end if;

  select account_id into v_acct from public.ugc_creators where invite_token = nullif(p->>'token','');
  if v_acct is null and v_ig <> '' then
    select id into v_acct from public.ci_competitors where username = v_ig and kind = 'creator';
  end if;

  insert into public.ugc_applications(account_id, name, instagram, email, phone, city, rate_reel, rate_photo, portfolio_url, content_types, message)
  values (v_acct, v_name, nullif(v_ig,''), v_email, left(nullif(btrim(coalesce(p->>'phone','')),''), 40),
          left(nullif(btrim(coalesce(p->>'city','')),''), 80), v_rr, v_rp, v_port, v_types, nullif(btrim(coalesce(p->>'message','')),''));

  if v_acct is not null then
    update public.ugc_creators set
      email = coalesce(email, v_email),
      phone = coalesce(phone, left(nullif(btrim(coalesce(p->>'phone','')),''), 40)),
      rate_egp = coalesce(rate_egp, v_rr),
      stage = case when stage in ('new','shortlisted','contacted') then 'replied' else stage end
    where account_id = v_acct;
  end if;
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function public.ugc_invite_info(text) from public;
revoke all on function public.ugc_submit_application(jsonb) from public;
grant execute on function public.ugc_invite_info(text) to anon, authenticated;
grant execute on function public.ugc_submit_application(jsonb) to anon, authenticated;

-- 5. Keep creators out of the weekly competitor AI report -----------------------------------
do $fn$
declare d text;
begin
  select pg_get_functiondef('public.ci_report_input(text)'::regprocedure) into d;
  if position('c.kind=''competitor''' in d) = 0 then
    d := replace(d, 'from public.ci_competitors c where c.status=''active''',
                    'from public.ci_competitors c where c.kind=''competitor'' and c.status=''active''');
    execute d;
  end if;
end $fn$;

-- Trigger-only function: not callable through the API.
revoke execute on function public.ugc_after_account_insert() from public, anon, authenticated;
