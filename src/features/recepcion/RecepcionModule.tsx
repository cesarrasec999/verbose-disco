"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Camera, CheckCircle2, ChevronLeft, Home, LogOut, Package,
  Download, Pencil, Printer, QrCode, RefreshCw, ScanLine, Trash2, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { endSingleDeviceSession, readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import { cleanCode, fullProductCode, mappedProductCodeCandidates } from "@/features/ciclicos/utils";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ReceptionRequest = {
  id: string;
  erp_inv_request_id: string;
  inv_request_no: string | null;
  doc_number: string | null;
  status_code: string | null;
  erp_status: string | null;
  request_date: string | null;
  creation_date: string | null;
  destination_store_code: string;
  destination_store_name: string | null;
  source_store_code: string;
  source_store_name: string | null;
  reason: string | null;
  notes: string | null;
  dispatched_by_name: string | null;
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

type DifferenceKind = "faltante" | "sobrante" | "desmedro";

type ReceptionDifferenceRow = {
  key: string;
  diffKey: string;
  kind: DifferenceKind;
  document: string;
  destinationStore: string;
  destinationStoreCode: string;
  sourceStore: string;
  sourceStoreCode: string;
  deliveredAt: string | null;
  deliveredByName: string | null;
  dispatchedByName: string | null;
  reportedAt: string;
  reportedByName: string | null;
  productCode: string;
  description: string | null;
  unit: string | null;
  qtySent: number | null;
  qtyReceived: number | null;
  qty: number;
  notes: string;
  photoUrl?: string | null;
};

// Reporte explicito de una diferencia (faltante/sobrante/desmedro), cargado
// por el operario de la tienda receptora. Nada se calcula ni aparece
// automaticamente: solo lo que se reporta aqui (ya sea con el boton
// "Reportar diferencias" - que reporta en bloque los faltantes/sobrantes
// detectados por cantidad - o con "Reportar desmedro" - manual, por codigo).
type ReceptionDifferenceReport = {
  id: string;
  request_id: string;
  line_id: string;
  kind: DifferenceKind;
  product_code: string;
  description: string | null;
  unit: string | null;
  qty_sent: number | null;
  qty_received: number | null;
  qty: number;
  notes: string | null;
  photo_url: string | null;
  operator_id: string | null;
  operator_name: string | null;
  created_at: string;
};

type RegularizationStatus = "pendiente" | "atendido" | "regularizado" | "rechazado";

type DifferenceRegularization = {
  id: string;
  diff_key: string;
  kind: DifferenceKind;
  destination_store_code: string;
  source_store_code: string;
  product_code: string;
  description: string | null;
  status: RegularizationStatus;
  requirement_ref: string | null;
  notes: string | null;
  attended_by: string | null;
  attended_by_name: string | null;
  attended_at: string | null;
  regularized_at: string | null;
  created_at: string;
  updated_at: string;
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
const PAGE_SIZE = 50;
const PENDING_REQUESTS_PAGE_SIZE = 1000;
// Con un filtro de tienda especifico el universo ya es acotado (la tienda con
// mas volumen, CD-GPC, tiene ~270 registros como destino): se carga todo de
// una vez para no esconder "en transito" antiguos detras de "Cargar mas".
const FILTERED_PAGE_SIZE = 1000;

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
// Cada combinacion tienda+fecha usada en la sesion crea una key de cache
// nueva (ver requestScopeKey) - sin limpieza esto crecia sin tope hasta
// superar la cuota de localStorage ("Setting the value of ... exceeded the
// quota"), lo que tiraba loadRequests() completo a su catch y mostraba
// "Error cargando requerimientos" aunque la consulta a Supabase si hubiera
// funcionado. pruneRequestCache() borra entradas vencidas (TTL) y, si aun
// asi sobran muchas, las mas viejas por encima de un tope duro.
function pruneRequestCache(exceptKey?: string) {
  if (typeof window === "undefined") return;
  const live: { key: string; savedAt: number }[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) || "";
    if (!key.startsWith(REQUEST_CACHE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "") as RequestCachePayload;
      if (!parsed?.savedAt || Date.now() - parsed.savedAt > REQUEST_CACHE_TTL_MS) { localStorage.removeItem(key); continue; }
      if (key !== exceptKey) live.push({ key, savedAt: parsed.savedAt });
    } catch {
      localStorage.removeItem(key);
    }
  }
  const MAX_LIVE_ENTRIES = 6;
  if (live.length > MAX_LIVE_ENTRIES) {
    live.sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of live.slice(0, live.length - MAX_LIVE_ENTRIES)) localStorage.removeItem(entry.key);
  }
}
function writeRequestCache(key: string, rows: ReceptionRequest[]) {
  if (typeof window === "undefined") return;
  const fullKey = REQUEST_CACHE_PREFIX + key;
  const payload = JSON.stringify({ savedAt: Date.now(), rows } satisfies RequestCachePayload);
  try {
    localStorage.setItem(fullKey, payload);
    pruneRequestCache(fullKey);
  } catch {
    // Cuota llena: se limpia lo vencido/viejo y se reintenta una vez. Si
    // sigue fallando, se deja pasar en silencio - el cache es solo una
    // optimizacion de carga inicial, no debe bloquear loadRequests().
    pruneRequestCache();
    try { localStorage.setItem(fullKey, payload); } catch {}
  }
}
// Un requerimiento puede tener varias guías/documentos en RMS. La clave de
// consolidación debe ser el requerimiento; la guía queda como información
// secundaria dentro de la fila agrupada.
function rqKey(req: ReceptionRequest) { return req.inv_request_no || req.erp_inv_request_id || req.doc_number || req.id; }
function groupedStatus(items: ReceptionRequest[]): ReceptionRequest["reception_status"] {
  if (items.length > 0 && items.every(item => item.reception_status === "completed")) return "completed";
  if (items.some(item => item.reception_status === "in_progress" || item.reception_status === "completed")) return "in_progress";
  return "pending";
}
function isTransitRequest(req: ReceptionRequest) {
  const erpStatus = textValue(req.erp_status);
  return erpStatus ? erpStatus === "T" : req.status_code === "T";
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
      inv_request_no: [...new Set(sorted.map(item => textValue(item.inv_request_no)).filter(Boolean))].join(", ") || base.inv_request_no,
      doc_number: [...new Set(sorted.map(item => textValue(item.doc_number)).filter(Boolean))].join(", ") || base.doc_number,
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
function requestGuides(req: ReceptionRequestGroup) {
  return [...new Set(req.child_requests.map(item => textValue(item.doc_number)).filter(Boolean))].join(", ") || "-";
}
// Un requerimiento puede agrupar guías con estados RMS distintos. Para
// pendientes por recepción se conserva únicamente la parte que sigue en
// tránsito, de modo que el detalle y el Excel no mezclen guías ya recibidas.
function transitOnlyGroup(group: ReceptionRequestGroup): ReceptionRequestGroup | null {
  const children = group.child_requests.filter(isTransitRequest);
  if (children.length === 0) return null;
  if (children.length === group.child_requests.length) return group;
  const sorted = [...children].sort((a, b) =>
    String(b.creation_date || b.request_date || "").localeCompare(String(a.creation_date || a.request_date || ""))
  );
  const base = sorted[0];
  return {
    ...base,
    id: sorted.map(item => item.id).join("|"),
    erp_inv_request_id: [...new Set(sorted.map(item => textValue(item.erp_inv_request_id)).filter(Boolean))].join(", "),
    inv_request_no: [...new Set(sorted.map(item => textValue(item.inv_request_no)).filter(Boolean))].join(", ") || base.inv_request_no,
    doc_number: [...new Set(sorted.map(item => textValue(item.doc_number)).filter(Boolean))].join(", ") || base.doc_number,
    line_count: sorted.reduce((sum, item) => sum + num(item.line_count), 0),
    qty_requested_total: sorted.reduce((sum, item) => sum + num(item.qty_requested_total), 0),
    qty_pending_total: sorted.reduce((sum, item) => sum + num(item.qty_pending_total), 0),
    reception_status: groupedStatus(sorted),
    completed_by_name: null,
    request_ids: sorted.map(item => item.id),
    transfer_count: sorted.length,
    child_requests: sorted,
  };
}
function dateShort(v: string | null) { return v ? new Date(v).toLocaleDateString("es-PE") : "-"; }
function dateTimeForExcel(v: string | null) {
  return v ? new Date(v).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" }) : "";
}
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
  const label = requestDocumentLabel(req);
  return `${label} (${fmt(quantity)})`;
}
function textValue(value: unknown) {
  return String(value ?? "").trim();
}
function requestRequirementLabel(req: ReceptionRequest | ReceptionRequestGroup | null | undefined) {
  return textValue(req?.inv_request_no);
}
function requestDocumentLabel(req: ReceptionRequest | ReceptionRequestGroup | null | undefined, fallback = "RQ") {
  const requirement = requestRequirementLabel(req);
  const guide = textValue(req?.doc_number);
  if (guide && requirement && guide !== requirement) return `${requirement} / ${guide}`;
  return guide || requirement || textValue(req?.erp_inv_request_id) || fallback;
}
function isVisibleReceptionDocument(req: ReceptionRequest | ReceptionRequestGroup) {
  if (req.reception_status === "completed") return true;
  // Cada tienda emite sus guias con su propio correlativo (T200- = CD-GPC,
  // T201- = GPC001, T204- = GPC002, etc. = "T2" + 200+codigo de tienda).
  // No solo CD-GPC emite guias validas, por eso se acepta cualquier T2XX-.
  return /^T2\d{2}-/.test(textValue(req.doc_number).toUpperCase());
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
  if (!reason) return (
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">SIN MOTIVO</span>
  );
  const isUrgente = /urgente/i.test(reason);
  return (
    <span className={`text-[10px] font-black uppercase tracking-widest ${isUrgente ? "text-amber-600" : "text-teal-600"}`}>
      {reason}
    </span>
  );
}

function ErpStatusBadge({ statusCode, erpStatus }: { statusCode: string | null; erpStatus?: string | null }) {
  const effectiveStatus = textValue(erpStatus) || statusCode;
  if (effectiveStatus === "V" || effectiveStatus === "R" || effectiveStatus === "E")
    return <span className="rounded-full bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5">Recibido en RMS</span>;
  if (effectiveStatus === "T")
    return <span className="rounded-full bg-teal-50 text-teal-600 text-[10px] font-black px-2 py-0.5">En tránsito en RMS</span>;
  return null;
}

function StatusBadge({ status }: { status: ReceptionRequest["reception_status"] }) {
  if (status === "completed")
    return <span className="rounded-full bg-emerald-100 text-emerald-700 text-xs font-black px-2.5 py-0.5">Completado</span>;
  if (status === "in_progress")
    return <span className="rounded-full bg-teal-100 text-teal-700 text-xs font-black px-2.5 py-0.5">En proceso</span>;
  return <span className="rounded-full bg-slate-100 text-slate-500 text-xs font-black px-2.5 py-0.5">Pendiente</span>;
}

// ─── Página ───────────────────────────────────────────────────────────────────

type ListPanel = "recepcion" | "pendientes" | "resumen" | "diferencias";

export default function RecepcionModule({ listPanel }: { listPanel: ListPanel }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [user, setUser]         = useState<CyclicUser | null>(null);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores]     = useState<Store[]>([]);
  const [requests, setRequests] = useState<ReceptionRequest[]>([]);
  const [lines, setLines]       = useState<ReceptionLine[]>([]);
  const [scans, setScans]       = useState<ReceptionScan[]>([]);
  const [summaryScans, setSummaryScans] = useState<ReceptionScan[]>([]);
  const [selected, setSelected] = useState<ReceptionRequestGroup | null>(null);
  const [view, setView]         = useState<"list" | "detail">("list");
  const [ready, setReady]       = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [hasMore, setHasMore]   = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exportingPendingRequests, setExportingPendingRequests] = useState(false);
  const [lastErpSync, setLastErpSync] = useState<string | null>(null);
  const [differenceRows, setDifferenceRows] = useState<ReceptionDifferenceRow[]>([]);
  const [loadingDifferences, setLoadingDifferences] = useState(false);
  const [diffDateFrom, setDiffDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [diffDateTo, setDiffDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [regularizations, setRegularizations] = useState<Map<string, DifferenceRegularization>>(new Map());
  const [savingRegularizationKey, setSavingRegularizationKey] = useState<string | null>(null);
  const [regFormInputs, setRegFormInputs] = useState<Record<string, { ref: string; notes: string }>>({});
  const [expandedDiffKey, setExpandedDiffKey] = useState<string | null>(null);
  const [deletingDiffKey, setDeletingDiffKey] = useState<string | null>(null);
  const [selectedDiffKeys, setSelectedDiffKeys] = useState<Set<string>>(new Set());
  const [deletingSelectedDiffs, setDeletingSelectedDiffs] = useState(false);

  // Reporte de diferencias (faltante/sobrante) en bloque y de desmedro (manual)
  const [savingAutoDiffReport, setSavingAutoDiffReport] = useState(false);
  // Pares "line_id::kind" ya reportados para el requerimiento abierto (leido
  // de la base, no solo de esta sesion) - evita reportar la misma diferencia
  // dos veces, incluso si se recarga la pagina o se reabre el requerimiento.
  const [reportedDiffPairs, setReportedDiffPairs] = useState<Set<string>>(new Set());
  const [desmedroLineId, setDesmedroLineId] = useState("");
  const [desmedroQty, setDesmedroQty] = useState("1");
  const [desmedroNotes, setDesmedroNotes] = useState("");
  const [desmedroPhotoFile, setDesmedroPhotoFile] = useState<File | null>(null);
  const [desmedroPhotoPreview, setDesmedroPhotoPreview] = useState("");
  const [savingDesmedroReport, setSavingDesmedroReport] = useState(false);

  // Filtros lista
  // storeFilter vive en la URL (?store=...) para conservarse al navegar entre
  // /recepcion, /recepcion/resumen y /recepcion/diferencias.
  const storeFilter = searchParams.get("store") || "all";
  const [search, setSearch]             = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "in_progress" | "completed">("all");
  const [filterErpStatus, setFilterErpStatus] = useState<"all" | "transit" | "received">("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  // Acota la consulta a reception_requests por creation_date, igual que el
  // resto de modulos (reportes, diferencias) - antes se traia sin tope de
  // fecha (hasta 1000 filas por tienda via FILTERED_PAGE_SIZE), lo que hacia
  // crecer sin limite el cache de localStorage hasta superar la cuota.
  const [reqDateFrom, setReqDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [reqDateTo, setReqDateTo] = useState(() => new Date().toISOString().slice(0, 10));

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
  const mountedRef        = useRef(true);
  const abortRef          = useRef<AbortController | null>(null);
  const loadedOffsetRef   = useRef(0);
  const scannerContainerId = "recepcion-scanner";
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const canViewAllStores = useMemo(() =>
    user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador" || user?.can_access_all_stores,
  [user]);
  const canViewSummary = canViewAllStores;
  const canDeleteRequests = user?.role === "Administrador";

  const storeCodes = useCallback((store: Store | null | undefined) => {
    const codes = [store?.code, store?.erp_sede].filter(Boolean).map(code => String(code).trim());
    // CD-GPC es la unica tienda cuyo "code" es una etiqueta ("CD-GPC") en vez
    // del StoreNo real de RMS. reception_requests siempre usa el StoreNo
    // crudo ("0" para CD-GPC), asi que se agrega ese alias para que el
    // filtrado por tienda (proveedora/receptora) funcione para este almacen.
    if (store?.code === "CD-GPC") codes.push("0");
    return [...new Set(codes)];
  }, []);

  const selectedStoreCodes = useCallback((value: string) => {
    if (!value || value === "all") return [];
    const store = stores.find(item => storeCodes(item).includes(value));
    return storeCodes(store).length > 0 ? storeCodes(store) : [value];
  }, [storeCodes, stores]);

  // Codigos de la tienda del usuario actual: usados para saber si actua como
  // tienda proveedora o tienda receptora en una fila de diferencias.
  const myStoreCodes = useMemo(() => {
    if (!user?.store_id) return [] as string[];
    return storeCodes(stores.find(s => s.id === user.store_id));
  }, [storeCodes, stores, user]);
  // Ademas de Admin/Supervisor/Validador, cualquier usuario con tienda
  // asignada puede ver (y accionar) sus propias diferencias reportadas o
  // por regularizar, aunque no tenga acceso a todas las tiendas.
  const canViewDifferences = canViewAllStores || myStoreCodes.length > 0;

  const requestScopeKey = useCallback(() => {
    if (!user) return "anonymous";
    const dateScope = `${reqDateFrom}_${reqDateTo}`;
    if (canViewAllStores) {
      return `${user.id}:${listPanel}:admin:${storeFilter || "all"}:${dateScope}`;
    }
    const store = stores.find(item => item.id === user.store_id);
    const codes = storeCodes(store);
    return `${user.id}:${listPanel}:store:${(codes.length > 0 ? codes : [user.store_id || "none"]).sort().join("+")}:${dateScope}`;
  }, [canViewAllStores, storeCodes, stores, user, storeFilter, reqDateFrom, reqDateTo, listPanel]);

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
    const documents = sorted.map(group => requestDocumentLabel(group, "")).filter(Boolean);
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
    toast.error(text);
  }, []);

  function updateStoreFilter(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") params.delete("store");
    else params.set("store", value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function tabHref(target: ListPanel) {
    const base = target === "recepcion" ? "/recepcion" : `/recepcion/${target}`;
    const qs = searchParams.toString();
    return qs ? `${base}?${qs}` : base;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "reception")) { window.location.replace("/"); return; }
    fetchDisabledModules().then(disabled => {
      if (!cancelled && isModuleBlockedForUser(disabled, "reception", stored)) setModuleDisabled(true);
    });
    Promise.resolve().then(() => { if (!cancelled) setUser(stored); });
    supabase.from("stores").select("id,code,name,erp_sede,is_active").eq("is_active", true).order("name")
      .then(({ data }) => {
        if (cancelled) return;
        setStores((data || []) as Store[]);
        setReady(true);
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      abortRef.current?.abort();
      if (emptyRetryTimer.current !== null) window.clearTimeout(emptyRetryTimer.current);
    };
  }, []);

  useEffect(() => { if (ready && user) void loadRequests(); }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && user) void loadRequests(); }, [storeFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ready && user && listPanel === "diferencias") void loadDifferencesReport();
    // Antes esta carga inicial dependia de que el boton de la pestaña
    // "diferencias" la disparara a mano al hacer click (setListPanel +
    // loadDifferencesReport en el mismo onClick); ahora que "diferencias" es
    // una ruta propia (se puede llegar por link o directamente), hace falta
    // este efecto disparado por [ready, user] para no depender de ese click.
  }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ready && user && listPanel === "diferencias") void loadDifferencesReport();
  }, [storeFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready || !user) return;
    if (listPanel === "resumen" && !canViewSummary) { router.replace(tabHref("recepcion")); return; }
    if (listPanel === "diferencias" && !canViewDifferences) { router.replace(tabHref("recepcion")); return; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user, listPanel, canViewSummary, canViewDifferences]);
  useEffect(() => {
    if (!ready || !user) return;
    const t = setTimeout(() => void loadRequests(), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ready && user) void loadRequests();
  }, [reqDateFrom, reqDateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cargar requerimientos ─────────────────────────────────────────────────

  // Busqueda por codigo de producto: reception_requests no tiene el codigo
  // (vive en las lineas), asi que primero se resuelve a que request_id
  // pertenecen las lineas que matchean y esos ids se suman al OR de texto.
  // Tope de 3 caracteres + limit(300) para no repetir el bug real de picking
  // (2026-07-14: un .in() con demasiados ids generaba URLs de 40k+
  // caracteres y Supabase respondia 400) - un partial de 1-2 caracteres
  // puede matchear miles de lineas.
  const PRODUCT_SEARCH_MIN_LEN = 3;
  const PRODUCT_SEARCH_LIMIT = 300;
  async function findRequestIdsByProductCode(searchText: string, signal: AbortSignal): Promise<string[]> {
    if (searchText.length < PRODUCT_SEARCH_MIN_LEN) return [];
    const escaped = searchText.replace(/%/g, "\\%").replace(/_/g, "\\_");
    try {
      const { data } = await supabase
        .from("reception_request_lines")
        .select("request_id")
        .or([
          `product_code.ilike.%${escaped}%`,
          `sku.ilike.%${escaped}%`,
          `barcode.ilike.%${escaped}%`,
        ].join(","))
        .limit(PRODUCT_SEARCH_LIMIT)
        .abortSignal(signal);
      return [...new Set((data || []).map(row => row.request_id as string))];
    } catch {
      return [];
    }
  }

  function buildReceptionQuery(
    signal: AbortSignal, codes: string[], searchText: string, offset: number, pageSize: number,
    fromIso: string, toIso: string, productRequestIds: string[] = [],
  ) {
    let q = supabase
      .from("reception_requests")
      .select("*")
      .order("creation_date", { ascending: false })
      .range(offset, offset + pageSize - 1)
      .gte("creation_date", fromIso)
      .lte("creation_date", toIso)
      .abortSignal(signal);
    if (searchText) {
      const escaped = searchText.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const orParts = [
        `doc_number.ilike.%${escaped}%`,
        `inv_request_no.ilike.%${escaped}%`,
        `destination_store_name.ilike.%${escaped}%`,
        `source_store_name.ilike.%${escaped}%`,
        `erp_inv_request_id.ilike.%${escaped}%`,
      ];
      if (productRequestIds.length > 0) orParts.push(`id.in.(${productRequestIds.join(",")})`);
      q = q.or(orParts.join(","));
    } else {
      q = q.or("status_code.eq.T,status_code.eq.R,reception_status.in.(in_progress,completed)");
    }
    if (codes.length > 0) q = q.in("destination_store_code", codes);
    return q;
  }

  function buildPendingReceptionQuery(signal: AbortSignal, codes: string[], offset: number) {
    let q = supabase
      .from("reception_requests")
      .select("*")
      // RMS puede dejar el estado de tránsito en status_code o en erp_status;
      // no se debe exigir guía/documento para que aparezca el requerimiento.
      .eq("erp_status", "T")
      .order("creation_date", { ascending: false })
      .range(offset, offset + PENDING_REQUESTS_PAGE_SIZE - 1)
      .abortSignal(signal);
    if (codes.length > 0) q = q.in("destination_store_code", codes);
    return q;
  }

  async function loadRequests() {
    const seq = ++loadSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const scopeKey = requestScopeKey();
    const cachedRows = readRequestCache(scopeKey);
    const fallbackCachedRows = listPanel === "pendientes" ? [] : (cachedRows.length > 0 ? cachedRows : readAnyRequestCache(user?.id));
    if (requests.length === 0 && cachedRows.length > 0) setRequests(cachedRows);
    else if (requests.length === 0 && fallbackCachedRows.length > 0) setRequests(fallbackCachedRows);
    setLoading(true);
    try {
      const store = !canViewAllStores && user?.store_id ? stores.find(s => s.id === user.store_id) : null;
      const codes = store ? storeCodes(store) : selectedStoreCodes(storeFilter);
      const syncStatusPromise = supabase
        .from("erp_sync_status").select("synced_at,updated_at")
        .eq("id", "reception_requests").abortSignal(signal).maybeSingle();

      if (listPanel === "pendientes") {
        const pendingRows: ReceptionRequest[] = [];
        for (let offset = 0; ; offset += PENDING_REQUESTS_PAGE_SIZE) {
          const { data, error } = await buildPendingReceptionQuery(signal, codes, offset);
          if (signal.aborted || !mountedRef.current || seq !== loadSeq.current) return;
          if (error) throw error;
          const page = (data || []) as ReceptionRequest[];
          pendingRows.push(...page);
          if (page.length < PENDING_REQUESTS_PAGE_SIZE) break;
        }
        loadedOffsetRef.current = pendingRows.length;
        setHasMore(false);
        const syncStatus = await syncStatusPromise;
        if (seq === loadSeq.current && mountedRef.current) {
          setLastErpSync(syncStatus.data?.synced_at || syncStatus.data?.updated_at || pendingRows[0]?.request_date || null);
          applyRequests(pendingRows);
        }
        return;
      }

      const pageSize = codes.length > 0 ? FILTERED_PAGE_SIZE : PAGE_SIZE;
      const fromIso = `${reqDateFrom}T00:00:00`;
      const toIso = `${reqDateTo}T23:59:59`;
      const trimmedSearch = search.trim();
      const productRequestIds = trimmedSearch ? await findRequestIdsByProductCode(trimmedSearch, signal) : [];
      if (signal.aborted || !mountedRef.current || seq !== loadSeq.current) return;

      const { data, error } = await buildReceptionQuery(signal, codes, trimmedSearch, 0, pageSize, fromIso, toIso, productRequestIds);
      if (signal.aborted || !mountedRef.current || seq !== loadSeq.current) return;
      if (error) throw error;

      const rows = (data || []) as ReceptionRequest[];
      loadedOffsetRef.current = rows.length;
      setHasMore(rows.length === pageSize);

      const syncStatus = await syncStatusPromise;
      if (seq === loadSeq.current && mountedRef.current) {
        setLastErpSync(syncStatus.data?.synced_at || syncStatus.data?.updated_at || rows[0]?.request_date || null);
      }
      if (rows.length === 0) {
        scheduleEmptyRetry();
        if (requests.length > 0) { setHasMore(false); return; }
        if (fallbackCachedRows.length > 0) setRequests(fallbackCachedRows);
        return;
      }
      if (emptyRetryTimer.current !== null) {
        window.clearTimeout(emptyRetryTimer.current);
        emptyRetryTimer.current = null;
      }
      applyRequests(rows);
    } catch (e: any) {
      if (seq === loadSeq.current && mountedRef.current && !signal.aborted) showMsg("Error cargando requerimientos: " + e.message);
    }
    finally {
      if (seq === loadSeq.current && mountedRef.current) setLoading(false);
    }
  }

  // ─── Cargar más ────────────────────────────────────────────────────────────

  async function loadMore() {
    if (!hasMore || loadingMore || !mountedRef.current) return;
    setLoadingMore(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const store = !canViewAllStores && user?.store_id ? stores.find(s => s.id === user.store_id) : null;
      const codes = store ? storeCodes(store) : selectedStoreCodes(storeFilter);
      const pageSize = codes.length > 0 ? FILTERED_PAGE_SIZE : PAGE_SIZE;
      const offset = loadedOffsetRef.current;
      const fromIso = `${reqDateFrom}T00:00:00`;
      const toIso = `${reqDateTo}T23:59:59`;
      const trimmedSearch = search.trim();
      const productRequestIds = trimmedSearch ? await findRequestIdsByProductCode(trimmedSearch, signal) : [];
      if (signal.aborted || !mountedRef.current) return;
      const { data, error } = await buildReceptionQuery(signal, codes, trimmedSearch, offset, pageSize, fromIso, toIso, productRequestIds);
      if (signal.aborted || !mountedRef.current) return;
      if (error) throw error;
      const rows = (data || []) as ReceptionRequest[];
      loadedOffsetRef.current = offset + rows.length;
      setHasMore(rows.length === pageSize);
      setRequests(prev => {
        const next = [...prev, ...rows];
        writeRequestCache(requestScopeKey(), next);
        return next;
      });
    } catch (e: any) {
      if (!signal.aborted && mountedRef.current) showMsg("Error cargando más: " + e.message);
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }

  // ─── Abrir requerimiento ───────────────────────────────────────────────────

  async function fetchReportedDiffPairs(requestIds: string[]): Promise<Set<string>> {
    const { data } = await supabase
      .from("reception_difference_reports")
      .select("line_id,kind")
      .in("request_id", requestIds);
    return new Set((data || []).map(row => `${row.line_id}::${row.kind}`));
  }

  async function openRequest(req: ReceptionRequestGroup) {
    setSelected(req);
    setView("detail");
    setActiveLine(null);
    setScanProduct("");
    setLoading(true);
    setReportedDiffPairs(new Set());
    try {
      const [{ data: lineData, error: lineErr }, { data: scanData }, reportedPairs] = await Promise.all([
        supabase.from("reception_request_lines").select("*").in("request_id", req.request_ids).order("line_id"),
        supabase.from("reception_scans").select("*").in("request_id", req.request_ids).order("created_at"),
        fetchReportedDiffPairs(req.request_ids),
      ]);
      if (lineErr) throw lineErr;
      setLines((lineData || []) as ReceptionLine[]);
      setScans((scanData || []) as ReceptionScan[]);
      setReportedDiffPairs(reportedPairs);
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
      const [{ data: bySku }, { data: byBarcode }, { data: byErpSku }] = await Promise.all([
        supabase.from("cyclic_products").select("sku,barcode,description,unit").in("sku", candidates).eq("is_active", true).limit(1),
        supabase.from("cyclic_products").select("sku,barcode,description,unit").in("barcode", candidates).eq("is_active", true).limit(1),
        supabase.from("cyclic_products").select("sku,barcode,description,unit").in("erp_sku", candidates).eq("is_active", true).limit(1),
      ]);
      const direct = ((bySku || [])[0] || (byBarcode || [])[0] || (byErpSku || [])[0]) as ProductLookup | undefined;
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

  async function createExtraLine(code: string, targetRequestId = ""): Promise<ReceptionLine | null> {
    if (!selected) return null;
    const raw = code.trim();
    const normalizedCode = normalize(fullProductCode(raw) || raw);

    const baseRequest =
      selected.child_requests.find(req => req.id === targetRequestId) ||
      selected.child_requests.find(req => selected.request_ids.includes(req.id)) ||
      selected.child_requests[0] ||
      selected;
    const requestId = baseRequest.id;
    const existing = lines.find(line =>
      line.request_id === requestId &&
      line.qty_requested === 0 &&
      normalize(line.product_code) === normalizedCode
    );
    if (existing) return existing;

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
        let targetRequestId = "";
        const requestOptions = selected?.child_requests.filter(req => selected.request_ids.includes(req.id)) || [];
        if (requestOptions.length > 1) {
          const choiceText = requestOptions
            .map((req, index) => `${index + 1}) ${requestDocumentLabel(req)}`)
            .join("\n");
          const choice = window.prompt(`Este producto es sobrante. En que guia/requerimiento deseas registrarlo?\n\n${choiceText}`);
          if (choice === null) return;
          const selectedIndex = Number(choice) - 1;
          if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= requestOptions.length) {
            showMsg("Seleccion de guia invalida para el sobrante.");
            return;
          }
          targetRequestId = requestOptions[selectedIndex].id;
        }
        const extraLine = await createExtraLine(code, targetRequestId);
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
      const rawQty = input?.qty ?? (sourceLines.length === 1 ? String(editQty) : "");
      const hasQty = String(rawQty).trim() !== "";
      const qty = num(rawQty);
      const notes = (input?.notes ?? editNotes).trim();
      return { line, qty, notes, hasQty };
    }).filter(row => row.hasQty && row.qty >= 0);
    if (rows.length === 0) { showMsg("Ingresa una cantidad para registrar la linea."); return; }
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
      showMsg("Recepción registrada.");
    } catch (e: any) { showMsg("Error guardando: " + e.message); }
    finally { setSaving(false); }
  }

  // ─── Editar scan ───────────────────────────────────────────────────────────

  async function saveEditScan() {
    if (!editingScanId || !user) return;
    const qty = num(editScanQty);
    if (qty < 0) { showMsg("La cantidad no puede ser negativa."); return; }
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
    const missingLine = progressLines.find(line => !consolidatedHasScan(line));
    if (missingLine) {
      const targetLine = missingLine.source_lines[0] || missingLine;
      setActiveLine(targetLine);
      prepareLineInputs(targetLine);
      setEditLineInputs(Object.fromEntries(
        missingLine.source_lines.map(line => [line.id, { qty: "0", notes: "No recibido" }])
      ));
      setEditQty(0);
      setEditNotes("No recibido");
      setTimeout(() => {
        lineRefs.current[missingLine.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
      window.alert(`Falta registrar el codigo ${missingLine.product_code}. Si no se recibio, guarda esta linea con cantidad 0 antes de marcar el requerimiento como completado.`);
      return;
    }

    if (diffSuggestions.length > 0) {
      if (!window.confirm(`Hay ${diffSuggestions.length} codigo(s) con diferencia de cantidad detectada.\n\nPodras reportarlas con el boton "Reportar diferencias" una vez completado el requerimiento.\n\nDeseas completar de todas formas?`)) return;
    }
    if (!window.confirm("Marcar este requerimiento como completado?")) return;

    setSaving(true);
    try {
      const completedAt = new Date().toISOString();
      const { data, error } = await supabase.from("reception_requests").update({
        reception_status:  "completed",
        completed_at:      completedAt,
        completed_by_id:   user.id,
        completed_by_name: user.full_name,
        updated_at:        new Date().toISOString(),
      }).in("id", selected.request_ids).select("id");
      if (error) throw error;
      const updatedIds = new Set((data || []).map(row => row.id));
      const missingIds = selected.request_ids.filter(id => !updatedIds.has(id));
      if (missingIds.length > 0) throw new Error(`No se actualizaron ${missingIds.length} documento(s) del grupo.`);
      setSelected(prev => prev ? {
        ...prev,
        reception_status: "completed",
        completed_at: completedAt,
        completed_by_name: user.full_name,
        child_requests: prev.child_requests.map(req => selected.request_ids.includes(req.id)
          ? { ...req, reception_status: "completed", completed_at: completedAt, completed_by_name: user.full_name }
          : req
        ),
      } : null);
      updateRequests(prev => prev.map(r => selected.request_ids.includes(r.id)
        ? { ...r, reception_status: "completed", completed_at: completedAt, completed_by_name: user.full_name }
        : r
      ));
      showMsg("Requerimiento completado.");
      if (listPanel === "diferencias") void loadDifferencesReport();
    } catch (e: any) { showMsg("Error: " + e.message); }
    finally { setSaving(false); }
  }

  async function reportarDiferenciasAutomaticas() {
    if (!selected || !user) return;
    if (selected.reception_status !== "completed") { showMsg("Marca el requerimiento como completado antes de reportar diferencias."); return; }
    if (diffSuggestions.length === 0) { showMsg("No hay diferencias de cantidad para reportar."); return; }
    setSavingAutoDiffReport(true);
    try {
      const rows = diffSuggestions.map(({ line, difference }) => {
        const sourceLine = line.source_lines[0] || line;
        const requested = num(line.qty_requested);
        const received = consolidatedScanTotal(line);
        return {
          request_id: sourceLine.request_id,
          line_id: sourceLine.id,
          kind: (difference > 0 ? "sobrante" : "faltante") as DifferenceKind,
          product_code: line.product_code,
          description: line.description,
          unit: line.unit,
          qty_sent: requested,
          qty_received: received,
          qty: Math.abs(difference),
          operator_id: user.id,
          operator_name: user.full_name,
        };
      });
      const { error } = await supabase.from("reception_difference_reports").insert(rows);
      if (error) {
        if (error.code === "23505") {
          showMsg("Alguna de estas diferencias ya habia sido reportada. Se actualizo la lista.");
          setReportedDiffPairs(await fetchReportedDiffPairs(selected.request_ids));
          return;
        }
        throw error;
      }
      setReportedDiffPairs(prev => {
        const next = new Set(prev);
        for (const row of rows) next.add(`${row.line_id}::${row.kind}`);
        return next;
      });
      showMsg(`${rows.length} diferencia(s) reportada(s).`);
      if (listPanel === "diferencias") void loadDifferencesReport();
    } catch (e: any) {
      showMsg("Error al reportar diferencias: " + e.message);
    } finally {
      setSavingAutoDiffReport(false);
    }
  }

  function setDesmedroPhoto(file: File | null) {
    setDesmedroPhotoPreview(prev => { if (prev) URL.revokeObjectURL(prev); return file ? URL.createObjectURL(file) : ""; });
    setDesmedroPhotoFile(file);
  }

  function resetDesmedroForm() {
    setDesmedroLineId("");
    setDesmedroQty("1");
    setDesmedroNotes("");
    setDesmedroPhoto(null);
  }

  async function reportarDesmedro() {
    if (!selected || !user) return;
    if (selected.reception_status !== "completed") { showMsg("Marca el requerimiento como completado antes de reportar un desmedro."); return; }
    const line = consolidatedLines.find(item => item.id === desmedroLineId);
    if (!line) { showMsg("Selecciona un codigo."); return; }
    const sourceLine = line.source_lines[0] || line;
    if (reportedDiffPairs.has(`${sourceLine.id}::desmedro`)) {
      showMsg("Ya se reporto un desmedro para este codigo.");
      return;
    }
    const qty = num(desmedroQty);
    if (qty <= 0) { showMsg("Ingresa una cantidad valida."); return; }
    setSavingDesmedroReport(true);
    try {
      let photoUrl: string | null = null;
      if (desmedroPhotoFile) {
        const path = `${selected.request_ids[0]}/${crypto.randomUUID()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("reception-damage-photos")
          .upload(path, desmedroPhotoFile);
        if (uploadError) throw uploadError;
        const { data: pub } = supabase.storage.from("reception-damage-photos").getPublicUrl(path);
        photoUrl = pub.publicUrl;
      }
      const { error: insertError } = await supabase.from("reception_difference_reports").insert({
        request_id: sourceLine.request_id,
        line_id: sourceLine.id,
        kind: "desmedro",
        product_code: line.product_code,
        description: line.description,
        unit: line.unit,
        qty_sent: null,
        qty_received: null,
        qty,
        notes: desmedroNotes.trim() || null,
        photo_url: photoUrl,
        operator_id: user.id,
        operator_name: user.full_name,
      });
      if (insertError) {
        if (insertError.code === "23505") {
          showMsg("Ya se reporto un desmedro para este codigo. Se actualizo la lista.");
          setReportedDiffPairs(await fetchReportedDiffPairs(selected.request_ids));
          return;
        }
        throw insertError;
      }
      setReportedDiffPairs(prev => new Set(prev).add(`${sourceLine.id}::desmedro`));
      resetDesmedroForm();
      showMsg("Desmedro reportado.");
      if (listPanel === "diferencias") void loadDifferencesReport();
    } catch (e: any) {
      showMsg("Error al reportar desmedro: " + e.message);
    } finally {
      setSavingDesmedroReport(false);
    }
  }

  async function deleteRequestGroup(req: ReceptionRequestGroup) {
    if (!canDeleteRequests) return;
    const label = requestDocumentLabel(req);
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
    <title>Recepción ${requestDocumentLabel(selected)}</title>
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
      <div class="info-item"><label>Documento</label>${requestDocumentLabel(selected, "-")}</div>
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
    if (!canViewSummary && !canViewDifferences) return;
    setLoadingDifferences(true);
    setSelectedDiffKeys(new Set());
    try {
      // Solo se muestra lo que el operario reporto explicitamente al
      // completar la recepcion (tabla reception_difference_reports) - nada
      // se calcula ni aparece solo. El filtro de fecha aplica sobre la fecha
      // del reporte, no de la recepcion.
      const fromIso = `${diffDateFrom}T00:00:00`;
      const toIso = `${diffDateTo}T23:59:59`;
      const { data: reportsData, error: reportsError } = await supabase
        .from("reception_difference_reports")
        .select("*")
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        .order("created_at", { ascending: false });
      if (reportsError) throw reportsError;
      const reports = (reportsData || []) as ReceptionDifferenceReport[];
      if (reports.length === 0) {
        setDifferenceRows([]);
        setRegularizations(new Map());
        return;
      }

      const requestIds = [...new Set(reports.map(report => report.request_id))];
      const chunks: string[][] = [];
      for (let i = 0; i < requestIds.length; i += 200) chunks.push(requestIds.slice(i, i + 200));
      const requestResults = await Promise.all(chunks.map(ids =>
        supabase.from("reception_requests").select("*").in("id", ids)
      ));
      const requestsError = requestResults.find(result => result.error)?.error;
      if (requestsError) throw requestsError;
      const requestsById = new Map<string, ReceptionRequest>();
      for (const req of requestResults.flatMap(result => (result.data || []) as ReceptionRequest[])) {
        requestsById.set(req.id, req);
      }

      // Alcance: un usuario con acceso a todas las tiendas puede acotar por
      // tienda destino (filtro de la lista); un usuario de una tienda
      // especifica ve solo donde su tienda es proveedora o receptora.
      const myStore = !canViewAllStores && user?.store_id ? stores.find(s => s.id === user.store_id) : null;
      const myCodes = myStore ? storeCodes(myStore) : [];
      const filterCodes = canViewAllStores ? selectedStoreCodes(storeFilter) : myCodes;

      const rows: ReceptionDifferenceRow[] = [];
      for (const report of reports) {
        const req = requestsById.get(report.request_id);
        if (!req) continue;
        if (filterCodes.length > 0) {
          const matches = canViewAllStores
            ? filterCodes.includes(req.destination_store_code)
            : filterCodes.includes(req.destination_store_code) || filterCodes.includes(req.source_store_code);
          if (!matches) continue;
        }
        rows.push({
          key: report.id,
          diffKey: report.id,
          kind: report.kind,
          document: requestDocumentLabel(req),
          destinationStore: req.destination_store_name || req.destination_store_code,
          destinationStoreCode: req.destination_store_code,
          sourceStore: req.source_store_name || req.source_store_code,
          sourceStoreCode: req.source_store_code,
          deliveredAt: req.completed_at,
          deliveredByName: req.completed_by_name,
          dispatchedByName: req.dispatched_by_name,
          reportedAt: report.created_at,
          reportedByName: report.operator_name,
          productCode: report.product_code,
          description: report.description,
          unit: report.unit,
          qtySent: report.qty_sent,
          qtyReceived: report.qty_received,
          qty: num(report.qty),
          notes: report.notes?.trim() || "",
          photoUrl: report.photo_url,
        });
      }

      setDifferenceRows(rows.sort((a, b) =>
        String(b.reportedAt || "").localeCompare(String(a.reportedAt || "")) ||
        a.destinationStore.localeCompare(b.destinationStore, "es") ||
        a.document.localeCompare(b.document, "es")
      ));

      const diffKeys = [...new Set(rows.map(row => row.diffKey))];
      const regChunks: string[][] = [];
      for (let i = 0; i < diffKeys.length; i += 200) regChunks.push(diffKeys.slice(i, i + 200));
      const regResults = await Promise.all(regChunks.map(ids =>
        supabase.from("reception_difference_regularizations").select("*").in("diff_key", ids)
      ));
      const regError = regResults.find(result => result.error)?.error;
      if (regError) throw regError;
      const regMap = new Map<string, DifferenceRegularization>();
      for (const reg of regResults.flatMap(result => (result.data || []) as DifferenceRegularization[])) {
        regMap.set(reg.diff_key, reg);
      }

      // El paso de "atendido" a "regularizado" lo hace un sync del lado del
      // servidor (sync-regularizaciones.js, cada 5 min) que verifica el N° de
      // requerimiento directo contra RMS. Aqui solo se lee el estado actual.
      setRegularizations(regMap);
    } catch (e: any) {
      showMsg("No se pudo cargar el reporte de diferencias: " + e.message);
    } finally {
      setLoadingDifferences(false);
    }
  }

  function exportDifferencesExcel() {
    if (differenceRows.length === 0) { showMsg("No hay diferencias para exportar."); return; }
    const kindLabel = (kind: DifferenceKind) =>
      kind === "sobrante" ? "Sobrante" : kind === "desmedro" ? "Desmedro" : "Faltante";
    const statusLabel = (status: RegularizationStatus) =>
      status === "regularizado" ? "Regularizado"
        : status === "atendido" ? "Atendido"
          : status === "rechazado" ? "Rechazado"
            : "Pendiente";
    const rows = differenceRows.map(row => {
      const reg = regularizations.get(row.diffKey);
      const diffQty = row.kind === "desmedro" ? null : (row.kind === "sobrante" ? row.qty : -row.qty);
      return {
        "Tienda destino": row.destinationStore,
        Documento: row.document,
        "Tienda origen": row.sourceStore,
        "Entregó guía": row.dispatchedByName || "",
        "Recepción completada": row.deliveredAt ? new Date(row.deliveredAt).toLocaleString("es-PE") : "",
        "Recibió": row.deliveredByName || "",
        Código: row.productCode,
        Descripción: row.description || "",
        Unidad: row.unit || "",
        Tipo: kindLabel(row.kind),
        Enviado: row.qtySent ?? "",
        Recibido: row.qtyReceived ?? "",
        Diferencia: diffQty ?? -row.qty,
        "Reportado": new Date(row.reportedAt).toLocaleString("es-PE"),
        "Reportado por": row.reportedByName || "",
        Notas: row.notes || "",
        Estado: statusLabel(reg?.status || "pendiente"),
        "N° Requerimiento reg.": reg?.requirement_ref || "",
        "Atendido por": reg?.attended_by_name || "",
        "Atendido el": reg?.attended_at ? new Date(reg.attended_at).toLocaleString("es-PE") : "",
        "Regularizado el": reg?.regularized_at ? new Date(reg.regularized_at).toLocaleString("es-PE") : "",
      };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Diferencias");
    XLSX.writeFile(wb, `diferencias-recepcion-${diffDateFrom}_a_${diffDateTo}.xlsx`);
  }

  function regularizationDefaults(row: ReceptionDifferenceRow): Omit<DifferenceRegularization, "id" | "created_at"> {
    const existing = regularizations.get(row.diffKey);
    return {
      diff_key: row.diffKey,
      kind: row.kind,
      destination_store_code: row.destinationStoreCode,
      source_store_code: row.sourceStoreCode,
      product_code: row.productCode,
      description: row.description,
      status: existing?.status || "pendiente",
      requirement_ref: existing?.requirement_ref ?? null,
      notes: existing?.notes ?? null,
      attended_by: existing?.attended_by ?? null,
      attended_by_name: existing?.attended_by_name ?? null,
      attended_at: existing?.attended_at ?? null,
      regularized_at: existing?.regularized_at ?? null,
      updated_at: new Date().toISOString(),
    };
  }

  async function saveRegularization(row: ReceptionDifferenceRow, patch: Partial<DifferenceRegularization>) {
    if (!user) return;
    setSavingRegularizationKey(row.diffKey);
    try {
      const payload = { ...regularizationDefaults(row), ...patch, updated_at: new Date().toISOString() };
      const { data, error } = await supabase
        .from("reception_difference_regularizations")
        .upsert(payload, { onConflict: "diff_key" })
        .select("*")
        .single();
      if (error) throw error;
      setRegularizations(prev => new Map(prev).set(row.diffKey, data as DifferenceRegularization));
      setRegFormInputs(prev => { const next = { ...prev }; delete next[row.diffKey]; return next; });
    } catch (e: any) {
      showMsg("Error al actualizar la diferencia: " + e.message);
    } finally {
      setSavingRegularizationKey(null);
    }
  }

  // Tienda proveedora: coloca el N° de requerimiento de regularizacion y lo
  // marca atendido. El paso a "regularizado" es automatico (ver
  // loadDifferencesReport) cuando ese requerimiento sale recibido en RMS.
  function marcarAtendido(row: ReceptionDifferenceRow) {
    const inputs = regFormInputs[row.diffKey] || { ref: "", notes: "" };
    if (!inputs.ref.trim()) { showMsg("Ingresa el numero de requerimiento."); return; }
    void saveRegularization(row, {
      status: "atendido",
      requirement_ref: inputs.ref.trim(),
      notes: inputs.notes.trim() || null,
      attended_by: user!.id,
      attended_by_name: user!.full_name,
      attended_at: new Date().toISOString(),
    });
  }

  // Tienda proveedora: rechaza la diferencia reportada (ej. no corresponde,
  // ya fue entregada, etc.). A diferencia de "atendido", las notas son
  // obligatorias para dejar constancia del motivo. Es un estado terminal:
  // no pasa a "regularizado" automaticamente.
  function marcarRechazado(row: ReceptionDifferenceRow) {
    const inputs = regFormInputs[row.diffKey] || { ref: "", notes: "" };
    if (!inputs.notes.trim()) { showMsg("Ingresa el motivo del rechazo en notas."); return; }
    void saveRegularization(row, {
      status: "rechazado",
      requirement_ref: inputs.ref.trim() || null,
      notes: inputs.notes.trim(),
      attended_by: user!.id,
      attended_by_name: user!.full_name,
      attended_at: new Date().toISOString(),
    });
  }

  // Eliminar un reporte de diferencia (faltante/sobrante/desmedro), solo
  // disponible para el rol Administrador. Tambien limpia su regularizacion
  // asociada (si existe) para no dejar registros huerfanos.
  async function deleteDifferenceReport(row: ReceptionDifferenceRow) {
    if (!canDeleteRequests) return;
    const confirmed = window.confirm(
      `¿Eliminar este reporte de ${row.kind} (${row.productCode})? Esta accion no se puede deshacer.`
    );
    if (!confirmed) return;
    setDeletingDiffKey(row.diffKey);
    try {
      await supabase.from("reception_difference_regularizations").delete().eq("diff_key", row.diffKey);
      const { error } = await supabase.from("reception_difference_reports").delete().eq("id", row.diffKey);
      if (error) throw error;
      setDifferenceRows(prev => prev.filter(item => item.diffKey !== row.diffKey));
      setRegularizations(prev => {
        if (!prev.has(row.diffKey)) return prev;
        const next = new Map(prev);
        next.delete(row.diffKey);
        return next;
      });
      if (expandedDiffKey === row.diffKey) setExpandedDiffKey(null);
      showMsg("Reporte de diferencia eliminado.");
    } catch (e: any) {
      showMsg("Error eliminando el reporte: " + e.message);
    } finally {
      setDeletingDiffKey(null);
    }
  }

  function toggleDiffRowSelection(diffKey: string) {
    setSelectedDiffKeys(prev => {
      const next = new Set(prev);
      if (next.has(diffKey)) next.delete(diffKey);
      else next.add(diffKey);
      return next;
    });
  }

  function toggleSelectAllDiffRows() {
    setSelectedDiffKeys(prev => {
      const allKeys = differenceRows.map(row => row.diffKey);
      const allSelected = allKeys.length > 0 && allKeys.every(key => prev.has(key));
      return allSelected ? new Set() : new Set(allKeys);
    });
  }

  // Eliminar en bloque los reportes de diferencia seleccionados (o todos,
  // si se marcaron todos con el checkbox del encabezado). Solo Administrador.
  async function deleteSelectedDifferenceReports() {
    if (!canDeleteRequests) return;
    const keys = [...selectedDiffKeys];
    if (keys.length === 0) return;
    const confirmed = window.confirm(
      `¿Eliminar ${keys.length} reporte(s) de diferencia seleccionados? Esta accion no se puede deshacer.`
    );
    if (!confirmed) return;
    setDeletingSelectedDiffs(true);
    try {
      await supabase.from("reception_difference_regularizations").delete().in("diff_key", keys);
      const { error } = await supabase.from("reception_difference_reports").delete().in("id", keys);
      if (error) throw error;
      setDifferenceRows(prev => prev.filter(item => !keys.includes(item.diffKey)));
      setRegularizations(prev => {
        const next = new Map(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (expandedDiffKey && keys.includes(expandedDiffKey)) setExpandedDiffKey(null);
      setSelectedDiffKeys(new Set());
      showMsg(`${keys.length} reporte(s) de diferencia eliminado(s).`);
    } catch (e: any) {
      showMsg("Error eliminando los reportes: " + e.message);
    } finally {
      setDeletingSelectedDiffs(false);
    }
  }

  // ─── Filtros ───────────────────────────────────────────────────────────────

  const requestGroups = useMemo(
    () => buildRequestGroups(requests),
    [requests]
  );

  const scopedRequestGroups = useMemo(() => {
    if (!canViewAllStores || storeFilter === "all") return requestGroups;
    const targetCodes = new Set(selectedStoreCodes(storeFilter).map(normalize));
    return requestGroups.filter(req =>
      req.child_requests.some(item => targetCodes.has(normalize(item.destination_store_code)))
    );
  }, [canViewAllStores, requestGroups, selectedStoreCodes, storeFilter]);

  const reasonOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const req of requestGroups) {
      const key = req.reason ? normalizeReason(req.reason) : "";
      if (!seen.has(key)) seen.set(key, req.reason || "");
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label: label || "Sin motivo" }))
      .sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [requestGroups]);

  const filteredRequests = useMemo(() => scopedRequestGroups.filter(r => {
    if (!isVisibleReceptionDocument(r)) return false;
    if (filterStatus !== "all" && r.reception_status !== filterStatus) return false;
    if (filterErpStatus !== "all") {
      const es = textValue(r.erp_status) || r.status_code;
      if (filterErpStatus === "transit"  && es !== "T")                          return false;
      if (filterErpStatus === "received" && es !== "V" && es !== "R" && es !== "E") return false;
    }
    if (reasonFilter !== "all") {
      const key = r.reason ? normalizeReason(r.reason) : "";
      if (key !== reasonFilter) return false;
    }
    return true;
  }), [scopedRequestGroups, filterStatus, filterErpStatus, reasonFilter]);

  const pendingRequestsByStore = useMemo(() => {
    const grouped = new Map<string, ReceptionRequestGroup[]>();
    for (const request of scopedRequestGroups) {
      const pendingRequest = transitOnlyGroup(request);
      if (!pendingRequest) continue;
      const key = pendingRequest.destination_store_code || pendingRequest.destination_store_name || "SIN_TIENDA";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(pendingRequest);
    }
    return [...grouped.entries()]
      .map(([key, rows]) => ({
        key,
        name: rows[0]?.destination_store_name || rows[0]?.destination_store_code || "Sin tienda",
        rows: [...rows].sort((a, b) => String(b.creation_date || b.request_date || "").localeCompare(String(a.creation_date || a.request_date || ""))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [scopedRequestGroups]);

  async function exportPendingRequestsExcel() {
    setExportingPendingRequests(true);
    try {
      const exportRows = pendingRequestsByStore.flatMap(group => group.rows.map(request => ({
        Tienda: request.destination_store_name || request.destination_store_code || group.name,
        "Código tienda": request.destination_store_code || "",
        Requerimiento: requestRequirementLabel(request),
        "Guías / documentos": requestGuides(request),
        "Estado RMS": "En tránsito",
        "Fecha requerimiento": dateTimeForExcel(request.creation_date),
        "Fecha tránsito": dateTimeForExcel(request.request_date),
        "Tienda origen": request.source_store_name || request.source_store_code || "",
        "Código origen": request.source_store_code || "",
        Motivo: request.reason || "",
        "Líneas": num(request.line_count),
        "Cantidad solicitada": num(request.qty_requested_total),
        "Cantidad pendiente": num(request.qty_pending_total),
        "Estado recepción": request.reception_status === "completed" ? "Completado" : request.reception_status === "in_progress" ? "En proceso" : "Pendiente",
        "Recepcionado por": request.completed_by_name || "",
        Observaciones: request.notes || "",
      })));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), "Pendientes recepción");
      const selectedStore = destStoreOptions.find(store => store.code === storeFilter)?.name || "todas_las_tiendas";
      XLSX.writeFile(workbook, `pendientes_por_recepcion_${selectedStore.replace(/[^a-z0-9]+/gi, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success(`${exportRows.length.toLocaleString("es-PE")} requerimientos pendientes exportados.`);
    } catch (error: any) {
      showMsg("Error descargando pendientes por recepción: " + (error?.message || error));
    } finally {
      setExportingPendingRequests(false);
    }
  }

  const destStoreOptions = useMemo(() => {
    // Base: todas las tiendas activas (no solo las que aparecen en la pagina
    // de solicitudes recientes cargadas, que puede dejar fuera tiendas con
    // poco volumen de recepcion). Si el nombre esta duplicado entre dos
    // registros de stores, se prefiere el que tiene erp_sede (el que usa el ERP).
    const dedupedStores = new Map<string, Store>();
    for (const s of stores) {
      const key = String(s.name || "").toLowerCase();
      const existing = dedupedStores.get(key);
      if (!existing || (!existing.erp_sede && s.erp_sede)) dedupedStores.set(key, s);
    }

    // Para cada nombre de tienda, encontrar el destination_store_code que realmente
    // usan los requerimientos — ese es el codigo que funciona en el filtro.
    // Esto resuelve el caso donde store.code no coincide con destination_store_code.
    const requestCodeByName = new Map<string, string>();
    for (const req of requestGroups) {
      for (const child of req.child_requests) {
        if (!child.destination_store_code) continue;
        const nameLower = String(child.destination_store_name || "").toLowerCase();
        if (nameLower && !requestCodeByName.has(nameLower)) {
          requestCodeByName.set(nameLower, child.destination_store_code);
        }
      }
    }

    const result = new Map<string, string>(); // code → name

    // Una opcion por tienda conocida, usando el codigo real de los requerimientos
    for (const s of dedupedStores.values()) {
      const nameLower = String(s.name || "").toLowerCase();
      const code = requestCodeByName.get(nameLower) || s.erp_sede || s.code || "";
      if (code) result.set(code, s.name);
    }

    // Agregar codigos de requerimientos que no correspondan a ninguna tienda conocida por nombre
    for (const req of requestGroups) {
      for (const child of req.child_requests) {
        const code = child.destination_store_code;
        if (!code) continue;
        const nameLower = String(child.destination_store_name || "").toLowerCase();
        if (nameLower && dedupedStores.has(nameLower)) continue;
        if (!result.has(code)) result.set(code, child.destination_store_name || code);
      }
    }

    return [...result.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [stores, requestGroups]);

  const summaryRows = useMemo(() => {
    const grouped = new Map<string, {
      key: string;
      name: string;
      total: number;
      advanced: number;
      pending: number;
      lines: number;
      units: number;
    }>();

    for (const req of scopedRequestGroups.filter(item => item.reception_status === "in_progress")) {
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
      row.advanced += 1;
    }

    return [...grouped.values()]
      .map(row => ({
        ...row,
        pct: row.total > 0 ? Math.round((row.advanced / row.total) * 100) : 0,
        pendingPct: row.total > 0 ? Math.round((row.pending / row.total) * 100) : 0,
      }))
      .sort((a, b) => b.pct - a.pct || b.total - a.total || a.name.localeCompare(b.name, "es"));
  }, [scopedRequestGroups]);

  const differenceStats = useMemo(() => {
    const faltantes = differenceRows.filter(row => row.kind === "faltante").length;
    const sobrantes = differenceRows.filter(row => row.kind === "sobrante").length;
    const desmedros = differenceRows.filter(row => row.kind === "desmedro").length;
    const netUnits = differenceRows.reduce((sum, row) => sum + (row.kind === "sobrante" ? row.qty : -row.qty), 0);
    const stores = new Set(differenceRows.map(row => row.destinationStore)).size;
    return { faltantes, sobrantes, desmedros, netUnits, stores };
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

  const consolidatedHasScan = useCallback((line: ConsolidatedReceptionLine) =>
    line.line_ids.some(lineId => (scansByLine.get(lineId) || []).length > 0),
  [scansByLine]);

  const progressLines = useMemo(
    () => consolidatedLines.filter(line => num(line.qty_requested) > 0),
    [consolidatedLines]
  );

  // Diferencias de cantidad detectadas (recibido vs pedido), incluyendo
  // codigos extra escaneados que no estaban en el pedido original (posibles
  // sobrantes). Solo informativo hasta que se reporten con el boton.
  const detectedDiffLines = useMemo(() => {
    return consolidatedLines
      .map(line => ({ line, difference: consolidatedScanTotal(line) - num(line.qty_requested) }))
      .filter(row => row.difference !== 0);
  }, [consolidatedLines, consolidatedScanTotal]);

  // Igual que detectedDiffLines pero sin las que ya fueron reportadas -
  // esto es lo que realmente se puede volver a reportar.
  const diffSuggestions = useMemo(() => {
    return detectedDiffLines.filter(row => {
      const sourceLine = row.line.source_lines[0] || row.line;
      const kind: DifferenceKind = row.difference > 0 ? "sobrante" : "faltante";
      return !reportedDiffPairs.has(`${sourceLine.id}::${kind}`);
    });
  }, [detectedDiffLines, reportedDiffPairs]);

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

  const linesScanned = useMemo(() => progressLines.filter(line => consolidatedHasScan(line)).length, [consolidatedHasScan, progressLines]);
  const receptionProgressPct = progressLines.length > 0 ? Math.round((linesScanned / progressLines.length) * 100) : 0;

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!ready) {
    return <main className="min-h-screen bg-slate-100 flex items-center justify-center"><p className="text-slate-500 font-black">Cargando...</p></main>;
  }
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Recepción" />;

  return (
    <main className="min-h-screen bg-slate-100 flex flex-col">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => { abortRef.current?.abort(); window.location.href = "/"; }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"><Home size={18} /></button>
            {view === "detail" && (
              <button onClick={() => { setView("list"); setSelected(null); setLines([]); setScans([]); setActiveLine(null); }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50"><ChevronLeft size={18} /></button>
            )}
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-teal-600 text-white">
                <ScanLine size={18} />
              </div>
              <div>
                <h1 className="font-black text-slate-900 text-sm leading-tight">
                  {view === "list" ? "Recepción" : requestDocumentLabel(selected, "Detalle")}
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

      {/* ══════════════ LISTA ════════════════════════════════════════════════ */}
      {view === "list" && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-3 lg:max-w-6xl xl:max-w-7xl">

          {(canViewSummary || canViewDifferences) && (
            <div className={`grid gap-2 rounded-2xl border bg-white p-1 shadow-sm ${canViewSummary ? "grid-cols-4" : "grid-cols-3"}`}>
              <Link
                href={tabHref("recepcion")}
                className={`rounded-xl px-3 py-2 text-center text-sm font-black ${listPanel === "recepcion" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Recepción
              </Link>
              <Link
                href={tabHref("pendientes")}
                className={`rounded-xl px-3 py-2 text-center text-sm font-black ${listPanel === "pendientes" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Pendientes por recepción
              </Link>
              {canViewSummary && (
                <Link
                  href={tabHref("resumen")}
                  className={`rounded-xl px-3 py-2 text-center text-sm font-black ${listPanel === "resumen" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
                >
                  Resumen
                </Link>
              )}
              <Link
                href={tabHref("diferencias")}
                className={`rounded-xl px-3 py-2 text-center text-sm font-black ${listPanel === "diferencias" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Diferencias
              </Link>
            </div>
          )}

          {(() => {
            const syncStale = !lastErpSync || (Date.now() - new Date(lastErpSync).getTime()) > 15 * 60 * 1000;
            return (
              <div className={`rounded-2xl border px-4 py-3 shadow-sm ${syncStale ? "border-red-300 bg-red-50" : "bg-white"}`}>
                <p className={`text-xs font-black uppercase ${syncStale ? "text-red-600" : "text-slate-500"}`}>
                  {syncStale ? "⚠ Sincronizacion ERP Recepcion detenida" : "Ultima sincronizacion ERP Recepcion"}
                </p>
                <p className={`text-sm font-black ${syncStale ? "text-red-700" : "text-slate-900"}`}>
                  {lastErpSync ? formatSync(lastErpSync) : "Sin sincronizacion registrada"}
                </p>
              </div>
            );
          })()}

          {/* Filtros */}
          <div className="flex flex-wrap gap-2">
            {canViewAllStores && (
              <select value={storeFilter} onChange={e => updateStoreFilter(e.target.value)}
                className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black min-w-[160px]">
                <option value="all">Todas las tiendas</option>
                {destStoreOptions.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            )}
            {listPanel !== "diferencias" && listPanel !== "pendientes" && (
              <>
                <div>
                  <label className="block text-[11px] font-black uppercase text-slate-400">Desde</label>
                  <input type="date" value={reqDateFrom} onChange={e => setReqDateFrom(e.target.value)}
                    className="border rounded-2xl px-3 py-2 text-xs font-bold text-slate-700" />
                </div>
                <div>
                  <label className="block text-[11px] font-black uppercase text-slate-400">Hasta</label>
                  <input type="date" value={reqDateTo} onChange={e => setReqDateTo(e.target.value)}
                    className="border rounded-2xl px-3 py-2 text-xs font-bold text-slate-700" />
                </div>
              </>
            )}
            {listPanel === "recepcion" && (
              <>
                <input className="flex-1 min-w-[150px] border rounded-2xl px-4 py-2.5 text-sm bg-white text-slate-900"
                  placeholder="Buscar documento, tienda, código..."
                  value={search} onChange={e => setSearch(e.target.value)} />
                <select value={reasonFilter} onChange={e => setReasonFilter(e.target.value)}
                  className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black">
                  <option value="all">Todos los motivos</option>
                  {reasonOptions.map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
                  className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black">
                  <option value="all">Todos</option>
                  <option value="pending">Pendiente</option>
                  <option value="in_progress">En proceso</option>
                  <option value="completed">Completados</option>
                </select>
                <select value={filterErpStatus} onChange={e => setFilterErpStatus(e.target.value as any)}
                  className="border rounded-2xl px-3 py-2.5 text-sm bg-white text-slate-900 font-black">
                  <option value="all">Estado en RMS</option>
                  <option value="transit">En tránsito en RMS</option>
                  <option value="received">Recibido en RMS</option>
                </select>
              </>
            )}
          </div>

          {listPanel === "recepcion" && <p className="text-xs text-slate-400 font-black px-1">{filteredRequests.length} requerimiento{filteredRequests.length !== 1 ? "s" : ""}</p>}
          {listPanel === "pendientes" && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <p className="text-xs text-slate-400 font-black">{pendingRequestsByStore.reduce((total, group) => total + group.rows.length, 0)} requerimiento{pendingRequestsByStore.reduce((total, group) => total + group.rows.length, 0) !== 1 ? "s" : ""} en tránsito · {pendingRequestsByStore.length} tienda{pendingRequestsByStore.length !== 1 ? "s" : ""}</p>
              <button
                type="button"
                onClick={() => void exportPendingRequestsExcel()}
                disabled={exportingPendingRequests || loading}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
              >
                <Download size={15} /> {exportingPendingRequests ? "Descargando..." : "Descargar Excel"}
              </button>
            </div>
          )}
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

          {!loading && listPanel === "pendientes" && pendingRequestsByStore.length === 0 && (
            <div className="py-16 text-center text-slate-400">
              <Package size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-black">No hay requerimientos pendientes por recepción.</p>
              <p className="mt-1 text-xs">Aquí se muestran todos los requerimientos que siguen en tránsito en RMS.</p>
            </div>
          )}

          {!loading && listPanel === "pendientes" && pendingRequestsByStore.length > 0 && (
            <div className="space-y-4">
              {pendingRequestsByStore.map(group => (
                <section key={group.key} className="overflow-hidden rounded-2xl border bg-white shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-teal-50 px-4 py-3">
                    <div>
                      <p className="font-black text-slate-900">{group.name}</p>
                      <p className="text-xs font-bold text-teal-700">{group.rows.length} requerimiento{group.rows.length !== 1 ? "s" : ""} en tránsito</p>
                    </div>
                    <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-black text-teal-700">Pendiente por recepción</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="bg-slate-50 text-left text-[11px] font-black uppercase text-slate-500">
                        <tr>
                          <th className="px-4 py-3">Requerimiento</th>
                          <th className="px-4 py-3">Guías / documentos</th>
                          <th className="px-4 py-3">Origen</th>
                          <th className="px-4 py-3">Fecha tránsito</th>
                          <th className="px-4 py-3 text-right">Líneas</th>
                          <th className="px-4 py-3 text-right">Cantidad</th>
                          <th className="px-4 py-3">Estado recepción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map(request => (
                          <tr key={request.id} className="border-t border-slate-100 hover:bg-teal-50">
                            <td className="px-4 py-3 font-black text-slate-900">
                              <button type="button" onClick={() => void openRequest(request)} className="text-left text-teal-700 underline underline-offset-2 hover:text-teal-900">
                                {requestRequirementLabel(request) || "Sin número"}
                              </button>
                            </td>
                            <td className="px-4 py-3 font-bold text-slate-600">{requestGuides(request)}</td>
                            <td className="px-4 py-3 text-slate-600">{request.source_store_name || request.source_store_code || "-"}</td>
                            <td className="px-4 py-3 text-slate-600">{dateShort(request.request_date || request.creation_date)}</td>
                            <td className="px-4 py-3 text-right font-bold text-slate-700">{fmt(num(request.line_count))}</td>
                            <td className="px-4 py-3 text-right font-black text-slate-900">{fmt(num(request.qty_requested_total))}</td>
                            <td className="px-4 py-3"><StatusBadge status={request.reception_status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          )}

          {!loading && listPanel === "diferencias" && (
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Reporte validador</p>
                  <h2 className="text-xl font-black text-slate-950">Diferencias de recepcion</h2>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="block text-[11px] font-black uppercase text-slate-400">Desde</label>
                    <input
                      type="date"
                      value={diffDateFrom}
                      onChange={e => setDiffDateFrom(e.target.value)}
                      className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-black uppercase text-slate-400">Hasta</label>
                    <input
                      type="date"
                      value={diffDateTo}
                      onChange={e => setDiffDateTo(e.target.value)}
                      className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-700"
                    />
                  </div>
                  <button
                    onClick={() => void loadDifferencesReport()}
                    disabled={loadingDifferences}
                    className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {loadingDifferences ? "Cargando..." : "Actualizar"}
                  </button>
                  <button
                    onClick={exportDifferencesExcel}
                    disabled={loadingDifferences || differenceRows.length === 0}
                    className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    Exportar Excel
                  </button>
                </div>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2 text-center text-xs font-black sm:grid-cols-5">
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
                <div className="rounded-xl bg-amber-50 p-3">
                  <p className="text-amber-500">Desmedros</p>
                  <p className="text-lg text-amber-700">{differenceStats.desmedros}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-slate-400">Neto uds.</p>
                  <p className="text-lg text-slate-950">{fmt(differenceStats.netUnits)}</p>
                </div>
              </div>

              {loadingDifferences && <p className="p-8 text-center text-sm font-bold text-slate-400">Cargando diferencias...</p>}
              {!loadingDifferences && differenceRows.length === 0 && (
                <p className="p-8 text-center text-sm font-bold text-slate-400">Sin diferencias reportadas en este rango.</p>
              )}
              {!loadingDifferences && differenceRows.length > 0 && canDeleteRequests && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border bg-white p-3 shadow-sm">
                  <p className="text-xs font-bold text-slate-500">
                    {selectedDiffKeys.size > 0 ? `${selectedDiffKeys.size} seleccionado${selectedDiffKeys.size !== 1 ? "s" : ""}` : "Selecciona reportes para eliminarlos en bloque"}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={toggleSelectAllDiffRows}
                      className="rounded-xl border px-3 py-2 text-xs font-black text-slate-600"
                    >
                      {differenceRows.every(row => selectedDiffKeys.has(row.diffKey)) ? "Deseleccionar todos" : "Seleccionar todos"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSelectedDifferenceReports()}
                      disabled={selectedDiffKeys.size === 0 || deletingSelectedDiffs}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-black text-white disabled:opacity-40"
                    >
                      <Trash2 size={14} /> {deletingSelectedDiffs ? "Eliminando..." : "Eliminar seleccionados"}
                    </button>
                  </div>
                </div>
              )}
              {!loadingDifferences && differenceRows.length > 0 && (
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[980px] text-left text-[11px]">
                    <thead>
                      <tr className="border-b bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                        {canDeleteRequests && (
                          <th className="p-2 w-8">
                            <input
                              type="checkbox"
                              checked={differenceRows.length > 0 && differenceRows.every(row => selectedDiffKeys.has(row.diffKey))}
                              onChange={toggleSelectAllDiffRows}
                            />
                          </th>
                        )}
                        <th className="p-2">Tienda / Doc.</th>
                        <th className="p-2">Entregó guía</th>
                        <th className="p-2">Recep. completada</th>
                        <th className="p-2">Código</th>
                        <th className="p-2">Tipo</th>
                        <th className="p-2 text-right">Enviado</th>
                        <th className="p-2 text-right">Recibido</th>
                        <th className="p-2 text-right">Dif.</th>
                        <th className="p-2">Reportado</th>
                        <th className="p-2">Estado</th>
                        <th className="p-2">N° Req.</th>
                        <th className="p-2">Regularizado</th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {differenceRows.map(row => {
                        const isProviderForRow = canViewAllStores || myStoreCodes.includes(row.sourceStoreCode);
                        const reg = regularizations.get(row.diffKey);
                        const status: RegularizationStatus = reg?.status || "pendiente";
                        const formInputs = regFormInputs[row.diffKey] || { ref: "", notes: "" };
                        const setFormInputs = (patch: Partial<{ ref: string; notes: string }>) =>
                          setRegFormInputs(prev => ({ ...prev, [row.diffKey]: { ...(prev[row.diffKey] || { ref: "", notes: "" }), ...patch } }));
                        const kindBadge = row.kind === "sobrante"
                          ? { label: "Sobrante", cls: "bg-blue-100 text-blue-700" }
                          : row.kind === "desmedro"
                            ? { label: "Desmedro", cls: "bg-amber-100 text-amber-700" }
                            : { label: "Faltante", cls: "bg-red-100 text-red-700" };
                        const statusBadge = status === "regularizado"
                          ? { label: "Regularizado", cls: "bg-emerald-100 text-emerald-700" }
                          : status === "atendido"
                            ? { label: "Atendido", cls: "bg-amber-100 text-amber-700" }
                            : status === "rechazado"
                              ? { label: "Rechazado", cls: "bg-red-100 text-red-700" }
                              : { label: "Pendiente", cls: "bg-slate-200 text-slate-600" };
                        const saving = savingRegularizationKey === row.diffKey;
                        const isOpen = expandedDiffKey === row.diffKey;
                        const diffQty = row.kind === "desmedro" ? null : (row.kind === "sobrante" ? row.qty : -row.qty);
                        return (
                          <Fragment key={row.key}>
                            <tr
                              className="cursor-pointer border-b last:border-0 hover:bg-slate-50"
                              onClick={() => setExpandedDiffKey(isOpen ? null : row.diffKey)}
                            >
                              {canDeleteRequests && (
                                <td className="p-2" onClick={event => event.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedDiffKeys.has(row.diffKey)}
                                    onChange={() => toggleDiffRowSelection(row.diffKey)}
                                  />
                                </td>
                              )}
                              <td className="p-2">
                                <p className="font-black text-slate-900">{row.destinationStore}</p>
                                <p className="text-slate-500">{row.document}</p>
                              </td>
                              <td className="p-2 font-bold text-slate-700">{row.dispatchedByName || "-"}</td>
                              <td className="p-2">
                                {row.deliveredAt ? (
                                  <>
                                    <p className="font-bold text-slate-700">{timeShort(row.deliveredAt)}</p>
                                    {row.deliveredByName && <p className="text-slate-500">{row.deliveredByName}</p>}
                                  </>
                                ) : <span className="text-slate-400">Aún sin completar</span>}
                              </td>
                              <td className="p-2">
                                <p className="font-black text-slate-900">{row.productCode}</p>
                                <p className="max-w-[160px] whitespace-normal break-words leading-snug text-slate-500">{row.description || "Sin descripcion"} {row.unit ? `· ${row.unit}` : ""}</p>
                              </td>
                              <td className="p-2">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${kindBadge.cls}`}>{kindBadge.label}</span>
                              </td>
                              <td className="p-2 text-right font-black text-slate-900">{row.qtySent !== null ? fmt(row.qtySent) : "-"}</td>
                              <td className="p-2 text-right font-black text-slate-900">{row.qtyReceived !== null ? fmt(row.qtyReceived) : "-"}</td>
                              <td className="p-2 text-right font-black text-slate-900">{diffQty !== null ? diffLabel(diffQty) : `-${fmt(row.qty)}`}</td>
                              <td className="p-2">
                                <p className="font-bold text-slate-700">{timeShort(row.reportedAt)}</p>
                                {row.reportedByName && <p className="text-slate-500">{row.reportedByName}</p>}
                              </td>
                              <td className="p-2">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${statusBadge.cls}`}>{statusBadge.label}</span>
                              </td>
                              <td className="p-2 font-bold text-slate-700">{reg?.requirement_ref || "-"}</td>
                              <td className="p-2">
                                {reg?.regularized_at ? (
                                  <p className="font-bold text-emerald-700">{timeShort(reg.regularized_at)}</p>
                                ) : <span className="text-slate-400">-</span>}
                              </td>
                              <td className="p-2 text-slate-500">{isOpen ? "▲" : "▼"}</td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b bg-slate-50/70 last:border-0">
                                <td colSpan={canDeleteRequests ? 14 : 13} className="p-3">
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-slate-500">
                                    <span>Origen: <b className="text-slate-700">{row.sourceStore}</b></span>
                                    {reg?.attended_at && <span>Atendido: <b className="text-slate-700">{timeShort(reg.attended_at)} · {reg.attended_by_name}</b></span>}
                                  </div>
                                  {row.notes && <p className="mt-1 text-xs font-semibold text-slate-600">Obs: {row.notes}</p>}
                                  {reg?.notes && <p className="mt-1 text-xs font-semibold text-slate-600">Obs. proveedora: {reg.notes}</p>}
                                  {row.kind === "desmedro" && (
                                    row.photoUrl ? (
                                      <a href={row.photoUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={row.photoUrl} alt="Evidencia de desmedro" className="h-16 w-16 rounded-md border object-cover" />
                                      </a>
                                    ) : <p className="mt-1 text-[11px] font-bold text-slate-500">Sin foto adjunta</p>
                                  )}

                                  {/* ── Workflow: proveedora coloca N° de requerimiento; el paso a
                                      "regularizado" es automatico cuando ese requerimiento sale
                                      recibido en RMS. ── */}
                                  {status !== "regularizado" && status !== "rechazado" && isProviderForRow && (
                                    <div className="mt-2 max-w-sm space-y-1.5 rounded-lg border border-dashed border-slate-300 bg-white p-2">
                                      <p className="text-[10px] font-black uppercase text-slate-500">Tienda proveedora</p>
                                      <input
                                        placeholder="N° de requerimiento (ej. 1010-3200)"
                                        value={formInputs.ref || reg?.requirement_ref || ""}
                                        onChange={e => setFormInputs({ ref: e.target.value })}
                                        className="w-full rounded-lg border px-2 py-1.5 text-xs font-bold"
                                      />
                                      <input
                                        placeholder="Notas (opcional para atender, obligatorio para rechazar)"
                                        value={formInputs.notes}
                                        onChange={e => setFormInputs({ notes: e.target.value })}
                                        className="w-full rounded-lg border px-2 py-1.5 text-xs font-semibold"
                                      />
                                      <div className="flex gap-1.5">
                                        <button
                                          onClick={() => marcarAtendido(row)}
                                          disabled={saving}
                                          className="flex-1 rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-black text-white disabled:opacity-40"
                                        >
                                          {saving ? "Guardando..." : status === "atendido" ? "Actualizar requerimiento" : "Marcar atendido"}
                                        </button>
                                        <button
                                          onClick={() => marcarRechazado(row)}
                                          disabled={saving}
                                          className="flex-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-black text-red-600 hover:bg-red-50 disabled:opacity-40"
                                        >
                                          {saving ? "Guardando..." : "Rechazar"}
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                  {status === "pendiente" && !isProviderForRow && (
                                    <p className="mt-2 text-[11px] font-bold text-slate-500">Pendiente de atencion por la tienda proveedora.</p>
                                  )}
                                  {status === "atendido" && !isProviderForRow && (
                                    <p className="mt-2 text-[11px] font-bold text-amber-600">Atendido con requerimiento {reg?.requirement_ref} · en espera de confirmacion en RMS.</p>
                                  )}
                                  {status === "regularizado" && (
                                    <div className="mt-2 max-w-sm rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[11px] font-bold text-emerald-700">
                                      Regularizado · Req. {reg?.requirement_ref} recibido en RMS
                                    </div>
                                  )}
                                  {status === "rechazado" && (
                                    <div className="mt-2 max-w-sm rounded-lg border border-red-200 bg-red-50 p-2 text-[11px] font-bold text-red-700">
                                      Rechazado por {reg?.attended_by_name || "tienda proveedora"} · {reg?.notes || "Sin motivo especificado"}
                                    </div>
                                  )}
                                  {canDeleteRequests && (
                                    <button
                                      type="button"
                                      onClick={event => { event.stopPropagation(); void deleteDifferenceReport(row); }}
                                      disabled={deletingDiffKey === row.diffKey}
                                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-black text-red-600 hover:bg-red-50 disabled:opacity-40"
                                    >
                                      <Trash2 size={14} /> {deletingDiffKey === row.diffKey ? "Eliminando..." : "Eliminar reporte"}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <ReasonBadge reason={req.reason} />
                    <ErpStatusBadge statusCode={req.status_code} erpStatus={req.erp_status} />
                  </div>
                  <p className="font-black text-slate-900 text-xl leading-tight mt-0.5">{requestDocumentLabel(req)}</p>
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

          {!loading && listPanel === "recepcion" && hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="w-full rounded-2xl border bg-white px-4 py-3 text-sm font-black text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-40"
            >
              {loadingMore ? "Cargando..." : "Cargar más requerimientos"}
            </button>
          )}
        </div>
      )}

      {/* ══════════════ DETALLE ══════════════════════════════════════════════ */}
      {view === "detail" && selected && (
        <div className="flex-1 p-4 max-w-3xl w-full mx-auto space-y-3 lg:max-w-4xl">

          {/* Info cabecera */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <ReasonBadge reason={selected.reason} />
                  <ErpStatusBadge statusCode={selected.status_code} erpStatus={selected.erp_status} />
                </div>
                <h2 className="font-black text-slate-900 text-2xl leading-tight">{requestDocumentLabel(selected)}</h2>
                <p className="text-sm text-slate-500">{selected.source_store_name} → {selected.destination_store_name}</p>
              </div>
              <StatusBadge status={selected.reception_status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
              {selected.creation_date && <span>Requerido: <b className="text-slate-600">{dateShort(selected.creation_date)}</b></span>}
              {selected.request_date  && <span>Tránsito: <b className="text-teal-600">{dateShort(selected.request_date)}</b></span>}
              {selected.transfer_count > 1 && <span><b className="text-slate-600">{selected.transfer_count}</b> transferencias agrupadas</span>}
            </div>
            {progressLines.length > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs font-black text-slate-500 mb-1">
                  <span>{linesScanned} / {progressLines.length} lineas recepcionadas</span>
                  <span>{receptionProgressPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-teal-600 transition-all" style={{ width: `${receptionProgressPct}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Botón completar */}
          {selected.reception_status !== "completed" && !loading && (
            <div className="rounded-2xl border bg-white p-3 shadow-sm">
              <button onClick={markComplete} disabled={saving || scans.length === 0}
                className="w-full rounded-2xl bg-slate-900 text-white py-3.5 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-40">
                <CheckCircle2 size={18} /> {saving ? "Guardando..." : "Marcar requerimiento completado"}
              </button>
              {scans.length === 0 && <p className="text-center text-xs text-slate-400 mt-1">Registra al menos un ítem para completar</p>}
            </div>
          )}

          {/* Reportar diferencias / desmedro - solo una vez que el operario
              revisó todo y marcó el requerimiento como completado */}
          {!loading && consolidatedLines.length > 0 && selected.reception_status !== "completed" && (
            <div className="rounded-2xl border border-dashed bg-slate-50 p-3 text-center text-xs font-bold text-slate-500">
              Marca el requerimiento como completado para poder reportar diferencias o desmedros.
            </div>
          )}
          {!loading && consolidatedLines.length > 0 && selected.reception_status === "completed" && (
            <div className="rounded-2xl border bg-white p-3 shadow-sm space-y-3">
              <p className="text-xs font-black uppercase text-slate-500">Reportar diferencias</p>

              <div>
                <p className="mb-1.5 text-xs font-semibold text-slate-500">
                  {diffSuggestions.length > 0
                    ? `${diffSuggestions.length} código(s) con diferencia de cantidad detectada (recibido vs pedido).`
                    : detectedDiffLines.length > 0
                      ? "Todas las diferencias detectadas ya fueron reportadas."
                      : "No hay diferencias de cantidad detectadas por ahora."}
                </p>
                <button
                  onClick={() => void reportarDiferenciasAutomaticas()}
                  disabled={savingAutoDiffReport || diffSuggestions.length === 0}
                  className="w-full rounded-xl bg-slate-950 px-3 py-2.5 text-xs font-black text-white disabled:opacity-40"
                >
                  {savingAutoDiffReport
                    ? "Reportando..."
                    : diffSuggestions.length === 0 && detectedDiffLines.length > 0
                      ? "Diferencias ya reportadas"
                      : "Reportar diferencias"}
                </button>
              </div>

              <div className="border-t pt-3">
                <p className="mb-1.5 text-xs font-black uppercase text-amber-700">Reportar desmedro</p>
                <div className="space-y-1.5">
                  <select
                    value={desmedroLineId}
                    onChange={e => setDesmedroLineId(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2 text-xs font-bold text-slate-700"
                  >
                    <option value="">Selecciona un código recepcionado...</option>
                    {consolidatedLines.map(line => {
                      const sourceLine = line.source_lines[0] || line;
                      const alreadyReported = reportedDiffPairs.has(`${sourceLine.id}::desmedro`);
                      return (
                        <option key={line.id} value={line.id}>
                          {line.product_code} · {line.description || "Sin descripcion"}{alreadyReported ? " (ya reportado)" : ""}
                        </option>
                      );
                    })}
                  </select>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={desmedroQty}
                      onChange={e => setDesmedroQty(e.target.value)}
                      placeholder="Cantidad dañada"
                      className="w-28 rounded-lg border px-2 py-1.5 text-xs font-bold"
                    />
                    <input
                      value={desmedroNotes}
                      onChange={e => setDesmedroNotes(e.target.value)}
                      placeholder="Notas (estado del producto)"
                      className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] font-black text-amber-700">
                    <Camera size={14} />
                    {desmedroPhotoFile ? "Cambiar foto" : "Adjuntar foto"}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={e => setDesmedroPhoto(e.target.files?.[0] || null)}
                    />
                  </label>
                  {desmedroPhotoPreview && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={desmedroPhotoPreview} alt="Evidencia" className="h-16 w-16 rounded-lg border object-cover" />
                  )}
                  <button
                    onClick={() => void reportarDesmedro()}
                    disabled={savingDesmedroReport}
                    className="w-full rounded-xl bg-amber-600 px-3 py-2.5 text-xs font-black text-white disabled:opacity-40"
                  >
                    {savingDesmedroReport ? "Reportando..." : "Reportar desmedro"}
                  </button>
                </div>
              </div>
            </div>
          )}

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
                          <p className="text-xs text-slate-600 whitespace-normal break-words leading-snug">{line.description || "Sin descripcion"}</p>
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
                                <p>{requestDocumentLabel(req)}</p>
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
                          <button onClick={saveScan} disabled={saving || line.source_lines.every(sourceLine => String(editLineInputs[sourceLine.id]?.qty ?? "").trim() === "")}
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
