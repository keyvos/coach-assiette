-- =====================================================================
-- Coach Assiette : lance la vérification des rappels toutes les 15 minutes
-- À coller dans Supabase > SQL Editor > New query, puis "Run",
-- APRÈS avoir créé la fonction "remind".
-- =====================================================================
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'coach-assiette-rappels';

select cron.schedule(
  'coach-assiette-rappels',
  '*/15 * * * *',
  $$ select net.http_post(
       url     := 'https://REMPLACER.supabase.co/functions/v1/remind',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body    := '{"run": true}'::jsonb
     ); $$
);
