-- =====================================================================
-- Monitor de stock · columnas nuevas de la hoja de Odoo (15/10/2026)
--   · Clientes demo     → a qué cliente se entregó cada unidad en Consignación-Demo
--   · Llegada estimada  → fechas y cantidades de lo que está en camino ("dd/mm (N u.)", "atrasada")
-- Ejecutar en el SQL Editor DESPUÉS de 20261015000000_monitor_stock.sql.
-- =====================================================================

-- En camino por día de llegada (fecha del movimiento en Odoo, hora Argentina)
create table if not exists public.incoming_by_day (
  product_id   integer not null references public.products(id) on delete cascade,
  warehouse_id integer not null references public.warehouses(id) on delete cascade,
  day          date    not null,
  qty          numeric not null default 0,
  primary key (product_id, warehouse_id, day)
);

-- Unidades en Consignación-Demo por cliente
create table if not exists public.demo_clients (
  product_id   integer not null references public.products(id) on delete cascade,
  warehouse_id integer not null references public.warehouses(id) on delete cascade,
  client       text    not null,
  qty          numeric not null default 0,
  primary key (product_id, warehouse_id, client)
);

alter table public.incoming_by_day enable row level security;
alter table public.demo_clients    enable row level security;
drop policy if exists "lectura deam" on public.incoming_by_day;
create policy "lectura deam" on public.incoming_by_day for select to authenticated using (public.is_allowed_user());
drop policy if exists "lectura deam" on public.demo_clients;
create policy "lectura deam" on public.demo_clients for select to authenticated using (public.is_allowed_user());
grant select on public.incoming_by_day, public.demo_clients to authenticated;

-- ---------- Reemplazo atómico: ahora también carga los detalles -------
drop function if exists public.replace_snapshot(jsonb, jsonb, jsonb);
create or replace function public.replace_snapshot(
  p_warehouses   jsonb,
  p_products     jsonb,
  p_stock        jsonb,
  p_incoming     jsonb default '[]'::jsonb,
  p_demo_clients jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into public.warehouses (id, name, code)
  select id, name, code
  from jsonb_to_recordset(p_warehouses) as x(id integer, name text, code text)
  on conflict (id) do update set name = excluded.name, code = excluded.code;

  insert into public.products (id, sku, name, category_id, category, updated_at)
  select id, sku, name, category_id, category, now()
  from jsonb_to_recordset(p_products)
       as x(id integer, sku text, name text, category_id integer, category text)
  on conflict (id) do update
    set sku = excluded.sku, name = excluded.name,
        category_id = excluded.category_id, category = excluded.category,
        updated_at = now();

  delete from public.stock_by_warehouse where true;
  delete from public.incoming_by_day where true;
  delete from public.demo_clients where true;

  insert into public.stock_by_warehouse (
    product_id, warehouse_id, disponible, no_conforme, demo,
    control_calidad, zona_franca, en_camino, comprometido)
  select product_id, warehouse_id,
         coalesce(disponible, 0), coalesce(no_conforme, 0), coalesce(demo, 0),
         coalesce(control_calidad, 0), coalesce(zona_franca, 0),
         coalesce(en_camino, 0), coalesce(comprometido, 0)
  from jsonb_to_recordset(p_stock) as x(
    product_id integer, warehouse_id integer, disponible numeric, no_conforme numeric,
    demo numeric, control_calidad numeric, zona_franca numeric,
    en_camino numeric, comprometido numeric);
  get diagnostics n = row_count;

  insert into public.incoming_by_day (product_id, warehouse_id, day, qty)
  select product_id, warehouse_id, day, sum(coalesce(qty, 0))
  from jsonb_to_recordset(p_incoming) as x(product_id integer, warehouse_id integer, day date, qty numeric)
  where exists (select 1 from public.products p where p.id = x.product_id)
  group by product_id, warehouse_id, day;

  insert into public.demo_clients (product_id, warehouse_id, client, qty)
  select product_id, warehouse_id, client, sum(coalesce(qty, 0))
  from jsonb_to_recordset(p_demo_clients) as x(product_id integer, warehouse_id integer, client text, qty numeric)
  where exists (select 1 from public.products p where p.id = x.product_id)
  group by product_id, warehouse_id, client;

  -- productos que ya no aparecen en Odoo se limpian
  delete from public.products p
  where not exists (select 1 from public.stock_by_warehouse s where s.product_id = p.id);

  return n;
end;
$$;
revoke all on function public.replace_snapshot(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ---------- Consulta de la web con las dos columnas nuevas ------------
-- Llegada estimada: "20/10 (5 u.) - 03/11 (2 u.)"; las fechas ya pasadas llevan " atrasada".
drop function if exists public.monitor(integer[]);
create or replace function public.monitor(p_warehouse_ids integer[] default null)
returns table (
  product_id integer, sku text, name text, category_id integer, category text,
  disponible numeric, no_conforme numeric, demo numeric, clientes_demo text,
  control_calidad numeric, zona_franca numeric, total_fisico numeric,
  en_camino numeric, llegada_estimada text, proxima_llegada date,
  disponible_mas_camino numeric, comprometido numeric, disponible_real numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select sw.product_id,
           sum(sw.disponible) as disponible, sum(sw.no_conforme) as no_conforme,
           sum(sw.demo) as demo, sum(sw.control_calidad) as control_calidad,
           sum(sw.zona_franca) as zona_franca, sum(sw.en_camino) as en_camino,
           sum(sw.comprometido) as comprometido
    from public.stock_by_warehouse sw
    where p_warehouse_ids is null or sw.warehouse_id = any (p_warehouse_ids)
    group by sw.product_id
  ),
  d as (   -- por producto y día, sumando los depósitos elegidos
    select i.product_id, i.day, sum(i.qty) as qty
    from public.incoming_by_day i
    where p_warehouse_ids is null or i.warehouse_id = any (p_warehouse_ids)
    group by i.product_id, i.day
  ),
  ll as (
    select d.product_id,
           min(d.day) as proxima,
           string_agg(
             to_char(d.day, 'DD/MM') || ' (' || replace(trim_scale(d.qty)::text, '.', ',') || ' u.)' ||
             case when d.day < (now() at time zone 'America/Argentina/Buenos_Aires')::date then ' atrasada' else '' end,
             ' - ' order by d.day) as texto
    from d
    group by d.product_id
  ),
  c as (
    select dc.product_id, string_agg(distinct dc.client, ' - ') as clientes
    from public.demo_clients dc
    where p_warehouse_ids is null or dc.warehouse_id = any (p_warehouse_ids)
    group by dc.product_id
  )
  select p.id, p.sku, p.name, p.category_id, p.category,
         s.disponible, s.no_conforme, s.demo, c.clientes,
         s.control_calidad, s.zona_franca,
         s.disponible + s.no_conforme + s.demo + s.control_calidad + s.zona_franca,
         s.en_camino, ll.texto, ll.proxima,
         (s.disponible - s.comprometido) + s.en_camino,
         s.comprometido,
         s.disponible - s.comprometido
  from s
  join public.products p on p.id = s.product_id
  left join ll on ll.product_id = s.product_id
  left join c  on c.product_id  = s.product_id
  order by p.sku nulls last, p.name;
$$;
grant execute on function public.monitor(integer[]) to authenticated;
