import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyFilters, fmtCell, NUM_COLUMNS, sortRows, toCsv,
  type Filters, type MonitorRow, type NumKey, type SortKey,
} from "./logic";
import { DEMO, fetchLastSync, fetchMonitor, fetchWarehouses, triggerSync, type SyncRun, type Warehouse } from "./data";

const EMPTY: Filters = { sku: "", name: "", categoryId: null, onlyNegative: false };

function cellClass(key: NumKey, v: number): string {
  const c = ["num", `c-${key}`];
  if (v > 0 && (key === "no_conforme" || key === "en_camino" || key === "control_calidad" || key === "demo")) c.push("pos");
  if (v < 0 && (key === "disponible_real" || key === "disponible_mas_camino")) c.push("neg");
  return c.join(" ");
}

function ago(iso: string | undefined | null): string {
  if (!iso) return "nunca";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h ${min % 60} min` : new Date(iso).toLocaleString("es-AR");
}

export default function Monitor({ email, onLogout }: { email: string | null; onLogout: () => void }) {
  const [rows, setRows] = useState<MonitorRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whSel, setWhSel] = useState<number[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "sku", dir: "asc" });
  const [sync, setSync] = useState<{ lastOk: SyncRun | null; last: SyncRun | null }>({ lastOk: null, last: null });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [r, s] = await Promise.all([fetchMonitor(whSel.length ? whSel : null), fetchLastSync()]);
      setRows(r);
      setSync(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [whSel]);

  useEffect(() => { fetchWarehouses().then(setWarehouses).catch(() => undefined); }, []);
  useEffect(() => { load(); }, [load]);

  // Revisa cada minuto si hubo una sincronización nueva y recarga si cambió
  useEffect(() => {
    const id = setInterval(async () => {
      tick((n) => n + 1);
      const s = await fetchLastSync().catch(() => null);
      if (s && s.lastOk?.started_at !== sync.lastOk?.started_at) load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load, sync.lastOk?.started_at]);

  const categories = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (r.category_id !== null) m.set(r.category_id, r.category ?? "");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
  }, [rows]);

  const visible = useMemo(() => sortRows(applyFilters(rows, filters), sort.key, sort.dir), [rows, filters, sort]);
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY) || whSel.length > 0;

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "sku" || key === "name" ? "asc" : "desc" });

  const refresh = async () => {
    setSyncing(true);
    setNotice(null);
    const msg = await triggerSync();
    if (msg) setNotice(msg);
    await load();
    setSyncing(false);
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(visible)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `monitor-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggleWh = (id: number) => setWhSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const arrow = (k: SortKey) => (sort.key === k ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const lastFailed = sync.last && sync.last.status === "error";

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Monitor de stock</h1>
          <p className="sub">
            Datos de Odoo · Actualizado <b>{ago(sync.lastOk?.finished_at ?? sync.lastOk?.started_at)}</b>
            {sync.lastOk?.finished_at && <> ({new Date(sync.lastOk.finished_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })})</>}
            {DEMO && <span className="demo-tag">MODO DEMO · datos de ejemplo</span>}
          </p>
          {lastFailed && <p className="warn">La última sincronización falló: {sync.last?.message}</p>}
          {notice && <p className="note">{notice}</p>}
        </div>
        <div className="actions">
          <button className="btn primary" onClick={refresh} disabled={syncing}>{syncing ? "Actualizando…" : "Actualizar ahora"}</button>
          <button className="btn" onClick={exportCsv}>Exportar CSV</button>
          {email && <button className="btn ghost" onClick={onLogout} title={email}>Salir</button>}
        </div>
      </header>

      <section className="filters">
        <input placeholder="SKU contiene…" value={filters.sku} onChange={(e) => setFilters({ ...filters, sku: e.target.value })} />
        <input placeholder="Nombre contiene…" value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} />
        <select value={filters.categoryId ?? ""} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Todas las categorías</option>
          {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={filters.onlyNegative} onChange={(e) => setFilters({ ...filters, onlyNegative: e.target.checked })} />
          Solo Disponible real negativo
        </label>
        <div className="wh">
          <span className="wh-label">Depósito:</span>
          {warehouses.map((w) => (
            <button key={w.id} className={"chip" + (whSel.includes(w.id) ? " on" : "")} onClick={() => toggleWh(w.id)} title={w.name}>
              {w.code && w.code !== "—" ? w.code : w.name}
            </button>
          ))}
          {whSel.length === 0 && <span className="muted">todos</span>}
        </div>
        {filtered && <button className="btn link" onClick={() => { setFilters(EMPTY); setWhSel([]); }}>Limpiar filtros</button>}
      </section>

      {error && <p className="warn">No se pudieron cargar los datos: {error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="sku sticky1" data-tip="Código interno del producto en Odoo." onClick={() => onSort("sku")}>SKU{arrow("sku")}</th>
              <th className="prod sticky2" data-tip="Nombre del producto. Pasá el mouse sobre una fila para ver su categoría." onClick={() => onSort("name")}>Producto{arrow("name")}</th>
              {NUM_COLUMNS.map((c) => (
                <th key={c.key} className={"num h-" + c.key} data-tip={c.hint} onClick={() => onSort(c.key)}>{c.label}{arrow(c.key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={12} className="empty">Cargando…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={12} className="empty">Sin productos para estos filtros.</td></tr>}
            {visible.map((r) => (
              <tr key={r.product_id}>
                <td className="sku sticky1">{r.sku ?? ""}</td>
                <td className="prod sticky2" title={r.category ?? ""}>{r.name}</td>
                {NUM_COLUMNS.map((c) => (
                  <td key={c.key} className={cellClass(c.key, r[c.key])}>
                    {fmtCell(r[c.key], c.key === "disponible_real" || c.key === "disponible_mas_camino" || c.key === "disponible" || c.key === "total_fisico")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="foot">
        Disponible real = Disponible − Comprometido (facturado no remitido) · Disponible + en camino = Disponible real + En camino · Total físico = Disponible + No conforme + Demo + Control de calidad + Zona Franca
      </footer>
    </div>
  );
}
