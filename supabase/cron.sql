-- =====================================================================
-- Programación automática (correr UNA vez en el SQL Editor de Supabase,
-- después de desplegar la Edge Function).
-- Reemplazá los dos valores marcados con <<< >>>.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guardamos URL y secreto en Vault (no quedan en texto plano en el cron)
select vault.create_secret('https://<<<PROJECT_REF>>>.supabase.co/functions/v1/sync-odoo', 'sync_odoo_url');
select vault.create_secret('<<<EL_MISMO_CRON_SECRET_QUE_EN_LA_FUNCTION>>>', 'sync_odoo_secret');

-- 1) Sincronizar Odoo → Supabase cada 10 minutos
select cron.schedule(
  'sync-odoo-cada-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'sync_odoo_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_odoo_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- 2) Foto diaria para historial, 23:55 hora Argentina (02:55 UTC)
select cron.schedule(
  'stock-diario',
  '55 2 * * *',
  $$
  insert into public.stock_daily (snapshot_date, product_id, sku, name, disponible, no_conforme, demo,
                                  control_calidad, zona_franca, en_camino, comprometido, disponible_real)
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date,
         product_id, sku, name, disponible, no_conforme, demo,
         control_calidad, zona_franca, en_camino, comprometido, disponible_real
  from public.monitor(null)
  on conflict (snapshot_date, product_id) do update
    set disponible = excluded.disponible, no_conforme = excluded.no_conforme, demo = excluded.demo,
        control_calidad = excluded.control_calidad, zona_franca = excluded.zona_franca,
        en_camino = excluded.en_camino, comprometido = excluded.comprometido,
        disponible_real = excluded.disponible_real;
  $$
);

-- 3) Limpieza del log de sincronizaciones (deja 30 días)
select cron.schedule(
  'limpiar-sync-runs',
  '0 4 * * *',
  $$ delete from public.sync_runs where started_at < now() - interval '30 days'; $$
);

-- Para ver/quitar los trabajos:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select cron.unschedule('sync-odoo-cada-10-min');
