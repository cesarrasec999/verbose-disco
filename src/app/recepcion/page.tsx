"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, ChevronLeft, Home, LogOut, Package,
  Pencil, Printer, QrCode, RefreshCw, ScanLine, Trash2, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { endSingleDeviceSession, readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { cleanCode, fullProductCode, mappedProductCodeCandidates } from "@/features/ciclicos/utils";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ReceptionRequest = {
  id: string;
  erp_inv_request_id: string;
  inv_request_no: string | null;
  doc_number: string | null;
  status_code: string | null;
  request_date: string | null;
  creation_date: string | null;
  destination_store_code: string;
  destination_store_name: string | null;
  source_store_code: string;
  source_store_name: string | null;
  reason: string | null;
  notes: string | null;
  line_count: number;
  qty_requested_total: number;
  qty_pending_total: number;
  reception_status: "pending" | "in_progress" | "completed";
  completed_at: string | null;
  completed_by_name: string | null;
};

type ReceptionRequestGroup = ReceptionRequest & {
  request_ids: string[];
  transfer_count: number;
  child_requests: ReceptionRequest[];
};

type ReceptionLine = {
  id: string;
  request_id: string;
  line_id: number;
  sku: string | null;
  product_code: string;
  barcode: string | null;
  description: string | null;
  unit: string | null;
  qty_requested: number;
  qty_pending: number;
};

type ReceptionScan = {
  id: string;
  request_id: string;
  line_id: string;
  operator_id: string | null;
  operator_name: string | null;
  product_code: string;
  scanned_code: string | null;
  qty: number;
  notes: string | null;
  created_at: string;
};

type Html5QrLike = {
  start: (cam: { facingMode: string }, cfg: { fps: number; qrbox: { width: number; height: number } }, onSuccess: (text: string) => void, onError?: () => void) => Promise<unknown>;
  stop: () => Promise<unknown>;
  clear: () => void | Promise<unknown>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function num(v: unknown) { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function fmt(n: number) { return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""); }
function normalize(v: string | null | undefined) { return String(v || "").trim().toUpperCase(); }
const SUPPLY_REASONS = new Set(["ABASTECIMIENTO", "ABASTECIMIENTO URGENTE"]);
const REQUEST_CACHE_PREFIX = "recepcion_requests_cache:";
const REQUEST_CACHE_TTL_MS = 20 * 60 * 1000;

type RequestCachePayload = {
  savedAt: number;
  rows: ReceptionRequest[];
};

function normalizeReason(v: string | null | undefined) { return normalize(v).replace(/\s+/g, " "); }
function isSupplyReason(v: string | null | undefined) { return SUPPLY_REASONS.has(normalizeReason(v)); }
function readRequestCache(key: string): ReceptionRequest[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(REQUEST_CACHE_PREFIX + key) || "") as RequestCachePayload;
    if (!parsed?.savedAt || !Array.isArray(parsed.rows)) return [];
    if (Date.now() - parsed.savedAt > REQUEST_CACHE_TTL_MS) return [];
    return parsed.rows;
  } catch {
    return [];
  }
}
function readAnyRequestCache(userId: string | undefined): ReceptionRequest[] {
  if (typeof window === "undefined" || !userId) return [];
  let best: RequestCachePayload | null = null;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) || "";
    if (!key.startsWith(REQUEST_CACHE_PREFIX + userId + ":")) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "") as RequestCachePayload;
      if (!parsed?.savedAt || !Array.isArray(parsed.rows) || parsed.rows.length === 0) continue;
      if (Date.now() - parsed.savedAt > REQUEST_CACHE_TTL_MS) continue;
      if (!best || parsed.savedAt > best.savedAt) best = parsed;
    } catch {}
  }
  return best?.rows || [];
}
function writeRequestCache(key: string, rows: ReceptionRequest[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(REQUEST_CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), rows } satisfies RequestCachePayload));
}
function rqKey(req: ReceptionRequest) { return req.doc_number || req.inv_request_no || req.erp_inv_request_id; }
function groupedStatus(items: ReceptionRequest[]): ReceptionRequest["reception_status"] {
  if (items.length > 0 && items.every(item => item.reception_status === "completed")) return "completed";
  if (items.some(item => item.reception_status === "in_progress" || item.reception_status === "completed")) return "in_progress";
  return "pending";
}
function buildRequestGroups(items: ReceptionRequest[]): ReceptionRequestGroup[] {
  const grouped = new Map<string, ReceptionRequest[]>();
  for (const item of items) {
    const key = normalize(rqKey(item));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  return [...grouped.values()].map(group => {
    const sorted = [...group].sort((a, b) =>
      String(b.creation_date || b.request_date || "").localeCompare(String(a.creation_date || a.request_date || ""))
    );
    const base = sorted[0];
    return {
      ...base,
      id: sorted.map(item => item.id).join("|"),
      erp_inv_request_id: sorted.map(item => item.erp_inv_request_id).join(", "),
      line_count: sorted.reduce((sum, item) => sum + num(item.line_count), 0),
      qty_requested_total: sorted.reduce((sum, item) => sum + num(item.qty_requested_total), 0),
      qty_pending_total: sorted.reduce((sum, item) => sum + num(item.qty_pending_total), 0),
      reception_status: groupedStatus(sorted),
      completed_by_name: sorted.every(item => item.reception_status === "completed")
        ? sorted.find(item => item.completed_by_name)?.completed_by_name || null
        : null,
      request_ids: sorted.map(item => item.id),
      transfer_count: sorted.length,
      child_requests: sorted,
    };
  }).sort((a, b) =>
    String(b.creation_date || b.request_date || "").localeCompare(String(a.creation_date || a.request_date || ""))
  );
}
function dateShort(v: string | null) { return v ? new Date(v).toLocaleDateString("es-PE") : "-"; }
function timeShort(v: string | null) {
  if (!v) return "-";
  return new Date(v).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

function diffClass(d: number) {
  if (d === 0) return "text-emerald-700 font-black";
  if (d > 0)  return "text-blue-700 font-black";
  return "text-red-600 font-black";
}
function diffLabel(d: number) {
  if (d === 0) return "OK";
  return (d > 0 ? "+" : "") + fmt(d);
}

function ReasonBadge({ reason }: { reason: string | null }) {
  const isUrgente = /urgente/i.test(reason || "");
  return (
    <span className={`text-[10px] font-black uppercase tracking-widest ${isUrgente ? "text-amber-600" : "text-teal-600"}`}>
      {reason || "ABASTECIMIENTO"}
    </span>
  );
}

function StatusBadge({ status }: { status: ReceptionRequest["reception_status"] }) {
  if (status === "completed")
    return <span className="rounded-full bg-emerald-100 text-emerald-700 text-xs font-black px-2.5 py-0.5">Completado</span>;
  if (status === "in_progress")
    return <span className="rounded-full bg-teal-100 text-teal-700 text-xs font-black px-2.5 py-0.5">En proceso</span>;
  return <span className="rounded-full bg-slate-100 text-slate-500 text-xs font-black px-2.5 py-0.5">Pendiente</span>;
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default function RecepcionPage() {
  const [user, setUser]         = useState<CyclicUser | null>(null);
  const [stores, setStores]     = useState<Store[]>([]);
  const [requests, setRequests] = useState<ReceptionRequest[]>([]);
  const [lines, setLines]       = useState<ReceptionLine[]>([]);
  const [scans, setScans]       = useState<ReceptionScan[]>([]);
  const [selected, setSelected] = useState<ReceptionRequestGroup | null>(null);
  const [view, setView]         = useState<"list" | "detail">("list");
  const [listPanel, setListPanel] = useState<"recepcion" | "resumen">("recepcion");
  const [ready, setReady]       = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [message, setMessage]   = useState("");

  // Filtros lista
  const [storeFilter, setStoreFilter]   = useState("all");
  const [search, setSearch]             = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "in_progress" | "completed">("all");

  // Escaneo
  const [scanProduct, setScanProduct]   = useState("");
  const [activeLine, setActiveLine]     = useState<ReceptionLine | null>(null);
  const [editQty, setEditQty]           = useState(1);
  const [editNotes, setEditNotes]       = useState("");

  // Edición de scan
  const [editingScanId, setEditingScanId]   = useState("");
  const [editScanQty, setEditScanQty]       = useState("");
  const [editScanNotes, setEditScanNotes]   = useState("");

  // Escáner
  const [scannerTarget, setScannerTarget]   = useState<"product" | null>(null);
  const [scannerRunning, setScannerRunning] = useState(false);
  const scannerRef    = useRef<Html5QrLike | null>(null);
  const scanHandled   = useRef(false);
  const loadSeq       = useRef(0);
  const emptyRetryTimer = useRef<number | null>(null);
  const scannerContainerId = "recepcion-scanner";
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const canViewAllStores = useMemo(() =>
    user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador" || user?.can_access_all_stores,
  [user]);
  const canViewSummary = canViewAllStores;
  const canDeleteRequests = user?.role === "Administrador";

  const storeCodes = useCallback((store: Store | null | undefined) => {
    return [...new Set([store?.code, store?.erp_sede].filter(Boolean).map(code => String(code).trim()))];
  }, []);

  const selectedStoreCodes = useCallback((value: string) => {
    if (!value || value === "all") return [];
    const store = stores.find(item => storeCodes(item).includes(value));
    return storeCodes(store).length > 0 ? storeCodes(store) : [value];
  }, [storeCodes, stores]);

  const requestScopeKey = useCallback(() => {
    if (!user) return "anonymous";
    if (canViewAllStores) {
      const codes = storeFilter === "all" ? ["all"] : selectedStoreCodes(storeFilter);
      return `${user.id}:admin:${codes.sort().join("+")}`;
    }
    const store = stores.find(item => item.id === user.store_id);
    const codes = storeCodes(store);
    return `${user.id}:store:${(codes.length > 0 ? codes : [user.store_id || "none"]).sort().join("+")}`;
  }, [canViewAllStores, selectedStoreCodes, storeCodes, storeFilter, stores, user]);

  const applyRequests = useCallback((rows: ReceptionRequest[]) => {
    setRequests(rows);
    writeRequestCache(requestScopeKey(), rows);
  }, [requestScopeKey]);

  const updateRequests = useCallback((updater: (prev: ReceptionRequest[]) => ReceptionRequest[]) => {
    setRequests(prev => {
      const next = updater(prev);
      writeRequestCache(requestScopeKey(), next);
      return next;
    });
  }, [requestScopeKey]);

  const scheduleEmptyRetry = useCallback(() => {
    if (emptyRetryTimer.current !== null) return;
    emptyRetryTimer.current = window.setTimeout(() => {
      emptyRetryTimer.current = null;
      void loadRequests();
    }, 4000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showMsg = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 4000);
  }, []);

  // ─── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "reception")) { window.location.replace("/"); return; }
    Promise.resolve().then(() => { if (!cancelled) setUser(stored); });
    supabase.from("stores").select("id,code,name,erp_sede,is_active").eq("is_active", true).order("name")
      .then(({ data }) => {
        if (cancelled) return;
        setStores((data || []) as Store[]);
        setReady(true);
      });
    return () => {
      cancelled = true;
      if (emptyRetryTimer.current !== null) window.clearTimeout(emptyRetryTimer.current);
    };
  }, []);

  useEffect(() => { if (ready && user) void loadRequests(); }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && user) void loadRequests(); }, [storeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cargar requerimientos ─────────────────────────────────────────────────

  async function loadRequests() {
    const seq = ++loadSeq.current;
    const scopeKey = requestScopeKey();
    const cachedRows = readRequestCache(scopeKey);
    const fallbackCachedRows = cachedRows.length > 0 ? cachedRows : readAnyRequestCache(user?.id);
    if (requests.length === 0 && cachedRows.length > 0) setRequests(cachedRows);
    else if (requests.length === 0 && fallbackCachedRows.length > 0) setRequests(fallbackCachedRows);
    setLoading(true);
    try {
      let query = supabase
        .from("reception_requests")
        .select("*")
        .eq("status_code", "T")
        .order("creation_date", { ascending: false })
        .limit(1000);

      if (canViewAllStores && storeFilter !== "all") {
        const codes = selectedStoreCodes(storeFilter);
        if (codes.length > 0) query = query.or(codes.map(code => `destination_store_code.eq.${code}`).join(","));
      } else if (!canViewAllStores && user?.store_id) {
        const store = stores.find(s => s.id === user!.store_id);
        const codes = storeCodes(store);
        if (codes.length > 0) query = query.or(codes.map(code => `destination_store_code.eq.${code}`).join(","));
      }

      const { data, error } = await query;
      if (error) throw error;
      if (seq !== loadSeq.current) return;
      const nextRows = ((data || []) as ReceptionRequest[]).filter(req => isSupplyReason(req.reason));
      if (nextRows.length === 0) {
        scheduleEmptyRetry();
        if (requests.length > 0) return;
        if (fallbackCachedRows.length > 0) setRequests(fallbackCachedRows);
        return;
      }
      if (emptyRetryTimer.current !== null) {
        window.clearTimeout(emptyRetryTimer.current);
        emptyRetryTimer.current = null;
      }
      applyRequests(nextRows);
    } catch (e: any) {
      if (seq === loadSeq.current) showMsg("Error cargando requerimientos: " + e.message);
    }
    finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  // ─── Abrir requerimiento ───────────────────────────────────────────────────

  async function openRequest(req: ReceptionRequestGroup) {
    setSelected(req);
    setView("detail");
    setActiveLine(null);
    setScanProduct("");
    setLoading(true);
    try {
      const [{ data: lineData, error: lineErr }, { data: scanData }] = await Promise.all([
        supabase.from("reception_request_lines").select("*").in("request_id", req.request_ids).order("line_id"),
        supabase.from("reception_scans").select("*").in("request_id", req.request_ids).order("created_at"),
      ]);
      if (lineErr) throw lineErr;
      setLines((lineData || []) as ReceptionLine[]);
      setScans((scanData || []) as ReceptionScan[]);
    } catch (e: any) { showMsg("Error cargando líneas: " + e.message); }
    finally { setLoading(false); }
  }

  async function reloadScans(requestIds: string[]) {
    const { data } = await supabase.from("reception_scans").select("*").in("request_id", requestIds).order("created_at");
    setScans((data || []) as ReceptionScan[]);
  }

  // ─── Escáner ───────────────────────────────────────────────────────────────

  const closeScanner = useCallback(async () => {
    try { await scannerRef.current?.stop(); await scannerRef.current?.clear(); } catch {}
    scannerRef.current = null;
    scanHandled.current = false;
    setScannerRunning(false);
    setScannerTarget(null);
  }, []);

  useEffect(() => {
    if (!scannerTarget) return;
    let cancelled = false;
    async function start() {
      try {
        scanHandled.current = false;
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        const qr = new Html5Qrcode(scannerContainerId, {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93,  Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.EAN_13,   Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.ITF,      Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,    Html5QrcodeSupportedFormats.QR_CODE,
          ],
        }) as Html5QrLike;
        scannerRef.current = qr;
        await qr.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 180 } },
          (decoded) => {
            if (scanHandled.current) return;
            scanHandled.current = true;
            setScanProduct(decoded.trim());
            void closeScanner();
            void handleScan(decoded.trim());
          },
          undefined
        );
        if (!cancelled) setScannerRunning(true);
      } catch (err) {
        showMsg("No se pudo abrir la cámara: " + (err instanceof Error ? err.message : String(err)));
        void closeScanner();
      }
    }
    void start();
    return () => { cancelled = true; void closeScanner(); };
  }, [scannerTarget, closeScanner]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Buscar línea por código ───────────────────────────────────────────────

  async function findLine(code: string): Promise<ReceptionLine | null> {
    const raw = code.trim();
    if (!raw) return null;

    const candidates = [...new Set([
      raw, cleanCode(raw), fullProductCode(raw),
    ].filter(Boolean).map(v => v.trim().toUpperCase()))];

    // Búsqueda directa en product_code / sku / barcode de las líneas cargadas
    const direct = lines.find(l =>
      candidates.some(c =>
        c === normalize(l.product_code) ||
        c === normalize(l.sku) ||
        c === normalize(l.barcode)
      )
    );
    if (direct) return direct;

    // Lookup en codigos_barra (UPC / ALU)
    try {
      const [{ data: byUpc }, { data: byAlu }] = await Promise.all([
        supabase.from("codigos_barra").select("codsap,upc,alu").in("upc", candidates).limit(20),
        supabase.from("codigos_barra").select("codsap,upc,alu").in("alu", candidates).limit(20),
      ]);
      const mapped = new Set(
        [...(byUpc || []), ...(byAlu || [])]
          .flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>))
          .map(v => v.trim().toUpperCase())
      );
      return lines.find(l =>
        mapped.has(normalize(l.product_code)) || mapped.has(normalize(l.sku))
      ) || null;
    } catch { return null; }
  }

  async function handleScan(code: string) {
    if (!code.trim()) return;
    const found = await findLine(code);
    if (found) {
      setActiveLine(found);
      setEditQty(1);
      setEditNotes("");
      setTimeout(() => {
        lineRefs.current[found.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    } else {
      showMsg(`Código "${code}" no encontrado en este requerimiento.`);
    }
  }

  // ─── Guardar scan ──────────────────────────────────────────────────────────

  async function saveScan() {
    if (!activeLine || !selected || !user) return;
    if (editQty <= 0) { showMsg("La cantidad debe ser mayor a 0."); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from("reception_scans").insert({
        request_id:    activeLine.request_id,
        line_id:       activeLine.id,
        operator_id:   user.id,
        operator_name: user.full_name,
        product_code:  activeLine.product_code,
        scanned_code:  scanProduct.trim() || null,
        qty:           editQty,
        notes:         editNotes.trim() || null,
      });
      if (error) throw error;

      // Pasar a in_progress si estaba pendiente
      await supabase.from("reception_requests").update({
        reception_status: "in_progress",
        updated_at: new Date().toISOString(),
      }).eq("id", activeLine.request_id).eq("reception_status", "pending");

      setSelected(prev => prev ? { ...prev, reception_status: prev.reception_status === "pending" ? "in_progress" : prev.reception_status } : null);
      updateRequests(prev => prev.map(r => r.id === activeLine.request_id && r.reception_status === "pending" ? { ...r, reception_status: "in_progress" } : r));

      setScanProduct("");
      setActiveLine(null);
      await reloadScans(selected.request_ids);
      showMsg("Recepción registrada.");
    } catch (e: any) { showMsg("Error guardando: " + e.message); }
    finally { setSaving(false); }
  }

  // ─── Editar scan ───────────────────────────────────────────────────────────

  async function saveEditScan() {
    if (!editingScanId || !user) return;
    const qty = num(editScanQty);
    if (qty <= 0) { showMsg("La cantidad debe ser mayor a 0."); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from("reception_scans")
        .update({ qty, notes: editScanNotes.trim() || null, updated_at: new Date().toISOString() })
        .eq("id", editingScanId);
      if (error) throw error;
      setEditingScanId(""); setEditScanQty(""); setEditScanNotes("");
      if (selected) await reloadScans(selected.request_ids);
      showMsg("Registro actualizado.");
    } catch (e: any) { showMsg("Error editando: " + e.message); }
    finally { setSaving(false); }
  }

  // ─── Eliminar scan ─────────────────────────────────────────────────────────

  async function deleteScan(scan: ReceptionScan) {
    if (!window.confirm(`¿Eliminar este registro de ${fmt(num(scan.qty))} unidades?`)) return;
    const { error } = await supabase.from("reception_scans").delete().eq("id", scan.id);
    if (error) { showMsg("Error eliminando: " + error.message); return; }
    if (selected) await reloadScans(selected.request_ids);
    showMsg("Registro eliminado.");
  }

  // ─── Marcar completado ─────────────────────────────────────────────────────

  async function markComplete() {
    if (!selected || !user) return;
    if (!window.confirm("¿Marcar este requerimiento como completado?")) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("reception_requests").update({
        reception_status:  "completed",
        completed_at:      new Date().toISOString(),
        completed_by_id:   user.id,
        completed_by_name: user.full_name,
        updated_at:        new Date().toISOString(),
      }).in("id", selected.request_ids);
      if (error) throw error;
      setSelected(prev => prev ? { ...prev, reception_status: "completed", completed_by_name: user.full_name } : null);
      updateRequests(prev => prev.map(r => selected.request_ids.includes(r.id) ? { ...r, reception_status: "completed", completed_by_name: user.full_name } : r));
      showMsg("Requerimiento completado.");
    } catch (e: any) { showMsg("Error: " + e.message); }
    finally { setSaving(false); }
  }

  async function deleteRequestGroup(req: ReceptionRequestGroup) {
    if (!canDeleteRequests) return;
    const label = req.doc_number || req.inv_request_no || req.erp_inv_request_id;
    const confirmed = window.confirm(`¿Eliminar el requerimiento ${label}? Se eliminarán ${req.transfer_count} transferencia${req.transfer_count !== 1 ? "s" : ""} agrupada${req.transfer_count !== 1 ? "s" : ""} y sus líneas.`);
    if (!confirmed) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("reception_requests").delete().in("id", req.request_ids);
      if (error) throw error;
      updateRequests(prev => prev.filter(item => !req.request_ids.includes(item.id)));
      showMsg("Requerimiento eliminado.");
    } catch (e: any) {
      showMsg("Error eliminando requerimiento: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── Reporte imprimible ────────────────────────────────────────────────────

  function printReport() {
    if (!selected) return;
    const lineRows = lines.map(line => {
      const lineScans = scans.filter(s => s.line_id === line.id);
      const received = lineScans.reduce((sum, s) => sum + num(s.qty), 0);
      const diff = received - num(line.qty_requested);
      return { line, received, diff, lineScans };
    });
    const totalReq = lineRows.reduce((s, r) => s + num(r.line.qty_requested), 0);
    const totalRec = lineRows.reduce((s, r) => s + r.received, 0);
    const totalDiff = totalRec - totalReq;
    const ok = lineRows.filter(r => r.diff === 0).length;
    const sobrantes = lineRows.filter(r => r.diff > 0).length;
    const faltantes = lineRows.filter(r => r.diff < 0).length;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>Recepción ${selected.doc_number || selected.inv_request_no}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#111}
      h2{font-size:14px;margin:0 0 4px}
      .info{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;border:1px solid #ccc;padding:8px;border-radius:6px}
      .info-item label{font-weight:bold;display:block;color:#555;font-size:9px;text-transform:uppercase}
      .stats{display:flex;gap:10px;margin-bottom:10px}
      .stat{background:#f1f5f9;border-radius:6px;padding:5px 10px;font-size:10px;font-weight:bold;text-align:center}
      .stat span{display:block;font-size:16px;font-weight:900}
      .stat.ok span{color:#047857}.stat.over span{color:#1d4ed8}.stat.under span{color:#dc2626}
      table{width:100%;border-collapse:collapse}
      th{background:#1e293b;color:white;padding:5px 4px;text-align:left;font-size:10px}
      td{padding:4px;border-bottom:1px solid #e2e8f0;font-size:10px;vertical-align:top}
      tr:nth-child(even) td{background:#f8fafc}
      .ok{color:#047857;font-weight:bold}.over{color:#1d4ed8;font-weight:bold}.under{color:#dc2626;font-weight:bold}
      .totals td{font-weight:bold;border-top:2px solid #1e293b}
      .signatures{margin-top:32px;display:flex;justify-content:space-around}
      .sign{text-align:center}
      .sign-line{border-top:1px solid #000;margin-top:48px;padding-top:4px;font-size:10px;font-weight:bold;width:180px}
      .sign-sub{font-size:9px;color:#555;margin-top:2px}
      @media print{body{margin:10px}}
    </style></head><body>
    <h2>Reporte de Recepción</h2>
    <p style="color:#555;font-size:10px;margin:0 0 8px">Generado: ${new Date().toLocaleString("es-PE")} | Por: ${selected.completed_by_name || user?.full_name || "-"}</p>
    <div class="info">
      <div class="info-item"><label>Motivo</label>${selected.reason || "Abastecimiento"}</div>
      <div class="info-item"><label>Documento</label>${selected.doc_number || selected.inv_request_no || "-"}</div>
      <div class="info-item"><label>Origen (CD)</label>${selected.source_store_name || selected.source_store_code}</div>
      <div class="info-item"><label>Tienda destino</label>${selected.destination_store_name || selected.destination_store_code}</div>
      <div class="info-item"><label>Fecha requerimiento</label>${dateShort(selected.creation_date)}</div>
      <div class="info-item"><label>Fecha en tránsito</label>${dateShort(selected.request_date)}</div>
    </div>
    <div class="stats">
      <div class="stat"><label>Códigos</label><span>${lineRows.length}</span></div>
      <div class="stat ok"><label>OK</label><span>${ok}</span></div>
      <div class="stat over"><label>Sobrantes</label><span>${sobrantes}</span></div>
      <div class="stat under"><label>Faltantes</label><span>${faltantes}</span></div>
    </div>
    <table>
      <thead><tr>
        <th>#</th><th>Código</th><th>Descripción</th><th style="font-weight:900">UM</th>
        <th style="text-align:right">Enviado</th>
        <th style="text-align:right">Recibido</th>
        <th style="text-align:right">Dif.</th>
        <th>Estado</th>
        <th>Observación</th>
      </tr></thead>
      <tbody>
        ${lineRows.map((r, i) => {
          const cls = r.diff === 0 ? "ok" : r.diff > 0 ? "over" : "under";
          const st  = r.diff === 0 ? "OK" : r.diff > 0 ? "SOBRANTE" : "FALTANTE";
          const obs = r.lineScans.filter(s => s.notes).map(s => s.notes).join("; ");
          return `<tr>
            <td>${i + 1}</td>
            <td style="font-weight:900">${r.line.product_code}</td>
            <td>${r.line.description || "-"}</td>
            <td style="font-weight:900">${r.line.unit || "-"}</td>
            <td style="text-align:right">${fmt(num(r.line.qty_requested))}</td>
            <td style="text-align:right;font-weight:900">${fmt(r.received)}</td>
            <td style="text-align:right" class="${cls}">${diffLabel(r.diff)}</td>
            <td class="${cls}">${st}</td>
            <td style="color:#6b7280">${obs}</td>
          </tr>`;
        }).join("")}
      </tbody>
      <tfoot><tr class="totals">
        <td colspan="4">TOTAL</td>
        <td style="text-align:right">${fmt(totalReq)}</td>
        <td style="text-align:right">${fmt(totalRec)}</td>
        <td style="text-align:right" class="${totalDiff === 0 ? "ok" : totalDiff > 0 ? "over" : "under"}">${diffLabel(totalDiff)}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table>
    <div class="signatures">
      <div class="sign"><div class="sign-line">Jefe de Tienda</div><div class="sign-sub">${selected.destination_store_name || selected.destination_store_code}</div></div>
      <div class="sign"><div class="sign-line">Asesor de Almacén</div><div class="sign-sub">CD-GPC</div></div>
    </div>
    </body></html>`;

    const win = window.open("", "_blank");
    if (!win) { showMsg("Permite ventanas emergentes para imprimir."); return; }
    win.document.write(html); win.document.close(); win.focus();
    setTimeout(() => win.print(), 400);
  }

  // ─── Filtros ───────────────────────────────────────────────────────────────

  const requestGroups = useMemo(
    () => buildRequestGroups(requests.filter(r => isSupplyReason(r.reason))),
    [requests]
  );

  const filteredRequests = useMemo(() => requestGroups.filter(r => {
    if (filterStatus !== "all" && r.reception_status !== filterStatus) return false;
    if (!search.trim()) return true;
    return [r.doc_number, r.inv_request_no, r.destination_store_name, r.source_store_name, r.reason, r.erp_inv_request_id]
      .join(" ").toLowerCase().includes(search.toLowerCase());
  }), [requestGroups, filterStatus, search]);

  const destStoreOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const store of stores) {
      const code = store.erp_sede || store.code;
      if (code) map.set(code, store.name || code);
    }
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [stores]);

  const summaryRows = useMemo(() => {
    const grouped = new Map<string, {
      key: string;
      name: string;
      total: number;
      completed: number;
      inProgress: number;
      pending: number;
      lines: number;
      units: number;
    }>();

    for (const req of requestGroups) {
      const key = req.destination_store_code || req.destination_store_name || "SIN_TIENDA";
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name: req.destination_store_name || req.destination_store_code || "Sin tienda",
          total: 0,
          completed: 0,
          inProgress: 0,
          pending: 0,
          lines: 0,
          units: 0,
        });
      }
      const row = grouped.get(key)!;
      row.total += 1;
      row.lines += num(req.line_count);
      row.units += num(req.qty_requested_total);
      if (req.reception_status === "completed") row.completed += 1;
      else if (req.reception_status === "in_progress") row.inProgress += 1;
      else row.pending += 1;
    }

    return [...grouped.values()]
      .map(row => ({
        ...row,
        pct: row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0,
        inProgressPct: row.total > 0 ? Math.round((row.inProgress / row.total) * 100) : 0,
        pendingPct: row.total > 0 ? Math.round((row.pending / row.total) * 100) : 0,
      }))
      .sort((a, b) => b.pct - a.pct || b.total - a.total || a.name.localeCompare(b.name, "es"));
  }, [requestGroups]);

  // Totales por línea desde los scans cargados
  const scanTotalByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scans) m.set(s.line_id, (m.get(s.line_id) || 0) + num(s.qty));
    return m;
  }, [scans]);

  const scansByLine = useMemo(() => {
    const m = new Map<string, ReceptionScan[]>();
    for (const s of scans) {
      if (!m.has(s.line_id)) m.set(s.line_id, []);
      m.get(s.line_id)!.push(s);
    }
    return m;
  }, [scans]);

  const linesScanned = useMemo(() => lines.filter(l => (scanTotalByLine.get(l.id) || 0) > 0).length, [lines, scanTotalByLine]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!ready) {
    return <main className="min-h-screen bg-slate-100 flex items-center justify-center"><p className="text-slate-500 font-black">Cargando...</p></main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 flex flex-col">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"><Home size={18} /></button>
            {view === "detail" && (
              <button onClick={() => { setView("list"); setSelected(null); setLines([]); setScans([]); setActiveLine(null); }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"><ChevronLeft size={18} /></button>
            )}
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-teal-600 text-white">
                <ScanLine size={18} />
              </div>
              <div>
                <h1 className="font-black text-slate-900 text-sm leading-tight">
                  {view === "list" ? "Recepción" : selected?.doc_number || selected?.inv_request_no || "Detalle"}
                </h1>
                <p className="text-[11px] text-slate-400 leading-none">{user?.full_name}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {view === "detail" && (
              <button onClick={printReport} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Imprimir reporte"><Printer size={16} /></button>
            )}
            <button onClick={() => view === "list" ? loadRequests() : (selected ? openRequest(selected) : void 0)} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"><RefreshCw size={16} /></button>
            <button onClick={() => { if (user) void endSingleDeviceSession(user); localStorage.removeItem("cyclic_user"); window.location.replace("/"); }}
              className="flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-black text-slate-600 hover:bg-slate-50">
              <LogOut size={15} /> Salir
            </button>
          </div>
        </div>
      </header>

      {/* ── Mensaje ──────────────────────────────────────────────────────────── */}
      {message && (
        <div className="mx-4 mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">{message}</div>
      )}

      {/* ══════════════ LISTA ════════════════════════════════════════════════ */}
      {view === "list" && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-3">

          {canViewSummary && (
            <div className="grid grid-cols-2 gap-2 rounded-2xl border bg-white p-1 shadow-sm">
              <button
                onClick={() => setListPanel("recepcion")}
                className={`rounded-xl px-3 py-2 text-sm font-black ${listPanel === "recepcion" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Recepción
              </button>
              <button
                onClick={() => setListPanel("resumen")}
                className={`rounded-xl px-3 py-2 text-sm font-black ${listPanel === "resumen" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Resumen
              </button>
            </div>
          )}

          {/* Filtros */}
          <div className="flex flex-wrap gap-2">
            {canViewAllStores && (
              <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)}
                className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black min-w-[160px]">
                <option value="all">Todas las tiendas</option>
                {destStoreOptions.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            )}
            {listPanel === "recepcion" && (
              <>
                <input className="flex-1 min-w-[150px] border rounded-2xl px-4 py-2.5 text-sm bg-white text-slate-900"
                  placeholder="Buscar documento, tienda..."
                  value={search} onChange={e => setSearch(e.target.value)} />
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
                  className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black">
                  <option value="all">Todos</option>
                  <option value="pending">Pendiente</option>
                  <option value="in_progress">En proceso</option>
                  <option value="completed">Completados</option>
                </select>
              </>
            )}
          </div>

          {listPanel === "recepcion" && <p className="text-xs text-slate-400 font-black px-1">{filteredRequests.length} requerimiento{filteredRequests.length !== 1 ? "s" : ""}</p>}
          {listPanel === "resumen" && <p className="text-xs text-slate-400 font-black px-1">{summaryRows.length} tienda{summaryRows.length !== 1 ? "s" : ""}</p>}

          {loading && <p className="text-center py-12 text-slate-400 font-bold">Cargando...</p>}
          {!loading && listPanel === "resumen" && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Avance por tienda</p>
                  <h2 className="text-xl font-black text-slate-950">Recepción de abastecimiento</h2>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] font-black">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">Completado</span>
                  <span className="rounded-full bg-teal-100 px-2.5 py-1 text-teal-700">En proceso</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-500">Pendiente</span>
                </div>
              </div>
              <div className="space-y-4">
                {summaryRows.map(row => (
                  <div key={row.key}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-black text-slate-800">{row.name}</p>
                        <p className="font-bold text-slate-400">{row.total} RQ · {row.lines} líneas · {fmt(row.units)} uds.</p>
                      </div>
                      <span className="shrink-0 text-lg font-black text-slate-950">{row.pct}%</span>
                    </div>
                    <div className="flex h-5 overflow-hidden rounded-full bg-slate-100">
                      <div className="bg-emerald-500" style={{ width: `${row.pct}%` }} title={`${row.completed} completados`} />
                      <div className="bg-teal-500" style={{ width: `${row.inProgressPct}%` }} title={`${row.inProgress} en proceso`} />
                      <div className="bg-slate-300" style={{ width: `${row.pendingPct}%` }} title={`${row.pending} pendientes`} />
                    </div>
                  </div>
                ))}
                {summaryRows.length === 0 && <p className="p-8 text-center text-sm font-bold text-slate-400">Sin datos para mostrar.</p>}
              </div>
            </div>
          )}

          {!loading && listPanel === "recepcion" && filteredRequests.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-black">Sin requerimientos{filterStatus !== "all" ? " en este estado" : ""}</p>
              <p className="text-xs mt-1">Los slips en tránsito aparecerán aquí automáticamente.</p>
            </div>
          )}

          {listPanel === "recepcion" && filteredRequests.map(req => (
            <button key={req.id} onClick={() => openRequest(req)}
              className={`w-full text-left rounded-2xl border p-4 shadow-sm hover:shadow-md transition-all hover:border-teal-400 ${req.reception_status === "in_progress" ? "border-teal-200 bg-white" : "bg-white"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <ReasonBadge reason={req.reason} />
                  <p className="font-black text-slate-900 text-xl leading-tight mt-0.5">{req.doc_number || req.inv_request_no || req.erp_inv_request_id}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{req.source_store_name || req.source_store_code} → {req.destination_store_name || req.destination_store_code}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={req.reception_status} />
                  {canDeleteRequests && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={event => { event.stopPropagation(); void deleteRequestGroup(req); }}
                      onKeyDown={event => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteRequestGroup(req);
                      }}
                      className="grid h-8 w-8 place-items-center rounded-xl border border-red-100 text-red-500 hover:bg-red-50"
                      title="Eliminar requerimiento"
                    >
                      <Trash2 size={14} />
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                {req.creation_date && <span>Requerido: <b className="text-slate-600">{dateShort(req.creation_date)}</b></span>}
                {req.request_date  && <span>En tránsito: <b className="text-teal-600">{dateShort(req.request_date)}</b></span>}
                <span><b className="text-slate-600">{req.line_count}</b> líneas · <b className="text-slate-600">{fmt(req.qty_requested_total)}</b> uds.</span>
                {req.transfer_count > 1 && <span><b className="text-slate-600">{req.transfer_count}</b> transferencias agrupadas</span>}
              </div>
              {req.reception_status === "completed" && req.completed_by_name && (
                <p className="mt-1.5 text-xs text-emerald-600 font-black">✓ {req.completed_by_name}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ══════════════ DETALLE ══════════════════════════════════════════════ */}
      {view === "detail" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-3">

          {/* Info cabecera */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <ReasonBadge reason={selected.reason} />
                <h2 className="font-black text-slate-900 text-2xl leading-tight">{selected.doc_number || selected.inv_request_no}</h2>
                <p className="text-sm text-slate-500">{selected.source_store_name} → {selected.destination_store_name}</p>
              </div>
              <StatusBadge status={selected.reception_status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
              {selected.creation_date && <span>Requerido: <b className="text-slate-600">{dateShort(selected.creation_date)}</b></span>}
              {selected.request_date  && <span>Tránsito: <b className="text-teal-600">{dateShort(selected.request_date)}</b></span>}
              {selected.transfer_count > 1 && <span><b className="text-slate-600">{selected.transfer_count}</b> transferencias agrupadas</span>}
            </div>
            {lines.length > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs font-black text-slate-500 mb-1">
                  <span>{linesScanned} / {lines.length} líneas recepcionadas</span>
                  <span>{Math.round((linesScanned / lines.length) * 100)}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-teal-600 transition-all" style={{ width: `${Math.round((linesScanned / lines.length) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Barra de escaneo / digitación */}
          {selected.reception_status !== "completed" && (
            <div className="rounded-2xl border bg-white p-3 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-500 mb-2">Escanear o digitar código de producto</p>
              <div className="flex gap-2">
                <input
                  className="flex-1 min-w-0 rounded-xl border bg-white px-3 py-2.5 text-sm font-bold text-slate-900"
                  placeholder="Código de producto, UPC o ALU..."
                  value={scanProduct}
                  onChange={e => setScanProduct(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && scanProduct.trim()) void handleScan(scanProduct); }}
                />
                <button onClick={() => { if (scanProduct.trim()) void handleScan(scanProduct); }}
                  className="rounded-xl bg-teal-600 text-white px-4 py-2 font-black text-sm">
                  Buscar
                </button>
                <button onClick={() => setScannerTarget("product")}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-white" title="Abrir escáner">
                  <QrCode size={18} />
                </button>
              </div>
            </div>
          )}

          {/* Escáner modal */}
          {scannerTarget && (
            <div className="fixed inset-0 bg-black/80 z-50 flex flex-col items-center justify-center gap-4 p-4">
              <p className="text-white font-black">Apunta al código del producto</p>
              {!scannerRunning && <p className="text-white/60 text-sm">Iniciando cámara...</p>}
              <div id={scannerContainerId} className="rounded-2xl overflow-hidden w-full max-w-xs" />
              <button onClick={closeScanner} className="rounded-2xl bg-white px-6 py-3 font-black text-slate-900 flex items-center gap-2">
                <X size={16} /> Cancelar
              </button>
            </div>
          )}

          {/* Líneas */}
          {loading ? (
            <p className="text-center py-10 text-slate-400 font-bold">Cargando líneas...</p>
          ) : (
            <div className="space-y-2">
              {lines.map(line => {
                const received = scanTotalByLine.get(line.id) || 0;
                const diff = received - num(line.qty_requested);
                const isActive = activeLine?.id === line.id;
                const lineScans = scansByLine.get(line.id) || [];

                return (
                  <div key={line.id} ref={el => { lineRefs.current[line.id] = el; }}>
                    {/* ── Card de línea ── */}
                    <button
                      onClick={() => {
                        if (isActive) { setActiveLine(null); return; }
                        setActiveLine(line);
                        setEditQty(1);
                        setEditNotes("");
                        setScanProduct("");
                      }}
                      className={`w-full text-left rounded-2xl border p-3 transition-all ${isActive ? "border-teal-500 bg-teal-50 shadow-md" : received > 0 ? "border-emerald-200 bg-white" : "border-slate-200 bg-white"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-black text-slate-900 text-sm">{line.product_code}</p>
                          <p className="text-xs text-slate-500 truncate">{line.description}</p>
                          {/* Unidad de medida en negrita */}
                          {line.unit && (
                            <p className="text-xs font-black text-slate-700 mt-0.5">
                              UM: <span className="text-teal-700">{line.unit}</span>
                            </p>
                          )}
                        </div>
                        <div className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-black border ${diff === 0 && received > 0 ? "bg-emerald-100 text-emerald-700 border-emerald-200" : diff > 0 ? "bg-blue-100 text-blue-700 border-blue-200" : received > 0 ? "bg-red-100 text-red-600 border-red-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
                          {received > 0 ? diffLabel(diff) : "—"}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-3 text-center text-[11px] font-black overflow-hidden rounded-xl border bg-slate-50">
                        <div className="border-r p-1.5">
                          <p className="text-slate-400 font-semibold">Enviado</p>
                          <p>{fmt(num(line.qty_requested))}</p>
                        </div>
                        <div className="border-r p-1.5 bg-teal-50">
                          <p className="text-teal-500 font-semibold">Recibido</p>
                          <p className="text-teal-700">{fmt(received)}</p>
                        </div>
                        <div className="p-1.5">
                          <p className="text-slate-400 font-semibold">Diferencia</p>
                          <p className={received > 0 ? diffClass(diff) : "text-slate-400"}>{received > 0 ? diffLabel(diff) : "—"}</p>
                        </div>
                      </div>
                    </button>

                    {/* ── Formulario de scan (activa) ── */}
                    {isActive && selected.reception_status !== "completed" && (
                      <div className="mx-2 rounded-b-2xl border border-t-0 border-teal-200 bg-teal-50/60 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <label className="text-[10px] font-black uppercase text-teal-600">Cantidad recibida</label>
                            <input
                              type="number" min="0" step="1"
                              value={editQty}
                              onChange={e => setEditQty(Number(e.target.value))}
                              className="mt-0.5 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-900 focus:border-teal-500 focus:ring-1 focus:ring-teal-300"
                              autoFocus
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] font-black uppercase text-slate-500">Observación (opcional)</label>
                            <input
                              type="text"
                              value={editNotes}
                              onChange={e => setEditNotes(e.target.value)}
                              placeholder="Ej: embalaje dañado"
                              className="mt-0.5 w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={saveScan} disabled={saving || editQty <= 0}
                            className="flex-1 rounded-xl bg-teal-600 text-white py-2.5 text-sm font-black disabled:opacity-50 flex items-center justify-center gap-1.5">
                            <CheckCircle2 size={15} /> {saving ? "Guardando..." : "Guardar"}
                          </button>
                          <button onClick={() => setActiveLine(null)} className="rounded-xl border px-4 py-2.5 text-sm font-black text-slate-600 hover:bg-slate-50">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Registros de scan para esta línea ── */}
                    {lineScans.length > 0 && (
                      <div className="mx-2 mt-1 space-y-1">
                        {lineScans.map(scan => (
                          <div key={scan.id} className="rounded-xl border bg-white px-3 py-2">
                            {editingScanId === scan.id ? (
                              <div className="flex items-center gap-2">
                                <input type="number" min="0" step="1" value={editScanQty}
                                  onChange={e => setEditScanQty(e.target.value)}
                                  className="w-20 rounded-xl border px-2 py-1.5 text-sm font-black" autoFocus />
                                <input type="text" value={editScanNotes}
                                  onChange={e => setEditScanNotes(e.target.value)}
                                  placeholder="Observación"
                                  className="flex-1 rounded-xl border px-2 py-1.5 text-sm" />
                                <button onClick={saveEditScan} disabled={saving}
                                  className="rounded-xl bg-teal-600 text-white px-3 py-1.5 text-xs font-black disabled:opacity-50">OK</button>
                                <button onClick={() => setEditingScanId("")}
                                  className="rounded-xl border px-3 py-1.5 text-xs font-black text-slate-600">Cancelar</button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <span className="font-black text-slate-900 text-sm">{fmt(num(scan.qty))}</span>
                                  {line.unit && <span className="text-xs font-black text-teal-600 ml-1">{line.unit}</span>}
                                  {scan.notes && <span className="text-xs text-slate-400 ml-2">· {scan.notes}</span>}
                                  <p className="text-[10px] text-slate-400">{scan.operator_name} · {timeShort(scan.created_at)}</p>
                                </div>
                                {selected.reception_status !== "completed" && (
                                  <div className="flex gap-1 shrink-0">
                                    <button onClick={() => { setEditingScanId(scan.id); setEditScanQty(String(num(scan.qty))); setEditScanNotes(scan.notes || ""); }}
                                      className="grid h-7 w-7 place-items-center rounded-lg border text-slate-500 hover:bg-slate-50">
                                      <Pencil size={13} />
                                    </button>
                                    <button onClick={() => void deleteScan(scan)}
                                      className="grid h-7 w-7 place-items-center rounded-lg border border-red-100 text-red-500 hover:bg-red-50">
                                      <Trash2 size={13} />
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Botón completar */}
          {selected.reception_status !== "completed" && !loading && (
            <div className="sticky bottom-4 pt-2">
              <button onClick={markComplete} disabled={saving || scans.length === 0}
                className="w-full rounded-2xl bg-slate-900 text-white py-4 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-40">
                <CheckCircle2 size={18} /> {saving ? "Guardando..." : "Marcar requerimiento completado"}
              </button>
              {scans.length === 0 && <p className="text-center text-xs text-slate-400 mt-1">Registra al menos un ítem para completar</p>}
            </div>
          )}

          {selected.reception_status === "completed" && (
            <div className="sticky bottom-4">
              <button onClick={printReport} className="w-full rounded-2xl bg-teal-600 text-white py-4 font-black text-sm flex items-center justify-center gap-2">
                <Printer size={18} /> Imprimir reporte
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
