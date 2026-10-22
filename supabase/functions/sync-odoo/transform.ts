// Lógica pura (sin red): convierte lo leído de Odoo en las filas de Supabase.
// Replica exactamente los pivots de la hoja "Monitor" del tablero de Odoo.

export type M2O = [number, string] | false;

export interface OdooWarehouse { id: number; name: string; code: string | false }
export interface OdooLocation { id: number; name: string; warehouse_id: M2O }
export interface OdooQuant { product_id: M2O; location_id: M2O; quantity: number; lot_id?: M2O }
export interface OdooMove { product_id: M2O; product_qty: number; picking_type_id: M2O; date?: string | false }
/** Movimiento hecho hacia Consignación-Demo: dice a qué cliente se entregó cada serie. */
export interface OdooMoveLine { product_id: M2O; lot_id: M2O; picking_partner_id: M2O; date: string | false }
export interface OdooPickingType { id: number; warehouse_id: M2O }
export interface OdooProduct { id: number; default_code: string | false; name: string; categ_id: M2O }

export type Bucket = "disponible" | "no_conforme" | "demo" | "control_calidad" | "zona_franca";

/** Nombre de ubicación en Odoo (campo `name`) → columna de la hoja. */
export const LOCATION_BUCKETS: Record<string, Bucket> = {
  "Disponible": "disponible",
  "No conforme": "no_conforme",
  "Consignación-Demo": "demo",
  "Recepción / Cuarentena": "control_calidad",
  "Pendiente de liberación": "zona_franca",
};

/** Nombres de ubicación que cuentan como Demo / Consignación. */
export const DEMO_LOCATION_NAMES = Object.entries(LOCATION_BUCKETS).filter(([, b]) => b === "demo").map(([n]) => n);
export const SIN_CLIENTE = "cliente sin identificar";
const TZ = "America/Argentina/Buenos_Aires";

export const NO_WAREHOUSE = { id: 0, name: "Sin depósito", code: "—" };

export interface StockRow {
  product_id: number;
  warehouse_id: number;
  disponible: number;
  no_conforme: number;
  demo: number;
  control_calidad: number;
  zona_franca: number;
  en_camino: number;
  comprometido: number;
  /** Pendiente de entrega de órdenes en estado operativo "Bloqueado" que todavía no se facturaron. */
  reservado_bloqueado: number;
}

/** En camino agrupado por día de llegada (columna "Llegada estimada"). */
export interface IncomingRow { product_id: number; warehouse_id: number; day: string; qty: number }
/** Cliente que tiene cada producto en demo (columna "Clientes demo"). */
export interface DemoClientRow { product_id: number; warehouse_id: number; client: string; qty: number }

export interface Snapshot {
  warehouses: { id: number; name: string; code: string | null }[];
  products: { id: number; sku: string | null; name: string; category_id: number | null; category: string | null }[];
  stock: StockRow[];
  incoming: IncomingRow[];
  demoClients: DemoClientRow[];
}

/** Fecha/hora UTC de Odoo ("2026-10-20 13:00:00") → día en hora Argentina ("2026-10-20"). */
export function localDay(odooDatetime: string): string {
  const d = new Date(odooDatetime.replace(" ", "T") + "Z");
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const id = (v: M2O) => (v ? v[0] : null);
const round = (n: number) => Math.round(n * 10000) / 10000;

/** Ids de productos que la lista de Odoo mostraría (stock interno ≠ 0, en camino o comprometido). */
export function productIdsToShow(quants: OdooQuant[], incoming: OdooMove[], committed: OdooMove[], blocked: OdooMove[] = []): number[] {
  const ids = new Set<number>();
  for (const q of quants) if (q.quantity !== 0 && id(q.product_id)) ids.add(id(q.product_id)!);
  for (const m of [...incoming, ...committed, ...blocked]) if (id(m.product_id)) ids.add(id(m.product_id)!);
  return [...ids].sort((a, b) => a - b);
}

export function buildSnapshot(input: {
  warehouses: OdooWarehouse[];
  locations: OdooLocation[];
  quants: OdooQuant[];
  incoming: OdooMove[];
  committed: OdooMove[];
  /** Salidas pendientes de órdenes bloqueadas sin facturar. */
  blocked?: OdooMove[];
  pickingTypes: OdooPickingType[];
  products: OdooProduct[];
  /** Entradas hechas a Consignación-Demo, de la más nueva a la más vieja. */
  demoMoveLines?: OdooMoveLine[];
}): Snapshot {
  const locById = new Map(input.locations.map((l) => [l.id, l]));
  const ptWarehouse = new Map(input.pickingTypes.map((p) => [p.id, id(p.warehouse_id) ?? 0]));
  const validProducts = new Map(input.products.map((p) => [p.id, p]));

  const rows = new Map<string, StockRow>();
  const row = (productId: number, warehouseId: number): StockRow => {
    const key = `${productId}:${warehouseId}`;
    let r = rows.get(key);
    if (!r) {
      r = { product_id: productId, warehouse_id: warehouseId, disponible: 0, no_conforme: 0, demo: 0,
            control_calidad: 0, zona_franca: 0, en_camino: 0, comprometido: 0, reservado_bloqueado: 0 };
      rows.set(key, r);
    }
    return r;
  };

  for (const q of input.quants) {
    const pid = id(q.product_id);
    const lid = id(q.location_id);
    if (!pid || !lid || !validProducts.has(pid) || q.quantity === 0) continue;
    const loc = locById.get(lid);
    if (!loc) continue; // ubicación no interna
    const r = row(pid, id(loc.warehouse_id) ?? 0);
    const bucket = LOCATION_BUCKETS[loc.name];
    if (bucket) r[bucket] += q.quantity;
  }

  const addMoves = (moves: OdooMove[], field: "en_camino" | "comprometido" | "reservado_bloqueado") => {
    for (const m of moves) {
      const pid = id(m.product_id);
      if (!pid || !validProducts.has(pid)) continue;
      const wh = ptWarehouse.get(id(m.picking_type_id) ?? -1) ?? 0;
      row(pid, wh)[field] += m.product_qty;
    }
  };
  addMoves(input.incoming, "en_camino");
  addMoves(input.committed, "comprometido");
  addMoves(input.blocked ?? [], "reservado_bloqueado");

  // Todos los productos de Odoo aparecen en el monitor: los que no tienen stock ni
  // movimientos van con una fila en cero en "Sin depósito".
  const withRow = new Set([...rows.values()].map((r) => r.product_id));
  for (const p of input.products) if (!withRow.has(p.id)) row(p.id, NO_WAREHOUSE.id);

  const stock = [...rows.values()].map((r) => ({
    ...r,
    disponible: round(r.disponible), no_conforme: round(r.no_conforme), demo: round(r.demo),
    control_calidad: round(r.control_calidad), zona_franca: round(r.zona_franca),
    en_camino: round(r.en_camino), comprometido: round(r.comprometido),
    reservado_bloqueado: round(r.reservado_bloqueado),
  }));

  // ---- Llegada estimada: en camino sumado por producto × depósito × día
  const inc = new Map<string, IncomingRow>();
  for (const m of input.incoming) {
    const pid = id(m.product_id);
    if (!pid || !validProducts.has(pid) || !m.date) continue;
    const wh = ptWarehouse.get(id(m.picking_type_id) ?? -1) ?? 0;
    const day = localDay(m.date);
    const key = `${pid}:${wh}:${day}`;
    const r = inc.get(key) ?? { product_id: pid, warehouse_id: wh, day, qty: 0 };
    r.qty += m.product_qty;
    inc.set(key, r);
  }
  const incoming = [...inc.values()].map((r) => ({ ...r, qty: round(r.qty) }));

  // ---- Clientes demo: cada serie en Consignación-Demo → cliente de la última entrega de esa serie
  const lastClient = new Map<string, string>();
  for (const ml of input.demoMoveLines ?? []) {           // vienen de la más nueva a la más vieja
    const key = `${id(ml.product_id)}|${id(ml.lot_id) ?? ""}`;
    if (!lastClient.has(key) && ml.picking_partner_id) lastClient.set(key, ml.picking_partner_id[1]);
  }
  const dc = new Map<string, DemoClientRow>();
  for (const q of input.quants) {
    const pid = id(q.product_id);
    const lid = id(q.location_id);
    if (!pid || !lid || !validProducts.has(pid) || q.quantity === 0) continue;
    const loc = locById.get(lid);
    if (!loc || !DEMO_LOCATION_NAMES.includes(loc.name)) continue;
    const wh = id(loc.warehouse_id) ?? 0;
    const client = lastClient.get(`${pid}|${id(q.lot_id ?? false) ?? ""}`) ?? SIN_CLIENTE;
    const key = `${pid}:${wh}:${client}`;
    const r = dc.get(key) ?? { product_id: pid, warehouse_id: wh, client, qty: 0 };
    r.qty += q.quantity;
    dc.set(key, r);
  }
  const demoClients = [...dc.values()].map((r) => ({ ...r, qty: round(r.qty) }));

  const usedProducts = new Set(stock.map((s) => s.product_id));
  const products = input.products
    .filter((p) => usedProducts.has(p.id))
    .map((p) => ({
      id: p.id,
      sku: p.default_code || null,
      name: p.name,
      category_id: id(p.categ_id),
      category: p.categ_id ? p.categ_id[1] : null,
    }));

  const warehouses = [
    { ...NO_WAREHOUSE, code: NO_WAREHOUSE.code as string | null },
    ...input.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code || null })),
  ];

  return { warehouses, products, stock, incoming, demoClients };
}
