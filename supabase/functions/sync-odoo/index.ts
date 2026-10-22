// Edge Function: lee Odoo (API JSON-2 de Odoo 19) y reemplaza la foto de stock en Supabase.
// Se dispara desde pg_cron (header x-cron-secret) o desde el botón "Actualizar" de la web
// (usuario logueado con email de un dominio permitido).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  buildSnapshot, DEMO_LOCATION_NAMES, productIdsToShow,
  type OdooLocation, type OdooMove, type OdooMoveLine, type OdooPickingType, type OdooProduct, type OdooQuant, type OdooWarehouse,
} from "./transform.ts";

const ODOO_URL = (Deno.env.get("ODOO_URL") ?? "").replace(/\/$/, "");
const ODOO_DB = Deno.env.get("ODOO_DB") ?? "";
const ODOO_API_KEY = Deno.env.get("ODOO_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- Cliente Odoo JSON-2 ----------------------------------------
async function odoo<T>(model: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ODOO_URL}/json/2/${model}/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `bearer ${ODOO_API_KEY}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(ODOO_DB ? { "X-Odoo-Database": ODOO_DB } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odoo ${model}.${method} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return await res.json() as T;
}

async function searchReadAll<T>(model: string, domain: unknown[], fields: string[], context: Record<string, unknown> = {}): Promise<T[]> {
  return searchReadAllOrdered<T>(model, domain, fields, "id", context);
}

async function searchReadAllOrdered<T>(model: string, domain: unknown[], fields: string[], order: string, context: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  const limit = 2000;
  for (let offset = 0; ; offset += limit) {
    const page = await odoo<T[]>(model, "search_read", { domain, fields, limit, offset, order, context });
    out.push(...page);
    if (page.length < limit) return out;
  }
}

// Dominios copiados de los pivots del tablero
const DOMAIN_QUANTS = [["location_id.usage", "=", "internal"], ["quantity", "!=", 0]];
const DOMAIN_EN_CAMINO = [
  ["picking_type_id.code", "=", "incoming"],
  ["state", "not in", ["done", "cancel"]],
  ["purchase_line_id", "!=", false],
];
// Comprometido = facturado no remitido. Cuenta como facturado lo facturado en Odoo
// (qty_invoiced > 0) o las órdenes migradas de SAP que tienen N° de factura SAP
// (en Odoo esas líneas quedan con qty_invoiced = 0).
const DOMAIN_COMPROMETIDO = [
  ["picking_type_id.code", "=", "outgoing"],
  ["state", "not in", ["done", "cancel"]],
  ["sale_line_id", "!=", false],
  "|",
  ["sale_line_id.qty_invoiced", ">", 0],
  ["sale_line_id.order_id.x_studio_sap_factura_nro", "!=", false],
];
// Reservado bloqueado = salidas pendientes de órdenes con Estado operativo "Bloqueado"
// que NO están facturadas (ni en Odoo ni en SAP). Es el complemento exacto de
// DOMAIN_COMPROMETIDO dentro de las bloqueadas, así nada se cuenta dos veces.
const DOMAIN_RESERVADO_BLOQUEADO = [
  ["picking_type_id.code", "=", "outgoing"],
  ["state", "not in", ["done", "cancel"]],
  ["sale_line_id", "!=", false],
  ["sale_line_id.order_id.x_estado_operativo", "=", "bloqueado"],
  ["sale_line_id.qty_invoiced", "<=", 0],
  ["sale_line_id.order_id.x_studio_sap_factura_nro", "=", false],
];

// ---------- Autorización ----------------------------------------------
async function authorized(req: Request, admin: SupabaseClient): Promise<boolean> {
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) return true;
  const token = (req.headers.get("authorization") ?? "").replace(/^bearer\s+/i, "");
  if (!token) return false;
  const { data } = await admin.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: domains } = await admin.from("allowed_domains").select("domain");
  return (domains ?? []).some((d) => email.endsWith("@" + String(d.domain).toLowerCase()));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (!(await authorized(req, admin))) return json({ error: "No autorizado" }, 401);
  if (!ODOO_URL || !ODOO_API_KEY) return json({ error: "Faltan ODOO_URL / ODOO_API_KEY" }, 500);

  // Evita corridas superpuestas o demasiado seguidas (botón apretado varias veces)
  const { data: last } = await admin.from("sync_runs").select("started_at,status")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.started_at).getTime() < 60_000 &&
      (last.status === "running" || last.status === "ok")) {
    return json({ skipped: true, reason: "Ya se sincronizó hace menos de 1 minuto" });
  }

  const { data: run } = await admin.from("sync_runs").insert({ status: "running" }).select("id").single();
  const finish = (patch: Record<string, unknown>) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", run!.id);

  try {
    const [warehouses, locations, quants, incoming, committed, blocked] = await Promise.all([
      searchReadAll<OdooWarehouse>("stock.warehouse", [], ["name", "code"]),
      searchReadAll<OdooLocation>("stock.location", [["usage", "=", "internal"]], ["name", "warehouse_id"], { active_test: false }),
      searchReadAll<OdooQuant>("stock.quant", DOMAIN_QUANTS, ["product_id", "location_id", "quantity", "lot_id"]),
      searchReadAll<OdooMove>("stock.move", DOMAIN_EN_CAMINO, ["product_id", "product_qty", "picking_type_id", "date"]),
      searchReadAll<OdooMove>("stock.move", DOMAIN_COMPROMETIDO, ["product_id", "product_qty", "picking_type_id"]),
      searchReadAll<OdooMove>("stock.move", DOMAIN_RESERVADO_BLOQUEADO, ["product_id", "product_qty", "picking_type_id"]),
    ]);

    const ptIds = [...new Set([...incoming, ...committed, ...blocked].map((m) => (m.picking_type_id ? m.picking_type_id[0] : 0)).filter(Boolean))];
    const productIds = productIdsToShow(quants, incoming, committed, blocked);

    // Productos que hoy están en Consignación-Demo (para buscar a qué cliente se entregaron)
    const demoLocIds = new Set(locations.filter((l) => DEMO_LOCATION_NAMES.includes(l.name)).map((l) => l.id));
    const demoProductIds = [...new Set(quants
      .filter((q) => q.location_id && demoLocIds.has(q.location_id[0]) && q.product_id)
      .map((q) => (q.product_id as [number, string])[0]))];

    // Todos los productos activos de tipo "Bienes" de Odoo, más los que tengan movimiento.
    const DOMAIN_PRODUCTS = productIds.length
      ? ["|", ["type", "=", "consu"], ["id", "in", productIds]]
      : [["type", "=", "consu"]];

    const [pickingTypes, products, demoMoveLines] = await Promise.all([
      ptIds.length
        ? searchReadAll<OdooPickingType>("stock.picking.type", [["id", "in", ptIds]], ["warehouse_id"], { active_test: false })
        : Promise.resolve([] as OdooPickingType[]),
      searchReadAll<OdooProduct>("product.product", DOMAIN_PRODUCTS, ["default_code", "name", "categ_id"]),
      demoProductIds.length
        ? searchReadAllOrdered<OdooMoveLine>("stock.move.line", [
            ["location_dest_id.usage", "=", "internal"],
            ["location_dest_id.name", "in", DEMO_LOCATION_NAMES],
            ["state", "=", "done"],
            ["product_id", "in", demoProductIds],
          ], ["product_id", "lot_id", "picking_partner_id", "date"], "date desc, id desc")
        : Promise.resolve([] as OdooMoveLine[]),
    ]);

    const snap = buildSnapshot({ warehouses, locations, quants, incoming, committed, blocked, pickingTypes, products, demoMoveLines });

    const { data: n, error } = await admin.rpc("replace_snapshot", {
      p_warehouses: snap.warehouses, p_products: snap.products, p_stock: snap.stock,
      p_incoming: snap.incoming, p_demo_clients: snap.demoClients,
    });
    if (error) throw new Error(`Supabase: ${error.message}`);

    // Reservado bloqueado: se escribe aparte sobre las filas recién cargadas
    const reservado = snap.stock
      .filter((s) => s.reservado_bloqueado !== 0)
      .map((s) => ({ product_id: s.product_id, warehouse_id: s.warehouse_id, qty: s.reservado_bloqueado }));
    if (reservado.length) {
      const { error: e2 } = await admin.rpc("set_reservado_bloqueado", { p_rows: reservado });
      if (e2) throw new Error(`Supabase (reservado bloqueado): ${e2.message}`);
    }

    await finish({ status: "ok", products: snap.products.length, rows: n });
    return json({ ok: true, products: snap.products.length, rows: n, reservado_bloqueado: reservado.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    await finish({ status: "error", message });
    return json({ error: message }, 500);
  }
});
