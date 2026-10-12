-- =====================================================================
-- Coach Assiette : base de données
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
