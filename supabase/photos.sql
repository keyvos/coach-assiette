-- =====================================================================
-- Coach Assiette : photos de progression (à lancer UNE fois)
-- © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
-- À coller dans Supabase > SQL Editor > New query, puis cliquer "Run".
-- Le script peut être relancé sans risque.
--
-- Qui voit quoi :
--  - chaque personne voit, ajoute et supprime SEULEMENT ses propres photos ;
--  - le coach voit une photo SEULEMENT si la personne a coché
--    « Partager mes photos avec mon coach » (shared = true) ;
--  - si la personne supprime son compte, ses photos partent avec.
-- =====================================================================
create table if not exists public.body_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  taken_on   date not null default current_date,
  angle      text not null check (angle in ('front', 'side')),
  img        text not null check (img like 'data:image/%' and length(img) < 600000),
  shared     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists body_photos_user on public.body_photos (user_id, taken_on);

alter table public.body_photos enable row level security;

drop policy if exists body_photos_read   on public.body_photos;
drop policy if exists body_photos_insert on public.body_photos;
drop policy if exists body_photos_update on public.body_photos;
drop policy if exists body_photos_delete on public.body_photos;
create policy body_photos_read   on public.body_photos for select to authenticated using (user_id = auth.uid() or (shared and public.is_coach()));
create policy body_photos_insert on public.body_photos for insert to authenticated with check (user_id = auth.uid());
create policy body_photos_update on public.body_photos for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy body_photos_delete on public.body_photos for delete to authenticated using (user_id = auth.uid());

revoke all on public.body_photos from anon;
grant select, insert, update, delete on public.body_photos to authenticated;

select 'Photos de progression : OK' as resultat;
