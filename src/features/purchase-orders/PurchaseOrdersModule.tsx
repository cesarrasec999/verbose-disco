"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock3, Home, PackageSearch,
  RefreshCw, Search, Store, Truck, X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store as StoreRow } from "@/features/ciclicos/types";

type PurchaseOrderStatus = "all" | "pending" | "closed" | "cancelled";

type PurchaseOrder = {
  erp_po_id: string;
  po_number: string;
  raw_status_code: string;
  business_status: Exclude<PurchaseOrderStatus, "all">;
  store_no: string;
  store_code: string | null;
  store_name: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  buyer: string | null;
  po_date: string;
  ship_date: string | null;
  closed_at: string | null;
  line_count: number;
  qty_ordered: number;
  qty_received: number;
  qty_due: number;
  total: number;
  synced_at: string;
  total_count: number;
};

type PurchaseOrderLine = {
  line_id: number;
  sku: string | null;
  product_code: string;
  barcode: string | null;
  description: string | null;
  unit: string | null;
  raw_status_code: string | null;
  qty_ordered: number;
  qty_received: number;
  qty_due: number;
  cost: number;
  ext_cost: number;
  price: number;
  ext_price: number;
  estimated_date: string | null;
  notes: string | null;
  total_count: number;
};

type Summary = {
  total_orders: number;
  pending_orders: number;
  closed_orders: number;
  cancelled_orders: number;
  total_amount: number;
};

const PAGE_SIZE = 50;
const LINE_PAGE_SIZE = 50;

function limaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function startOfMonth() {
  const parts = limaDate().split("-");
  return `${parts[0]}-${parts[1]}-01`;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  return new Intl.NumberFormat("es-PE", {
    style: "currency", currency: "PEN", minimumFractionDigits: 2,
  }).format(numberValue(value));
}

function quantity(value: unknown) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(numberValue(value));
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima", dateStyle: "short", timeStyle: "short",
  }).format(new Date(value));
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date(value));
}

function storeNo(store: StoreRow | null | undefined) {
  if (!store) return "";
  if (store.erp_store_no) return String(store.erp_store_no).trim();
  if (store.code === "CD-GPC") return "0";
  const digits = String(store.code || store.name || "").match(/GPC0*(\d+)/i)?.[1];
  return digits ? String(Number(digits)) : "";
}

function statusMeta(status: PurchaseOrder["business_status"]) {
  if (status === "closed") return { label: "Cerrada", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  if (status === "cancelled") return { label: "Cancelada", className: "bg-slate-100 text-slate-600 border-slate-200" };
  return { label: "Pendiente", className: "bg-amber-100 text-amber-800 border-amber-200" };
}

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white px-4 py-3">
      <p className="text-xs font-bold text-slate-500">Mostrando {from.toLocaleString("es-PE")}-{to.toLocaleString("es-PE")} de {total.toLocaleString("es-PE")}</p>
      <div className="flex items-center gap-2">
        <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-35"><ChevronLeft size={15} />Anterior</button>
        <span className="min-w-[92px] text-center text-xs font-black text-slate-700">Página {page} de {pages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= pages} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-35">Siguiente<ChevronRight size={15} /></button>
      </div>
    </div>
  );
}

export default function PurchaseOrdersModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [summary, setSummary] = useState<Summary>({ total_orders: 0, pending_orders: 0, closed_orders: 0, cancelled_orders: 0, total_amount: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus>("all");
  const [dateFrom, setDateFrom] = useState(startOfMonth);
  const [dateTo, setDateTo] = useState(limaDate);
  const [selectedStoreNo, setSelectedStoreNo] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<PurchaseOrder | null>(null);
  const [lines, setLines] = useState<PurchaseOrderLine[]>([]);
  const [linePage, setLinePage] = useState(1);
  const [lineTotal, setLineTotal] = useState(0);
  const [loadingLines, setLoadingLines] = useState(false);
  const loadSeq = useRef(0);
  const linesSeq = useRef(0);

  const canViewAllStores = Boolean(user && (
    user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador" || user.can_access_all_stores
  ));

  const assignedStore = useMemo(() => stores.find(store => store.id === user?.store_id) || null, [stores, user?.store_id]);

  const storeOptions = useMemo(() => {
    const seen = new Set<string>();
    return stores
      .map(store => ({ no: storeNo(store), name: store.name }))
      .filter(store => store.no && !seen.has(store.no) && seen.add(store.no))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [stores]);

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "purchase_orders")) {
      window.location.replace("/");
      return;
    }
    setUser(stored);
    Promise.all([
      supabase.from("stores").select("id,code,name,erp_sede,erp_store_no,is_active").eq("is_active", true).order("name"),
      supabase.from("erp_sync_status").select("synced_at").eq("id", "purchase_orders").maybeSingle(),
    ]).then(([storesResult, syncResult]) => {
      if (storesResult.error) toast.error(`No se pudieron cargar las tiendas: ${storesResult.error.message}`);
      setStores((storesResult.data || []) as StoreRow[]);
      setLastSync(syncResult.data?.synced_at || null);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !user || canViewAllStores) return;
    const ownStoreNo = storeNo(assignedStore);
    if (ownStoreNo) setSelectedStoreNo(ownStoreNo);
  }, [assignedStore, canViewAllStores, ready, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadOrders = useCallback(async () => {
    if (!ready || !user) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    const scopeStore = selectedStoreNo === "all" ? null : selectedStoreNo;
    const [pageResult, summaryResult, syncResult] = await Promise.all([
      supabase.rpc("get_purchase_orders_page", {
        p_status: statusFilter,
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_store_no: scopeStore,
        p_search: search || null,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      }),
      supabase.rpc("get_purchase_orders_summary", {
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_store_no: scopeStore,
        p_search: search || null,
      }),
      supabase.from("erp_sync_status").select("synced_at").eq("id", "purchase_orders").maybeSingle(),
    ]);
    if (seq !== loadSeq.current) return;
    if (pageResult.error) {
      toast.error(`No se pudieron cargar las órdenes: ${pageResult.error.message}`);
      setRows([]);
      setTotal(0);
    } else {
      const data = (pageResult.data || []) as PurchaseOrder[];
      setRows(data);
      setTotal(numberValue(data[0]?.total_count));
    }
    if (!summaryResult.error && summaryResult.data?.[0]) {
      const value = summaryResult.data[0] as Summary;
      setSummary({
        total_orders: numberValue(value.total_orders),
        pending_orders: numberValue(value.pending_orders),
        closed_orders: numberValue(value.closed_orders),
        cancelled_orders: numberValue(value.cancelled_orders),
        total_amount: numberValue(value.total_amount),
      });
    }
    if (syncResult.data?.synced_at) setLastSync(syncResult.data.synced_at);
    setLoading(false);
  }, [dateFrom, dateTo, page, ready, search, selectedStoreNo, statusFilter, user]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  useEffect(() => {
    if (!ready) return;
    const interval = window.setInterval(() => void loadOrders(), 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [loadOrders, ready]);

  const loadLines = useCallback(async (order: PurchaseOrder, targetPage: number) => {
    const seq = ++linesSeq.current;
    setLoadingLines(true);
    const { data, error } = await supabase.rpc("get_purchase_order_lines_page", {
      p_erp_po_id: order.erp_po_id,
      p_limit: LINE_PAGE_SIZE,
      p_offset: (targetPage - 1) * LINE_PAGE_SIZE,
    });
    if (seq !== linesSeq.current) return;
    if (error) {
      toast.error(`No se pudo cargar el detalle: ${error.message}`);
      setLines([]);
      setLineTotal(0);
    } else {
      const detail = (data || []) as PurchaseOrderLine[];
      setLines(detail);
      setLineTotal(numberValue(detail[0]?.total_count));
    }
    setLoadingLines(false);
  }, []);

  function openOrder(order: PurchaseOrder) {
    setSelectedOrder(order);
    setLinePage(1);
    setLines([]);
    setLineTotal(0);
    void loadLines(order, 1);
  }

  function changeStatus(status: PurchaseOrderStatus) {
    setStatusFilter(status);
    setPage(1);
  }

  function changeLinePage(nextPage: number) {
    if (!selectedOrder) return;
    setLinePage(nextPage);
    void loadLines(selectedOrder, nextPage);
  }

  if (!ready) return <div className="min-h-screen grid place-items-center bg-slate-100"><RefreshCw className="animate-spin text-orange-600" /></div>;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-3 px-4 py-3 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border bg-white hover:bg-slate-50" aria-label="Inicio"><Home size={19} /></Link>
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-orange-600 text-white"><PackageSearch size={21} /></div>
            <div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">RMS · Compras</p><h1 className="truncate text-lg font-black">Órdenes de compra</h1></div>
          </div>
          <button onClick={() => void loadOrders()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""} />Actualizar</button>
        </div>
      </header>

      <div className="mx-auto max-w-[1680px] space-y-4 p-4 lg:p-8">
        <section className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <div className="rounded-3xl border bg-white p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-wider text-orange-600">Seguimiento de ingreso</p>
            <h2 className="mt-1 text-2xl font-black">Pendientes y cerradas en RMS</h2>
            <p className="mt-1 text-sm text-slate-500">Las OC cerradas ya fueron ingresadas; las pendientes todavía requieren ingreso en la tienda indicada.</p>
          </div>
          <div className="flex min-w-[270px] items-center gap-3 rounded-3xl border bg-slate-950 px-5 py-4 text-white shadow-sm">
            <Clock3 className="text-orange-400" />
            <div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Última sincronización RMS</p><p className="text-sm font-black">{dateTime(lastSync)}</p><p className="text-[11px] text-slate-400">Automática cada 5 minutos</p></div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          {[
            { key: "all" as const, label: "Total OC", value: summary.total_orders, className: "text-slate-950" },
            { key: "pending" as const, label: "Pendientes", value: summary.pending_orders, className: "text-amber-600" },
            { key: "closed" as const, label: "Cerradas", value: summary.closed_orders, className: "text-emerald-600" },
            { key: "cancelled" as const, label: "Canceladas", value: summary.cancelled_orders, className: "text-slate-500" },
          ].map(card => (
            <button key={card.key} onClick={() => changeStatus(card.key)} className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusFilter === card.key ? "ring-2 ring-orange-500" : ""}`}>
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">{card.label}</p>
              <p className={`mt-1 text-3xl font-black ${card.className}`}>{card.value.toLocaleString("es-PE")}</p>
            </button>
          ))}
          <div className="col-span-2 rounded-2xl border bg-white p-4 shadow-sm xl:col-span-1"><p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Valor del filtro</p><p className="mt-1 text-2xl font-black text-blue-700">{money(summary.total_amount)}</p></div>
        </section>

        <section className="rounded-3xl border bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(280px,1fr)_180px_180px_280px_auto] xl:items-end">
            <label className="block"><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Buscar OC o código</span><div className="flex items-center rounded-2xl border bg-white px-3 focus-within:ring-2 focus-within:ring-orange-400"><Search size={18} className="text-slate-400" /><input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Número, proveedor o últimos 5 dígitos" className="w-full bg-transparent px-3 py-3 text-sm font-bold outline-none" /></div></label>
            <label className="block"><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Desde</span><input type="date" value={dateFrom} onChange={event => { setDateFrom(event.target.value); setPage(1); }} className="w-full rounded-2xl border px-3 py-3 text-sm font-bold" /></label>
            <label className="block"><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Hasta</span><input type="date" value={dateTo} onChange={event => { setDateTo(event.target.value); setPage(1); }} className="w-full rounded-2xl border px-3 py-3 text-sm font-bold" /></label>
            <label className="block"><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Tienda de ingreso</span><select value={selectedStoreNo} disabled={!canViewAllStores} onChange={event => { setSelectedStoreNo(event.target.value); setPage(1); }} className="w-full rounded-2xl border bg-white px-3 py-3 text-sm font-black disabled:bg-slate-100"><option value="all">Todas las tiendas</option>{storeOptions.map(store => <option key={store.no} value={store.no}>{store.name}</option>)}</select></label>
            <button onClick={() => { setSearchInput(""); setSearch(""); setDateFrom(startOfMonth()); setDateTo(limaDate()); setStatusFilter("all"); if (canViewAllStores) setSelectedStoreNo("all"); setPage(1); }} className="rounded-2xl border px-4 py-3 text-sm font-black hover:bg-slate-50">Limpiar</button>
          </div>
          <p className="mt-3 text-xs text-slate-400">La búsqueda también revisa ALU/SKU/UPC de los artículos y reconoce coincidencias por los últimos 5 dígitos.</p>
        </section>

        <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />

        <section className="overflow-hidden rounded-3xl border bg-white shadow-sm">
          {loading ? (
            <div className="grid min-h-[320px] place-items-center"><div className="text-center"><RefreshCw className="mx-auto animate-spin text-orange-600" /><p className="mt-3 text-sm font-bold text-slate-500">Consultando OC...</p></div></div>
          ) : rows.length === 0 ? (
            <div className="grid min-h-[320px] place-items-center text-center"><div><PackageSearch className="mx-auto text-slate-300" size={46} /><p className="mt-3 font-black">No hay órdenes para estos filtros</p><p className="text-sm text-slate-400">Prueba otro rango, tienda o código.</p></div></div>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[1180px] border-collapse text-sm">
                  <thead className="bg-slate-950 text-left text-[11px] uppercase tracking-wider text-white"><tr><th className="p-4">OC / estado</th><th className="p-4">Generada</th><th className="p-4">Tienda de ingreso</th><th className="p-4">Proveedor</th><th className="p-4">Comprador</th><th className="p-4 text-right">Artículos / unidades</th><th className="p-4 text-right">Total</th><th className="p-4">Ingreso RMS</th></tr></thead>
                  <tbody className="divide-y">{rows.map(order => { const meta = statusMeta(order.business_status); return <tr key={order.erp_po_id} onClick={() => openOrder(order)} className="cursor-pointer transition hover:bg-orange-50"><td className="p-4"><p className="font-black text-blue-700">{order.po_number}</p><span className={`mt-1 inline-flex rounded-full border px-2 py-1 text-[10px] font-black uppercase ${meta.className}`}>{meta.label}</span></td><td className="p-4 font-bold">{dateTime(order.po_date)}</td><td className="p-4"><p className="font-black">{order.store_name || order.store_code || order.store_no}</p><p className="text-xs text-slate-400">RMS {order.store_no}</p></td><td className="max-w-[320px] p-4"><p className="font-bold">{order.vendor_name || "Sin proveedor"}</p><p className="text-xs text-slate-400">{order.vendor_code || "—"}</p></td><td className="p-4 text-slate-600">{order.buyer || "—"}</td><td className="p-4 text-right"><p className="font-black">{order.line_count.toLocaleString("es-PE")} ítems</p><p className="text-xs text-slate-500">{quantity(order.qty_received)} / {quantity(order.qty_ordered)} recibidas</p></td><td className="p-4 text-right font-black">{money(order.total)}</td><td className="p-4"><p className={order.business_status === "closed" ? "font-black text-emerald-700" : "font-bold text-amber-700"}>{order.closed_at ? dateTime(order.closed_at) : "Pendiente"}</p><p className="text-xs text-slate-400">RMS: {order.raw_status_code}</p></td></tr>; })}</tbody>
                </table>
              </div>
              <div className="divide-y lg:hidden">{rows.map(order => { const meta = statusMeta(order.business_status); return <button key={order.erp_po_id} onClick={() => openOrder(order)} className="block w-full p-4 text-left hover:bg-orange-50"><div className="flex items-start justify-between gap-3"><div><p className="text-lg font-black text-blue-700">OC {order.po_number}</p><p className="mt-1 text-xs font-bold text-slate-500">{dateTime(order.po_date)}</p></div><span className={`rounded-full border px-2 py-1 text-[10px] font-black uppercase ${meta.className}`}>{meta.label}</span></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><p className="text-[10px] font-black uppercase text-slate-400">Tienda</p><p className="font-black">{order.store_name || order.store_no}</p></div><div><p className="text-[10px] font-black uppercase text-slate-400">Proveedor</p><p className="line-clamp-2 font-bold">{order.vendor_name || "—"}</p></div><div><p className="text-[10px] font-black uppercase text-slate-400">Detalle</p><p className="font-bold">{order.line_count} ítems · {quantity(order.qty_ordered)} uds.</p></div><div><p className="text-[10px] font-black uppercase text-slate-400">Total</p><p className="font-black">{money(order.total)}</p></div></div></button>; })}</div>
            </>
          )}
        </section>

        <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>

      {selectedOrder && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedOrder(null); }}>
          <div className="ml-auto flex h-full w-full max-w-5xl flex-col overflow-hidden bg-slate-50 shadow-2xl sm:rounded-3xl">
            <div className="border-b bg-white p-4 sm:p-6"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wider text-orange-600">Detalle de orden de compra</p><div className="mt-1 flex flex-wrap items-center gap-3"><h2 className="text-2xl font-black">OC {selectedOrder.po_number}</h2><span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase ${statusMeta(selectedOrder.business_status).className}`}>{statusMeta(selectedOrder.business_status).label}</span></div><p className="mt-1 text-sm text-slate-500">{selectedOrder.vendor_name || selectedOrder.vendor_code || "Sin proveedor"}</p></div><button onClick={() => setSelectedOrder(null)} className="grid h-10 w-10 place-items-center rounded-xl border hover:bg-slate-50" aria-label="Cerrar"><X size={20} /></button></div></div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <div className="rounded-2xl border bg-white p-3"><CalendarDays className="text-blue-600" size={18} /><p className="mt-2 text-[10px] font-black uppercase text-slate-400">Generada</p><p className="text-sm font-black">{dateTime(selectedOrder.po_date)}</p></div>
                <div className="rounded-2xl border bg-white p-3"><Store className="text-orange-600" size={18} /><p className="mt-2 text-[10px] font-black uppercase text-slate-400">Debe ingresar</p><p className="text-sm font-black">{selectedOrder.store_name || selectedOrder.store_no}</p></div>
                <div className="rounded-2xl border bg-white p-3"><Truck className="text-violet-600" size={18} /><p className="mt-2 text-[10px] font-black uppercase text-slate-400">Unidades</p><p className="text-sm font-black">{quantity(selectedOrder.qty_received)} / {quantity(selectedOrder.qty_ordered)}</p></div>
                <div className="rounded-2xl border bg-white p-3"><PackageSearch className="text-emerald-600" size={18} /><p className="mt-2 text-[10px] font-black uppercase text-slate-400">Ítems</p><p className="text-sm font-black">{selectedOrder.line_count.toLocaleString("es-PE")}</p></div>
                <div className="col-span-2 rounded-2xl border bg-slate-950 p-3 text-white lg:col-span-1"><p className="text-[10px] font-black uppercase text-slate-400">Total OC</p><p className="mt-2 text-xl font-black">{money(selectedOrder.total)}</p></div>
              </div>

              <Pager page={linePage} total={lineTotal} pageSize={LINE_PAGE_SIZE} onPage={changeLinePage} />
              <div className="overflow-hidden rounded-2xl border bg-white">
                {loadingLines ? <div className="grid min-h-[260px] place-items-center"><RefreshCw className="animate-spin text-orange-600" /></div> : lines.length === 0 ? <div className="p-12 text-center text-sm font-bold text-slate-400">Sin artículos sincronizados.</div> : <>
                  <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[900px] text-sm"><thead className="bg-slate-900 text-left text-[10px] uppercase tracking-wider text-white"><tr><th className="p-3">Código</th><th className="p-3">Descripción</th><th className="p-3">UM</th><th className="p-3 text-right">Pedido</th><th className="p-3 text-right">Recibido</th><th className="p-3 text-right">Pendiente</th><th className="p-3 text-right">Costo</th><th className="p-3 text-right">Total costo</th></tr></thead><tbody className="divide-y">{lines.map(line => <tr key={line.line_id}><td className="p-3"><p className="font-black text-blue-700">{line.product_code}</p><p className="text-[11px] text-slate-400">SKU {line.sku || "—"}{line.barcode ? ` · UPC ${line.barcode}` : ""}</p></td><td className="max-w-[360px] p-3 font-bold">{line.description || "—"}</td><td className="p-3">{line.unit || "—"}</td><td className="p-3 text-right font-black">{quantity(line.qty_ordered)}</td><td className="p-3 text-right font-black text-emerald-700">{quantity(line.qty_received)}</td><td className="p-3 text-right font-black text-amber-700">{quantity(line.qty_due)}</td><td className="p-3 text-right">{money(line.cost)}</td><td className="p-3 text-right font-black">{money(line.ext_cost)}</td></tr>)}</tbody></table></div>
                  <div className="divide-y md:hidden">{lines.map(line => <div key={line.line_id} className="p-4"><p className="font-black text-blue-700">{line.product_code}</p><p className="mt-1 text-sm font-bold">{line.description || "—"}</p><p className="mt-1 text-xs text-slate-400">SKU {line.sku || "—"} · UM {line.unit || "—"}</p><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-xl bg-slate-100 p-2"><p className="text-[9px] font-black uppercase text-slate-400">Pedido</p><p className="font-black">{quantity(line.qty_ordered)}</p></div><div className="rounded-xl bg-emerald-50 p-2"><p className="text-[9px] font-black uppercase text-emerald-600">Recibido</p><p className="font-black text-emerald-700">{quantity(line.qty_received)}</p></div><div className="rounded-xl bg-amber-50 p-2"><p className="text-[9px] font-black uppercase text-amber-600">Pendiente</p><p className="font-black text-amber-700">{quantity(line.qty_due)}</p></div></div></div>)}</div>
                </>}
              </div>
              <Pager page={linePage} total={lineTotal} pageSize={LINE_PAGE_SIZE} onPage={changeLinePage} />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
