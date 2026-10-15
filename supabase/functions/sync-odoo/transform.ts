// Lógica pura (sin red): convierte lo leído de Odoo en las filas de Supabase.
// Replica exactamente los pivots de la hoja "Monitor" del tablero de Odoo.

export type M2O = [number, string] | false;

export interface OdooWarehouse { id: number; name: string; code: string | false }
export interface OdooLocation { id: number; name: string; warehouse_id: M2O }
export interface OdooQuant { product_id: M2O; location_id: M2O; quantity: number }
export interface OdooMove { product_id: M2O; product_qty: number; picking_type_id: M2O }
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
}

export interface Snapshot {
  warehouses: { id: number; name: string; code: string | null }[];
  products: { id: number; sku: string | null; name: string; category_id: number | null; category: string | null }[];
  stock: StockRow[];
}

const id = (v: M2O) => (v ? v[0] : null);
const round = (n: number) => Math.round(n * 10000) / 10000;

/** Ids de productos que la lista de Odoo mostraría (stock interno ≠ 0, en camino o comprometido). */
export function productIdsToShow(quants: OdooQuant[], incoming: OdooMove[], committed: OdooMove[]): number[] {
  const ids = new Set<number>();
  for (const q of quants) if (q.quantity !== 0 && id(q.product_id)) ids.add(id(q.product_id)!);
  for (const m of [...incoming, ...committed]) if (id(m.product_id)) ids.add(id(m.product_id)!);
  return [...ids].sort((a, b) => a - b);
}

export function buildSnapshot(input: {
  warehouses: OdooWarehouse[];
  locations: OdooLocation[];
  quants: OdooQuant[];
  incoming: OdooMove[];
  committed: OdooMove[];
  pickingTypes: OdooPickingType[];
  products: OdooProduct[];
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
            control_calidad: 0, zona_franca: 0, en_camino: 0, comprometido: 0 };
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

  const addMoves = (moves: OdooMove[], field: "en_camino" | "comprometido") => {
    for (const m of moves) {
      const pid = id(m.product_id);
      if (!pid || !validProducts.has(pid)) continue;
      const wh = ptWarehouse.get(id(m.picking_type_id) ?? -1) ?? 0;
      row(pid, wh)[field] += m.product_qty;
    }
  };
  addMoves(input.incoming, "en_camino");
  addMoves(input.committed, "comprometido");

  const stock = [...rows.values()].map((r) => ({
    ...r,
    disponible: round(r.disponible), no_conforme: round(r.no_conforme), demo: round(r.demo),
    control_calidad: round(r.control_calidad), zona_franca: round(r.zona_franca),
    en_camino: round(r.en_camino), comprometido: round(r.comprometido),
  }));

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

  return { warehouses, products, stock };
}
