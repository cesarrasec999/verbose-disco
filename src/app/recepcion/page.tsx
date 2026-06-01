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

type ConsolidatedReceptionLine = ReceptionLine & {
  line_ids: string[];
  request_detail: string;
  source_lines: ReceptionLine[];
};

type ReceptionDifferenceRow = {
  key: string;
  document: string;
  destinationStore: string;
  sourceStore: string;
  completedAt: string | null;
  completedByName: string | null;
  productCode: string;
  description: string | null;
  unit: string | null;
  requestedQty: number;
  receivedQty: number;
  difference: number;
  notes: string;
};

type ProductLookup = {
  sku: string;
  barcode: string | null;
  description: string | null;
  unit: string | null;
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
const REQUEST_PAGE_SIZE = 1000;
const REQUEST_MAX_ROWS = 5000;

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
function formatSync(value: string | null) {
  if (!value) return "Sin sincronizacion registrada";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
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
function isInvalidExtraLine(line: Pick<ReceptionLine, "id" | "qty_requested" | "description">) {
  return String(line.id || "").includes("|EXTRA|") &&
    num(line.qty_requested) === 0 &&
    /producto no incluido/i.test(String(line.description || ""));
}
function lineProductKey(line: Pick<ReceptionLine, "product_code" | "sku">) {
  return normalize(line.product_code || line.sku);
}
function requestLineLabel(req: ReceptionRequest | undefined, quantity: number) {
  const label = req?.doc_number || req?.inv_request_no || req?.erp_inv_request_id || "RQ";
  return `${label} (${fmt(quantity)})`;
}
function consolidateReceptionLines(lines: ReceptionLine[], requestsById: Map<string, ReceptionRequest>): ConsolidatedReceptionLine[] {
  const grouped = new Map<string, ReceptionLine[]>();
  for (const line of lines) {
    if (isInvalidExtraLine(line)) continue;
    const key = lineProductKey(line);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(line);
  }

  return [...grouped.values()].map(group => {
    const sorted = [...group].sort((a, b) => a.line_id - b.line_id || a.id.localeCompare(b.id));
    const base = sorted[0];
    const requestDetails = sorted.map(line => requestLineLabel(requestsById.get(line.request_id), num(line.qty_requested)));
    return {
      ...base,
      id: sorted.map(line => line.id).join("|"),
      line_ids: sorted.map(line => line.id),
      source_lines: sorted,
      request_detail: requestDetails.join(" / "),
      qty_requested: sorted.reduce((sum, line) => sum + num(line.qty_requested), 0),
      qty_pending: sorted.reduce((sum, line) => sum + num(line.qty_pending), 0),
    };
  }).sort((a, b) => a.line_id - b.line_id || a.product_code.localeCompare(b.product_code, "es"));
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
  const [summaryScans, setSummaryScans] = useState<ReceptionScan[]>([]);
  const [selected, setSelected] = useState<ReceptionRequestGroup | null>(null);
  const [view, setView]         = useState<"list" | "detail">("list");
  const [listPanel, setListPanel] = useState<"recepcion" | "resumen" | "diferencias">("recepcion");
  const [ready, setReady]       = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [message, setMessage]   = useState("");
  const [lastErpSync, setLastErpSync] = useState<string | null>(null);
  const [differenceRows, setDifferenceRows] = useState<ReceptionDifferenceRow[]>([]);
  const [loadingDifferences, setLoadingDifferences] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  // Filtros lista
  const [storeFilter, setStoreFilter]   = useState("all");
  const [search, setSearch]             = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "in_progress" | "completed">("all");

  // Escaneo
  const [scanProduct, setScanProduct]   = useState("");
  const [activeLine, setActiveLine]     = useState<ReceptionLine | null>(null);
  const [editQty, setEditQty]           = useState(1);
  const [editNotes, setEditNotes]       = useState("");
  const [editLineInputs, setEditLineInputs] = useState<Record<string, { qty: string; notes: string }>>({});

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
      return `${user.id}:admin:all`;
    }
    const store = stores.find(item => item.id === user.store_id);
    const codes = storeCodes(store);
    return `${user.id}:store:${(codes.length > 0 ? codes : [user.store_id || "none"]).sort().join("+")}`;
  }, [canViewAllStores, storeCodes, stores, user]);

  const applyRequests = useCallback((rows: ReceptionRequest[]) => {
    setRequests(rows);
    writeRequestCache(requestScopeKey(), rows);
  }, [requestScopeKey]);

  function toggleSelectedGroup(groupId: string) {
    setSelectedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function mergeRequestGroups(groups: ReceptionRequestGroup[]): ReceptionRequestGroup | null {
    if (groups.length === 0) return null;
    const sorted = [...groups].sort((a, b) =>
      String(b.creation_date || b.request_date || "").localeCompare(String(a.creation_date || a.request_date || ""))
    );
    const base = sorted[0];
    const childRequests = sorted.flatMap(group => group.child_requests);
    const requestIds = [...new Set(sorted.flatMap(group => group.request_ids))];
    const documents = sorted.map(group => group.doc_number || group.inv_request_no || group.erp_inv_request_id).filter(Boolean);
    return {
      ...base,
      id: sorted.map(group => group.id).join("||"),
      erp_inv_request_id: sorted.map(group => group.erp_inv_request_id).join(", "),
      inv_request_no: documents.join(" + "),
      doc_number: documents.join(" + "),
      line_count: sorted.reduce((sum, group) => sum + num(group.line_count), 0),
      qty_requested_total: sorted.reduce((sum, group) => sum + num(group.qty_requested_total), 0),
      qty_pending_total: sorted.reduce((sum, group) => sum + num(group.qty_pending_total), 0),
      reception_status: groupedStatus(childRequests),
      completed_by_name: childRequests.every(item => item.reception_status === "completed")
        ? childRequests.find(item => item.completed_by_name)?.completed_by_name || null
        : null,
      request_ids: requestIds,
      transfer_count: childRequests.length,
      child_requests: childRequests,
    };
  }

  function openSelectedGroups() {
    const groups = filteredRequests.filter(req => selectedGroupIds.has(req.id));
    const merged = mergeRequestGroups(groups);
    if (!merged) {
      showMsg("Selecciona al menos un requerimiento.");
      return;
    }
    void openRequest(merged);
  }

  const updateRequests = useCallback((updater: (prev: ReceptionRequest[]) => ReceptionRequest[]) => {
    setRequests(prev => {
      const next = updater(prev);
      writeRequestCache(requestScopeKey(), next);
      return next;
    });
  }, [requestScopeKey]);

  async function loadSummaryScans(requestIds: string[]) {
    if (requestIds.length === 0) { setSummaryScans([]); return; }
    const chunks: string[][] = [];
    for (let i = 0; i < requestIds.length; i += 200) chunks.push(requestIds.slice(i, i + 200));
    const results = await Promise.all(
      chunks.map(ids => supabase.from("reception_scans").select("*").in("request_id", ids))
    );
    const rows = results.flatMap(({ data }) => (data || []) as ReceptionScan[]);
    setSummaryScans(rows);
  }

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
  useEffect(() => { if (ready && user && !canViewAllStores) void loadRequests(); }, [storeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const syncStatusPromise = supabase
        .from("erp_sync_status")
        .select("synced_at,updated_at")
        .eq("id", "reception_requests")
        .maybeSingle();
      const rows: ReceptionRequest[] = [];
      const store = !canViewAllStores && user?.store_id ? stores.find(s => s.id === user.store_id) : null;
      const codes = store ? storeCodes(store) : [];

      for (let offset = 0; offset < REQUEST_MAX_ROWS; offset += REQUEST_PAGE_SIZE) {
        let query = supabase
          .from("reception_requests")
          .select("*")
          .eq("status_code", "T")
          .order("creation_date", { ascending: false })
          .range(offset, offset + REQUEST_PAGE_SIZE - 1);

        if (codes.length > 0) {
          query = query.or(codes.map(code => `destination_store_code.eq.${code}`).join(","));
        }

        const { data, error } = await query;
        if (error) throw error;
        rows.push(...((data || []) as ReceptionRequest[]));
        if (!data || data.length < REQUEST_PAGE_SIZE) break;
      }

      if (seq !== loadSeq.current) return;
      const nextRows = rows.filter(req => isSupplyReason(req.reason));
      const syncStatus = await syncStatusPromise;
      if (seq === loadSeq.current) {
        setLastErpSync(syncStatus.data?.synced_at || syncStatus.data?.updated_at || nextRows[0]?.request_date || null);
      }
      if (nextRows.length === 0) {
        scheduleEmptyRetry();
        if (requests.length > 0) return;
        if (fallbackCachedRows.length > 0) {
          setRequests(fallbackCachedRows);
          await loadSummaryScans(fallbackCachedRows.map(req => req.id));
        }
        return;
      }
      if (emptyRetryTimer.current !== null) {
        window.clearTimeout(emptyRetryTimer.current);
        emptyRetryTimer.current = null;
      }
      applyRequests(nextRows);
      await loadSummaryScans(nextRows.map(req => req.id));
      await resetCompletedRequestsWithoutScans(nextRows.filter(req => req.reception_status === "completed").map(req => req.id));
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
    const searchableLines = lines.filter(line => !isInvalidExtraLine(line));
    const direct = searchableLines.find(l =>
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
      return searchableLines.find(l =>
        mapped.has(normalize(l.product_code)) || mapped.has(normalize(l.sku))
      ) || null;
    } catch { return null; }
  }

  async function lookupProduct(code: string): Promise<ProductLookup | null> {
    const raw = code.trim();
    if (!raw) return null;
    const candidates = [...new Set([
      raw, cleanCode(raw), fullProductCode(raw),
    ].filter(Boolean).map(v => v.trim().toUpperCase()))];

    try {
      const [{ data: bySku }, { data: byBarcode }] = await Promise.all([
        supabase.from("cyclic_products").select("sku,barcode,description,unit").in("sku", candidates).eq("is_active", true).limit(1),
        supabase.from("cyclic_products").select("sku,barcode,description,unit").in("barcode", candidates).eq("is_active", true).limit(1),
      ]);
      const direct = ((bySku || [])[0] || (byBarcode || [])[0]) as ProductLookup | undefined;
      if (direct) return direct;

      const [{ data: byUpc }, { data: byAlu }] = await Promise.all([
        supabase.from("codigos_barra").select("codsap,upc,alu").in("upc", candidates).not("codsap", "is", null).limit(20),
        supabase.from("codigos_barra").select("codsap,upc,alu").in("alu", candidates).not("codsap", "is", null).limit(20),
      ]);
      const mapped = [...new Set(
        [...(byUpc || []), ...(byAlu || [])]
          .flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>))
          .map(v => v.trim().toUpperCase())
      )];
      if (mapped.length === 0) return null;
      const { data } = await supabase
        .from("cyclic_products")
        .select("sku,barcode,description,unit")
        .in("sku", mapped)
        .eq("is_active", true)
        .limit(1);
      return ((data || [])[0] as ProductLookup | undefined) || null;
    } catch {
      return null;
    }
  }

  async function createExtraLine(code: string): Promise<ReceptionLine | null> {
    if (!selected) return null;
    const raw = code.trim();
    const normalizedCode = normalize(fullProductCode(raw) || raw);
    const existing = lines.find(line => line.qty_requested === 0 && normalize(line.product_code) === normalizedCode);
    if (existing) return existing;

    const baseRequest = selected.child_requests.find(req => selected.request_ids.includes(req.id)) || selected.child_requests[0] || selected;
    const requestId = baseRequest.id;
    const erpRequestId = String(baseRequest.erp_inv_request_id || selected.erp_inv_request_id).split(",")[0].trim();
    const product = await lookupProduct(raw);
    if (!product?.sku) return null;
    const productCode = product.sku;
    const extraId = `${requestId}|EXTRA|${normalize(productCode)}`;
    const existingById = lines.find(line => line.id === extraId);
    if (existingById) return existingById;

    const nextLineId = Math.max(0, ...lines.filter(line => line.request_id === requestId).map(line => num(line.line_id))) + 1;
    const newLine: ReceptionLine = {
      id: extraId,
      request_id: requestId,
      line_id: nextLineId,
      sku: product.sku,
      product_code: productCode,
      barcode: product.barcode || raw,
      description: product.description || "Producto adicional",
      unit: product.unit || null,
      qty_requested: 0,
      qty_pending: 0,
    };

    const { error } = await supabase.from("reception_request_lines").upsert({
      id: newLine.id,
      request_id: newLine.request_id,
      erp_inv_request_id: erpRequestId,
      line_id: newLine.line_id,
      sku: newLine.sku,
      product_code: newLine.product_code,
      barcode: newLine.barcode,
      description: newLine.description,
      unit: newLine.unit,
      qty_requested: 0,
      qty_pending: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw error;
    setLines(prev => prev.some(line => line.id === newLine.id) ? prev : [...prev, newLine]);
    return newLine;
  }

  async function handleScan(code: string) {
    if (!code.trim()) return;
    const found = await findLine(code);
    if (found) {
      setActiveLine(found);
      setEditQty(1);
      setEditNotes("");
      prepareLineInputs(found);
      setTimeout(() => {
        lineRefs.current[found.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    } else {
      try {
        const extraLine = await createExtraLine(code);
        if (!extraLine) {
          showMsg(`Codigo "${code}" no existe en la base de productos. No se agrego al requerimiento.`);
          return;
        }
        setActiveLine(extraLine);
        setEditQty(1);
        setEditNotes("Sobrante no enviado");
        prepareLineInputs(extraLine, "Sobrante no enviado");
        setScanProduct(code.trim());
        setTimeout(() => {
          lineRefs.current[extraLine.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
        showMsg(`Codigo "${code}" agregado como sobrante con enviado 0.`);
      } catch (e: any) {
        showMsg("No se pudo agregar el sobrante: " + e.message);
      }
    }
  }

  // ─── Guardar scan ──────────────────────────────────────────────────────────

  async function saveScan() {
    if (!activeLine || !selected || !user) return;
    const activeGroup = consolidatedLines.find(line => line.line_ids.includes(activeLine.id));
    const sourceLines = activeGroup?.source_lines || [activeLine];
    const rows = sourceLines.map(line => {
      const input = editLineInputs[line.id];
      const qty = num(input?.qty ?? (sourceLines.length === 1 ? editQty : 0));
      const notes = (input?.notes ?? editNotes).trim();
      return { line, qty, notes };
    }).filter(row => row.qty > 0);
    if (rows.length === 0) { showMsg("Ingresa al menos una cantidad mayor a 0."); return; }
    setSaving(true);
    try {
      const payload = rows.map(row => ({
        request_id:    row.line.request_id,
        line_id:       row.line.id,
        operator_id:   user.id,
        operator_name: user.full_name,
        product_code:  row.line.product_code,
        scanned_code:  scanProduct.trim() || null,
        qty:           row.qty,
        notes:         row.notes || null,
      }));
      const { error } = await supabase.from("reception_scans").insert(payload);
      if (error) throw error;

      // Pasar a in_progress si estaba pendiente
      const requestIdsToUpdate = [...new Set(rows.map(row => row.line.request_id))];
      await supabase.from("reception_requests").update({
        reception_status: "in_progress",
        updated_at: new Date().toISOString(),
      }).in("id", requestIdsToUpdate).eq("reception_status", "pending");

      setSelected(prev => prev ? { ...prev, reception_status: prev.reception_status === "pending" ? "in_progress" : prev.reception_status } : null);
      updateRequests(prev => prev.map(r => requestIdsToUpdate.includes(r.id) && r.reception_status === "pending" ? { ...r, reception_status: "in_progress" } : r));

      setScanProduct("");
      setActiveLine(null);
      setEditLineInputs({});
      if (selected.reception_status === "completed") await resetCompletedRequestsWithoutScans(requestIdsToUpdate, true);
      await reloadScans(selected.request_ids);
      await loadSummaryScans(requests.map(req => req.id));
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
      if (selected?.reception_status === "completed") await resetCompletedRequestsWithoutScans(selected.request_ids, true);
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
    if (selected) await resetCompletedRequestsWithoutScans(selected.request_ids, true);
    if (selected) await reloadScans(selected.request_ids);
    setSummaryScans(prev => prev.filter(item => item.id !== scan.id));
    showMsg("Registro eliminado.");
  }

  async function resetCompletedRequestsWithoutScans(requestIds: string[], downgradeWithScans = false) {
    const uniqueIds = [...new Set(requestIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Set<string>();

    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 200) chunks.push(uniqueIds.slice(i, i + 200));

    const scanResults = await Promise.all(chunks.map(ids =>
      supabase.from("reception_scans").select("request_id").in("request_id", ids)
    ));
    const scanError = scanResults.find(result => result.error)?.error;
    if (scanError) throw scanError;

    const requestIdsWithScans = new Set(
      scanResults.flatMap(result => (result.data || []) as Pick<ReceptionScan, "request_id">[])
        .map(row => row.request_id)
    );
    const emptyRequestIds = uniqueIds.filter(id => !requestIdsWithScans.has(id));
    const inProgressRequestIds = downgradeWithScans ? uniqueIds.filter(id => requestIdsWithScans.has(id)) : [];
    if (emptyRequestIds.length === 0 && inProgressRequestIds.length === 0) return new Set<string>();

    if (emptyRequestIds.length > 0) {
      const { error } = await supabase.from("reception_requests").update({
        reception_status: "pending",
        completed_at: null,
        completed_by_id: null,
        completed_by_name: null,
        updated_at: new Date().toISOString(),
      }).in("id", emptyRequestIds).eq("reception_status", "completed");
      if (error) throw error;
    }

    if (inProgressRequestIds.length > 0) {
      const { error } = await supabase.from("reception_requests").update({
        reception_status: "in_progress",
        completed_at: null,
        completed_by_id: null,
        completed_by_name: null,
        updated_at: new Date().toISOString(),
      }).in("id", inProgressRequestIds).eq("reception_status", "completed");
      if (error) throw error;
    }

    const changedRequestIds = [...emptyRequestIds, ...inProgressRequestIds];

    updateRequests(prev => prev.map(req => changedRequestIds.includes(req.id)
      ? { ...req, reception_status: emptyRequestIds.includes(req.id) ? "pending" : "in_progress", completed_at: null, completed_by_name: null }
      : req
    ));
    setSelected(prev => {
      if (!prev) return prev;
      const childRequests = prev.child_requests.map(req => changedRequestIds.includes(req.id)
        ? { ...req, reception_status: (emptyRequestIds.includes(req.id) ? "pending" : "in_progress") as ReceptionRequest["reception_status"], completed_at: null, completed_by_name: null }
        : req
      );
      return {
        ...prev,
        child_requests: childRequests,
        reception_status: groupedStatus(childRequests),
        completed_by_name: childRequests.every(req => req.reception_status === "completed")
          ? childRequests.find(req => req.completed_by_name)?.completed_by_name || null
          : null,
      };
    });

    return new Set(changedRequestIds);
  }

  // ─── Marcar completado ─────────────────────────────────────────────────────

  async function markComplete() {
    if (!selected || !user) return;
    if (!window.confirm("¿Marcar este requerimiento como completado?")) return;
    setSaving(true);
    try {
      const completedAt = new Date().toISOString();
      const { error } = await supabase.from("reception_requests").update({
        reception_status:  "completed",
        completed_at:      completedAt,
        completed_by_id:   user.id,
        completed_by_name: user.full_name,
        updated_at:        new Date().toISOString(),
      }).in("id", selected.request_ids);
      if (error) throw error;
      setSelected(prev => prev ? { ...prev, reception_status: "completed", completed_by_name: user.full_name } : null);
      updateRequests(prev => prev.map(r => selected.request_ids.includes(r.id) ? { ...r, reception_status: "completed", completed_by_name: user.full_name } : r));
      showMsg("Requerimiento completado. Las diferencias quedan disponibles en el reporte de validadores.");
      if (listPanel === "diferencias") void loadDifferencesReport();
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
    const lineRows = consolidatedLines.map(line => {
      const lineIdSet = new Set(line.line_ids);
      const lineScans = scans.filter(s => lineIdSet.has(s.line_id));
      const received = lineScans.reduce((sum, s) => sum + num(s.qty), 0);
      const diff = received - num(line.qty_requested);
      return { line, received, diff, lineScans };
    });
    const reportRows = [...lineRows].sort((a, b) => {
      const rank = (diff: number) => diff < 0 ? 0 : diff > 0 ? 1 : 2;
      return rank(a.diff) - rank(b.diff) || String(a.line.product_code).localeCompare(String(b.line.product_code), "es");
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
        ${reportRows.map((r, i) => {
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

  async function loadDifferencesReport() {
    if (!canViewSummary) return;
    const completedGroups = scopedRequestGroups.filter(req => req.reception_status === "completed");
    const completedRequestIds = [...new Set(completedGroups.flatMap(req => req.request_ids))];
    const staleCompletedIds = await resetCompletedRequestsWithoutScans(completedRequestIds);
    const requestIds = completedRequestIds.filter(id => !staleCompletedIds.has(id));
    if (requestIds.length === 0) {
      setDifferenceRows([]);
      return;
    }

    setLoadingDifferences(true);
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < requestIds.length; i += 200) chunks.push(requestIds.slice(i, i + 200));

      const [lineResults, scanResults] = await Promise.all([
        Promise.all(chunks.map(ids =>
          supabase.from("reception_request_lines").select("*").in("request_id", ids).order("line_id")
        )),
        Promise.all(chunks.map(ids =>
          supabase.from("reception_scans").select("*").in("request_id", ids).order("created_at")
        )),
      ]);

      const lineError = lineResults.find(result => result.error)?.error;
      const scanError = scanResults.find(result => result.error)?.error;
      if (lineError) throw lineError;
      if (scanError) throw scanError;

      const reportRequests = new Map<string, ReceptionRequest>();
      for (const group of completedGroups) {
        for (const child of group.child_requests) reportRequests.set(child.id, child);
      }

      const scansByLineReport = new Map<string, ReceptionScan[]>();
      for (const scan of scanResults.flatMap(result => (result.data || []) as ReceptionScan[])) {
        if (!scansByLineReport.has(scan.line_id)) scansByLineReport.set(scan.line_id, []);
        scansByLineReport.get(scan.line_id)!.push(scan);
      }

      const rows: ReceptionDifferenceRow[] = [];
      const linesByRequest = lineResults.flatMap(result => (result.data || []) as ReceptionLine[]);
      const requestsById = reportRequests;
      const consolidatedReportLines = consolidateReceptionLines(linesByRequest, requestsById);
      for (const line of consolidatedReportLines) {
        const lineIdSet = new Set(line.line_ids);
        const lineScans = [...lineIdSet].flatMap(lineId => scansByLineReport.get(lineId) || []);
        const receivedQty = lineScans.reduce((sum, scan) => sum + num(scan.qty), 0);
        const requestedQty = num(line.qty_requested);
        const difference = receivedQty - requestedQty;
        if (difference === 0) continue;

        const req = reportRequests.get(line.request_id);
        if (!req) continue;
        rows.push({
          key: `${line.id}:${difference}`,
          document: line.request_detail || req.doc_number || req.inv_request_no || req.erp_inv_request_id,
          destinationStore: req.destination_store_name || req.destination_store_code,
          sourceStore: req.source_store_name || req.source_store_code,
          completedAt: req.completed_at,
          completedByName: req.completed_by_name,
          productCode: line.product_code,
          description: line.description,
          unit: line.unit,
          requestedQty,
          receivedQty,
          difference,
          notes: [...new Set(lineScans.map(scan => scan.notes?.trim()).filter(Boolean))].join(" | "),
        });
      }

      setDifferenceRows(rows.sort((a, b) =>
        String(b.completedAt || "").localeCompare(String(a.completedAt || "")) ||
        a.destinationStore.localeCompare(b.destinationStore, "es") ||
        a.document.localeCompare(b.document, "es")
      ));
    } catch (e: any) {
      showMsg("No se pudo cargar el reporte de diferencias: " + e.message);
    } finally {
      setLoadingDifferences(false);
    }
  }

  // ─── Filtros ───────────────────────────────────────────────────────────────

  const requestGroups = useMemo(
    () => buildRequestGroups(requests.filter(r => isSupplyReason(r.reason))),
    [requests]
  );

  const scopedRequestGroups = useMemo(() => {
    if (!canViewAllStores || storeFilter === "all") return requestGroups;
    const allowed = new Set(selectedStoreCodes(storeFilter).map(normalize));
    if (allowed.size === 0) return requestGroups;
    return requestGroups.filter(req => req.child_requests.some(item => allowed.has(normalize(item.destination_store_code))));
  }, [canViewAllStores, requestGroups, selectedStoreCodes, storeFilter]);

  const filteredRequests = useMemo(() => scopedRequestGroups.filter(r => {
    if (filterStatus !== "all" && r.reception_status !== filterStatus) return false;
    if (!search.trim()) return true;
    return [r.doc_number, r.inv_request_no, r.destination_store_name, r.source_store_name, r.reason, r.erp_inv_request_id]
      .join(" ").toLowerCase().includes(search.toLowerCase());
  }), [scopedRequestGroups, filterStatus, search]);

  const destStoreOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const store of stores) {
      const code = store.erp_sede || store.code;
      if (code) map.set(code, store.name || code);
    }
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [stores]);

  const summaryRows = useMemo(() => {
    const scannedRequestIds = new Set(summaryScans.map(scan => scan.request_id));
    const grouped = new Map<string, {
      key: string;
      name: string;
      total: number;
      advanced: number;
      pending: number;
      lines: number;
      units: number;
    }>();

    for (const req of scopedRequestGroups) {
      const key = req.destination_store_code || req.destination_store_name || "SIN_TIENDA";
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name: req.destination_store_name || req.destination_store_code || "Sin tienda",
          total: 0,
          advanced: 0,
          pending: 0,
          lines: 0,
          units: 0,
        });
      }
      const row = grouped.get(key)!;
      row.total += 1;
      row.lines += num(req.line_count);
      row.units += num(req.qty_requested_total);
      const hasExistingScan = req.request_ids.some(id => scannedRequestIds.has(id));
      if (req.reception_status === "completed" || hasExistingScan) row.advanced += 1;
      else row.pending += 1;
    }

    return [...grouped.values()]
      .map(row => ({
        ...row,
        pct: row.total > 0 ? Math.round((row.advanced / row.total) * 100) : 0,
        pendingPct: row.total > 0 ? Math.round((row.pending / row.total) * 100) : 0,
      }))
      .sort((a, b) => b.pct - a.pct || b.total - a.total || a.name.localeCompare(b.name, "es"));
  }, [scopedRequestGroups, summaryScans]);

  const differenceStats = useMemo(() => {
    const faltantes = differenceRows.filter(row => row.difference < 0).length;
    const sobrantes = differenceRows.filter(row => row.difference > 0).length;
    const netUnits = differenceRows.reduce((sum, row) => sum + row.difference, 0);
    const stores = new Set(differenceRows.map(row => row.destinationStore)).size;
    return { faltantes, sobrantes, netUnits, stores };
  }, [differenceRows]);

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

  const selectedRequestsById = useMemo(() => {
    const map = new Map<string, ReceptionRequest>();
    for (const req of selected?.child_requests || []) map.set(req.id, req);
    return map;
  }, [selected]);

  const consolidatedLines = useMemo(
    () => consolidateReceptionLines(lines, selectedRequestsById),
    [lines, selectedRequestsById]
  );

  const consolidatedScanTotal = useCallback((line: ConsolidatedReceptionLine) =>
    line.line_ids.reduce((sum, lineId) => sum + (scanTotalByLine.get(lineId) || 0), 0),
  [scanTotalByLine]);

  const prepareLineInputs = useCallback((line: ReceptionLine, defaultNotes = "") => {
    const group = consolidatedLines.find(item => item.line_ids.includes(line.id));
    const sourceLines = group?.source_lines || [line];
    const singleLine = sourceLines.length === 1;
    const next: Record<string, { qty: string; notes: string }> = {};
    for (const sourceLine of sourceLines) {
      next[sourceLine.id] = { qty: singleLine ? "1" : "", notes: defaultNotes };
    }
    setEditLineInputs(next);
  }, [consolidatedLines]);

  const linesScanned = useMemo(() => consolidatedLines.filter(l => consolidatedScanTotal(l) > 0).length, [consolidatedLines, consolidatedScanTotal]);
  const receptionProgressPct = consolidatedLines.length > 0 ? Math.round((linesScanned / consolidatedLines.length) * 100) : 0;

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
            <div className="grid grid-cols-3 gap-2 rounded-2xl border bg-white p-1 shadow-sm">
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
              <button
                onClick={() => { setListPanel("diferencias"); void loadDifferencesReport(); }}
                className={`rounded-xl px-3 py-2 text-sm font-black ${listPanel === "diferencias" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Diferencias
              </button>
            </div>
          )}

          <div className="rounded-2xl border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-black uppercase text-slate-500">Ultima sincronizacion ERP Recepcion</p>
            <p className="text-sm font-black text-slate-900">{formatSync(lastErpSync)}</p>
          </div>

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
          {listPanel === "diferencias" && <p className="text-xs text-slate-400 font-black px-1">{differenceRows.length} diferencia{differenceRows.length !== 1 ? "s" : ""}</p>}

          {loading && <p className="text-center py-12 text-slate-400 font-bold">Cargando...</p>}
          {!loading && listPanel === "resumen" && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Avance por tienda</p>
                  <h2 className="text-xl font-black text-slate-950">Recepción de abastecimiento</h2>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] font-black">
                  <span className="rounded-full bg-teal-100 px-2.5 py-1 text-teal-700">Con avance</span>
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
                      <div className="bg-teal-500" style={{ width: `${row.pct}%` }} title={`${row.advanced} con avance`} />
                      <div className="bg-slate-300" style={{ width: `${row.pendingPct}%` }} title={`${row.pending} pendientes`} />
                    </div>
                  </div>
                ))}
                {summaryRows.length === 0 && <p className="p-8 text-center text-sm font-bold text-slate-400">Sin datos para mostrar.</p>}
              </div>
            </div>
          )}

          {!loading && listPanel === "diferencias" && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Reporte validador</p>
                  <h2 className="text-xl font-black text-slate-950">Diferencias de recepcion</h2>
                </div>
                <button
                  onClick={() => void loadDifferencesReport()}
                  disabled={loadingDifferences}
                  className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  {loadingDifferences ? "Cargando..." : "Actualizar"}
                </button>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2 text-center text-xs font-black sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-slate-400">Tiendas</p>
                  <p className="text-lg text-slate-950">{differenceStats.stores}</p>
                </div>
                <div className="rounded-xl bg-red-50 p-3">
                  <p className="text-red-400">Faltantes</p>
                  <p className="text-lg text-red-700">{differenceStats.faltantes}</p>
                </div>
                <div className="rounded-xl bg-blue-50 p-3">
                  <p className="text-blue-400">Sobrantes</p>
                  <p className="text-lg text-blue-700">{differenceStats.sobrantes}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-slate-400">Neto uds.</p>
                  <p className="text-lg text-slate-950">{fmt(differenceStats.netUnits)}</p>
                </div>
              </div>

              {loadingDifferences && <p className="p-8 text-center text-sm font-bold text-slate-400">Cargando diferencias...</p>}
              {!loadingDifferences && differenceRows.length === 0 && (
                <p className="p-8 text-center text-sm font-bold text-slate-400">Sin diferencias en recepciones completadas.</p>
              )}
              {!loadingDifferences && differenceRows.length > 0 && (
                <div className="space-y-2">
                  {differenceRows.map(row => (
                    <div key={row.key} className="rounded-xl border bg-slate-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[11px] font-black uppercase text-slate-400">{row.destinationStore} · {row.document}</p>
                          <p className="truncate text-sm font-black text-slate-950">{row.productCode}</p>
                          <p className="text-xs font-semibold text-slate-600">{row.description || "Sin descripcion"}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-black ${row.difference > 0 ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-700"}`}>
                          {diffLabel(row.difference)}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-3 overflow-hidden rounded-lg border bg-white text-center text-[11px] font-black">
                        <div className="border-r p-1.5"><p className="text-slate-400">Enviado</p><p>{fmt(row.requestedQty)}</p></div>
                        <div className="border-r p-1.5"><p className="text-slate-400">Recibido</p><p>{fmt(row.receivedQty)}</p></div>
                        <div className="p-1.5"><p className="text-slate-400">UM</p><p>{row.unit || "-"}</p></div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold text-slate-400">
                        <span>Origen: <b className="text-slate-600">{row.sourceStore}</b></span>
                        <span>Cierre: <b className="text-slate-600">{timeShort(row.completedAt)}</b></span>
                        {row.completedByName && <span>Por: <b className="text-slate-600">{row.completedByName}</b></span>}
                      </div>
                      {row.notes && <p className="mt-1 text-xs font-semibold text-slate-500">Obs: {row.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!loading && listPanel === "recepcion" && filteredRequests.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-black">Sin requerimientos{filterStatus !== "all" ? " en este estado" : ""}</p>
              <p className="text-xs mt-1">Los slips en tránsito aparecerán aquí automáticamente.</p>
            </div>
          )}

          {!loading && listPanel === "recepcion" && filteredRequests.length > 0 && (
            <div className="sticky top-[72px] z-20 rounded-2xl border bg-white/95 p-3 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Revision agrupada</p>
                  <p className="text-xs font-bold text-slate-400">{selectedGroupIds.size} requerimiento{selectedGroupIds.size !== 1 ? "s" : ""} seleccionado{selectedGroupIds.size !== 1 ? "s" : ""}</p>
                </div>
                <div className="flex gap-2">
                  {selectedGroupIds.size > 0 && (
                    <button type="button" onClick={() => setSelectedGroupIds(new Set())} className="rounded-xl border px-3 py-2 text-xs font-black text-slate-600">
                      Limpiar
                    </button>
                  )}
                  <button type="button" onClick={openSelectedGroups} disabled={selectedGroupIds.size === 0} className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                    Revisar seleccionados juntos
                  </button>
                </div>
              </div>
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
                  <span
                    role="checkbox"
                    aria-checked={selectedGroupIds.has(req.id)}
                    tabIndex={0}
                    onClick={event => { event.stopPropagation(); toggleSelectedGroup(req.id); }}
                    onKeyDown={event => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      toggleSelectedGroup(req.id);
                    }}
                    className={`grid h-8 w-8 place-items-center rounded-xl border text-xs font-black ${selectedGroupIds.has(req.id) ? "border-teal-500 bg-teal-50 text-teal-700" : "border-slate-200 text-slate-300"}`}
                    title="Seleccionar para revisar junto con otros requerimientos"
                  >
                    {selectedGroupIds.has(req.id) ? "✓" : ""}
                  </span>
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
            {consolidatedLines.length > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs font-black text-slate-500 mb-1">
                  <span>{linesScanned} / {consolidatedLines.length} lineas recepcionadas</span>
                  <span>{receptionProgressPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-teal-600 transition-all" style={{ width: `${receptionProgressPct}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Barra de escaneo / digitación */}
          {(
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
              {consolidatedLines.map(line => {
                const received = consolidatedScanTotal(line);
                const diff = received - num(line.qty_requested);
                const isActive = activeLine ? line.line_ids.includes(activeLine.id) : false;
                const lineScans = line.line_ids.flatMap(lineId => scansByLine.get(lineId) || []);

                return (
                  <div key={line.id} ref={el => {
                    lineRefs.current[line.id] = el;
                    line.line_ids.forEach(lineId => { lineRefs.current[lineId] = el; });
                  }}>
                    {/* ── Card de línea ── */}
                    <button
                      onClick={() => {
                        if (isActive) { setActiveLine(null); return; }
                        setActiveLine(line.source_lines[0] || line);
                        setEditQty(1);
                        setEditNotes("");
                        prepareLineInputs(line.source_lines[0] || line);
                        setScanProduct("");
                      }}
                      className={`w-full text-left rounded-2xl border p-3 transition-all ${isActive ? "border-teal-500 bg-teal-50 shadow-md" : received > 0 ? "border-emerald-200 bg-white" : "border-slate-200 bg-white"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-black text-slate-900 text-sm">{line.product_code}</p>
                          <p className="text-xs text-slate-500 truncate">{line.description}</p>
                          {line.request_detail && (
                            <p className="mt-1 text-[11px] font-black text-slate-500">{line.request_detail}</p>
                          )}
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
                    {isActive && (
                      <div className="mx-2 rounded-b-2xl border border-t-0 border-teal-200 bg-teal-50/60 p-3 space-y-2">
                        {line.source_lines.map((sourceLine, index) => {
                          const req = selectedRequestsById.get(sourceLine.request_id);
                          const input = editLineInputs[sourceLine.id] || { qty: line.source_lines.length === 1 ? String(editQty) : "", notes: editNotes };
                          return (
                            <div key={sourceLine.id} className="grid gap-2 rounded-xl border bg-white p-2 sm:grid-cols-[minmax(120px,180px)_1fr_1fr]">
                              <div className="text-xs font-black text-slate-700">
                                <p>{req?.doc_number || req?.inv_request_no || req?.erp_inv_request_id || "RQ"}</p>
                                <p className="text-[10px] text-slate-400">Enviado: {fmt(num(sourceLine.qty_requested))}</p>
                              </div>
                              <div>
                                <label className="text-[10px] font-black uppercase text-teal-600">Cantidad</label>
                                <input
                                  type="number" min="0" step="1"
                                  value={input.qty}
                                  onChange={e => {
                                    const value = e.target.value;
                                    setEditLineInputs(prev => ({ ...prev, [sourceLine.id]: { qty: value, notes: prev[sourceLine.id]?.notes || "" } }));
                                    if (line.source_lines.length === 1) setEditQty(Number(value));
                                  }}
                                  className="mt-0.5 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-900 focus:border-teal-500 focus:ring-1 focus:ring-teal-300"
                                  autoFocus={index === 0}
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-black uppercase text-slate-500">Obs.</label>
                                <input
                                  type="text"
                                  value={input.notes}
                                  onChange={e => {
                                    const value = e.target.value;
                                    setEditLineInputs(prev => ({ ...prev, [sourceLine.id]: { qty: prev[sourceLine.id]?.qty || "", notes: value } }));
                                    if (line.source_lines.length === 1) setEditNotes(value);
                                  }}
                                  placeholder="Observacion"
                                  className="mt-0.5 w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900"
                                />
                              </div>
                            </div>
                          );
                        })}
                        <div className="flex gap-2">
                          <button onClick={saveScan} disabled={saving || line.source_lines.every(sourceLine => num(editLineInputs[sourceLine.id]?.qty) <= 0)}
                            className="flex-1 rounded-xl bg-teal-600 text-white py-2.5 text-sm font-black disabled:opacity-50 flex items-center justify-center gap-1.5">
                            <CheckCircle2 size={15} /> {saving ? "Guardando..." : "Guardar"}
                          </button>
                          <button onClick={() => { setActiveLine(null); setEditLineInputs({}); }} className="rounded-xl border px-4 py-2.5 text-sm font-black text-slate-600 hover:bg-slate-50">
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
                                {(
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
