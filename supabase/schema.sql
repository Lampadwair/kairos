-- ============================================================================
-- Kairos : base de données (module « Soirée choisie »)
-- À coller dans Supabase → SQL Editor → Run. Peut être relancé sans risque.
-- Toutes les tables et fonctions commencent par kairos_ : tu peux les créer
-- dans un nouveau projet ou dans un projet Supabase existant (Hepha, par ex.).
-- ============================================================================

-- ---------- Tables ----------------------------------------------------------

create table if not exists public.kairos_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  token            text not null unique default replace(gen_random_uuid()::text, '-', ''),
  insta_quota_min  integer not null default 20 check (insta_quota_min between 0 and 600),
  reading_goal_min integer not null default 15 check (reading_goal_min between 1 and 600),
  mode             text not null default 'ferme' check (mode in ('doux', 'ferme')),
  day_end_hour     integer not null default 5 check (day_end_hour between 0 and 8),
  tz               text not null default 'Europe/Paris',
  last_goal_day    date,
  created_at       timestamptz not null default now()
);

create table if not exists public.kairos_events (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  app     text not null check (app in ('insta', 'lecture')),
  kind    text not null check (kind in ('open', 'close')),
  at      timestamptz not null default now()
);
alter table public.kairos_events add column if not exists inferred boolean not null default false;
create index if not exists kairos_events_user_at on public.kairos_events (user_id, at);

-- Aucun accès direct aux tables : tout passe par les fonctions ci-dessous,
-- qui ne lisent que les données de la personne connectée (ou du jeton fourni).
alter table public.kairos_profiles enable row level security;
alter table public.kairos_events   enable row level security;
revoke all on public.kairos_profiles from anon, authenticated;
revoke all on public.kairos_events   from anon, authenticated;

-- ---------- Fonctions internes (non appelables depuis l'extérieur) ---------

-- « Journée » Kairos : elle se termine à day_end_hour (5 h par défaut),
-- pour que ta soirée jusqu'à 2 h compte dans la même journée.
create or replace function public.kairos_day_of(p_at timestamptz, p_tz text, p_h integer)
returns date language sql stable as $$
  select ((p_at at time zone p_tz) - make_interval(hours => p_h))::date
$$;

-- Sessions reconstituées à partir des ouvertures / fermetures d'app.
-- Une session sans fermeture est plafonnée (45 min, ou 10 min si une autre
-- ouverture arrive entre-temps) pour qu'un oubli ne fausse pas tout.
create or replace function public.kairos_sessions(p_user uuid, p_since timestamptz)
returns table (app text, started timestamptz, minutes numeric)
language sql stable security definer set search_path = public as $$
  with ev as (
    select e.app, e.kind, e.at,
           lead(e.kind) over w as next_kind,
           lead(e.at)   over w as next_at
    from kairos_events e
    where e.user_id = p_user and e.at >= p_since - interval '1 hour'
    window w as (partition by e.app order by e.at, e.id)
  )
  select ev.app, ev.at,
         round((extract(epoch from (
           case
             when ev.next_at is null      then least(now(),      ev.at + interval '45 minutes')
             when ev.next_kind = 'close'  then least(ev.next_at, ev.at + interval '45 minutes')
             else                              least(ev.next_at, ev.at + interval '10 minutes')
           end - ev.at)) / 60.0)::numeric, 1)
  from ev
  where ev.kind = 'open' and ev.at >= p_since
$$;

-- Minutes Insta / lecture par journée, sur les p_days dernières journées.
create or replace function public.kairos_daily(p_user uuid, p_days integer)
returns table (day date, insta numeric, lecture numeric)
language sql stable security definer set search_path = public as $$
  with t as (
    select public.kairos_day_of(now(), p.tz, p.day_end_hour) as today, p.tz, p.day_end_hour as h
    from kairos_profiles p where p.user_id = p_user
  ),
  s as (
    select public.kairos_day_of(x.started, t.tz, t.h) as day, x.app, x.minutes
    from t
    cross join lateral public.kairos_sessions(
      p_user,
      ((t.today - (p_days - 1))::timestamp + make_interval(hours => t.h)) at time zone t.tz
    ) x
  )
  select g.d::date,
         coalesce(sum(s.minutes) filter (where s.app = 'insta'),   0),
         coalesce(sum(s.minutes) filter (where s.app = 'lecture'), 0)
  from t
  cross join generate_series(t.today - (p_days - 1), t.today, interval '1 day') as g(d)
  left join s on s.day = g.d::date
  group by g.d
  order by g.d
$$;

-- Série en cours et record : journées consécutives où l'objectif lecture est atteint.
-- La journée en cours ne casse pas la série tant qu'elle n'est pas finie.
create or replace function public.kairos_streak(p_user uuid, out current integer, out best integer)
language plpgsql stable security definer set search_path = public as $$
declare
  v_goal integer;
  v_lec  numeric[];
  n integer; i integer; run integer := 0;
begin
  current := 0; best := 0;
  select reading_goal_min into v_goal from kairos_profiles where user_id = p_user;
  if v_goal is null then return; end if;
  select array_agg(d.lecture order by d.day) into v_lec from public.kairos_daily(p_user, 366) d;
  n := coalesce(array_length(v_lec, 1), 0);
  for i in 1..n loop
    if v_lec[i] >= v_goal then run := run + 1; best := greatest(best, run); else run := 0; end if;
  end loop;
  i := n;
  if i >= 1 and v_lec[i] < v_goal then i := i - 1; end if;
  while i >= 1 and v_lec[i] >= v_goal loop
    current := current + 1; i := i - 1;
  end loop;
end $$;

-- ---------- Fonction appelée par les Raccourcis iPhone ----------------------
-- POST https://<projet>.supabase.co/rest/v1/rpc/kairos_log
-- en-tête apikey: <clé publishable>, corps JSON {"p_token": "...", "p_app": "insta open"}
-- (ou p_app = "insta" et p_event = "open" séparément)
-- Réponse : {"action": "none|warn|nudge|redirect|celebrate", "message": "..." (si besoin), "ouvrir": "manga" (si redirect), ...}

create or replace function public.kairos_log(p_token text, p_app text, p_event text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  pr     kairos_profiles;
  v_app  text;
  v_kind text;
  td     record;
  st     record;
  act    text := 'none';
  msg    text := '';
  parts  text[];
  last_a record;
  t_prev timestamptz;
  t0     timestamptz;
begin
  select * into pr from kairos_profiles where token = trim(p_token);
  if not found then
    raise exception 'Jeton Kairos inconnu : recopie-le depuis les réglages de l''app' using errcode = '28000';
  end if;

  -- Le raccourci peut tout envoyer dans p_app : « insta open », « lecture close »…
  if coalesce(trim(p_event), '') = '' then
    parts := regexp_split_to_array(trim(coalesce(p_app, '')), '\s+');
    p_app := parts[1];
    p_event := parts[array_length(parts, 1)];
  end if;

  v_app := case lower(trim(p_app))
             when 'insta' then 'insta' when 'instagram' then 'insta'
             when 'lecture' then 'lecture' when 'manga' then 'lecture' when 'mangapin' then 'lecture'
           end;
  v_kind := case lower(trim(p_event))
              when 'open' then 'open' when 'ouvert' then 'open' when 'ouverte' then 'open'
              when 'close' then 'close' when 'ferme' then 'close' when 'fermee' then 'close'
            end;
  if v_app is null or v_kind is null then
    raise exception 'p_app doit valoir insta ou lecture, p_event open ou close' using errcode = '22023';
  end if;

  -- iOS ne déclenche pas toujours « Est ouverte » quand on revient dans une app par le geste
  -- en bas de l'écran, alors que « Est fermée » arrive bien. Si une fermeture arrive sans
  -- ouverture, on reconstitue le début de session : au dernier signal (d'une autre app) des
  -- 15 dernières minutes, sinon 5 min avant.
  if v_kind = 'close' then
    select e.kind, e.at into last_a from kairos_events e
     where e.user_id = pr.user_id and e.app = v_app order by e.at desc, e.id desc limit 1;
    if last_a is null or last_a.kind = 'close' or last_a.at < now() - interval '45 minutes' then
      select max(e.at) into t_prev from kairos_events e
       where e.user_id = pr.user_id and e.at > now() - interval '15 minutes';
      t0 := coalesce(t_prev, now() - interval '5 minutes');
      if now() - t0 > interval '5 seconds' then
        insert into kairos_events (user_id, app, kind, at, inferred)
        values (pr.user_id, v_app, 'open', t0 + interval '1 second', true);
      end if;
    end if;
  end if;

  -- Garde-fous : pas de doublon à 3 s près, 500 événements max sur 24 h.
  if not exists (select 1 from kairos_events
                 where user_id = pr.user_id and app = v_app and kind = v_kind
                   and at > now() - interval '3 seconds')
     and (select count(*) from kairos_events
          where user_id = pr.user_id and at > now() - interval '24 hours') < 500 then
    insert into kairos_events (user_id, app, kind) values (pr.user_id, v_app, v_kind);
  end if;

  select * into td from public.kairos_daily(pr.user_id, 1);

  if v_app = 'insta' and v_kind = 'open' then
    if td.insta >= pr.insta_quota_min then
      select * into st from public.kairos_streak(pr.user_id);
      if pr.mode = 'ferme' then
        act := 'redirect';
        msg := format('Quota Insta atteint (%s/%s min). Direction la lecture 📖', round(td.insta), pr.insta_quota_min);
      else
        act := 'nudge';
        msg := format('Quota Insta dépassé (%s/%s min). Un chapitre plutôt ? 📖', round(td.insta), pr.insta_quota_min);
      end if;
      if st.current > 0 then
        msg := msg || format(' Série en jeu : %s j 🔥', st.current);
      end if;
    elsif td.insta >= pr.insta_quota_min * 0.75 then
      act := 'warn';
      msg := format('Insta : %s min sur %s aujourd''hui. Encore %s min.',
                    round(td.insta), pr.insta_quota_min,
                    greatest(pr.insta_quota_min - round(td.insta), 0));
    end if;

  elsif v_app = 'lecture' and v_kind = 'close' then
    if td.lecture >= pr.reading_goal_min and pr.last_goal_day is distinct from td.day then
      update kairos_profiles set last_goal_day = td.day where user_id = pr.user_id;
      select * into st from public.kairos_streak(pr.user_id);
      act := 'celebrate';
      msg := format('Objectif lecture atteint : %s min aujourd''hui. Série : %s j 🔥', round(td.lecture), st.current);
    end if;
  end if;

  -- « message » et « ouvrir » ne sont présents que s'il y a quelque chose à faire :
  -- le raccourci teste juste « possède une valeur », sans comparer de texte.
  return json_strip_nulls(json_build_object(
    'action', act,
    'message', nullif(msg, ''),
    'ouvrir', case when act = 'redirect' then 'manga' end,
    'insta_min', round(td.insta), 'lecture_min', round(td.lecture),
    'quota_min', pr.insta_quota_min, 'goal_min', pr.reading_goal_min
  ));
end $$;

-- ---------- Fonctions appelées par la web app (personne connectée) ----------

create or replace function public.kairos_dashboard(p_days integer default 14)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pr  kairos_profiles;
  st  record;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  insert into kairos_profiles (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from kairos_profiles where user_id = uid;
  select * into st from public.kairos_streak(uid);
  return json_build_object(
    'settings', json_build_object(
      'insta_quota_min', pr.insta_quota_min, 'reading_goal_min', pr.reading_goal_min,
      'mode', pr.mode, 'day_end_hour', pr.day_end_hour, 'token', pr.token),
    'streak', st.current,
    'best', st.best,
    'days', (select json_agg(json_build_object('day', d.day, 'insta', d.insta, 'lecture', d.lecture) order by d.day)
             from public.kairos_daily(uid, least(greatest(p_days, 1), 90)) d),
    'last_event', (select max(at) from kairos_events where user_id = uid),
    'events_count', (select count(*) from kairos_events where user_id = uid)
  );
end $$;

create or replace function public.kairos_save_settings(p_quota integer, p_goal integer, p_mode text, p_day_end integer)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_profiles
     set insta_quota_min = p_quota, reading_goal_min = p_goal, mode = p_mode, day_end_hour = p_day_end
   where user_id = auth.uid();
end $$;

create or replace function public.kairos_new_token()
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text;
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_profiles set token = replace(gen_random_uuid()::text, '-', '')
   where user_id = auth.uid() returning token into t;
  return t;
end $$;

create or replace function public.kairos_clear_history()
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  delete from kairos_events where user_id = auth.uid();
  update kairos_profiles set last_goal_day = null where user_id = auth.uid();
end $$;

-- ---------- Droits ----------------------------------------------------------

revoke all on function public.kairos_day_of(timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.kairos_sessions(uuid, timestamptz)        from public, anon, authenticated;
revoke all on function public.kairos_daily(uuid, integer)               from public, anon, authenticated;
revoke all on function public.kairos_streak(uuid)                       from public, anon, authenticated;

revoke all on function public.kairos_log(text, text, text)                         from public;
revoke all on function public.kairos_dashboard(integer)                            from public, anon;
revoke all on function public.kairos_save_settings(integer, integer, text, integer) from public, anon;
revoke all on function public.kairos_new_token()                                   from public, anon;
revoke all on function public.kairos_clear_history()                               from public, anon;

grant execute on function public.kairos_log(text, text, text)                         to anon, authenticated;
grant execute on function public.kairos_dashboard(integer)                            to authenticated;
grant execute on function public.kairos_save_settings(integer, integer, text, integer) to authenticated;
grant execute on function public.kairos_new_token()                                   to authenticated;
grant execute on function public.kairos_clear_history()                               to authenticated;
