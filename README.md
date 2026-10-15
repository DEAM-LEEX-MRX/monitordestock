# Monitor de stock · DEAM

Versión web de la hoja **Monitor** del tablero de Odoo "Monitor de stock", con los datos actualizados automáticamente.

```
Odoo (API JSON-2) ──cada 10 min──► Supabase Edge Function "sync-odoo" ──► tablas en Supabase
                                                                              │
                         Web (React + Vite) en Vercel ◄── login @deam.com.ar ─┘
```

- **Columnas y fórmulas** iguales a la hoja: Disponible, No conforme, Demo / Consignación, Clientes demo, Control de calidad, Zona Franca, Total físico, En camino, Llegada estimada, Disponible + en camino, Comprometido y Disponible real.
- **Filtros:** SKU, nombre, categoría, depósito y "solo negativos". Además se puede ordenar por cualquier columna y exportar a CSV (Excel).
- **Actualización:** automática cada 10 minutos, más un botón **Actualizar ahora**.
- **Historial:** queda una foto diaria por producto en la tabla `stock_daily`.
- **Acceso:** solo con correos `@deam.com.ar`, entrando por un enlace mágico sin contraseña. Lo controla Supabase con RLS.

## Cómo se calcula cada columna

| Columna | Origen en Odoo |
|---|---|
| Disponible | `stock.quant` en ubicaciones internas llamadas **Disponible** |
| No conforme | ubicaciones **No conforme** |
| Demo / Consignación | ubicación **Consignación-Demo** (sin depósito) |
| Clientes demo | por cada serie en **Consignación-Demo**, el cliente (`picking_partner_id`) de la última entrega hecha a esa ubicación (`stock.move.line`); si no hay, «cliente sin identificar» |
| Control de calidad | ubicaciones **Recepción / Cuarentena** |
| Zona Franca | ubicación **Pendiente de liberación** (depósito ZF) |
| En camino | `stock.move` de recepciones con compra, no hechos ni cancelados (`product_qty`) |
| Llegada estimada | los mismos movimientos agrupados por día (`date`, hora Argentina): «20/10 (5 u.) - 03/11 (2 u.)»; si la fecha ya pasó dice «atrasada» |
| Comprometido | `stock.move` de entregas no hechas, con línea de venta ya facturada (`qty_invoiced > 0`) |
| Total físico | Disponible + No conforme + Demo + Control + Zona Franca |
| Disponible real | Disponible − Comprometido |
| Disponible + en camino | Disponible real + En camino |

Para mapear otros nombres de ubicación, editá `LOCATION_BUCKETS` en `supabase/functions/sync-odoo/transform.ts`.

---

## Puesta en marcha (≈ 30 min)

### 1. Odoo: usuario técnico y API key

1. Revisá que la suscripción tenga acceso a la API externa. En Odoo Online es el plan **Custom**.
2. Creá un usuario interno, por ejemplo `api-monitor@deam.com.ar`, con permisos de lectura en Inventario, Compras y Ventas.
3. Entrá como ese usuario y andá a **Preferencias → Seguridad de la cuenta → Nueva clave API**. Guardá la clave.
4. Anotá el nombre de la base de datos (aparece en `https://deam.odoo.com/web/database/selector` o en *Ajustes → Activar modo desarrollador*).

### 2. GitHub

```bash
git init && git add . && git commit -m "Monitor de stock"
gh repo create deam/monitor-stock --private --source . --push
```

### 3. Supabase

1. Creá un proyecto nuevo (región São Paulo).
2. Abrí el **SQL Editor** y ejecutá, en orden, `supabase/migrations/20261015000000_monitor_stock.sql` y `supabase/migrations/20261015180000_llegada_y_clientes_demo.sql`.
3. Desplegá la función con la [CLI de Supabase](https://supabase.com/docs/guides/cli):
   ```bash
   supabase login
   supabase link --project-ref <PROJECT_REF>
   supabase secrets set ODOO_URL=https://deam.odoo.com ODOO_DB=<nombre_base> \
       ODOO_API_KEY=<clave_api_odoo> CRON_SECRET=<texto_largo_al_azar>
   supabase functions deploy sync-odoo
   ```
   Para generar el `CRON_SECRET` sirve `openssl rand -hex 24`.
4. Probala una vez a mano:
   ```bash
   curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/sync-odoo -H "x-cron-secret: <CRON_SECRET>"
   ```
   Tiene que responder `{"ok":true,"products":928,...}`.
5. En el SQL Editor, ejecutá `supabase/cron.sql` reemplazando `<<<PROJECT_REF>>>` y el secreto. Eso programa la sincronización cada 10 minutos y la foto diaria.
6. En **Authentication → URL Configuration**, poné como *Site URL* la dirección de Vercel (paso 4), por ejemplo `https://monitor-stock.vercel.app`.

### 4. Vercel

1. En **Add New → Project**, importá el repo de GitHub. Detecta Vite solo.
2. Cargá estas variables de entorno (están en Supabase → *Project Settings → API*):
   - `VITE_SUPABASE_URL` = `https://<PROJECT_REF>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = la clave *anon public*
   - `VITE_ALLOWED_DOMAIN` = `deam.com.ar`
3. Hacé clic en Deploy. Cada `git push` vuelve a publicar.

---

## Desarrollo local

```bash
npm install
cp .env.example .env      # completar, o dejar VITE_DEMO=1 para ver el diseño con datos de ejemplo
npm run dev
npm test                  # pruebas de la lógica de sincronización y filtros
```

## Mantenimiento

- **Ver si sincroniza bien:** `select * from sync_runs order by started_at desc limit 20;`. Si la última falla, la web lo muestra en rojo arriba.
- **Cambiar la frecuencia:** `select cron.alter_job((select jobid from cron.job where jobname='sync-odoo-cada-10-min'), schedule := '*/5 * * * *');`
- **Permitir otro dominio de correo:** `insert into allowed_domains values ('otrodominio.com');`
- **Rotar la clave de Odoo:** `supabase secrets set ODOO_API_KEY=...` (no hace falta volver a desplegar).

## Estructura

```
src/                      Web (React)
  Monitor.tsx             pantalla principal
  logic.ts                filtros, orden, totales, CSV
  data.ts                 acceso a Supabase (y modo demo)
supabase/
  migrations/…sql         tablas, función monitor(), RLS
  functions/sync-odoo/    sincronización Odoo → Supabase
  cron.sql                programación con pg_cron
tests/                    pruebas (vitest)
```
