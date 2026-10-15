import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MonitorRow } from "./logic";
import { demoRows, demoWarehouses } from "./demo";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const DEMO = import.meta.env.VITE_DEMO === "1" || !url || !anon;
export const ALLOWED_DOMAIN = (import.meta.env.VITE_ALLOWED_DOMAIN as string | undefined) ?? "deam.com.ar";

export const supabase: SupabaseClient | null = DEMO ? null : createClient(url!, anon!);

export interface Warehouse { id: number; name: string; code: string | null }
export interface SyncRun { started_at: string; finished_at: string | null; status: string; message: string | null }

export async function fetchWarehouses(): Promise<Warehouse[]> {
  if (!supabase) return demoWarehouses;
  const { data, error } = await supabase.from("warehouses").select("id,name,code").order("id");
  if (error) throw error;
  return data ?? [];
}

/** Trae todas las filas paginando de a 1000 (límite por defecto de Supabase). */
export async function fetchMonitor(warehouseIds: number[] | null): Promise<MonitorRow[]> {
  if (!supabase) return demoRows(warehouseIds);
  const out: MonitorRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .rpc("monitor", { p_warehouse_ids: warehouseIds })
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as MonitorRow[];
    out.push(...rows.map((r) => {
      const n = { ...r } as Record<string, unknown>;
      for (const k of Object.keys(n)) if (k !== "sku" && k !== "name" && k !== "category" && n[k] !== null) n[k] = Number(n[k]);
      return n as unknown as MonitorRow;
    }));
    if (rows.length < page) return out;
  }
}

export async function fetchLastSync(): Promise<{ lastOk: SyncRun | null; last: SyncRun | null }> {
  if (!supabase) {
    const now = new Date(Date.now() - 4 * 60_000).toISOString();
    const run = { started_at: now, finished_at: now, status: "ok", message: null };
    return { lastOk: run, last: run };
  }
  const [okRes, lastRes] = await Promise.all([
    supabase.from("sync_runs").select("started_at,finished_at,status,message").eq("status", "ok")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("sync_runs").select("started_at,finished_at,status,message")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { lastOk: okRes.data ?? null, last: lastRes.data ?? null };
}

export async function triggerSync(): Promise<string | null> {
  if (!supabase) { await new Promise((r) => setTimeout(r, 800)); return null; }
  const { data, error } = await supabase.functions.invoke("sync-odoo", { body: {} });
  if (error) return error.message;
  if (data?.skipped) return data.reason as string;
  return null;
}
