-- =====================================================================
-- Coach Assiette : base de données
-- © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
-- À coller dans Supabase > SQL Editor > New query, puis cliquer "Run".
-- AVANT de lancer : remplace TON-ADRESSE@exemple.com (tout en bas)
-- par l'adresse e-mail avec laquelle TU te connecteras à l'application
-- en tant que coach.
-- Le script peut être relancé sans risque.
-- =====================================================================

-- 1. Données de chaque personne (profil, repas, mesures, bilans...)
create table if not exists public.kv (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- 2. Résumé partagé avec le coach (seulement si le client l'accepte)
create table if not exists public.coaching (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb,
  updated_at timestamptz not null default now()
);

-- 3. Avis des testeurs
create table if not exists public.feedback (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb,
  updated_at timestamptz not null default now()
);

-- 4. Adresse(s) du coach
create table if not exists public.coach_emails (
  email text primary key
);

-- 5. Compteur d'analyses IA par jour (protège ta facture)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  n       integer not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------
-- Sécurité : chaque ligne n'est visible que par la bonne personne
-- ---------------------------------------------------------------------
alter table public.kv           enable row level security;
alter table public.coaching     enable row level security;
alter table public.feedback     enable row level security;
alter table public.coach_emails enable row level security;
alter table public.ai_usage     enable row level security;

create or replace function public.is_coach()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.coach_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists kv_own on public.kv;
create policy kv_own on public.kv for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists coaching_read on public.coaching;
drop policy if exists coaching_insert on public.coaching;
drop policy if exists coaching_update on public.coaching;
drop policy if exists coaching_delete on public.coaching;
create policy coaching_read   on public.coaching for select to authenticated using (user_id = auth.uid() or public.is_coach());
create policy coaching_insert on public.coaching for insert to authenticated with check (user_id = auth.uid());
create policy coaching_update on public.coaching for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy coaching_delete on public.coaching for delete to authenticated using (user_id = auth.uid());

drop policy if exists feedback_read on public.feedback;
drop policy if exists feedback_insert on public.feedback;
drop policy if exists feedback_update on public.feedback;
drop policy if exists feedback_delete on public.feedback;
create policy feedback_read   on public.feedback for select to authenticated using (user_id = auth.uid() or public.is_coach());
create policy feedback_insert on public.feedback for insert to authenticated with check (user_id = auth.uid());
create policy feedback_update on public.feedback for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy feedback_delete on public.feedback for delete to authenticated using (user_id = auth.uid());

-- Une personne peut seulement savoir si SA propre adresse est celle d'un coach
drop policy if exists coach_self on public.coach_emails;
create policy coach_self on public.coach_emails for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ai_usage : aucune règle = personne n'y accède depuis l'application (seule la fonction IA, côté serveur)

revoke all on public.kv, public.coaching, public.feedback, public.coach_emails, public.ai_usage from anon;
grant select, insert, update, delete on public.kv, public.coaching, public.feedback to authenticated;
grant select on public.coach_emails to authenticated;
revoke all on public.ai_usage from authenticated;

-- ---------------------------------------------------------------------
-- Droit à l'effacement : une personne peut supprimer son propre compte
-- (toutes ses données partent avec, grâce à "on delete cascade")
-- ---------------------------------------------------------------------
create or replace function public.delete_me()
returns void language sql security definer set search_path = public as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

-- ---------------------------------------------------------------------
-- TON ADRESSE DE COACH : remplace l'adresse ci-dessous avant de lancer
-- ---------------------------------------------------------------------
insert into public.coach_emails (email) values (lower('TON-ADRESSE@exemple.com'))
on conflict do nothing;

-- =====================================================================
-- Rappels de repas (notifications)
-- =====================================================================
create table if not exists public.push_subs (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null,
  sub        jsonb not null,
  tz         text not null default 'Europe/Paris',
  lang       text not null default 'fr',
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.push_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  kind    text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);
create table if not exists public.app_secrets (
  name  text primary key,
  value jsonb not null
);
alter table public.push_subs   enable row level security;
alter table public.push_log    enable row level security;
alter table public.app_secrets enable row level security;

drop policy if exists push_own on public.push_subs;
create policy push_own on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.push_subs, public.push_log, public.app_secrets from anon;
grant select, insert, update, delete on public.push_subs to authenticated;
revoke all on public.push_log, public.app_secrets from authenticated;
-- push_log et app_secrets : aucune règle = accessibles seulement par la fonction "remind", côté serveur

-- =====================================================================
-- Abonnements payants (Stripe)
-- Tant que tu ne les actives pas dans « Mes clients > Abonnements »,
-- tout le monde utilise l'application gratuitement.
-- =====================================================================
create table if not exists public.app_config (
  name  text primary key,
  value jsonb not null
);
insert into public.app_config (name, value)
values ('billing', '{"on": false, "default": "free", "grace_days": 3}'::jsonb)
on conflict do nothing;

-- Qui paie et qui ne paie pas : réglé par toi, par adresse e-mail
-- (ça marche même pour quelqu'un qui n'a pas encore créé son compte)
create table if not exists public.billing_plans (
  email      text primary key,
  plan       text not null check (plan in ('free', 'paid')),
  updated_at timestamptz not null default now()
);

-- État de l'abonnement de chaque compte, tenu à jour automatiquement par Stripe
create table if not exists public.subscriptions (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  stripe_customer text,
  stripe_sub      text,
  status          text not null default 'none',
  period_end      timestamptz,
  cancel_at_end   boolean not null default false,
  status_since    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.app_config    enable row level security;
alter table public.billing_plans enable row level security;
alter table public.subscriptions enable row level security;

-- Le réglage général (activé ou non) peut être lu par l'application ; personne ne peut le modifier directement
drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config for select to authenticated using (true);

revoke all on public.app_config, public.billing_plans, public.subscriptions from anon;
revoke all on public.billing_plans, public.subscriptions from authenticated;
revoke all on public.app_config from authenticated;
grant select on public.app_config to authenticated;
-- billing_plans et subscriptions : aucune règle = modifiables seulement par les fonctions ci-dessous et par Stripe (côté serveur)

-- Accès d'une personne : a-t-elle le droit d'utiliser l'analyse par IA ?
create or replace function public.access_for(uid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cfg jsonb; em text; pl text; coach boolean; st text; since timestamptz; pend timestamptz; cae boolean; ok boolean; grace int; billing_on boolean;
begin
  select value into cfg from public.app_config where name = 'billing';
  cfg := coalesce(cfg, '{}'::jsonb);
  billing_on := coalesce((cfg ->> 'on')::boolean, false);
  grace := coalesce((cfg ->> 'grace_days')::int, 3);
  select lower(u.email::text) into em from auth.users u where u.id = uid;
  coach := exists (select 1 from public.coach_emails c where lower(c.email) = em);
  select bp.plan into pl from public.billing_plans bp where bp.email = em;
  pl := coalesce(pl, cfg ->> 'default', 'free');
  select s.status, s.status_since, s.period_end, s.cancel_at_end into st, since, pend, cae from public.subscriptions s where s.user_id = uid;
  st := coalesce(st, 'none');
  if not billing_on or coach or pl = 'free' then ok := true;
  elsif st in ('active', 'trialing') then ok := true;
  elsif st in ('past_due', 'incomplete') and since > now() - make_interval(days => grace) then ok := true;
  else ok := false;
  end if;
  return jsonb_build_object('billing', billing_on, 'plan', case when coach then 'coach' else pl end, 'status', st,
    'period_end', pend, 'cancel_at_end', coalesce(cae, false), 'allowed', ok);
end $$;
revoke all on function public.access_for(uuid) from public, anon, authenticated;
grant execute on function public.access_for(uuid) to service_role;

create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = public as $$
  select public.access_for(auth.uid());
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

-- Pour toi (coach) : la liste de tous les comptes et de leur abonnement
create or replace function public.coach_billing_list()
returns table (email text, user_id uuid, created_at timestamptz, plan text, status text, period_end timestamptz, cancel_at_end boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(lower(u.email::text), bp.email), u.id, u.created_at, bp.plan, s.status, s.period_end, s.cancel_at_end
  from auth.users u
  full outer join public.billing_plans bp on bp.email = lower(u.email::text)
  left join public.subscriptions s on s.user_id = u.id
  where public.is_coach()
  order by u.created_at desc nulls first;
$$;
revoke all on function public.coach_billing_list() from public, anon;
grant execute on function public.coach_billing_list() to authenticated;

-- Pour toi (coach) : rendre une personne gratuite ou payante ('default' = suivre le réglage général)
create or replace function public.coach_set_plan(target_email text, new_plan text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Réservé au coach' using errcode = '42501'; end if;
  if new_plan = 'default' then
    delete from public.billing_plans where email = lower(trim(target_email));
  elsif new_plan in ('free', 'paid') then
    insert into public.billing_plans (email, plan, updated_at) values (lower(trim(target_email)), new_plan, now())
    on conflict (email) do update set plan = excluded.plan, updated_at = now();
  else
    raise exception 'Valeur inconnue : %', new_plan;
  end if;
end $$;
revoke all on function public.coach_set_plan(text, text) from public, anon;
grant execute on function public.coach_set_plan(text, text) to authenticated;

-- Pour toi (coach) : activer / désactiver les abonnements et choisir le réglage des nouveaux comptes
create or replace function public.coach_set_billing(turn_on boolean, default_plan text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Réservé au coach' using errcode = '42501'; end if;
  if default_plan not in ('free', 'paid') then raise exception 'Valeur inconnue : %', default_plan; end if;
  insert into public.app_config (name, value) values ('billing', jsonb_build_object('on', turn_on, 'default', default_plan, 'grace_days', 3))
  on conflict (name) do update set value = public.app_config.value || jsonb_build_object('on', turn_on, 'default', default_plan);
end $$;
revoke all on function public.coach_set_billing(boolean, text) from public, anon;
grant execute on function public.coach_set_billing(boolean, text) to authenticated;
