-- =====================================================================
-- Monitor de stock · DEAM
-- Esquema que replica la hoja "Monitor" del tablero de Odoo.
-- =====================================================================

-- ---------- Configuración de acceso ---------------------------------
create table if not exists public.allowed_domains (
  domain text primary key
);
insert into public.allowed_domains (domain) values ('deam.com.ar')
on conflict do nothing;

-- true si el usuario logueado tiene un email de un dominio permitido
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.allowed_domains d
    where lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 2)) = lower(d.domain)
  );
$$;

-- ---------- Datos sincronizados desde Odoo -------------------------
create table if not exists public.warehouses (
  id    integer primary key,           -- stock.warehouse.id (0 = sin depósito, ej. Consignación-Demo)
  name  text not null,
  code  text
);

create table if not exists public.products (
  id          integer primary key,     -- product.product.id
  sku         text,                    -- default_code
  name        text not null,
  category_id integer,
  category    text,
  updated_at  timestamptz not null default now()
);

-- Una fila por producto × depósito. Mismas columnas que la hoja.
create table if not exists public.stock_by_warehouse (
  product_id      integer not null references public.products(id) on delete cascade,
  warehouse_id    integer not null references public.warehouses(id) on delete cascade,
  disponible      numeric not null default 0,  -- ubicación "Disponible"
  no_conforme     numeric not null default 0,  -- ubicación "No conforme"
  demo            numeric not null default 0,  -- ubicación "Consignación-Demo"
  control_calidad numeric not null default 0,  -- ubicación "Recepción / Cuarentena"
  zona_franca     numeric not null default 0,  -- ubicación "Pendiente de liberación"
  en_camino       numeric not null default 0,  -- compras pendientes de recibir
  comprometido    numeric not null default 0,  -- facturado no remitido
  primary key (product_id, warehouse_id)
);
create index if not exists stock_by_warehouse_wh_idx on public.stock_by_warehouse (warehouse_id);

create table if not exists public.sync_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',  -- running | ok | error
  products    integer,
  rows        integer,
  message     text
);

-- Historial diario (una foto por día y producto, todos los depósitos)
create table if not exists public.stock_daily (
  snapshot_date   date not null,
  product_id      integer not null,
  sku             text,
  name            text,
  disponible      numeric,
  no_conforme     numeric,
  demo            numeric,
  control_calidad numeric,
  zona_franca     numeric,
  en_camino       numeric,
  comprometido    numeric,
  disponible_real numeric,
  primary key (snapshot_date, product_id)
);

-- ---------- Reemplazo atómico de la foto actual ---------------------
-- La llama la Edge Function con la service role. Todo en una transacción:
-- la web nunca ve una foto a medio cargar.
create or replace function public.replace_snapshot(
  p_warehouses jsonb,
  p_products   jsonb,
  p_stock      jsonb
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

  -- productos que ya no aparecen en Odoo se limpian
  delete from public.products p
  where not exists (select 1 from public.stock_by_warehouse s where s.product_id = p.id);

  return n;
end;
$$;
revoke all on function public.replace_snapshot(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ---------- Consulta que usa la web --------------------------------
-- Suma por producto, opcionalmente filtrando depósitos.
-- Fórmulas iguales a la hoja:
--   Total físico          = Disponible + No conforme + Demo + Control + Zona Franca
--   Disponible real       = Disponible − Comprometido
--   Disponible + en camino = Disponible real + En camino
create or replace function public.monitor(p_warehouse_ids integer[] default null)
returns table (
  product_id integer, sku text, name text, category_id integer, category text,
  disponible numeric, no_conforme numeric, demo numeric, control_calidad numeric,
  zona_franca numeric, total_fisico numeric, en_camino numeric,
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
  )
  select p.id, p.sku, p.name, p.category_id, p.category,
         s.disponible, s.no_conforme, s.demo, s.control_calidad, s.zona_franca,
         s.disponible + s.no_conforme + s.demo + s.control_calidad + s.zona_franca,
         s.en_camino,
         (s.disponible - s.comprometido) + s.en_camino,
         s.comprometido,
         s.disponible - s.comprometido
  from s
  join public.products p on p.id = s.product_id
  order by p.sku nulls last, p.name;
$$;

-- ---------- Seguridad (RLS) ----------------------------------------
alter table public.allowed_domains     enable row level security;
alter table public.warehouses          enable row level security;
alter table public.products            enable row level security;
alter table public.stock_by_warehouse  enable row level security;
alter table public.sync_runs           enable row level security;
alter table public.stock_daily         enable row level security;

drop policy if exists "lectura deam" on public.warehouses;
create policy "lectura deam" on public.warehouses for select to authenticated using (public.is_allowed_user());
drop policy if exists "lectura deam" on public.products;
create policy "lectura deam" on public.products for select to authenticated using (public.is_allowed_user());
drop policy if exists "lectura deam" on public.stock_by_warehouse;
create policy "lectura deam" on public.stock_by_warehouse for select to authenticated using (public.is_allowed_user());
drop policy if exists "lectura deam" on public.sync_runs;
create policy "lectura deam" on public.sync_runs for select to authenticated using (public.is_allowed_user());
drop policy if exists "lectura deam" on public.stock_daily;
create policy "lectura deam" on public.stock_daily for select to authenticated using (public.is_allowed_user());
-- allowed_domains: sin políticas → nadie la lee desde la web.

grant execute on function public.monitor(integer[]) to authenticated;
grant execute on function public.is_allowed_user() to authenticated;
grant select on public.warehouses, public.products, public.stock_by_warehouse,
               public.sync_runs, public.stock_daily to authenticated;
