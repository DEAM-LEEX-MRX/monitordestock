-- Columna "Reservado bloqueado": salidas pendientes de órdenes con Estado operativo
-- "Bloqueado" que todavía no se facturaron (ni en Odoo ni en SAP).
-- (Aplicada en producción el 22/10/2026.)

alter table public.stock_by_warehouse add column if not exists reservado_bloqueado numeric not null default 0;

-- replace_snapshot no se modifica: inserta las filas con reservado_bloqueado = 0 (default)
-- y la Edge Function completa el valor después con esta función.
create or replace function public.set_reservado_bloqueado(p_rows jsonb)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  update public.stock_by_warehouse sw
     set reservado_bloqueado = x.qty
    from jsonb_to_recordset(p_rows) as x(product_id integer, warehouse_id integer, qty numeric)
   where sw.product_id = x.product_id and sw.warehouse_id = x.warehouse_id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.set_reservado_bloqueado(jsonb) from public, anon, authenticated;
grant execute on function public.set_reservado_bloqueado(jsonb) to service_role;

-- Lo mismo que public.monitor() más las dos columnas nuevas. La web usa esta.
create or replace function public.monitor_v2(p_warehouse_ids integer[] default null)
 returns table(product_id integer, sku text, name text, category_id integer, category text, disponible numeric, no_conforme numeric, demo numeric, clientes_demo text, control_calidad numeric, zona_franca numeric, total_fisico numeric, en_camino numeric, llegada_estimada text, proxima_llegada date, disponible_mas_camino numeric, comprometido numeric, disponible_real numeric, reservado_bloqueado numeric, disponible_real_con_bloqueado numeric)
 language sql stable set search_path to 'public'
as $$
  select m.product_id, m.sku, m.name, m.category_id, m.category, m.disponible, m.no_conforme, m.demo,
         m.clientes_demo, m.control_calidad, m.zona_franca, m.total_fisico, m.en_camino,
         m.llegada_estimada, m.proxima_llegada, m.disponible_mas_camino, m.comprometido, m.disponible_real,
         coalesce(r.qty, 0) as reservado_bloqueado,
         m.disponible_real - coalesce(r.qty, 0) as disponible_real_con_bloqueado
  from public.monitor(p_warehouse_ids) m
  left join (
    select sw.product_id, sum(sw.reservado_bloqueado) as qty
    from public.stock_by_warehouse sw
    where p_warehouse_ids is null or sw.warehouse_id = any (p_warehouse_ids)
    group by sw.product_id
  ) r on r.product_id = m.product_id
  order by m.sku nulls last, m.name;
$$;
grant execute on function public.monitor_v2(integer[]) to anon, authenticated, service_role;
