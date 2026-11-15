-- ============================================================================
-- Kairos : rappels pendant le scroll (notifications push)
-- À exécuter après schema.sql. Peut être relancé sans risque.
-- ============================================================================

alter table public.kairos_profiles add column if not exists remind_enabled   boolean not null default true;
alter table public.kairos_profiles add column if not exists remind_after_min integer not null default 10;
alter table public.kairos_profiles add column if not exists remind_every_min integer not null default 5;
alter table public.kairos_profiles add column if not exists last_remind_at   timestamptz;
alter table public.kairos_profiles add column if not exists remind_snooze_until timestamptz;

do $$ begin
  alter table public.kairos_profiles add constraint kairos_remind_after_chk check (remind_after_min between 1 and 120);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.kairos_profiles add constraint kairos_remind_every_chk check (remind_every_min between 1 and 60);
exception when duplicate_object then null; end $$;

-- Abonnements aux notifications (un par appareil / navigateur)
create table if not exists public.kairos_push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.kairos_push_subs enable row level security;
revoke all on public.kairos_push_subs from anon, authenticated;

-- Sessions Insta qui méritent un rappel maintenant (sans rien modifier).
-- Session = dernier signal Insta est une ouverture, il y a entre remind_after_min et 45 min.
create or replace function public.kairos_due_sessions()
returns table (r_user uuid, r_minutes integer)
language sql stable security definer set search_path = public as $$
  with last_ev as (
    select distinct on (e.user_id) e.user_id, e.kind, e.at
    from kairos_events e
    where e.app = 'insta' and e.at > now() - interval '50 minutes'
    order by e.user_id, e.at desc, e.id desc
  )
  select p.user_id, floor(extract(epoch from now() - l.at) / 60)::integer
  from kairos_profiles p
  join last_ev l on l.user_id = p.user_id
  where p.remind_enabled
    and l.kind = 'open'
    and now() - l.at >= make_interval(mins => p.remind_after_min)
    and now() - l.at <= interval '45 minutes'
    and (p.remind_snooze_until is null or p.remind_snooze_until < now())
    and (p.last_remind_at is null
         or p.last_remind_at < l.at
         or now() - p.last_remind_at >= make_interval(mins => p.remind_every_min) - interval '20 seconds')
    and exists (select 1 from kairos_push_subs s where s.user_id = p.user_id)
$$;

-- Appelée chaque minute par la tâche planifiée : évite de réveiller la fonction d'envoi pour rien.
create or replace function public.kairos_any_due()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kairos_due_sessions())
$$;

-- Secret partagé avec la tâche planifiée : seules les requêtes qui le connaissent
-- peuvent lire les abonnements et déclencher l'envoi.
create table if not exists public.kairos_secrets (name text primary key, value text not null);
alter table public.kairos_secrets enable row level security;
revoke all on public.kairos_secrets from anon, authenticated;
-- Le secret est tiré au hasard par la base elle-même : personne n'a besoin de le recopier.
insert into public.kairos_secrets (name, value)
values ('cron', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.kairos_check_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from kairos_secrets where name = 'cron' and value = p_secret and length(p_secret) >= 24)
$$;

-- Appelée par la fonction d'envoi : renvoie les rappels à envoyer et note l'heure du rappel.
drop function if exists public.kairos_due_reminders();
create or replace function public.kairos_due_reminders(p_secret text)
returns table (r_user uuid, r_minutes integer, r_endpoint text, r_p256dh text, r_auth text)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    with due as (select d.r_user as u, d.r_minutes as m from public.kairos_due_sessions() d),
    upd as (update kairos_profiles p set last_remind_at = now() from due where p.user_id = due.u returning p.user_id)
    select due.u, due.m, s.endpoint, s.p256dh, s.auth
    from due join kairos_push_subs s on s.user_id = due.u;
end $$;

-- Abonnement expiré (le service de notifications a répondu 404/410)
drop function if exists public.kairos_drop_push(text);
create or replace function public.kairos_drop_push(p_endpoint text, p_secret text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from kairos_push_subs where endpoint = p_endpoint;
end $$;


-- Clés VAPID des notifications : générées une seule fois par la fonction d'envoi et gardées ici.
create or replace function public.kairos_push_config(p_secret text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'pub',  (select value from kairos_secrets where name = 'vapid_public'),
    'priv', (select value from kairos_secrets where name = 'vapid_private'));
end $$;

create or replace function public.kairos_set_vapid(p_secret text, p_pub text, p_priv text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from kairos_secrets where name = 'vapid_public') then return; end if;
  insert into kairos_secrets (name, value) values ('vapid_public', p_pub), ('vapid_private', p_priv);
end $$;

-- Clé publique (faite pour être publique) : l'app s'en sert pour s'abonner aux notifications.
create or replace function public.kairos_vapid_public()
returns text language sql stable security definer set search_path = public as $$
  select value from kairos_secrets where name = 'vapid_public'
$$;

-- Depuis l'app : enregistrer l'abonnement de cet appareil
create or replace function public.kairos_save_push(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'Abonnement invalide'; end if;
  insert into kairos_push_subs (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
  -- au plus 5 appareils par personne
  delete from kairos_push_subs where user_id = auth.uid() and endpoint not in (
    select endpoint from kairos_push_subs where user_id = auth.uid() order by created_at desc limit 5);
end $$;

-- Depuis l'app : « Plus de rappels ce soir » (jusqu'à la fin de la journée Kairos)
create or replace function public.kairos_snooze_reminders()
returns timestamptz language plpgsql volatile security definer set search_path = public as $$
declare pr kairos_profiles; t timestamptz;
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  select * into pr from kairos_profiles where user_id = auth.uid();
  t := ((public.kairos_day_of(now(), pr.tz, pr.day_end_hour) + 1)::timestamp
        + make_interval(hours => pr.day_end_hour)) at time zone pr.tz;
  update kairos_profiles set remind_snooze_until = t where user_id = auth.uid();
  return t;
end $$;

-- Réglages : on ajoute les rappels (paramètres facultatifs)
drop function if exists public.kairos_save_settings(integer, integer, text, integer);
create or replace function public.kairos_save_settings(
  p_quota integer, p_goal integer, p_mode text, p_day_end integer,
  p_remind boolean default null, p_remind_after integer default null, p_remind_every integer default null)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_profiles
     set insta_quota_min = p_quota, reading_goal_min = p_goal, mode = p_mode, day_end_hour = p_day_end,
         remind_enabled = coalesce(p_remind, remind_enabled),
         remind_after_min = coalesce(p_remind_after, remind_after_min),
         remind_every_min = coalesce(p_remind_every, remind_every_min)
   where user_id = auth.uid();
end $$;

-- Tableau de bord : on renvoie aussi les réglages de rappel
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
      'mode', pr.mode, 'day_end_hour', pr.day_end_hour, 'token', pr.token,
      'remind_enabled', pr.remind_enabled, 'remind_after_min', pr.remind_after_min,
      'remind_every_min', pr.remind_every_min,
      'remind_snoozed', coalesce(pr.remind_snooze_until > now(), false)),
    'push_devices', (select count(*) from kairos_push_subs where user_id = uid),
    'streak', st.current,
    'best', st.best,
    'days', (select json_agg(json_build_object('day', d.day, 'insta', d.insta, 'lecture', d.lecture) order by d.day)
             from public.kairos_daily(uid, least(greatest(p_days, 1), 90)) d),
    'last_event', (select max(at) from kairos_events where user_id = uid),
    'events_count', (select count(*) from kairos_events where user_id = uid)
  );
end $$;

-- ---------- Droits ----------
revoke all on function public.kairos_due_sessions()  from public, anon, authenticated;
revoke all on function public.kairos_any_due()       from public, anon, authenticated;
revoke all on function public.kairos_check_secret(text) from public, anon, authenticated;
revoke all on function public.kairos_due_reminders(text) from public;
revoke all on function public.kairos_drop_push(text, text) from public;
grant execute on function public.kairos_due_reminders(text) to anon, authenticated;
grant execute on function public.kairos_drop_push(text, text) to anon, authenticated;
revoke all on function public.kairos_push_config(text) from public;
revoke all on function public.kairos_set_vapid(text, text, text) from public;
grant execute on function public.kairos_push_config(text) to anon, authenticated;
grant execute on function public.kairos_set_vapid(text, text, text) to anon, authenticated;
grant execute on function public.kairos_vapid_public() to anon, authenticated;

revoke all on function public.kairos_save_push(text, text, text) from public, anon;
revoke all on function public.kairos_snooze_reminders()          from public, anon;
revoke all on function public.kairos_save_settings(integer, integer, text, integer, boolean, integer, integer) from public, anon;
revoke all on function public.kairos_dashboard(integer)          from public, anon;
grant execute on function public.kairos_save_push(text, text, text) to authenticated;
grant execute on function public.kairos_snooze_reminders()          to authenticated;
grant execute on function public.kairos_save_settings(integer, integer, text, integer, boolean, integer, integer) to authenticated;
grant execute on function public.kairos_dashboard(integer)          to authenticated;


-- Pour la notification de test : tous les appareils abonnés
create or replace function public.kairos_push_targets(p_secret text)
returns table (r_endpoint text, r_p256dh text, r_auth text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select endpoint, p256dh, auth from kairos_push_subs;
end $$;
revoke all on function public.kairos_push_targets(text) from public;
grant execute on function public.kairos_push_targets(text) to anon, authenticated;

-- ---------- Tâche planifiée : chaque minute, réveille la fonction d'envoi s'il y a un rappel dû ----------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname = 'kairos-rappels';
select cron.schedule('kairos-rappels', '* * * * *', $cron$
  select net.http_post(
    url := 'https://qhbrypojnamuhclaneem.supabase.co/functions/v1/kairos-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-kairos-cron', (select value from public.kairos_secrets where name = 'cron')),
    body := '{}'::jsonb)
  where public.kairos_any_due();
$cron$);
