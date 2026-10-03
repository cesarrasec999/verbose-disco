"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3,
  FileSignature, History, Home, Link2, PackageSearch, RefreshCw, Search,
  ShieldCheck, Store, Truck, Upload, X, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store as StoreRow } from "@/features/ciclicos/types";

type PurchaseOrderStatus = "all" | "pending" | "closed" | "cancelled";
type ApprovalFilter = "all" | "action" | "pending" | "approved" | "rejected" | "unrouted";
type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "superseded";

type PurchaseOrder = {
  erp_po_id: string; po_number: string; raw_status_code: string;
  business_status: Exclude<PurchaseOrderStatus, "all">;
  store_no: string; store_code: string | null; store_name: string | null;
  vendor_code: string | null; vendor_name: string | null; buyer: string | null;
  po_date: string; ship_date: string | null; closed_at: string | null;
  line_count: number; qty_ordered: number; qty_received: number; qty_due: number;
  total: number; currency_id: number | null; synced_at: string;
  approval_id: string | null; approval_status: ApprovalStatus | null;
  approval_tier: "low" | "medium" | "high" | "replacement" | null;
  route_kind: "standard" | "replacement" | null; approval_version: number | null;
  current_step_role: string | null; current_step_name: string | null;
  can_current_user_act: boolean; has_replacement: boolean; total_count: number;
};

type PurchaseOrderLine = {
  line_id: number; sku: string | null; product_code: string; barcode: string | null;
  description: string | null; unit: string | null; raw_status_code: string | null;
  qty_ordered: number; qty_received: number; qty_due: number; cost: number;
  ext_cost: number; price: number; ext_price: number; estimated_date: string | null;
  notes: string | null; total_count: number;
};

type ApprovalStep = {
  id: string; step_order: number; role_key: string; role_label: string;
  approver_user_id: string; approver_name: string;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  acted_at: string | null; comment: string | null;
};

type ApprovalEvent = {
  id: number; event_type: string; actor_name: string | null; comment: string | null;
  metadata: Record<string, unknown>; created_at: string;
};

type ApprovalDetail = {
  approval_id: string; version: number; route_kind: "standard" | "replacement";
  approval_tier: "low" | "medium" | "high" | "replacement";
  currency_code: "PEN" | "USD"; amount_snapshot: number; approval_status: ApprovalStatus;
  rejected_comment: string | null; created_at: string; approved_at: string | null;
  rejected_at: string | null; can_current_user_act: boolean; can_link_replacement: boolean;
  replaces_po_number: string | null; replaced_by_po_number: string | null;
  steps: ApprovalStep[]; events: ApprovalEvent[];
};

type Summary = {
  total_orders: number; awaiting_my_approval: number; pending_approval: number;
  approved_orders: number; rejected_orders: number; unrouted_orders: number;
  total_amount: number;
};

type SignatureApprover = {
  role_key: string; user_id: string;
  user: { id: string; full_name: string; username: string } | null;
  signature: null | { original_filename: string; file_size: number; sha256: string;
    uploaded_at: string; updated_at: string; preview_url: string | null };
};

const PAGE_SIZE = 50;
const LINE_PAGE_SIZE = 50;
const EMPTY_SUMMARY: Summary = { total_orders: 0, awaiting_my_approval: 0, pending_approval: 0, approved_orders: 0, rejected_orders: 0, unrouted_orders: 0, total_amount: 0 };

function limaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function startOfMonth() { const parts = limaDate().split("-"); return `${parts[0]}-${parts[1]}-01`; }
function numberValue(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function currencyCode(currencyId: number | null | undefined): "PEN" | "USD" { return Number(currencyId) === 2 ? "USD" : "PEN"; }
function money(value: unknown, currency: "PEN" | "USD" = "PEN") { return new Intl.NumberFormat("es-PE", { style: "currency", currency, minimumFractionDigits: 2 }).format(numberValue(value)); }
function quantity(value: unknown) { return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(numberValue(value)); }
function dateTime(value: string | null | undefined) { if (!value) return "—"; return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function storeNo(store: StoreRow | null | undefined) { if (!store) return ""; if (store.erp_store_no) return String(store.erp_store_no).trim(); if (store.code === "CD-GPC") return "0"; const digits = String(store.code || store.name || "").match(/GPC0*(\d+)/i)?.[1]; return digits ? String(Number(digits)) : ""; }

function statusMeta(status: PurchaseOrder["business_status"]) {
  if (status === "closed") return { label: "Cerrada RMS", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  if (status === "cancelled") return { label: "Cancelada RMS", className: "bg-slate-100 text-slate-600 border-slate-200" };
  return { label: "Pendiente RMS", className: "bg-amber-100 text-amber-800 border-amber-200" };
}
function approvalMeta(status: ApprovalStatus | null) {
  if (status === "approved") return { label: "Aprobada", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  if (status === "rejected") return { label: "Rechazada", className: "bg-red-100 text-red-800 border-red-200" };
  if (status === "cancelled") return { label: "Cancelada", className: "bg-slate-100 text-slate-600 border-slate-200" };
  if (status === "superseded") return { label: "Versión reemplazada", className: "bg-violet-100 text-violet-800 border-violet-200" };
  if (status === "pending") return { label: "En aprobación", className: "bg-blue-100 text-blue-800 border-blue-200" };
  return { label: "Sin ruta histórica", className: "bg-slate-100 text-slate-500 border-slate-200" };
}
function tierLabel(tier: PurchaseOrder["approval_tier"] | ApprovalDetail["approval_tier"] | null) { if (tier === "high") return "Tramo mayor"; if (tier === "medium") return "Tramo medio"; if (tier === "replacement") return "Reemplazo"; if (tier === "low") return "Tramo menor"; return "Sin ruta"; }
function roleLabel(role: string) { if (role === "purchasing_lead") return "Líder de Compras"; if (role === "purchasing_manager") return "Jefe de Compras"; if (role === "finance_manager") return "Jefe de Finanzas"; if (role === "treasury_lead") return "Líder de Tesorería"; return role; }

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize)); const from = total === 0 ? 0 : (page - 1) * pageSize + 1; const to = Math.min(page * pageSize, total);
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white px-4 py-3"><p className="text-xs font-bold text-slate-500">Mostrando {from.toLocaleString("es-PE")}-{to.toLocaleString("es-PE")} de {total.toLocaleString("es-PE")}</p><div className="flex items-center gap-2"><button onClick={() => onPage(page - 1)} disabled={page <= 1} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-35"><ChevronLeft size={15} />Anterior</button><span className="min-w-[92px] text-center text-xs font-black text-slate-700">Página {page} de {pages}</span><button onClick={() => onPage(page + 1)} disabled={page >= pages} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-35">Siguiente<ChevronRight size={15} /></button></div></div>;
}

export default function PurchaseOrdersModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus>("all");
  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>("all");
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
  const [approval, setApproval] = useState<ApprovalDetail | null>(null);
  const [loadingApproval, setLoadingApproval] = useState(false);
  const [actionComment, setActionComment] = useState("");
  const [acting, setActing] = useState(false);
  const [replacementNumber, setReplacementNumber] = useState("");
  const [linkingReplacement, setLinkingReplacement] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signatureRows, setSignatureRows] = useState<SignatureApprover[]>([]);
  const [signatureLoading, setSignatureLoading] = useState(false);
  const [signatureUploading, setSignatureUploading] = useState<string | null>(null);
  const loadSeq = useRef(0); const linesSeq = useRef(0);

  const isAdmin = String(user?.role || "").toLowerCase() === "administrador";
  const canViewAllStores = Boolean(user && (user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador" || user.can_access_all_stores));
  const assignedStore = useMemo(() => stores.find(store => store.id === user?.store_id) || null, [stores, user?.store_id]);
  const storeOptions = useMemo(() => { const seen = new Set<string>(); return stores.map(store => ({ no: storeNo(store), name: store.name })).filter(store => store.no && !seen.has(store.no) && seen.add(store.no)).sort((a, b) => a.name.localeCompare(b.name, "es")); }, [stores]);
  const authHeaders = useCallback(() => ({ "x-user-id": user?.id || "", "x-session-token": user?.cyclic_session_token || "", "x-device-id": user?.cyclic_device_id || "" }), [user]);

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "purchase_orders")) { window.location.replace("/"); return; }
    setUser(stored);
    Promise.all([
      supabase.from("stores").select("id,code,name,erp_sede,erp_store_no,is_active").eq("is_active", true).order("name"),
      supabase.from("erp_sync_status").select("synced_at").eq("id", "purchase_orders").maybeSingle(),
    ]).then(([storesResult, syncResult]) => { if (storesResult.error) toast.error(`No se pudieron cargar las tiendas: ${storesResult.error.message}`); setStores((storesResult.data || []) as StoreRow[]); setLastSync(syncResult.data?.synced_at || null); setReady(true); });
  }, []);
  useEffect(() => { if (!ready || !user || canViewAllStores) return; const ownStoreNo = storeNo(assignedStore); if (ownStoreNo) setSelectedStoreNo(ownStoreNo); }, [assignedStore, canViewAllStores, ready, user]);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350); return () => window.clearTimeout(timer); }, [searchInput]);

  const loadOrders = useCallback(async () => {
    if (!ready || !user) return; const seq = ++loadSeq.current; setLoading(true); const scopeStore = selectedStoreNo === "all" ? null : selectedStoreNo;
    const [pageResult, summaryResult, syncResult] = await Promise.all([
      supabase.rpc("get_purchase_orders_workflow_page", { p_user_id: user.id, p_status: statusFilter, p_approval_status: approvalFilter, p_date_from: dateFrom || null, p_date_to: dateTo || null, p_store_no: scopeStore, p_search: search || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
      supabase.rpc("get_purchase_orders_workflow_summary", { p_user_id: user.id, p_date_from: dateFrom || null, p_date_to: dateTo || null, p_store_no: scopeStore, p_search: search || null }),
      supabase.from("erp_sync_status").select("synced_at").eq("id", "purchase_orders").maybeSingle(),
    ]);
    if (seq !== loadSeq.current) return;
    if (pageResult.error) { toast.error(`No se pudieron cargar las órdenes: ${pageResult.error.message}`); setRows([]); setTotal(0); } else { const data = (pageResult.data || []) as PurchaseOrder[]; setRows(data); setTotal(numberValue(data[0]?.total_count)); }
    if (summaryResult.error) setSummary(EMPTY_SUMMARY); else if (summaryResult.data?.[0]) { const value = summaryResult.data[0] as Summary; setSummary({ total_orders: numberValue(value.total_orders), awaiting_my_approval: numberValue(value.awaiting_my_approval), pending_approval: numberValue(value.pending_approval), approved_orders: numberValue(value.approved_orders), rejected_orders: numberValue(value.rejected_orders), unrouted_orders: numberValue(value.unrouted_orders), total_amount: numberValue(value.total_amount) }); }
    if (syncResult.data?.synced_at) setLastSync(syncResult.data.synced_at); setLoading(false);
  }, [approvalFilter, dateFrom, dateTo, page, ready, search, selectedStoreNo, statusFilter, user]);
  useEffect(() => { void loadOrders(); }, [loadOrders]);
  useEffect(() => { if (!ready) return; const interval = window.setInterval(() => void loadOrders(), 5 * 60 * 1000); return () => window.clearInterval(interval); }, [loadOrders, ready]);

  const loadLines = useCallback(async (order: PurchaseOrder, targetPage: number) => {
    const seq = ++linesSeq.current; setLoadingLines(true);
    const { data, error } = await supabase.rpc("get_purchase_order_lines_page", { p_erp_po_id: order.erp_po_id, p_limit: LINE_PAGE_SIZE, p_offset: (targetPage - 1) * LINE_PAGE_SIZE });
    if (seq !== linesSeq.current) return;
    if (error) { toast.error(`No se pudo cargar el detalle: ${error.message}`); setLines([]); setLineTotal(0); } else { const detail = (data || []) as PurchaseOrderLine[]; setLines(detail); setLineTotal(numberValue(detail[0]?.total_count)); } setLoadingLines(false);
  }, []);
  const loadApproval = useCallback(async (order: PurchaseOrder) => {
    if (!user) return; setLoadingApproval(true);
    const { data, error } = await supabase.rpc("get_purchase_order_approval_detail", { p_erp_po_id: order.erp_po_id, p_user_id: user.id });
    if (error) { toast.error(`No se pudo cargar la ruta: ${error.message}`); setApproval(null); } else setApproval((data?.[0] as ApprovalDetail | undefined) || null); setLoadingApproval(false);
  }, [user]);
  function openOrder(order: PurchaseOrder) { setSelectedOrder(order); setLinePage(1); setLines([]); setLineTotal(0); setApproval(null); setActionComment(""); setReplacementNumber(""); void Promise.all([loadLines(order, 1), loadApproval(order)]); }
  function changeLinePage(nextPage: number) { if (!selectedOrder) return; setLinePage(nextPage); void loadLines(selectedOrder, nextPage); }

  async function actOnApproval(action: "approve" | "reject") {
    if (!user || !approval || !selectedOrder) return; if (action === "reject" && actionComment.trim().length < 3) { toast.error("Indica el motivo del rechazo"); return; }
    setActing(true); const { error } = await supabase.rpc("act_on_purchase_order_approval", { p_approval_id: approval.approval_id, p_user_id: user.id, p_session_token: user.cyclic_session_token || null, p_device_id: user.cyclic_device_id || null, p_action: action, p_comment: actionComment.trim() || null }); setActing(false);
    if (error) { toast.error(error.message); return; } toast.success(action === "approve" ? "Aprobación registrada" : "OC rechazada con historial"); setActionComment(""); await Promise.all([loadApproval(selectedOrder), loadOrders()]);
  }
  async function linkReplacement() {
    if (!user || !approval || !selectedOrder || !replacementNumber.trim()) return; setLinkingReplacement(true); const normalized = replacementNumber.trim();
    const { data: candidates, error: findError } = await supabase.from("erp_purchase_orders").select("erp_po_id,po_number").eq("po_number", normalized).neq("erp_po_id", selectedOrder.erp_po_id).limit(2);
    if (findError || !candidates?.length) { setLinkingReplacement(false); toast.error("No se encontró esa nueva OC en RMS"); return; }
    if (candidates.length > 1) { setLinkingReplacement(false); toast.error("Hay más de una coincidencia; usa el número completo"); return; }
    const { error } = await supabase.rpc("link_purchase_order_replacement", { p_rejected_approval_id: approval.approval_id, p_new_erp_po_id: candidates[0].erp_po_id, p_user_id: user.id, p_session_token: user.cyclic_session_token || null, p_device_id: user.cyclic_device_id || null }); setLinkingReplacement(false);
    if (error) { toast.error(error.message); return; } toast.success(`OC ${normalized} vinculada como reemplazo`); setReplacementNumber(""); await Promise.all([loadApproval(selectedOrder), loadOrders()]);
  }

  const loadSignatures = useCallback(async () => {
    if (!user || !isAdmin) return; setSignatureLoading(true); const response = await fetch("/api/purchase-orders/signatures", { headers: authHeaders(), cache: "no-store" }); const payload = await response.json().catch(() => ({})); setSignatureLoading(false); if (!response.ok) { toast.error(payload.error || "No se pudieron cargar las firmas"); return; } setSignatureRows(payload.approvers || []);
  }, [authHeaders, isAdmin, user]);
  async function openSignatures() { setSignatureOpen(true); await loadSignatures(); }
  async function uploadSignature(targetUserId: string, file: File | null) {
    if (!file) return; setSignatureUploading(targetUserId); const form = new FormData(); form.append("userId", targetUserId); form.append("file", file); const response = await fetch("/api/purchase-orders/signatures", { method: "POST", headers: authHeaders(), body: form }); const payload = await response.json().catch(() => ({})); setSignatureUploading(null); if (!response.ok) { toast.error(payload.error || "No se pudo subir la firma"); return; } toast.success("Firma digital guardada de forma privada"); await loadSignatures();
  }

  if (!ready) return <div className="grid min-h-screen place-items-center bg-slate-100"><RefreshCw className="animate-spin text-orange-600" /></div>;

  return <main className="min-h-screen bg-slate-100 text-slate-950">
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-[1680px] items-center justify-between gap-3 px-4 py-3 lg:px-8"><div className="flex min-w-0 items-center gap-3"><Link href="/" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border bg-white hover:bg-slate-50" aria-label="Inicio"><Home size={19} /></Link><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-orange-600 text-white"><PackageSearch size={21} /></div><div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">RMS · Compras</p><h1 className="truncate text-lg font-black">Órdenes de compra y aprobaciones</h1></div></div><div className="flex items-center gap-2">{isAdmin && <button onClick={() => void openSignatures()} className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50"><FileSignature size={16} />Firmas digitales</button>}<button onClick={() => void loadOrders()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""} />Actualizar</button></div></div></header>

    <div className="mx-auto max-w-[1680px] space-y-4 p-4 lg:p-8">
      <section className="grid gap-3 lg:grid-cols-[1fr_auto]"><div className="rounded-3xl border bg-white p-5 shadow-sm"><p className="text-xs font-black uppercase tracking-wider text-orange-600">Flujo automático y secuencial</p><h2 className="mt-1 text-2xl font-black">Aprobaciones de órdenes de compra RMS</h2><p className="mt-1 text-sm text-slate-500">La ruta se crea según moneda e importe. Cada responsable actúa únicamente después de la aprobación anterior.</p></div><div className="flex min-w-[270px] items-center gap-3 rounded-3xl border bg-slate-950 px-5 py-4 text-white shadow-sm"><Clock3 className="text-orange-400" /><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Última sincronización RMS</p><p className="text-sm font-black">{dateTime(lastSync)}</p><p className="text-[11px] text-slate-400">Automática cada 5 minutos</p></div></div></section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-6">{[
        { key: "all" as ApprovalFilter, label: "Total visibles", value: summary.total_orders, color: "text-slate-950" },
        { key: "action" as ApprovalFilter, label: "Me corresponde", value: summary.awaiting_my_approval, color: "text-orange-600" },
        { key: "pending" as ApprovalFilter, label: "En aprobación", value: summary.pending_approval, color: "text-blue-700" },
        { key: "approved" as ApprovalFilter, label: "Aprobadas", value: summary.approved_orders, color: "text-emerald-700" },
        { key: "rejected" as ApprovalFilter, label: "Rechazadas", value: summary.rejected_orders, color: "text-red-700" },
      ].map(card => <button key={card.key} onClick={() => { setApprovalFilter(card.key); setPage(1); }} className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${approvalFilter === card.key ? "ring-2 ring-orange-500" : ""}`}><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{card.label}</p><p className={`mt-1 text-3xl font-black ${card.color}`}>{card.value.toLocaleString("es-PE")}</p></button>)}<div className="col-span-2 rounded-2xl border bg-white p-4 shadow-sm xl:col-span-1"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Valor del filtro</p><p className="mt-1 text-2xl font-black text-blue-700">{money(summary.total_amount)}</p><p className="text-[10px] text-slate-400">Consolidado referencial</p></div></section>

      <section className="rounded-3xl border bg-white p-4 shadow-sm"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_170px_170px_250px_190px_auto] xl:items-end"><label><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Buscar OC o código</span><div className="flex items-center rounded-2xl border bg-white px-3 focus-within:ring-2 focus-within:ring-orange-400"><Search size={18} className="text-slate-400" /><input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Número, proveedor o últimos 5 dígitos" className="w-full bg-transparent px-3 py-3 text-sm font-bold outline-none" /></div></label><label><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Desde</span><input type="date" value={dateFrom} onChange={event => { setDateFrom(event.target.value); setPage(1); }} className="w-full rounded-2xl border px-3 py-3 text-sm font-bold" /></label><label><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Hasta</span><input type="date" value={dateTo} onChange={event => { setDateTo(event.target.value); setPage(1); }} className="w-full rounded-2xl border px-3 py-3 text-sm font-bold" /></label><label><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Tienda de ingreso</span><select value={selectedStoreNo} disabled={!canViewAllStores} onChange={event => { setSelectedStoreNo(event.target.value); setPage(1); }} className="w-full rounded-2xl border bg-white px-3 py-3 text-sm font-black disabled:bg-slate-100"><option value="all">Todas las tiendas</option>{storeOptions.map(store => <option key={store.no} value={store.no}>{store.name}</option>)}</select></label><label><span className="mb-1 block text-[11px] font-black uppercase text-slate-500">Estado RMS</span><select value={statusFilter} onChange={event => { setStatusFilter(event.target.value as PurchaseOrderStatus); setPage(1); }} className="w-full rounded-2xl border bg-white px-3 py-3 text-sm font-black"><option value="all">Todos</option><option value="pending">Pendientes</option><option value="closed">Cerradas</option><option value="cancelled">Canceladas</option></select></label><button onClick={() => { setSearchInput(""); setSearch(""); setDateFrom(startOfMonth()); setDateTo(limaDate()); setStatusFilter("all"); setApprovalFilter("all"); if (canViewAllStores) setSelectedStoreNo("all"); setPage(1); }} className="rounded-2xl border px-4 py-3 text-sm font-black hover:bg-slate-50">Limpiar</button></div><p className="mt-3 text-xs text-slate-400">La búsqueda revisa OC, proveedor, ALU/SKU/UPC y coincidencias por los últimos 5 dígitos.</p></section>

      <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />
      <section className="overflow-hidden rounded-3xl border bg-white shadow-sm">{loading ? <div className="grid min-h-[320px] place-items-center"><RefreshCw className="animate-spin text-orange-600" /></div> : rows.length === 0 ? <div className="grid min-h-[320px] place-items-center text-center"><div><ShieldCheck className="mx-auto text-slate-300" size={46} /><p className="mt-3 font-black">No hay órdenes para estos filtros</p><p className="text-sm text-slate-400">Para los aprobadores solo se muestran las rutas que les corresponden.</p></div></div> : <><div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[1320px] border-collapse text-sm"><thead className="bg-slate-950 text-left text-[10px] uppercase tracking-wider text-white"><tr><th className="p-4">OC / RMS</th><th className="p-4">Aprobación</th><th className="p-4">Generada</th><th className="p-4">Tienda</th><th className="p-4">Proveedor</th><th className="p-4">Comprador</th><th className="p-4 text-right">Detalle</th><th className="p-4 text-right">Total</th></tr></thead><tbody className="divide-y">{rows.map(order => { const rms = statusMeta(order.business_status); const approvalState = approvalMeta(order.approval_status); return <tr key={order.erp_po_id} onClick={() => openOrder(order)} className={`cursor-pointer transition hover:bg-orange-50 ${order.can_current_user_act ? "bg-orange-50/60" : ""}`}><td className="p-4"><p className="font-black text-blue-700">{order.po_number}</p><span className={`mt-1 inline-flex rounded-full border px-2 py-1 text-[9px] font-black uppercase ${rms.className}`}>{rms.label}</span></td><td className="p-4"><span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-black uppercase ${approvalState.className}`}>{approvalState.label}</span><p className="mt-1 text-xs font-bold text-slate-600">{tierLabel(order.approval_tier)}{order.approval_version ? ` · V${order.approval_version}` : ""}</p>{order.can_current_user_act ? <p className="mt-1 text-xs font-black text-orange-700">Requiere tu decisión</p> : order.current_step_name ? <p className="mt-1 text-[11px] text-slate-400">Turno: {order.current_step_name}</p> : null}</td><td className="p-4 font-bold">{dateTime(order.po_date)}</td><td className="p-4"><p className="font-black">{order.store_name || order.store_code || order.store_no}</p><p className="text-xs text-slate-400">RMS {order.store_no}</p></td><td className="max-w-[280px] p-4"><p className="font-bold">{order.vendor_name || "Sin proveedor"}</p><p className="text-xs text-slate-400">{order.vendor_code || "—"}</p></td><td className="p-4 text-slate-600">{order.buyer || "—"}</td><td className="p-4 text-right"><p className="font-black">{order.line_count} ítems</p><p className="text-xs text-slate-500">{quantity(order.qty_ordered)} uds.</p></td><td className="p-4 text-right font-black">{money(order.total, currencyCode(order.currency_id))}</td></tr>; })}</tbody></table></div><div className="divide-y lg:hidden">{rows.map(order => { const meta = approvalMeta(order.approval_status); return <button key={order.erp_po_id} onClick={() => openOrder(order)} className={`block w-full p-4 text-left hover:bg-orange-50 ${order.can_current_user_act ? "bg-orange-50" : ""}`}><div className="flex items-start justify-between gap-3"><div><p className="text-lg font-black text-blue-700">OC {order.po_number}</p><p className="mt-1 text-xs font-bold text-slate-500">{dateTime(order.po_date)}</p></div><span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${meta.className}`}>{meta.label}</span></div><p className="mt-3 font-black">{order.vendor_name || "Sin proveedor"}</p><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><p className="text-[9px] font-black uppercase text-slate-400">Tienda</p><p className="font-bold">{order.store_name || order.store_no}</p></div><div><p className="text-[9px] font-black uppercase text-slate-400">Total</p><p className="font-black">{money(order.total, currencyCode(order.currency_id))}</p></div></div>{order.can_current_user_act && <p className="mt-3 rounded-xl bg-orange-100 px-3 py-2 text-xs font-black text-orange-800">Requiere tu decisión</p>}</button>; })}</div></>}</section>
      <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />
    </div>

    {selectedOrder && <OrderDrawer order={selectedOrder} approval={approval} loadingApproval={loadingApproval} lines={lines} loadingLines={loadingLines} linePage={linePage} lineTotal={lineTotal} actionComment={actionComment} acting={acting} replacementNumber={replacementNumber} linkingReplacement={linkingReplacement} onClose={() => setSelectedOrder(null)} onLinePage={changeLinePage} onComment={setActionComment} onAction={actOnApproval} onReplacement={setReplacementNumber} onLinkReplacement={linkReplacement} />}
    {signatureOpen && <SignatureModal rows={signatureRows} loading={signatureLoading} uploading={signatureUploading} onClose={() => setSignatureOpen(false)} onUpload={uploadSignature} />}
  </main>;
}

function OrderDrawer({ order, approval, loadingApproval, lines, loadingLines, linePage, lineTotal, actionComment, acting, replacementNumber, linkingReplacement, onClose, onLinePage, onComment, onAction, onReplacement, onLinkReplacement }: { order: PurchaseOrder; approval: ApprovalDetail | null; loadingApproval: boolean; lines: PurchaseOrderLine[]; loadingLines: boolean; linePage: number; lineTotal: number; actionComment: string; acting: boolean; replacementNumber: string; linkingReplacement: boolean; onClose: () => void; onLinePage: (page: number) => void; onComment: (value: string) => void; onAction: (action: "approve" | "reject") => Promise<void>; onReplacement: (value: string) => void; onLinkReplacement: () => Promise<void> }) {
  return <div className="fixed inset-0 z-50 bg-slate-950/55 p-0 backdrop-blur-sm sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="ml-auto flex h-full w-full max-w-6xl flex-col overflow-hidden bg-slate-50 shadow-2xl sm:rounded-3xl"><div className="border-b bg-white p-4 sm:p-6"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wider text-orange-600">Detalle y ruta de aprobación</p><div className="mt-1 flex flex-wrap items-center gap-3"><h2 className="text-2xl font-black">OC {order.po_number}</h2><span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase ${approvalMeta(approval?.approval_status || order.approval_status).className}`}>{approvalMeta(approval?.approval_status || order.approval_status).label}</span></div><p className="mt-1 text-sm text-slate-500">{order.vendor_name || order.vendor_code || "Sin proveedor"}</p></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl border hover:bg-slate-50"><X size={20} /></button></div></div><div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><InfoCard icon={<CalendarDays className="text-blue-600" size={18} />} label="Generada" value={dateTime(order.po_date)} /><InfoCard icon={<Store className="text-orange-600" size={18} />} label="Debe ingresar" value={order.store_name || order.store_no} /><InfoCard icon={<Truck className="text-violet-600" size={18} />} label="Unidades" value={`${quantity(order.qty_received)} / ${quantity(order.qty_ordered)}`} /><InfoCard icon={<PackageSearch className="text-emerald-600" size={18} />} label="Ítems" value={String(order.line_count)} /><div className="col-span-2 rounded-2xl border bg-slate-950 p-3 text-white lg:col-span-1"><p className="text-[10px] font-black uppercase text-slate-400">Total OC</p><p className="mt-2 text-xl font-black">{money(order.total, currencyCode(order.currency_id))}</p></div></div>
    <section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-wider text-orange-600">Control de autorizaciones</p><h3 className="text-lg font-black">Ruta de aprobación</h3></div>{approval && <div className="text-right"><p className="font-black">{tierLabel(approval.approval_tier)} · {approval.currency_code}</p><p className="text-xs text-slate-400">Versión {approval.version} · {money(approval.amount_snapshot, approval.currency_code)}</p></div>}</div>
      {loadingApproval ? <div className="grid min-h-[150px] place-items-center"><RefreshCw className="animate-spin text-orange-600" /></div> : !approval ? <div className="mt-4 rounded-2xl bg-slate-100 p-4 text-sm font-bold text-slate-500">Esta OC pertenece al historial anterior a la activación del flujo automático.</div> : <>
        {(approval.replaces_po_number || approval.replaced_by_po_number) && <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-3 text-sm font-bold text-violet-800"><Link2 className="mr-2 inline" size={16} />{approval.replaces_po_number ? `Reemplaza la OC ${approval.replaces_po_number}` : `Fue reemplazada por la OC ${approval.replaced_by_po_number}`}</div>}
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{approval.steps.map(step => <div key={step.id} className={`rounded-2xl border p-3 ${step.status === "approved" ? "border-emerald-200 bg-emerald-50" : step.status === "rejected" ? "border-red-200 bg-red-50" : step.status === "pending" ? "border-orange-300 bg-orange-50 ring-1 ring-orange-200" : "bg-slate-50"}`}><div className="flex items-center justify-between"><span className="grid h-7 w-7 place-items-center rounded-full bg-white text-xs font-black shadow-sm">{step.step_order}</span>{step.status === "approved" ? <CheckCircle2 className="text-emerald-600" size={19} /> : step.status === "rejected" ? <XCircle className="text-red-600" size={19} /> : step.status === "pending" ? <Clock3 className="text-orange-600" size={19} /> : <div className="h-3 w-3 rounded-full bg-slate-300" />}</div><p className="mt-3 text-[10px] font-black uppercase text-slate-400">{step.role_label || roleLabel(step.role_key)}</p><p className="font-black">{step.approver_name}</p><p className="mt-1 text-xs text-slate-500">{step.status === "approved" ? `Aprobó ${dateTime(step.acted_at)}` : step.status === "rejected" ? `Rechazó ${dateTime(step.acted_at)}` : step.status === "pending" ? "Esperando decisión" : "Espera aprobación anterior"}</p>{step.comment && <p className="mt-2 rounded-lg bg-white/80 p-2 text-xs">{step.comment}</p>}</div>)}</div>
        {approval.rejected_comment && <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4"><p className="text-xs font-black uppercase text-red-600">Motivo del rechazo</p><p className="mt-1 font-bold text-red-900">{approval.rejected_comment}</p></div>}
        {approval.can_current_user_act && <div className="mt-4 rounded-2xl border-2 border-orange-200 bg-orange-50 p-4"><p className="font-black text-orange-900">Esta decisión te corresponde ahora</p><textarea value={actionComment} onChange={event => onComment(event.target.value)} rows={2} placeholder="Comentario opcional al aprobar; obligatorio al rechazar" className="mt-3 w-full rounded-xl border bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-orange-400" /><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => void onAction("approve")} disabled={acting} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50"><CheckCircle2 size={18} />Aprobar y enviar al siguiente</button><button onClick={() => void onAction("reject")} disabled={acting} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50"><XCircle size={18} />Rechazar</button></div></div>}
        {approval.can_link_replacement && <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="font-black text-violet-900">Relacionar nueva OC de reemplazo</p><p className="mt-1 text-xs text-violet-700">La OC rechazada conserva su historial. La nueva usará Jefe de Finanzas → Líder de Tesorería.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={replacementNumber} onChange={event => onReplacement(event.target.value)} placeholder="Número completo de la nueva OC" className="min-w-0 flex-1 rounded-xl border bg-white px-3 py-3 text-sm font-bold" /><button onClick={() => void onLinkReplacement()} disabled={linkingReplacement || !replacementNumber.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"><Link2 size={17} />Vincular reemplazo</button></div></div>}
        <details className="mt-4 rounded-2xl border bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-black"><History className="mr-2 inline" size={16} />Historial de la ruta ({approval.events.length})</summary><div className="mt-3 space-y-2">{approval.events.map(event => <div key={event.id} className="rounded-xl bg-white p-3 text-xs"><div className="flex justify-between gap-3"><p className="font-black">{event.actor_name || "Sistema"} · {event.event_type.replaceAll("_", " ")}</p><p className="shrink-0 text-slate-400">{dateTime(event.created_at)}</p></div>{event.comment && <p className="mt-1 text-slate-600">{event.comment}</p>}</div>)}</div></details>
      </>}
    </section>
    <Pager page={linePage} total={lineTotal} pageSize={LINE_PAGE_SIZE} onPage={onLinePage} />
    <div className="overflow-hidden rounded-2xl border bg-white">{loadingLines ? <div className="grid min-h-[260px] place-items-center"><RefreshCw className="animate-spin text-orange-600" /></div> : lines.length === 0 ? <div className="p-12 text-center text-sm font-bold text-slate-400">Sin artículos sincronizados.</div> : <><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[900px] text-sm"><thead className="bg-slate-900 text-left text-[10px] uppercase tracking-wider text-white"><tr><th className="p-3">Código</th><th className="p-3">Descripción</th><th className="p-3">UM</th><th className="p-3 text-right">Pedido</th><th className="p-3 text-right">Recibido</th><th className="p-3 text-right">Pendiente</th><th className="p-3 text-right">Costo</th><th className="p-3 text-right">Total costo</th></tr></thead><tbody className="divide-y">{lines.map(line => <tr key={line.line_id}><td className="p-3"><p className="font-black text-blue-700">{line.product_code}</p><p className="text-[11px] text-slate-400">SKU {line.sku || "—"}{line.barcode ? ` · UPC ${line.barcode}` : ""}</p></td><td className="max-w-[360px] p-3 font-bold">{line.description || "—"}</td><td className="p-3">{line.unit || "—"}</td><td className="p-3 text-right font-black">{quantity(line.qty_ordered)}</td><td className="p-3 text-right font-black text-emerald-700">{quantity(line.qty_received)}</td><td className="p-3 text-right font-black text-amber-700">{quantity(line.qty_due)}</td><td className="p-3 text-right">{money(line.cost, currencyCode(order.currency_id))}</td><td className="p-3 text-right font-black">{money(line.ext_cost, currencyCode(order.currency_id))}</td></tr>)}</tbody></table></div><div className="divide-y md:hidden">{lines.map(line => <div key={line.line_id} className="p-4"><p className="font-black text-blue-700">{line.product_code}</p><p className="mt-1 text-sm font-bold">{line.description || "—"}</p><p className="mt-1 text-xs text-slate-400">SKU {line.sku || "—"} · UM {line.unit || "—"}</p></div>)}</div></>}</div>
    <Pager page={linePage} total={lineTotal} pageSize={LINE_PAGE_SIZE} onPage={onLinePage} />
  </div></div></div>;
}

function InfoCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="rounded-2xl border bg-white p-3">{icon}<p className="mt-2 text-[10px] font-black uppercase text-slate-400">{label}</p><p className="text-sm font-black">{value}</p></div>; }

function SignatureModal({ rows, loading, uploading, onClose, onUpload }: { rows: SignatureApprover[]; loading: boolean; uploading: string | null; onClose: () => void; onUpload: (userId: string, file: File | null) => Promise<void> }) {
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-3 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-3xl bg-slate-100 shadow-2xl"><div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-white p-5"><div><p className="text-xs font-black uppercase tracking-wider text-orange-600">Configuración administrativa</p><h2 className="text-2xl font-black">Firmas digitales de aprobadores</h2><p className="mt-1 text-sm text-slate-500">Archivos privados usados al generar la OC aprobada.</p></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl border"><X size={19} /></button></div><div className="space-y-4 p-5"><div className="grid gap-4 rounded-3xl border border-blue-200 bg-blue-50 p-4 md:grid-cols-[1fr_320px]"><div><p className="font-black text-blue-950">Así debes enviar cada firma</p><ul className="mt-2 space-y-1 text-sm text-blue-900"><li>• PNG con fondo transparente.</li><li>• Recomendado: 1000 × 400 px; mínimo 300 × 100 px.</li><li>• Máximo 2 MB, sin nombre impreso, sello, marco ni fondo blanco.</li><li>• Ejemplo: <b>firma-giancarlo-mendoza.png</b>.</li></ul></div><div className="rounded-2xl border-2 border-dashed border-blue-300 bg-white p-4 text-center"><p className="text-[10px] font-black uppercase text-slate-400">Ejemplo visual</p><p className="mt-3 -rotate-3 font-serif text-3xl italic text-slate-800">Firma manuscrita</p><p className="mt-2 text-[10px] text-slate-400">Solo el trazo, fondo transparente</p></div></div>{loading ? <div className="grid min-h-[260px] place-items-center"><RefreshCw className="animate-spin text-orange-600" /></div> : <div className="grid gap-3 md:grid-cols-2">{rows.map(row => <div key={row.user_id} className="rounded-2xl border bg-white p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase text-slate-400">{roleLabel(row.role_key)}</p><p className="text-lg font-black">{row.user?.full_name || row.user_id}</p><p className="text-xs text-slate-400">Usuario {row.user?.username || "—"}</p></div>{row.signature ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-black uppercase text-emerald-700">Configurada</span> : <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black uppercase text-amber-700">Pendiente</span>}</div><div className="mt-3 grid min-h-[110px] place-items-center rounded-xl border-2 border-dashed bg-slate-50 p-3">{row.signature?.preview_url ? <img src={row.signature.preview_url} alt={`Firma de ${row.user?.full_name || "aprobador"}`} className="max-h-24 max-w-full object-contain" /> : <div className="text-center text-xs font-bold text-slate-400"><FileSignature className="mx-auto mb-2" />Sin firma cargada</div>}</div><div className="mt-3 flex items-center justify-between gap-3"><div className="min-w-0 text-[10px] text-slate-400">{row.signature ? <><p className="truncate">{row.signature.original_filename}</p><p>Actualizada {dateTime(row.signature.updated_at)}</p></> : <p>PNG transparente</p>}</div><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white"><Upload size={15} />{uploading === row.user_id ? "Subiendo..." : row.signature ? "Reemplazar" : "Subir firma"}<input type="file" accept="image/png" disabled={uploading !== null} className="hidden" onChange={event => { const file = event.target.files?.[0] || null; event.currentTarget.value = ""; void onUpload(row.user_id, file); }} /></label></div></div>)}</div>}<div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertTriangle className="shrink-0" size={20} /><p>Al reemplazar una firma, los PDF ya emitidos conservarán su evidencia y hash. La nueva firma se usará únicamente en documentos generados después del cambio.</p></div></div></div></div>;
}
