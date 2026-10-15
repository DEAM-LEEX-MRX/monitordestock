import { describe, expect, it } from "vitest";
import { buildSnapshot, productIdsToShow } from "../supabase/functions/sync-odoo/transform";
import { applyFilters, sortRows, toCsv, totals, type MonitorRow } from "../src/logic";

const warehouses = [
  { id: 1, name: "Depósito Set Córdoba", code: "CBA" },
  { id: 2, name: "Depósito Fiscal / Zona Franca Córdoba", code: "ZF" },
  { id: 6, name: "Depósito Capital Federal", code: "BUE" },
];
const locations = [
  { id: 10, name: "Disponible", warehouse_id: [1, "CBA"] as [number, string] },
  { id: 11, name: "No conforme", warehouse_id: [1, "CBA"] as [number, string] },
  { id: 12, name: "Recepción / Cuarentena", warehouse_id: [1, "CBA"] as [number, string] },
  { id: 20, name: "Pendiente de liberación", warehouse_id: [2, "ZF"] as [number, string] },
  { id: 30, name: "Disponible", warehouse_id: [6, "BUE"] as [number, string] },
  { id: 40, name: "Consignación-Demo", warehouse_id: false as const },
  { id: 50, name: "Estante raro", warehouse_id: [6, "BUE"] as [number, string] },
];
const P = (id: number): [number, string] => [id, `P${id}`];
const L = (id: number): [number, string] => [id, `L${id}`];

const quants = [
  { product_id: P(1), location_id: L(10), quantity: 5 },
  { product_id: P(1), location_id: L(30), quantity: 3 },
  { product_id: P(1), location_id: L(11), quantity: 2 },
  { product_id: P(1), location_id: L(40), quantity: 1 },
  { product_id: P(2), location_id: L(20), quantity: 7 },
  { product_id: P(2), location_id: L(12), quantity: 4 },
  { product_id: P(3), location_id: L(50), quantity: 9 },   // ubicación interna no mapeada: aparece con ceros
  { product_id: P(4), location_id: L(99), quantity: 9 },   // ubicación no interna: ignorada
];
const incoming = [{ product_id: P(5), product_qty: 10, picking_type_id: [100, "Recepciones CBA"] as [number, string] }];
const committed = [
  { product_id: P(1), product_qty: 6, picking_type_id: [200, "Entregas CBA"] as [number, string] },
  { product_id: P(1), product_qty: 4, picking_type_id: [201, "Entregas BUE"] as [number, string] },
];
const pickingTypes = [
  { id: 100, warehouse_id: [1, "CBA"] as [number, string] },
  { id: 200, warehouse_id: [1, "CBA"] as [number, string] },
  { id: 201, warehouse_id: [6, "BUE"] as [number, string] },
];
const products = [1, 2, 3, 5].map((id) => ({ id, default_code: `SKU${id}`, name: `Prod ${id}`, categ_id: [9, "Cat"] as [number, string] }));

describe("sync transform", () => {
  const snap = buildSnapshot({ warehouses, locations, quants, incoming, committed, pickingTypes, products });
  const get = (p: number, w: number) => snap.stock.find((s) => s.product_id === p && s.warehouse_id === w);

  it("asigna cada ubicación a su columna y depósito", () => {
    expect(get(1, 1)).toMatchObject({ disponible: 5, no_conforme: 2, comprometido: 6 });
    expect(get(1, 6)).toMatchObject({ disponible: 3, comprometido: 4 });
    expect(get(1, 0)).toMatchObject({ demo: 1 });
    expect(get(2, 2)).toMatchObject({ zona_franca: 7 });
    expect(get(2, 1)).toMatchObject({ control_calidad: 4 });
    expect(get(5, 1)).toMatchObject({ en_camino: 10 });
  });

  it("incluye productos con stock interno en ubicaciones no mapeadas y excluye no internas", () => {
    expect(get(3, 6)).toMatchObject({ disponible: 0, no_conforme: 0 });
    expect(snap.stock.some((s) => s.product_id === 4)).toBe(false);
    expect(snap.products.map((p) => p.id).sort()).toEqual([1, 2, 3, 5]);
  });

  it("agrega 'Sin depósito' y respeta la lista de productos a mostrar", () => {
    expect(snap.warehouses[0]).toMatchObject({ id: 0 });
    expect(productIdsToShow(quants, incoming, committed)).toEqual([1, 2, 3, 4, 5]);
  });
});

const row = (o: Partial<MonitorRow>): MonitorRow => ({
  product_id: 1, sku: "A", name: "x", category_id: 1, category: "c", disponible: 0, no_conforme: 0, demo: 0,
  control_calidad: 0, zona_franca: 0, total_fisico: 0, en_camino: 0, disponible_mas_camino: 0,
  comprometido: 0, disponible_real: 0, ...o,
});

describe("web logic", () => {
  const rows = [
    row({ product_id: 1, sku: "100150073", name: "Rfme Teclado Ecg C110", disponible: 2, disponible_real: 2 }),
    row({ product_id: 2, sku: "100150100", name: "Placa Teclado Dus 3", category_id: 2, disponible_real: -3 }),
    row({ product_id: 3, sku: null, name: "Bisagra Tapa", disponible_real: 5 }),
  ];
  it("filtra por SKU, palabras del nombre (sin acentos) y negativos", () => {
    expect(applyFilters(rows, { sku: "0073", name: "", categoryId: null, onlyNegative: false }).map((r) => r.product_id)).toEqual([1]);
    expect(applyFilters(rows, { sku: "", name: "teclado placa", categoryId: null, onlyNegative: false }).map((r) => r.product_id)).toEqual([2]);
    expect(applyFilters(rows, { sku: "", name: "", categoryId: null, onlyNegative: true }).map((r) => r.product_id)).toEqual([2]);
  });
  it("ordena con vacíos al final y suma totales", () => {
    expect(sortRows(rows, "sku", "asc").map((r) => r.product_id)).toEqual([1, 2, 3]);
    expect(sortRows(rows, "disponible_real", "desc").map((r) => r.product_id)).toEqual([3, 1, 2]);
    expect(totals(rows)).toMatchObject({ count: 3, disponible_real: 4 });
  });
  it("exporta CSV con ; y BOM para Excel", () => {
    const csv = toCsv(rows);
    expect(csv.startsWith("﻿SKU;Producto")).toBe(true);
    expect(csv.split("\n")).toHaveLength(4);
  });
});
