"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import { cachedRead } from "@/lib/boundedReads";
import { pickingPage, type PickingCursor } from "@/lib/picking/transport";
import ReadPagination from "@/components/ReadPagination";

type User = { id: string; role: string; full_name: string; module_access?: string[] | null };
type Option = { key: string; label: string };
type Options = { sources: Option[]; destinations: Option[]; pickers: Option[]; reasons: Option[] };
type Row = {
  scan: { id: string; created_at: string; qty: number; location_code: string; scanned_product_code: string | null; scanned_barcode: string | null; is_match: boolean };
  request: { source_store_code: string; source_store_name: string | null; destination_store_code: string; destination_store_name: string | null; doc_number: string | null; inv_request_no: string | null; reason: string | null };
  line: { product_code: string; description: string | null; unit: string | null };
  picker_name: string;
};
type Filters = { from: string; to: string; source: string; destination: string; picker: string; reason: string; query: string };
const emptyOptions: Options = { sources: [], destinations: [], pickers: [], reasons: [] };
const tabs = [["asignacion", "Asignación"], ["resumen", "Resumen"], ["reportes", "Reportes"], ["registros", "Registros"], ["productividad", "Productividad"]];
const control = "w-full rounded-xl border border-slate-300 bg-white p-2 text-sm text-slate-900";
function message(error: unknown) { return (error as { message?: string })?.message || "No se pudo consultar Picking."; }

/** Read-only page; never derives stored progress or historical totals from this page. */
export default function PickingRecords() {
  const [user, setUser] = useState<User | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<Filters>({ from: today, to: today, source: "", destination: "", picker: "", reason: "", query: "" });
  const [filters, setFilters] = useState(draft);
  const [options, setOptions] = useState(emptyOptions);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursors, setCursors] = useState<Array<PickingCursor | null>>([null]);
  const [page, setPage] = useState(0);
  const [next, setNext] = useState<PickingCursor | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const generation = useRef(0);
  const cursor = cursors[page];

  useEffect(() => {
    let disposed = false;
    const current = readStoredUser<User>();
    if (!current || !["Administrador", "Supervisor", "Validador"].includes(current.role) || !canAccessModule(current, "picking")) {
      setError("Inicia sesión con un usuario autorizado para consultar los registros de Picking.");
      setBusy(false);
      return;
    }
    void fetchDisabledModules().then(disabled => {
      if (disposed) return;
      if (isModuleBlockedForUser(disabled, "picking", current)) {
        setError("El módulo Picking está deshabilitado para este usuario."); setBusy(false); return;
      }
      setUser(current); setAuthorized(true);
    }).catch(err => { if (!disposed) { setError(message(err)); setBusy(false); } });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!authorized || !user) return;
    let disposed = false;
    void cachedRead(`picking-registry-options:${user.id}`, async () => {
      const response = await supabase.rpc("get_picking_registry_filters_v2");
      if (response.error) throw response.error;
      return response.data as Options;
    }, 60000).then(result => { if (!disposed) setOptions(result); })
      .catch(err => { if (!disposed) setError(`Filtros: ${message(err)}`); });
    void supabase.from("erp_sync_status").select("synced_at").eq("id", "picking_requests").maybeSingle()
      .then(result => { if (!disposed && !result.error) setSyncedAt(result.data?.synced_at || null); });
    return () => { disposed = true; };
  }, [authorized, user, revision]);

  useEffect(() => {
    if (!authorized) return;
    const ownGeneration = ++generation.current;
    setBusy(true); setError(""); setRows([]); setNext(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await supabase.rpc("get_picking_registry_page_v2", {
          p_from: filters.from || null, p_to: filters.to || null,
          p_source: filters.source || null, p_destination: filters.destination || null,
          p_picker: filters.picker || null, p_reason: filters.reason || null, p_query: filters.query.trim() || null,
          p_before_at: cursor?.created_at || null, p_before_id: cursor?.id || null, p_limit: 51,
        }).abortSignal(controller.signal);
        if (generation.current !== ownGeneration || controller.signal.aborted) return;
        if (response.error) throw response.error;
        const result = pickingPage((response.data || []) as Row[], row => row.scan);
        setRows(result.items); setNext(result.next);
      } catch (err) {
        if (!controller.signal.aborted && generation.current === ownGeneration) setError(message(err));
      } finally {
        if (!controller.signal.aborted && generation.current === ownGeneration) setBusy(false);
      }
    })();
    return () => { controller.abort(); };
  }, [authorized, filters, cursor, revision]);

  function applyFilters() {
    if (draft.from && draft.to && draft.from > draft.to) { setError("La fecha desde no puede ser posterior a la fecha hasta."); return; }
    setCursors([null]); setPage(0); setFilters({ ...draft }); setRevision(value => value + 1);
  }
  function changePage(target: number) {
    if (busy) return;
    if (target > page) { if (!next) return; setCursors(previous => [...previous.slice(0, target), next]); }
    setPage(target);
  }
  function filterSelect(field: "source" | "destination" | "picker" | "reason", label: string, values: Option[]) {
    return <label className="space-y-1 text-xs font-bold text-slate-600">{label}
      <select className={control} value={draft[field]} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))}>
        <option value="">Todos</option>{values.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select></label>;
  }

  return <main className="mx-auto w-full max-w-[1800px] space-y-4 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white p-4">
      <div><h1 className="text-xl font-black">Picking · Registros</h1><p className="text-xs text-slate-600">{user?.full_name || "Validando acceso"}</p></div>
      <div className="flex gap-3 text-sm font-bold"><Link href="/">Menú principal</Link><Link href="/picking/registros?legacy=1">Vista anterior / correcciones</Link></div>
    </header>
    <nav className="flex flex-wrap gap-2 rounded-2xl border bg-white p-3" aria-label="Picking">{tabs.map(([path, label]) =>
      <Link key={path} href={`/picking/${path}`} className={`rounded-xl px-4 py-2 text-sm font-bold ${path === "registros" ? "bg-slate-950 text-white" : "text-slate-600"}`}>{label}</Link>)}</nav>
    {authorized && <>
      <section className="rounded-2xl border bg-white p-4">
        <p className="mb-3 text-xs text-slate-600">Última sincronización ERP: {syncedAt ? new Date(syncedAt).toLocaleString("es-PE") : "Sin dato disponible"}</p>
        <form onSubmit={event => { event.preventDefault(); applyFilters(); }} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-xs font-bold text-slate-600">Desde<input aria-label="Desde" type="date" className={control} value={draft.from} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></label>
          <label className="space-y-1 text-xs font-bold text-slate-600">Hasta<input aria-label="Hasta" type="date" className={control} value={draft.to} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></label>
          {filterSelect("source", "Tienda que entrega", options.sources)}
          {filterSelect("destination", "Tienda solicitante", options.destinations)}
          {filterSelect("picker", "Picador", options.pickers)}
          {filterSelect("reason", "Motivo", options.reasons)}
          <label className="space-y-1 text-xs font-bold text-slate-600">Código, descripción, ubicación o documento<input className={control} maxLength={100} value={draft.query} onChange={event => setDraft(previous => ({ ...previous, query: event.target.value }))} /></label>
          <button disabled={busy} className="self-end rounded-xl bg-slate-950 p-2 font-bold text-white disabled:opacity-50">{busy ? "Consultando…" : "Consultar / actualizar"}</button>
        </form>
      </section>
      <section className="overflow-hidden rounded-2xl border bg-white">
        <div className="p-4"><h2 className="font-black">Registros de picadores</h2><p className="text-xs text-slate-600">{rows.length} registros en esta página. Consulta por páginas de 50, del más reciente al más antiguo. Las cantidades son lo registrado en cada ubicación; no son stock actual.</p></div>
        <ReadPagination page={page} hasNext={!!next} busy={busy} onPage={changePage} />
        <div className="overflow-x-auto"><table className="w-full table-fixed text-xs"><thead className="bg-slate-100 text-left"><tr>
          {["Fecha y hora", "Picador", "Tienda solicitante", "Documento", "Código / descripción", "UM", "Ubicación registrada", "Cantidad"].map(title => <th key={title} className="break-words p-3">{title}</th>)}
        </tr></thead><tbody>{rows.map(row => <tr key={row.scan.id} className="border-t align-top">
          <td className="break-words p-3">{new Date(row.scan.created_at).toLocaleString("es-PE")}</td>
          <td className="break-words p-3 font-bold">{row.picker_name}</td>
          <td className="break-words p-3">{row.request.destination_store_name || row.request.destination_store_code}</td>
          <td className="break-words p-3">{row.request.doc_number || row.request.inv_request_no || "—"}<p className="mt-1 text-slate-500">{row.request.reason}</p></td>
          <td className="break-words p-3"><b>{row.line.product_code}</b><p>{row.line.description}</p><p className="mt-1 text-slate-500">Escaneado: {row.scan.scanned_product_code || row.scan.scanned_barcode || "—"}</p></td>
          <td className="p-3">{row.line.unit || "—"}</td><td className="break-words p-3 font-bold">{row.scan.location_code}</td>
          <td className="p-3 text-right font-black">{Number(row.scan.qty).toLocaleString("es-PE", { maximumFractionDigits: 6 })}</td>
        </tr>)}</tbody></table></div>
        {!busy && !error && rows.length === 0 && <p className="p-8 text-center text-slate-500">No hay registros para estos filtros.</p>}
        <ReadPagination page={page} hasNext={!!next} busy={busy} onPage={changePage} />
      </section>
    </>}
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <Link className="underline" href="/picking/registros?legacy=1">Abrir vista anterior</Link></p>}
  </main>;
}
