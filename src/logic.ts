export interface MonitorRow {
  product_id: number;
  sku: string | null;
  name: string;
  category_id: number | null;
  category: string | null;
  disponible: number;
  no_conforme: number;
  demo: number;
  clientes_demo: string | null;
  control_calidad: number;
  zona_franca: number;
  total_fisico: number;
  en_camino: number;
  llegada_estimada: string | null;
  /** Fecha (YYYY-MM-DD) de la primera llegada; sirve para ordenar "Llegada estimada". */
  proxima_llegada: string | null;
  disponible_mas_camino: number;
  comprometido: number;
  disponible_real: number;
}

export type TextKey = "clientes_demo" | "llegada_estimada";
export type NumKey = Exclude<keyof MonitorRow, "product_id" | "sku" | "name" | "category_id" | "category" | TextKey | "proxima_llegada">;
export type SortKey = "sku" | "name" | NumKey | TextKey;

export const NUM_COLUMNS: { key: NumKey; label: string; kpi: string; hint: string }[] = [
  { key: "disponible", label: "Disponible", kpi: "Disponible", hint: "Stock en ubicación «Disponible», listo para vender." },
  { key: "no_conforme", label: "No conforme", kpi: "No conforme", hint: "Unidades con fallas o rechazadas; no se pueden vender." },
  { key: "demo", label: "Demo / Consignación", kpi: "Demo / Consignación", hint: "Unidades en demostración o en consignación en clientes." },
  { key: "control_calidad", label: "Control de calidad", kpi: "Control de calidad", hint: "Recibido, en cuarentena esperando inspección." },
  { key: "zona_franca", label: "Zona Franca (pend. liberación)", kpi: "Zona Franca", hint: "Mercadería en Zona Franca, pendiente de liberación." },
  { key: "total_fisico", label: "Total físico", kpi: "Total físico", hint: "Disponible + No conforme + Demo + Control de calidad + Zona Franca." },
  { key: "en_camino", label: "En camino", kpi: "En camino", hint: "Compras confirmadas que todavía no ingresaron." },
  { key: "disponible_mas_camino", label: "Disponible + en camino", kpi: "Disponible + en camino", hint: "Disponible real + En camino." },
  { key: "comprometido", label: "Comprometido", kpi: "Comprometido", hint: "Facturado al cliente pero aún no remitido." },
  { key: "disponible_real", label: "Disponible real", kpi: "Disponible real", hint: "Lo que realmente se puede vender: Disponible − Comprometido." },
];

export const TEXT_COLUMNS: { key: TextKey; label: string; hint: string; after: NumKey }[] = [
  { key: "clientes_demo", label: "Clientes demo", after: "demo",
    hint: "Cliente que tiene cada unidad en demo / consignación (según la última entrega de esa serie)." },
  { key: "llegada_estimada", label: "Llegada estimada", after: "en_camino",
    hint: "Fecha prevista y cantidad de cada compra en camino. «atrasada» = la fecha ya pasó." },
];

/** Orden de columnas igual a la hoja: las de texto van al lado de la numérica que explican. */
export type Column =
  | { kind: "num"; key: NumKey; label: string; hint: string }
  | { kind: "text"; key: TextKey; label: string; hint: string };
export const COLUMNS: Column[] = NUM_COLUMNS.flatMap((c) => [
  { kind: "num" as const, key: c.key, label: c.label, hint: c.hint },
  ...TEXT_COLUMNS.filter((t) => t.after === c.key).map((t) => ({ kind: "text" as const, key: t.key, label: t.label, hint: t.hint })),
]);

export interface Filters {
  sku: string;
  name: string;
  categoryId: number | null;
  onlyNegative: boolean;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function applyFilters(rows: MonitorRow[], f: Filters): MonitorRow[] {
  const sku = norm(f.sku);
  const nameWords = norm(f.name).split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (sku && !norm(r.sku ?? "").includes(sku)) return false;
    if (nameWords.length) {
      const n = norm(r.name);
      if (!nameWords.every((w) => n.includes(w))) return false;
    }
    if (f.categoryId !== null && r.category_id !== f.categoryId) return false;
    if (f.onlyNegative && !(r.disponible_real < 0)) return false;
    return true;
  });
}

export function sortRows(rows: MonitorRow[], key: SortKey, dir: "asc" | "desc"): MonitorRow[] {
  const m = dir === "asc" ? 1 : -1;
  const field: keyof MonitorRow = key === "llegada_estimada" ? "proxima_llegada" : key;
  return [...rows].sort((a, b) => {
    const va = a[field], vb = b[field];
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * m;
    const sa = (va ?? "") as string, sb = (vb ?? "") as string;
    if (!sa && sb) return 1;   // vacíos siempre al final
    if (sa && !sb) return -1;
    return sa.localeCompare(sb, "es", { numeric: true }) * m;
  });
}

export function totals(rows: MonitorRow[]): Record<NumKey, number> & { count: number } {
  const t = { count: rows.length } as Record<NumKey, number> & { count: number };
  for (const c of NUM_COLUMNS) t[c.key] = 0;
  for (const r of rows) for (const c of NUM_COLUMNS) t[c.key] += Number(r[c.key]) || 0;
  return t;
}

const nf = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
export const fmt = (n: number) => nf.format(n);
/** Igual que la hoja: los ceros de las columnas de ubicación se muestran vacíos. */
export const fmtCell = (n: number, showZero: boolean) => (n === 0 && !showZero ? "" : nf.format(n));

export function toCsv(rows: MonitorRow[]): string {
  const head = ["SKU", "Producto", "Categoría", ...COLUMNS.map((c) => c.label)];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.sku, r.name, r.category, ...COLUMNS.map((c) => (c.kind === "num" ? String(r[c.key]).replace(".", ",") : r[c.key] ?? ""))].map(esc).join(";"));
  return "﻿" + [head.map(esc).join(";"), ...lines].join("\n");
}
