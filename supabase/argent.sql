-- ============================================================================
-- Kairos : module « Argent »
-- Dépenses Apple Pay notées par un raccourci, catégories, abonnements, objectifs.
-- À exécuter après schema.sql et rappels.sql. Peut être relancé sans risque.
-- ============================================================================

alter table public.kairos_profiles add column if not exists money_budget numeric(10,2);

create table if not exists public.kairos_tx (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  at        timestamptz not null default now(),
  amount    numeric(10,2) not null,
  merchant  text not null default '',
  category  text not null default 'autre',
  source    text not null default 'applepay' check (source in ('applepay', 'manuel', 'import')),
  card      text,
  manual_cat boolean not null default false
);
create index if not exists kairos_tx_user_at on public.kairos_tx (user_id, at);

create table if not exists public.kairos_merchant_rules (
  user_id      uuid not null references auth.users(id) on delete cascade,
  merchant_key text not null,
  category     text not null,
  primary key (user_id, merchant_key)
);

create table if not exists public.kairos_subs (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  amount        numeric(10,2) not null check (amount >= 0),
  period        text not null default 'mois' check (period in ('semaine', 'mois', 'an')),
  next_date     date not null,
  category      text not null default 'abonnements',
  notify_days   integer not null default 3 check (notify_days between 0 and 30),
  last_alert_for date,
  created_at    timestamptz not null default now()
);

create table if not exists public.kairos_goals (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  target     numeric(10,2) not null check (target > 0),
  saved      numeric(10,2) not null default 0,
  deadline   date,
  created_at timestamptz not null default now()
);

alter table public.kairos_tx             enable row level security;
alter table public.kairos_merchant_rules enable row level security;
alter table public.kairos_subs           enable row level security;
alter table public.kairos_goals          enable row level security;
revoke all on public.kairos_tx, public.kairos_merchant_rules, public.kairos_subs, public.kairos_goals from anon, authenticated;

-- ---------- Outils ----------

create or replace function public.kairos_norm_merchant(p text)
returns text language sql immutable as $$
  select lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

-- « 12,50 € », « 1 234,56 », « 12.5 » → 12.50
create or replace function public.kairos_parse_amount(p text)
returns numeric language plpgsql immutable as $$
declare s text := regexp_replace(coalesce(p, ''), '[^0-9,.\-]', '', 'g');
begin
  if s = '' then return null; end if;
  if position(',' in s) > 0 and position('.' in s) > 0 then
    if strpos(reverse(s), ',') < strpos(reverse(s), '.') then   -- la virgule est le séparateur décimal
      s := replace(replace(s, '.', ''), ',', '.');
    else
      s := replace(s, ',', '');
    end if;
  else
    s := replace(s, ',', '.');
  end if;
  return round(s::numeric, 2);
exception when others then return null;
end $$;

-- Catégorie : règle apprise de l'utilisateur, sinon mots-clés.
create or replace function public.kairos_guess_category(p_user uuid, p_merchant text)
returns text language plpgsql stable security definer set search_path = public as $$
declare k text := public.kairos_norm_merchant(p_merchant); c text;
begin
  select category into c from kairos_merchant_rules where user_id = p_user and merchant_key = k;
  if c is not null then return c; end if;
  return case
    when k ~ '(uber ?eats|deliveroo|just ?eat|mc ?do|mcdonald|burger|kfc|starbucks|subway|tacos|pizza|sushi|kebab|boulangerie|restaurant|brasserie|domino)' then 'resto'
    when k ~ '(carrefour|monoprix|franprix|lidl|auchan|leclerc|intermarch|casino|picard|naturalia|biocoop|super u|aldi|g20|spar|grand frais|primeur)' then 'courses'
    when k ~ '(sncf|ratp|navigo|uber|bolt|lime|velib|ouigo|blablacar|total|esso|shell|parking|indigo|tier|dott)' then 'transport'
    when k ~ '(steam|riot|playstation|nintendo|xbox|epic games|micromania|instant gaming|blizzard|ubisoft)' then 'jeux'
    when k ~ '(netflix|spotify|deezer|disney|prime video|canal|youtube|apple\.com|icloud|crunchyroll|adn|chatgpt|openai|claude|anthropic)' then 'abonnements'
    when k ~ '(cin[ée]ma|ugc|path[ée]|mk2|gaumont|ticketmaster|fnac spectacles|bowling|escape|concert)' then 'sorties'
    when k ~ '(pharmacie|doctolib|m[ée]decin|dentiste|opticien|laboratoire)' then 'sante'
    when k ~ '(ikea|leroy merlin|castorama|edf|engie|free|orange|sfr|bouygues|loyer)' then 'maison'
    when k ~ '(amazon|fnac|darty|decathlon|zara|h&m|uniqlo|action|primark|aliexpress|shein|cdiscount|boulanger|sephora)' then 'achats'
    else 'autre'
  end;
end $$;

-- Avance la prochaine échéance des abonnements déjà passés.
create or replace function public.kairos_roll_subs(p_user uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare today date := (now() at time zone 'Europe/Paris')::date; i integer := 0;
begin
  loop
    update kairos_subs
       set next_date = (next_date + case period when 'semaine' then interval '7 days'
                                                when 'an' then interval '1 year'
                                                else interval '1 month' end)::date
     where (p_user is null or user_id = p_user) and next_date < today;
    exit when not found or i > 120;
    i := i + 1;
  end loop;
end $$;

-- ---------- Appelée par le raccourci « Wallet / Transaction » ----------
-- POST /rest/v1/rpc/kairos_pay  {"p_token": "...", "p_amount": "12,50 €", "p_merchant": "Carrefour"}
create or replace function public.kairos_pay(p_token text, p_amount text, p_merchant text default null, p_card text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  pr kairos_profiles; amt numeric; merch text; cat text;
  m_start timestamptz; before_total numeric; after_total numeric; msg text := null;
  env_lim numeric; env_after numeric;
begin
  select * into pr from kairos_profiles where token = trim(p_token);
  if not found then raise exception 'Jeton Kairos inconnu' using errcode = '28000'; end if;
  amt := public.kairos_parse_amount(p_amount);
  if amt is null then raise exception 'Montant illisible : %', p_amount using errcode = '22023'; end if;
  merch := coalesce(nullif(trim(p_merchant), ''), 'Apple Pay');
  -- doublon (même montant, même commerçant, moins d'une minute) : ignoré
  if exists (select 1 from kairos_tx where user_id = pr.user_id and amount = amt
             and public.kairos_norm_merchant(merchant) = public.kairos_norm_merchant(merch)
             and at > now() - interval '60 seconds') then
    return json_build_object('ok', true, 'duplicate', true);
  end if;
  m_start := date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  select coalesce(sum(amount), 0) into before_total from kairos_tx where user_id = pr.user_id and at >= m_start;
  cat := public.kairos_guess_category(pr.user_id, merch);
  insert into kairos_tx (user_id, amount, merchant, category, source, card)
  values (pr.user_id, amt, left(merch, 120), cat, 'applepay', left(p_card, 60));
  after_total := before_total + amt;
  if pr.money_budget is not null and pr.money_budget > 0 then
    if before_total < pr.money_budget and after_total >= pr.money_budget then
      msg := format('Budget du mois atteint : %s € sur %s €.', round(after_total), round(pr.money_budget));
    elsif before_total < pr.money_budget * 0.8 and after_total >= pr.money_budget * 0.8 then
      msg := format('80 %% du budget du mois : %s € sur %s €.', round(after_total), round(pr.money_budget));
    end if;
  end if;
  -- Enveloppe de la catégorie (si un plan de budget existe)
  if msg is null and to_regclass('public.kairos_envelopes') is not null then
    select monthly into env_lim from kairos_envelopes where user_id = pr.user_id and category = cat;
    if env_lim is not null and env_lim > 0 then
      select coalesce(sum(amount), 0) into env_after from kairos_tx where user_id = pr.user_id and category = cat and at >= m_start;
      if env_after - amt < env_lim and env_after >= env_lim then
        msg := format('Enveloppe %s dépassée : %s € sur %s €.', cat, round(env_after), round(env_lim));
      elsif env_after - amt < env_lim * 0.8 and env_after >= env_lim * 0.8 then
        msg := format('Enveloppe %s à %s %% : %s € sur %s €.', cat, round(env_after / env_lim * 100), round(env_after), round(env_lim));
      end if;
    end if;
  end if;
  return json_strip_nulls(json_build_object('ok', true, 'category', cat, 'month_total', after_total, 'message', msg));
end $$;

-- ---------- Appelées par la web app ----------

create or replace function public.kairos_money(p_month date default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pr  kairos_profiles;
  m0  date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Paris')::date))::date;
  t0  timestamptz; t1 timestamptz; p0 timestamptz; pcut timestamptz;
  is_current boolean;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  insert into kairos_profiles (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from kairos_profiles where user_id = uid;
  perform public.kairos_roll_subs(uid);
  t0 := m0::timestamp at time zone 'Europe/Paris';
  t1 := (m0 + interval '1 month')::timestamp at time zone 'Europe/Paris';
  p0 := (m0 - interval '1 month')::timestamp at time zone 'Europe/Paris';
  is_current := now() >= t0 and now() < t1;
  -- même point du mois précédent (pour comparer à date égale)
  pcut := case when is_current then p0 + (now() - t0) else t0 end;
  return json_build_object(
    'month', to_char(m0, 'YYYY-MM'),
    'is_current', is_current,
    'budget', pr.money_budget,
    'total', (select coalesce(sum(amount), 0) from kairos_tx where user_id = uid and at >= t0 and at < t1),
    'prev_total_same_point', (select coalesce(sum(amount), 0) from kairos_tx where user_id = uid and at >= p0 and at < least(pcut, t0)),
    'prev_total', (select coalesce(sum(amount), 0) from kairos_tx where user_id = uid and at >= p0 and at < t0),
    'by_cat', (select coalesce(json_agg(x order by x.total desc), '[]') from (
                 select category as cat, sum(amount) as total, count(*) as n
                 from kairos_tx where user_id = uid and at >= t0 and at < t1 group by category) x),
    'tx', (select coalesce(json_agg(x order by x.at desc), '[]') from (
             select id, at, amount, merchant, category, source from kairos_tx
             where user_id = uid and at >= t0 and at < t1 order by at desc limit 100) x),
    'subs', (select coalesce(json_agg(x order by x.next_date), '[]') from (
               select id, name, amount, period, next_date, category, notify_days,
                      round(case period when 'an' then amount / 12 when 'semaine' then amount * 52 / 12 else amount end, 2) as monthly
               from kairos_subs where user_id = uid) x),
    'goals', (select coalesce(json_agg(x order by x.created_at), '[]') from (
                select id, name, target, saved, deadline, created_at from kairos_goals where user_id = uid) x),
    'applepay_count', (select count(*) from kairos_tx where user_id = uid and source = 'applepay'),
    'last_applepay', (select max(at) from kairos_tx where user_id = uid and source = 'applepay')
  );
end $$;

create or replace function public.kairos_money_settings(p_budget numeric)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_profiles set money_budget = nullif(p_budget, 0) where user_id = auth.uid();
end $$;

-- Ajouter / modifier une dépense. p_learn : retenir la catégorie pour ce commerçant.
create or replace function public.kairos_tx_save(
  p_id bigint, p_amount numeric, p_merchant text, p_category text,
  p_at timestamptz default null, p_learn boolean default false)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); rid bigint; k text := public.kairos_norm_merchant(p_merchant);
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  if p_id is null then
    insert into kairos_tx (user_id, at, amount, merchant, category, source, manual_cat)
    values (uid, coalesce(p_at, now()), round(p_amount, 2), left(coalesce(p_merchant, ''), 120),
            coalesce(nullif(p_category, ''), public.kairos_guess_category(uid, p_merchant)), 'manuel', p_category is not null)
    returning id into rid;
  else
    update kairos_tx set amount = round(p_amount, 2), merchant = left(coalesce(p_merchant, ''), 120),
                         category = p_category, at = coalesce(p_at, at), manual_cat = true
     where id = p_id and user_id = uid returning id into rid;
  end if;
  if p_learn and k <> '' and p_category is not null then
    insert into kairos_merchant_rules (user_id, merchant_key, category) values (uid, k, p_category)
    on conflict (user_id, merchant_key) do update set category = excluded.category;
    update kairos_tx set category = p_category
     where user_id = uid and public.kairos_norm_merchant(merchant) = k and not manual_cat;
  end if;
  return rid;
end $$;

create or replace function public.kairos_tx_delete(p_id bigint)
returns void language sql volatile security definer set search_path = public as $$
  delete from kairos_tx where id = p_id and user_id = auth.uid()
$$;

create or replace function public.kairos_sub_save(
  p_id bigint, p_name text, p_amount numeric, p_period text, p_next_date date, p_notify_days integer default 3)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); rid bigint;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  if p_id is null then
    insert into kairos_subs (user_id, name, amount, period, next_date, notify_days)
    values (uid, left(p_name, 80), round(p_amount, 2), p_period, p_next_date, coalesce(p_notify_days, 3))
    returning id into rid;
  else
    update kairos_subs set name = left(p_name, 80), amount = round(p_amount, 2), period = p_period,
                           next_date = p_next_date, notify_days = coalesce(p_notify_days, notify_days),
                           last_alert_for = case when next_date <> p_next_date then null else last_alert_for end
     where id = p_id and user_id = uid returning id into rid;
  end if;
  perform public.kairos_roll_subs(uid);
  return rid;
end $$;

create or replace function public.kairos_sub_delete(p_id bigint)
returns void language sql volatile security definer set search_path = public as $$
  delete from kairos_subs where id = p_id and user_id = auth.uid()
$$;

create or replace function public.kairos_goal_save(p_id bigint, p_name text, p_target numeric, p_deadline date default null)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); rid bigint;
begin
  if uid is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  if p_id is null then
    insert into kairos_goals (user_id, name, target, deadline) values (uid, left(p_name, 80), p_target, p_deadline) returning id into rid;
  else
    update kairos_goals set name = left(p_name, 80), target = p_target, deadline = p_deadline
     where id = p_id and user_id = uid returning id into rid;
  end if;
  return rid;
end $$;

create or replace function public.kairos_goal_add(p_id bigint, p_amount numeric)
returns numeric language plpgsql volatile security definer set search_path = public as $$
declare v numeric;
begin
  if auth.uid() is null then raise exception 'Non connecté' using errcode = '28000'; end if;
  update kairos_goals set saved = greatest(saved + round(p_amount, 2), 0)
   where id = p_id and user_id = auth.uid() returning saved into v;
  return v;
end $$;

create or replace function public.kairos_goal_delete(p_id bigint)
returns void language sql volatile security definer set search_path = public as $$
  delete from kairos_goals where id = p_id and user_id = auth.uid()
$$;

-- ---------- Alertes de renouvellement (envoyées par la fonction kairos-push) ----------

create or replace function public.kairos_sub_alerts_due()
returns table (r_sub bigint, r_user uuid, r_name text, r_amount numeric, r_days integer)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.name, s.amount,
         (s.next_date - (now() at time zone 'Europe/Paris')::date)::integer
  from kairos_subs s
  where s.notify_days > 0
    and extract(hour from now() at time zone 'Europe/Paris') >= 10
    and s.next_date >= (now() at time zone 'Europe/Paris')::date
    and s.next_date - s.notify_days <= (now() at time zone 'Europe/Paris')::date
    and s.last_alert_for is distinct from s.next_date
    and exists (select 1 from kairos_push_subs p where p.user_id = s.user_id)
$$;

create or replace function public.kairos_any_sub_due()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kairos_sub_alerts_due())
$$;

create or replace function public.kairos_due_sub_alerts(p_secret text)
returns table (r_name text, r_amount numeric, r_days integer, r_endpoint text, r_p256dh text, r_auth text)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.kairos_check_secret(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.kairos_roll_subs(null);
  return query
    with due as (select * from public.kairos_sub_alerts_due()),
    upd as (update kairos_subs s set last_alert_for = s.next_date from due where s.id = due.r_sub returning s.id)
    select due.r_name, due.r_amount, due.r_days, p.endpoint, p.p256dh, p.auth
    from due join kairos_push_subs p on p.user_id = due.r_user;
end $$;

-- ---------- Droits ----------
revoke all on function public.kairos_guess_category(uuid, text) from public, anon, authenticated;
revoke all on function public.kairos_roll_subs(uuid)            from public, anon, authenticated;
revoke all on function public.kairos_sub_alerts_due()           from public, anon, authenticated;
revoke all on function public.kairos_any_sub_due()              from public, anon, authenticated;

revoke all on function public.kairos_pay(text, text, text, text) from public;
grant execute on function public.kairos_pay(text, text, text, text) to anon, authenticated;
revoke all on function public.kairos_due_sub_alerts(text) from public;
grant execute on function public.kairos_due_sub_alerts(text) to anon, authenticated;

revoke all on function public.kairos_money(date)                                         from public, anon;
revoke all on function public.kairos_money_settings(numeric)                             from public, anon;
revoke all on function public.kairos_tx_save(bigint, numeric, text, text, timestamptz, boolean) from public, anon;
revoke all on function public.kairos_tx_delete(bigint)                                   from public, anon;
revoke all on function public.kairos_sub_save(bigint, text, numeric, text, date, integer) from public, anon;
revoke all on function public.kairos_sub_delete(bigint)                                  from public, anon;
revoke all on function public.kairos_goal_save(bigint, text, numeric, date)              from public, anon;
revoke all on function public.kairos_goal_add(bigint, numeric)                           from public, anon;
revoke all on function public.kairos_goal_delete(bigint)                                 from public, anon;
grant execute on function public.kairos_money(date)                                         to authenticated;
grant execute on function public.kairos_money_settings(numeric)                             to authenticated;
grant execute on function public.kairos_tx_save(bigint, numeric, text, text, timestamptz, boolean) to authenticated;
grant execute on function public.kairos_tx_delete(bigint)                                   to authenticated;
grant execute on function public.kairos_sub_save(bigint, text, numeric, text, date, integer) to authenticated;
grant execute on function public.kairos_sub_delete(bigint)                                  to authenticated;
grant execute on function public.kairos_goal_save(bigint, text, numeric, date)              to authenticated;
grant execute on function public.kairos_goal_add(bigint, numeric)                           to authenticated;
grant execute on function public.kairos_goal_delete(bigint)                                 to authenticated;

-- ---------- La tâche planifiée réveille aussi la fonction pour les alertes d'abonnement ----------
select cron.unschedule(jobid) from cron.job where jobname = 'kairos-rappels';
select cron.schedule('kairos-rappels', '* * * * *', $cron$
  select net.http_post(
    url := 'https://qhbrypojnamuhclaneem.supabase.co/functions/v1/kairos-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-kairos-cron', (select value from public.kairos_secrets where name = 'cron')),
    body := '{}'::jsonb)
  where public.kairos_any_due() or public.kairos_any_sub_due();
$cron$);
