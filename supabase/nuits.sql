-- ============================================================================
-- Kairos : module « Nuits » (sommeil Garmin via l'app Santé, coucher progressif)
-- À exécuter après schema.sql, rappels.sql et argent.sql. Peut être relancé sans risque.
--
-- Les heures du soir sont comptées en minutes depuis 18:00 (« m18 ») pour que
-- 23:30 (330) < 00:45 (405) < 01:30 (450) se comparent simplement.
-- ============================================================================

alter table public.kairos_profiles add column if not exists sleep_goal_min   integer not null default 450;  -- 7 h 30
alter table public.kairos_profiles add column if not exists bed_final_m18    integer not null default 360;  -- 00:00
alter table public.kairos_profiles add column if not exists bed_step_min     integer not null default 15;
alter table public.kairos_profiles add column if not exists bed_target_m18   integer;                       -- palier actuel (null = on observe)
alter table public.kairos_profiles add column if not exists bed_target_since date;
alter table public.kairos_profiles add column if not exists bed_scope        text not null default 'semaine';
alter table public.kairos_profiles add column if not exists bed_remind       boolean not null default true;
alter table public.kairos_profiles add column if not exists bed_remind_before integer not null default 30;
alter table public.kairos_profiles add column if not exists bed_last_remind  timestamptz;
alter table public.kairos_profiles add column if not exists last_sleep_sync  timestamptz;

do $$ begin
  alter table public.kairos_profiles add constraint kairos_sleep_chk check (
    sleep_goal_min between 240 and 720 and bed_final_m18 between 180 and 600
    and bed_step_min between 5 and 60 and bed_remind_before between 5 and 120
    and bed_scope in ('semaine', 'tous'));
exception when duplicate_object then null; end $$;

create table if not exists public.kairos_nights (
  user_id    uuid not null references auth.users(id) on delete cascade,
  night      date not null,              -- date du soir (la nuit du 14 au 15 = 14)
  bed_at     timestamptz not null,       -- endormissement
  wake_at    timestamptz not null,       -- réveil
  asleep_min integer not null,
  deep_min   integer not null default 0,
  rem_min    integer not null default 0,
  core_min   integer not null default 0,
  awake_min  integer not null default 0,
  target_m18 integer,                    -- cible qui s'appliquait ce soir-là (null = soir libre)
  source     text not null default 'sante',
  updated_at timestamptz not null default now(),
  primary key (user_id, night)
);
alter table public.kairos_nights enable row level security;
revoke all on public.kairos_nights from anon, authenticated;

-- ---------- Outils ----------

create or replace function public.kairos_m18(p_at timestamptz, p_tz text)
returns integer language sql stable as $$
  select (extract(epoch from ((p_at at time zone p_tz) - interval '18 hours')::time) / 60)::integer
$$;

create or replace function public.kairos_hhmi(p_m18 integer)
returns text language sql immutable as $$
  select case when p_m18 is null then null else to_char(time '18:00' + make_interval(mins => p_m18), 'HH24:MI') end
$$;

create or replace function public.kairos_dur(p_min integer)
returns text language sql immutable as $$
  select case when p_min is null then null
              when abs(p_min) < 60 then abs(p_min) || ' min'
              else (abs(p_min) / 60) || ' h ' || lpad((abs(p_min) % 60)::text, 2, '0') end
$$;

-- Le soir compte-t-il pour la cible ? (« semaine » = soirs du dimanche au jeudi)
create or replace function public.kairos_bed_applies(p_night date, p_scope text)
returns boolean language sql immutable as $$
  select p_scope = 'tous' or extract(dow from p_night) between 0 and 4
$$;

-- Lignes envoyées par le raccourci : « début|fin|valeur » (dates ISO 8601)
create or replace function public.kairos_sleep_parse(p_data text)
returns table (s timestamptz, e timestamptz, k text)
language plpgsql stable set search_path = public as $$
declare ln text; parts text[]; v text;
begin
  foreach ln in array regexp_split_to_array(coalesce(p_data, ''), E'\\r?\\n') loop
    parts := regexp_split_to_array(trim(ln), '\s*[|;\t]\s*');
    continue when array_length(parts, 1) is null or array_length(parts, 1) < 3;
    v := lower(trim(parts[3]));
    k := case
      when v ~ 'veill|awake|^2$' then 'awake'
      when v ~ 'parad|rem|^5$' then 'rem'
      when v ~ 'profond|deep|^4$' then 'deep'
      when v ~ 'l.ger|core|base|essentiel|^3$' then 'core'
      when v ~ 'au lit|lit$|bed|^0$' then 'inbed'
      when v ~ 'endormi|asleep|sommeil|^1$' then 'asleep'
      else null end;
    continue when k is null;
    begin
      s := parts[1]::timestamptz;
      e := parts[2]::timestamptz;
    exception when others then continue;
    end;
    continue when e <= s or e - s > interval '16 hours';
    return next;
  end loop;
end $$;

-- Palier de coucher : démarre à ta médiane récente, avance de bed_step_min
-- quand au moins 60 % des soirs de la semaine écoulée sont dans la cible (+15 min de marge).
create or replace function public.kairos_bed_progress(p_user uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare pr kairos_profiles; today date; med numeric; n integer; ok integer; nt integer;
begin
  select * into pr from kairos_profiles where user_id = p_user;
  today := (now() at time zone pr.tz)::date;
  if pr.bed_target_m18 is null then
    select count(*), percentile_cont(0.5) within group (order by kairos_m18(bed_at, pr.tz))
      into n, med
    from kairos_nights where user_id = p_user and night > today - 15;
    if n < 3 then return null; end if;
    nt := greatest(pr.bed_final_m18, least(600, (round(med / 15) * 15)::integer));
    update kairos_profiles set bed_target_m18 = nt, bed_target_since = today where user_id = p_user;
    return format('Cible de départ : coucher vers %s (ta moyenne récente). Elle avancera de %s min quand tu la tiens.',
                  kairos_hhmi(nt), pr.bed_step_min);
  end if;
  if pr.bed_target_m18 <= pr.bed_final_m18 or today - pr.bed_target_since < 7 then return null; end if;
  select count(*), count(*) filter (where kairos_m18(bed_at, pr.tz) <= pr.bed_target_m18 + 15)
    into n, ok
  from kairos_nights
  where user_id = p_user and night >= today - 8 and night >= pr.bed_target_since
    and kairos_bed_applies(night, pr.bed_scope);
  if n < 3 or ok::numeric / n < 0.6 then return null; end if;
  nt := greatest(pr.bed_final_m18, pr.bed_target_m18 - pr.bed_step_min);
  update kairos_profiles set bed_target_m18 = nt, bed_target_since = today where user_id = p_user;
  return format('Palier tenu (%s/%s soirs) 🎯 Nouvelle cible : %s.', ok, n, kairos_hhmi(nt));
end $$;

-- ---------- Appelée par le raccourci « Kairos Nuit » ----------
create or replace function public.kairos_sleep(p_token text, p_data text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  pr kairos_profiles; r record; cnt integer := 0; last_n kairos_nights;
  debt integer; prog text; msg text; verdict text := '';
begin
  select * into pr from kairos_profiles where token = trim(p_token);
  if not found then raise exception 'Jeton Kairos inconnu' using errcode = '28000'; end if;
  if length(coalesce(p_data, '')) > 400000 then raise exception 'Trop de données' using errcode = '22023'; end if;
  if coalesce(trim(p_data), '') = '' then
    return json_build_object('ok', true, 'nights', 0,
      'message', 'Aucune nuit trouvée dans Santé. Vérifie que Garmin Connect partage « Sommeil » avec Santé.');
  end if;

  for r in
    with smp as (
      select * from kairos_sleep_parse(p_data)
      where s > now() - interval '15 days' and e <= now() + interval '10 minutes'),
    sl as (  -- échantillons de sommeil (repli sur « au lit » s'il n'y a que ça)
      select s, e, k from smp where k in ('asleep', 'core', 'deep', 'rem')
      union all
      select s, e, 'asleep' from smp
      where k = 'inbed' and not exists (select 1 from smp where k in ('asleep', 'core', 'deep', 'rem'))),
    o1 as (select *, max(e) over (order by s, e rows between unbounded preceding and 1 preceding) pe from sl),
    g1 as (select *, sum(case when pe is null or s > pe + interval '60 minutes' then 1 else 0 end) over (order by s, e) g from o1),
    -- union des intervalles (évite de compter deux fois des échantillons qui se chevauchent)
    o2 as (select *, max(e) over (partition by g order by s, e rows between unbounded preceding and 1 preceding) pe2 from g1),
    g2 as (select *, sum(case when pe2 is null or s > pe2 then 1 else 0 end) over (partition by g order by s, e) piece from o2),
    pieces as (select g, min(s) ps, max(e) pe from g2 group by g, piece),
    sess as (
      select g1.g, min(g1.s) bed, max(g1.e) wake,
             (select sum(extract(epoch from p.pe - p.ps)) / 60 from pieces p where p.g = g1.g)::integer asleep,
             (sum(extract(epoch from g1.e - g1.s)) filter (where g1.k = 'deep') / 60)::integer deep,
             (sum(extract(epoch from g1.e - g1.s)) filter (where g1.k = 'rem')  / 60)::integer rem,
             (sum(extract(epoch from g1.e - g1.s)) filter (where g1.k = 'core') / 60)::integer core
      from g1 group by g1.g),
    nights as (
      select distinct on (((bed at time zone pr.tz) - interval '12 hours')::date)
             ((bed at time zone pr.tz) - interval '12 hours')::date night, sess.*,
             coalesce((select sum(extract(epoch from least(a.e, sess.wake) - greatest(a.s, sess.bed))) / 60
                       from smp a where a.k = 'awake' and a.e > sess.bed and a.s < sess.wake), 0)::integer awake
      from sess
      where asleep >= 150
      order by ((bed at time zone pr.tz) - interval '12 hours')::date, asleep desc)
    select * from nights
  loop
    insert into kairos_nights as kn (user_id, night, bed_at, wake_at, asleep_min, deep_min, rem_min, core_min, awake_min, target_m18)
    values (pr.user_id, r.night, r.bed, r.wake, r.asleep, coalesce(r.deep, 0), coalesce(r.rem, 0), coalesce(r.core, 0), r.awake,
            case when kairos_bed_applies(r.night, pr.bed_scope) then pr.bed_target_m18 end)
    on conflict (user_id, night) do update
      set bed_at = excluded.bed_at, wake_at = excluded.wake_at, asleep_min = excluded.asleep_min,
          deep_min = excluded.deep_min, rem_min = excluded.rem_min, core_min = excluded.core_min,
          awake_min = excluded.awake_min, updated_at = now(),
          target_m18 = coalesce(kn.target_m18, excluded.target_m18);
    cnt := cnt + 1;
  end loop;

  update kairos_profiles set last_sleep_sync = now() where user_id = pr.user_id;
  if cnt = 0 then
    return json_build_object('ok', true, 'nights', 0,
      'message', 'Pas de nuit complète trouvée (moins de 2 h 30 de sommeil). Ta montre s''est-elle synchronisée ?');
  end if;

  prog := kairos_bed_progress(pr.user_id);
  select * into last_n from kairos_nights where user_id = pr.user_id order by night desc limit 1;
  select sum(pr.sleep_goal_min - asleep_min) into debt
  from kairos_nights where user_id = pr.user_id and night > last_n.night - 7;

  if last_n.target_m18 is not null then
    verdict := case
      when kairos_m18(last_n.bed_at, pr.tz) <= last_n.target_m18 then format(' Cible %s tenue ✓', kairos_hhmi(last_n.target_m18))
      when kairos_m18(last_n.bed_at, pr.tz) <= last_n.target_m18 + 15 then format(' Cible %s : presque ✓', kairos_hhmi(last_n.target_m18))
      else format(' Cible %s : +%s.', kairos_hhmi(last_n.target_m18), kairos_dur(kairos_m18(last_n.bed_at, pr.tz) - last_n.target_m18)) end;
  end if;
  msg := format('Nuit : %s de sommeil (endormi %s, réveil %s).%s',
                kairos_dur(last_n.asleep_min),
                to_char(last_n.bed_at at time zone pr.tz, 'HH24:MI'),
                to_char(last_n.wake_at at time zone pr.tz, 'HH24:MI'), verdict);
  if debt > 30 then msg := msg || format(' Manque sur 7 nuits : %s.', kairos_dur(debt)); end if;
  if prog is not null then msg := msg || ' ' || prog; end if;
  return json_build_object('ok', true, 'nights', cnt, 'message', msg);
end $$;

-- ---------- Rappels du soir (envoyés par la fonction kairos-push) ----------
create or replace function public.kairos_bed_due()
returns table (r_user uuid, r_kind text, r_target text, r_insta boolean)
language sql stable security definer set search_path = public as $$
  with p as (
    select pr.*,
           ((now() at time zone pr.tz) - interval '12 hours')::date ev
    from kairos_profiles pr
    where pr.bed_remind and pr.bed_target_m18 is not null
      and exists (select 1 from kairos_push_subs s where s.user_id = pr.user_id)),
  t as (
    select p.*, ((p.ev::timestamp + time '18:00' + make_interval(mins => p.bed_target_m18)) at time zone p.tz) tgt
    from p where kairos_bed_applies(p.ev, p.bed_scope)),
  k as (
    select t.*, case
      when now() >= tgt and now() < tgt + interval '20 minutes'
           and (bed_last_remind is null or bed_last_remind < tgt - interval '30 seconds') then 'now'
      when now() >= tgt - make_interval(mins => bed_remind_before) and now() < tgt
           and (bed_last_remind is null or bed_last_remind < tgt - make_interval(mins => bed_remind_before) - interval '1 minute') then 'before'
      end kind
    from t)
  select k.user_id, k.kind, kairos_hhmi(k.bed_target_m18),
         coalesce((select e.kind = 'open' from kairos_events e
                   where e.user_id = k.user_id and e.app = 'insta' and e.at > now() - interval '45 minutes'
                   order by e.at desc, e.id desc limit 1), false)
  from k where k.kind is not null
$$;

create or replace function public.kairos_any_bed_due()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kairos_bed_due())
$$;

create or replace function public.kairos_due_bed(p_secret text)
returns table (r_kind text, r_target text, r_insta boolean, r_before integer, r_endpoint text, r_p256dh text, r_auth text)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    with due as (select * from public.kairos_bed_due()),
    upd as (update kairos_profiles pr set bed_last_remind = now() from due where pr.user_id = due.r_user
            returning pr.user_id, pr.bed_remind_before)
    select due.r_kind, due.r_target, due.r_insta, upd.bed_remind_before, s.endpoint, s.p256dh, s.auth
    from due join upd on upd.user_id = due.r_user join kairos_push_subs s on s.user_id = due.r_user;
end $$;

-- ---------- Appelées par la web app ----------
create or replace function public.kairos_nights_dash(p_days integer default 30)
returns json language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); pr kairos_profiles; ev date; days integer := least(greatest(p_days, 7), 120);
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  insert into kairos_profiles (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from kairos_profiles where user_id = uid;
  ev := ((now() at time zone pr.tz) - interval '12 hours')::date;
  return json_build_object(
    'settings', json_build_object(
      'sleep_goal_min', pr.sleep_goal_min, 'bed_final_m18', pr.bed_final_m18, 'bed_step_min', pr.bed_step_min,
      'bed_target_m18', pr.bed_target_m18, 'bed_target_since', pr.bed_target_since, 'bed_scope', pr.bed_scope,
      'bed_remind', pr.bed_remind, 'bed_remind_before', pr.bed_remind_before,
      'last_sleep_sync', pr.last_sleep_sync, 'token', pr.token),
    'tonight', json_build_object('night', ev, 'applies', kairos_bed_applies(ev, pr.bed_scope),
                                 'target', kairos_hhmi(pr.bed_target_m18)),
    'nights', (
      select coalesce(json_agg(x order by x.night), '[]'::json) from (
        select n.night, n.asleep_min asleep, n.deep_min deep, n.rem_min rem, n.core_min core, n.awake_min awake,
               kairos_m18(n.bed_at, pr.tz) bed_m, kairos_m18(n.wake_at, pr.tz) wake_m,
               to_char(n.bed_at at time zone pr.tz, 'HH24:MI') bed, to_char(n.wake_at at time zone pr.tz, 'HH24:MI') wake,
               n.target_m18 target_m, kairos_bed_applies(n.night, pr.bed_scope) applies,
               coalesce((select round(sum(s.minutes)) from kairos_sessions(uid, n.bed_at - interval '8 hours') s
                         where s.app = 'insta' and s.started >= (n.night::timestamp + time '21:00') at time zone pr.tz
                           and s.started < n.bed_at), 0) insta_late,
               coalesce((select round(sum(s.minutes)) from kairos_sessions(uid, n.bed_at - interval '8 hours') s
                         where s.app = 'lecture' and s.started >= (n.night::timestamp + time '21:00') at time zone pr.tz
                           and s.started < n.bed_at), 0) read_late
        from kairos_nights n
        where n.user_id = uid and n.night > ev - days) x)
  );
end $$;

create or replace function public.kairos_nights_settings(
  p_goal integer, p_final integer, p_step integer, p_remind boolean, p_before integer, p_scope text,
  p_recalibrate boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare msg text;
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_profiles
     set sleep_goal_min = p_goal, bed_final_m18 = p_final, bed_step_min = p_step,
         bed_remind = p_remind, bed_remind_before = p_before, bed_scope = p_scope,
         bed_target_m18 = case when p_recalibrate then null
                               when bed_target_m18 is not null then greatest(bed_target_m18, p_final) end
   where user_id = auth.uid();
  if p_recalibrate then msg := kairos_bed_progress(auth.uid()); end if;
  return json_build_object('ok', true, 'message', msg);
end $$;

-- ---------- Droits ----------
revoke all on function public.kairos_sleep_parse(text)      from public, anon, authenticated;
revoke all on function public.kairos_bed_progress(uuid)     from public, anon, authenticated;
revoke all on function public.kairos_bed_due()              from public, anon, authenticated;
revoke all on function public.kairos_any_bed_due()          from public, anon, authenticated;
revoke all on function public.kairos_sleep(text, text)      from public;
revoke all on function public.kairos_due_bed(text)          from public;
grant execute on function public.kairos_sleep(text, text)   to anon, authenticated;
grant execute on function public.kairos_due_bed(text)       to anon, authenticated;
revoke all on function public.kairos_nights_dash(integer)   from public, anon;
revoke all on function public.kairos_nights_settings(integer, integer, integer, boolean, integer, text, boolean) from public, anon;
grant execute on function public.kairos_nights_dash(integer) to authenticated;
grant execute on function public.kairos_nights_settings(integer, integer, integer, boolean, integer, text, boolean) to authenticated;

-- ---------- Tâche planifiée : réveille aussi la fonction pour les rappels du soir ----------
select cron.unschedule(jobid) from cron.job where jobname = 'kairos-rappels';
select cron.schedule('kairos-rappels', '* * * * *', $cron$
  select net.http_post(
    url := 'https://qhbrypojnamuhclaneem.supabase.co/functions/v1/kairos-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-kairos-cron', (select value from public.kairos_secrets where name = 'cron')),
    body := '{}'::jsonb)
  where public.kairos_any_due() or public.kairos_any_sub_due() or public.kairos_any_bed_due();
$cron$);
