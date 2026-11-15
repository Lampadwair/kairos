-- ============================================================================
-- Kairos : plan de budget (revenus → charges fixes → épargne → enveloppes)
-- et données du tableau de bord Argent. À exécuter après argent.sql.
-- ============================================================================

alter table public.kairos_profiles add column if not exists money_income  numeric(10,2);
alter table public.kairos_profiles add column if not exists money_savings numeric(10,2);

create table if not exists public.kairos_fixed (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name    text not null,
  amount  numeric(10,2) not null check (amount >= 0),
  day     integer check (day between 1 and 31)
);

create table if not exists public.kairos_envelopes (
  user_id  uuid not null references auth.users(id) on delete cascade,
  category text not null,
  monthly  numeric(10,2) not null check (monthly >= 0),
  primary key (user_id, category)
);

alter table public.kairos_fixed     enable row level security;
alter table public.kairos_envelopes enable row level security;
revoke all on public.kairos_fixed, public.kairos_envelopes from anon, authenticated;

-- ---------- Plan de budget ----------

create or replace function public.kairos_plan()
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); pr kairos_profiles;
  m0 date := date_trunc('month', (now() at time zone 'Europe/Paris')::date)::date;
  t0 timestamptz := m0::timestamp at time zone 'Europe/Paris';
  a0 timestamptz := (m0 - interval '3 months')::timestamp at time zone 'Europe/Paris';
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  insert into kairos_profiles (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from kairos_profiles where user_id = uid;
  return json_build_object(
    'income', pr.money_income,
    'savings', pr.money_savings,
    'fixed', (select coalesce(json_agg(x order by x.day nulls last, x.id), '[]') from (
                select id, name, amount, day from kairos_fixed where user_id = uid) x),
    'subs_monthly', (select coalesce(sum(case period when 'an' then amount / 12 when 'semaine' then amount * 52 / 12 else amount end), 0)
                     from kairos_subs where user_id = uid),
    'envelopes', (select coalesce(json_object_agg(category, monthly), '{}') from kairos_envelopes where user_id = uid),
    -- moyenne mensuelle des 3 derniers mois complets, par catégorie (pour proposer des enveloppes)
    'avg3', (select coalesce(json_object_agg(category, round(total / 3, 0)), '{}') from (
               select category, sum(amount) as total from kairos_tx
               where user_id = uid and at >= a0 and at < t0 group by category) x),
    'months_of_data', (select count(distinct date_trunc('month', at at time zone 'Europe/Paris')) from kairos_tx
                       where user_id = uid and at >= a0 and at < t0),
    -- dépensé ce mois par catégorie (pour l'avancement des enveloppes)
    'spent', (select coalesce(json_object_agg(category, total), '{}') from (
                select category, sum(amount) as total from kairos_tx
                where user_id = uid and at >= t0 group by category) x)
  );
end $$;

-- Enregistre le plan. p_envelopes = {"resto": 150, "jeux": 40, ...}
-- Le budget du mois (alertes 80 % / 100 %) devient la somme des enveloppes.
create or replace function public.kairos_plan_save(p_income numeric, p_savings numeric, p_envelopes jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); total numeric;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  delete from kairos_envelopes where user_id = uid;
  insert into kairos_envelopes (user_id, category, monthly)
  select uid, key, round(value::text::numeric, 2)
  from jsonb_each(coalesce(p_envelopes, '{}'::jsonb))
  where key in ('courses','resto','transport','jeux','sorties','achats','abonnements','sante','maison','autre')
    and value::text::numeric > 0;
  select sum(monthly) into total from kairos_envelopes where user_id = uid;
  update kairos_profiles
     set money_income = nullif(p_income, 0), money_savings = nullif(p_savings, 0),
         money_budget = coalesce(total, money_budget)
   where user_id = uid;
end $$;

create or replace function public.kairos_fixed_save(p_id bigint, p_name text, p_amount numeric, p_day integer default null)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); rid bigint;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  if p_id is null then
    insert into kairos_fixed (user_id, name, amount, day) values (uid, left(p_name, 80), round(p_amount, 2), p_day) returning id into rid;
  else
    update kairos_fixed set name = left(p_name, 80), amount = round(p_amount, 2), day = p_day
     where id = p_id and user_id = uid returning id into rid;
  end if;
  return rid;
end $$;

create or replace function public.kairos_fixed_delete(p_id bigint)
returns void language sql volatile security definer set search_path = public as $$
  delete from kairos_fixed where id = p_id and user_id = auth.uid()
$$;

-- ---------- Tableau de bord ----------

create or replace function public.kairos_money_dash(p_month date default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); pr kairos_profiles;
  m0 date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Paris')::date))::date;
  t0 timestamptz := m0::timestamp at time zone 'Europe/Paris';
  t1 timestamptz := (m0 + interval '1 month')::timestamp at time zone 'Europe/Paris';
  p0 timestamptz := (m0 - interval '1 month')::timestamp at time zone 'Europe/Paris';
  s0 timestamptz := (m0 - interval '5 months')::timestamp at time zone 'Europe/Paris';
  q0 timestamptz := (m0 - interval '2 months')::timestamp at time zone 'Europe/Paris';
  ndays integer := extract(day from (m0 + interval '1 month' - interval '1 day'))::integer;
  today integer;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  select * into pr from kairos_profiles where user_id = uid;
  today := case when now() >= t0 and now() < t1 then extract(day from now() at time zone 'Europe/Paris')::integer else ndays end;
  return json_build_object(
    'month', to_char(m0, 'YYYY-MM'),
    'days_in_month', ndays,
    'today', today,
    'budget', pr.money_budget,
    -- dépenses par jour du mois choisi et du mois précédent (cumul calculé côté app)
    'daily', (select coalesce(json_agg(json_build_object('d', d, 'v', v) order by d), '[]') from (
                select extract(day from at at time zone 'Europe/Paris')::integer as d, sum(amount) as v
                from kairos_tx where user_id = uid and at >= t0 and at < t1 group by 1) x),
    'prev_daily', (select coalesce(json_agg(json_build_object('d', d, 'v', v) order by d), '[]') from (
                select extract(day from at at time zone 'Europe/Paris')::integer as d, sum(amount) as v
                from kairos_tx where user_id = uid and at >= p0 and at < t0 group by 1) x),
    -- 6 derniers mois : total et catégories
    'months', (select coalesce(json_agg(json_build_object('m', to_char(g.m, 'YYYY-MM'), 'total', coalesce(t.total, 0), 'cats', coalesce(t.cats, '{}'::json)) order by g.m), '[]')
               from generate_series(m0 - interval '5 months', m0, interval '1 month') as g(m)
               left join (
                 select mm, sum(total) as total, json_object_agg(category, total) as cats from (
                   select date_trunc('month', at at time zone 'Europe/Paris') as mm, category, sum(amount) as total
                   from kairos_tx where user_id = uid and at >= s0 and at < t1 group by 1, 2) y group by mm
               ) t on t.mm = g.m),
    -- commerçants du mois et des 3 derniers mois
    'top_month', (select coalesce(json_agg(x order by x.total desc), '[]') from (
                    select (array_agg(merchant order by at desc))[1] as name,
                           (array_agg(category order by at desc))[1] as category, sum(amount) as total, count(*) as n
                    from kairos_tx where user_id = uid and at >= t0 and at < t1 and merchant <> ''
                    group by public.kairos_norm_merchant(merchant) order by sum(amount) desc limit 8) x),
    'top_3m', (select coalesce(json_agg(x order by x.total desc), '[]') from (
                    select (array_agg(merchant order by at desc))[1] as name,
                           (array_agg(category order by at desc))[1] as category, sum(amount) as total, count(*) as n
                    from kairos_tx where user_id = uid and at >= q0 and at < t1 and merchant <> ''
                    group by public.kairos_norm_merchant(merchant) order by sum(amount) desc limit 8) x),
    -- habitudes sur les 3 derniers mois : jour de la semaine (1 = lundi) et moment de la journée
    'weekday', (select coalesce(json_agg(json_build_object('w', w, 'v', v, 'n', n) order by w), '[]') from (
                  select extract(isodow from at at time zone 'Europe/Paris')::integer as w, sum(amount) as v, count(*) as n
                  from kairos_tx where user_id = uid and at >= q0 and at < t1 group by 1) x),
    'moments', (select coalesce(json_agg(json_build_object('k', k, 'v', v, 'n', n, 'top', top)), '[]') from (
                  select k, sum(amount) as v, count(*) as n,
                         (select category from kairos_tx t2
                           where t2.user_id = uid and t2.at >= q0 and t2.at < t1
                             and public.kairos_moment(t2.at) = z.k
                           group by category order by sum(amount) desc limit 1) as top
                  from (select public.kairos_moment(at) as k, amount from kairos_tx
                        where user_id = uid and at >= q0 and at < t1) z group by k) x)
  );
end $$;

-- Moment de la journée (heure de Paris) : matin 5–11 h, midi 11–14 h, après-midi 14–19 h, soirée 19–5 h
create or replace function public.kairos_moment(p_at timestamptz)
returns text language sql immutable as $$
  select case
    when extract(hour from p_at at time zone 'Europe/Paris') >= 5  and extract(hour from p_at at time zone 'Europe/Paris') < 11 then 'matin'
    when extract(hour from p_at at time zone 'Europe/Paris') >= 11 and extract(hour from p_at at time zone 'Europe/Paris') < 14 then 'midi'
    when extract(hour from p_at at time zone 'Europe/Paris') >= 14 and extract(hour from p_at at time zone 'Europe/Paris') < 19 then 'aprem'
    else 'soir' end
$$;

-- ---------- Droits ----------
revoke all on function public.kairos_plan()                                   from public, anon;
revoke all on function public.kairos_plan_save(numeric, numeric, jsonb)       from public, anon;
revoke all on function public.kairos_fixed_save(bigint, text, numeric, integer) from public, anon;
revoke all on function public.kairos_fixed_delete(bigint)                     from public, anon;
revoke all on function public.kairos_money_dash(date)                         from public, anon;
grant execute on function public.kairos_plan()                                   to authenticated;
grant execute on function public.kairos_plan_save(numeric, numeric, jsonb)       to authenticated;
grant execute on function public.kairos_fixed_save(bigint, text, numeric, integer) to authenticated;
grant execute on function public.kairos_fixed_delete(bigint)                     to authenticated;
grant execute on function public.kairos_money_dash(date)                         to authenticated;
