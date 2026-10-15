// Datos de ejemplo para probar el diseño sin conectarse (VITE_DEMO=1).
import type { MonitorRow } from "./logic";

export const demoWarehouses = [
  { id: 0, name: "Sin depósito", code: "—" },
  { id: 1, name: "Depósito Set Córdoba", code: "CBA" },
  { id: 2, name: "Depósito Fiscal / Zona Franca Córdoba", code: "ZF" },
  { id: 4, name: "Depósito oficina", code: "OFI" },
  { id: 6, name: "Depósito Capital Federal", code: "BUE" },
];

const NAMES = [
  "Rfme Teclado Ecg C110", "Rfme Placa Cpu Ecg C110", "Rfme Impresor Termico Ecg C110",
  "Rfme Impresor Termico C110 Nvo.", "Rfme Fusible C110", "Rfme Cable De Impresor Termico",
  "Aguja Inscriptora P/Fk 501B", "Bisagra Izquierda Tapa Teclado Dus 3 / 6",
  "Bisagra Derecha Tapa Teclado Dus 3 / 6", "Teclado Silicona Dus 6", "Placa Teclado Dus 3",
  "Teclado Silicona Dus 3", "Ecogr. Tapa Teclado Interna Dus3", "Transductor Lineal L742",
  "Cable Paciente 10 Derivaciones", "Electrodo Adulto Descartable", "Bateria Litio 14.4V",
  "Fuente Alimentacion 12V 5A", "Sensor SpO2 Adulto Reusable", "Papel Termico 80mm",
];
const CATS = [
  { id: 10, name: "Repuestos / ECG" }, { id: 11, name: "Repuestos / Ecógrafos" },
  { id: 12, name: "Insumos" }, { id: 13, name: "Accesorios" },
];

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

interface Base { id: number; sku: string; name: string; cat: typeof CATS[number]; byWh: Record<number, number[]> }
let cache: Base[] | null = null;

function base(): Base[] {
  if (cache) return cache;
  const r = rng(42);
  const pick = (p: number, max: number) => (r() < p ? Math.ceil(r() * max) : 0);
  cache = Array.from({ length: 240 }, (_, i) => {
    const byWh: Record<number, number[]> = {};
    for (const wh of [1, 4, 6]) {
      // [disponible, no_conforme, demo, control, zf, en_camino, comprometido]
      byWh[wh] = [pick(0.55, 40), pick(0.08, 5), 0, pick(0.06, 8), 0, pick(0.12, 20), pick(0.07, 6)];
    }
    byWh[0] = [0, 0, pick(0.06, 4), 0, 0, 0, 0];
    byWh[2] = [0, 0, 0, 0, pick(0.05, 30), 0, 0];
    if (i % 37 === 5) byWh[1][6] += 12; // algunos negativos en disponible real
    return {
      id: 1000 + i,
      sku: `1000000000001${String(50073 + i * 7).padStart(5, "0")}`,
      name: i < NAMES.length ? NAMES[i] : `${NAMES[i % NAMES.length]} (var. ${Math.floor(i / NAMES.length)})`,
      cat: CATS[i % CATS.length],
      byWh,
    };
  });
  return cache;
}

export function demoRows(whIds: number[] | null): MonitorRow[] {
  return base()
    .map((p) => {
      const s = [0, 0, 0, 0, 0, 0, 0];
      for (const [wh, v] of Object.entries(p.byWh)) {
        if (whIds && !whIds.includes(Number(wh))) continue;
        v.forEach((x, i) => (s[i] += x));
      }
      const [disponible, no_conforme, demo, control_calidad, zona_franca, en_camino, comprometido] = s;
      return {
        product_id: p.id, sku: p.sku, name: p.name, category_id: p.cat.id, category: p.cat.name,
        disponible, no_conforme, demo, control_calidad, zona_franca,
        total_fisico: disponible + no_conforme + demo + control_calidad + zona_franca,
        en_camino, comprometido,
        disponible_real: disponible - comprometido,
        disponible_mas_camino: disponible - comprometido + en_camino,
      };
    })
    .filter((r) => r.total_fisico || r.en_camino || r.comprometido);
}
