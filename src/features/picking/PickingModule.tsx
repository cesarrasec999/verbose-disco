"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BarChart3, ClipboardList, Clock, Download, Home, Printer, QrCode, RefreshCw, ScanLine, Trophy, TrendingUp, UserCircle, UserPlus, X } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import { cleanCode, fullProductCode, mappedProductCodeCandidates } from "@/features/ciclicos/utils";
import { toast } from "sonner";

type CyclicUser = {
  id: string;
  full_name: string;
  role: string;
  store_id?: string | null;
  module_access?: string[] | null;
  whatsapp?: string | null;
};

type PickingRequest = {
  id: string;
  erp_inv_request_id: string;
  inv_request_no: string | null;
  doc_number: string | null;
  status_code: string | null;
  status_name: string | null;
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
  source_updated_at?: string | null;
  hidden_at?: string | null;
  hidden_by?: string | null;
  hidden_by_name?: string | null;
  hidden_reason?: string | null;
};

type PickingLine = {
  id: string;
  request_id: string;
  erp_inv_request_id: string;
  line_id: number;
  sku: string | null;
  product_code: string;
  barcode: string | null;
  description: string | null;
  unit: string | null;
  qty_requested: number;
  qty_pending: number;
  assigned_qty: number;
  picked_qty: number;
};

type PickingAssignment = {
  id: string;
  request_id: string;
  line_id: string;
  picker_id: string | null;
  picker_name: string;
  assigned_qty: number;
  picked_qty: number;
  status: string;
  picking_date?: string | null;
  created_at: string;
};

type PickingScan = {
  id: string;
  assignment_id: string;
  request_id: string;
  line_id: string;
  picker_id: string | null;
  picker_name: string | null;
  location_code: string;
  scanned_product_code: string | null;
  scanned_barcode: string | null;
  qty: number;
  is_match: boolean;
  created_at: string;
};

type StoreRow = {
  id: string;
  code: string;
  name: string;
  erp_sede?: string | null;
};

type ProductRow = {
  id: string;
  sku: string;
  barcode: string | null;
};

type LocationRow = {
  product_id: string | null;
  sku: string | null;
  location: string;
  stored_quantity?: number | string | null;
};

type PickingPanel = "asignacion" | "resumen" | "reportes" | "registros" | "productividad";
type LocationSort = "asc" | "desc";
type ScannerTarget = "location" | "product" | null;
type AssignmentProgressFilter = "todos" | "pendiente";
type PickingLocationFilter = {
  zone: string;
  lineal: string;
  metro: string;
  nivel: string;
};

type ParsedPickingLocation = PickingLocationFilter;

type ScanEntry = {
  location: string;
  qty: string;
};

type Html5QrLike = {
  start: (
    cameraConfig: { facingMode: string },
    config: { fps: number; qrbox: { width: number; height: number } },
    onSuccess: (decodedText: string) => void,
    onError?: (errorMessage: string) => void
  ) => Promise<unknown>;
  stop: () => Promise<unknown>;
  clear: () => void | Promise<unknown>;
};

function canAccessPicking(user: CyclicUser) {
  return canAccessModule(user, "picking");
}

function canManagePicking(user: CyclicUser | null) {
  return user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador";
}

function num(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(done: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 1000) / 10);
}

function dateText(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

function sameDate(value: string | null | undefined, date: string) {
  if (!date) return true;
  if (!value) return false;
  return String(value).slice(0, 10) === date;
}

function inDateRange(value: string | null | undefined, from: string, to: string) {
  if (!value) return false;
  const date = String(value).slice(0, 10);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function reasonBadgeClass(reason: string | null | undefined) {
  const value = normalize(reason);
  if (value.includes("URGENTE")) return "text-amber-600";
  if (value.includes("IMPORTACION")) return "text-blue-600";
  if (!value) return "text-slate-400";
  return "text-violet-600";
}

function formatSync(value: string | null) {
  if (!value) return "Sin sincronizacion registrada";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
}

function formatQty(value: number) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(value);
}

function pickingDocumentLabel(request: PickingRequest | null | undefined) {
  return request?.doc_number || request?.inv_request_no || request?.erp_inv_request_id || "";
}

function tabHref(target: PickingPanel) {
  return `/picking/${target}`;
}

function formatWhole(value: number) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 }).format(value);
}

function isAssignmentComplete(assignment: PickingAssignment, pickedOverride?: number) {
  const assigned = num(assignment.assigned_qty);
  const picked = pickedOverride ?? num(assignment.picked_qty);
  return assigned > 0 && picked >= assigned;
}

function cleanLocationLabel(value: string) {
  return String(value || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function parsePickingLocation(value: string): ParsedPickingLocation | null {
  const normalized = normalize(cleanLocationLabel(value)).replace(/[’‘'`]/g, "-").replace(/\s+/g, "");
  const match = /^(\d{2})-([A-Z][0-9]{0,2})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) return null;
  return { zone: match[1], lineal: match[2], metro: match[3], nivel: match[4] };
}

function storeLabel(request: PickingRequest | null | undefined) {
  return request?.source_store_name || request?.source_store_code || "-";
}

function requesterStoreLabel(request: PickingRequest | null | undefined) {
  return request?.destination_store_name || request?.destination_store_code || "-";
}

function requesterStoreKey(request: PickingRequest | null | undefined) {
  return normalize(request?.destination_store_code || request?.destination_store_name);
}

function DonutCard({ title, done, total, detail }: { title: string; done: number; total: number; detail: string }) {
  const progress = pct(done, total);
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-md">
      <div className="flex items-center gap-5">
        <div
          className="grid h-28 w-28 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(#7c3aed ${progress * 3.6}deg, #e2e8f0 0deg)` }}
        >
          <div className="grid h-20 w-20 place-items-center rounded-full bg-white text-xl font-black text-slate-900">{progress}%</div>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{title}</p>
          <p className="mt-1.5 text-2xl font-black text-slate-950">{formatQty(done)} / {formatQty(total)}</p>
          <p className="mt-1 text-sm font-semibold text-slate-500">{detail}</p>
        </div>
      </div>
    </div>
  );
}

function BarListCard({ title, rows, colorClass }: { title: string; rows: Array<{ label: string; value: number }>; colorClass: string }) {
  const max = Math.max(...rows.map(row => row.value), 0);
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-md">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">{title}</h2>
      </div>
      <div className="space-y-3.5">
        {rows.map(row => {
          const width = max > 0 ? Math.max(3, Math.round((row.value / max) * 100)) : 0;
          return (
            <div key={row.label}>
              <div className="mb-1.5 flex justify-between gap-3 text-sm font-semibold text-slate-600">
                <span className="truncate">{row.label}</span>
                <span className="font-black text-slate-800">{formatQty(row.value)}</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100">
                <div className={`h-2.5 rounded-full transition-all ${colorClass}`} style={{ width: `${width}%` }} />
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">Sin datos para mostrar.</p>}
      </div>
    </div>
  );
}

export default function PickingModule({ panel }: { panel: PickingPanel }) {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<PickingRequest[]>([]);
  const [lines, setLines] = useState<PickingLine[]>([]);
  const [assignments, setAssignments] = useState<PickingAssignment[]>([]);
  const [scans, setScans] = useState<PickingScan[]>([]);
  const [pickers, setPickers] = useState<CyclicUser[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  // Universo COMPLETO de tienda entrega / motivo entre los requerimientos activos,
  // independiente de la pestana y fecha que se este mirando (el filtro del header es
  // compartido por las 5 pestanas). Se llena con una consulta liviana aparte; ver loadData.
  const [filterSourceStores, setFilterSourceStores] = useState<Array<{ key: string; label: string }>>([]);
  const [filterReasons, setFilterReasons] = useState<Array<{ key: string; label: string }>>([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const selectedRequestIdRef = useRef(selectedRequestId);
  useEffect(() => { selectedRequestIdRef.current = selectedRequestId; }, [selectedRequestId]);
  const [selectedPickerId, setSelectedPickerId] = useState("");
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [selectedAssignedPicker, setSelectedAssignedPicker] = useState("all");
  const [assignmentProgressFilter, setAssignmentProgressFilter] = useState<AssignmentProgressFilter>("todos");
  const [activeAssignmentId, setActiveAssignmentId] = useState("");
  const [scanProduct, setScanProduct] = useState("");
  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([{ location: "", qty: "1" }]);
  const [locationsByLine, setLocationsByLine] = useState<Record<string, string[]>>({});
  const [stockByLine, setStockByLine] = useState<Record<string, number>>({});
  const [lastErpSync, setLastErpSync] = useState<string | null>(null);
  const [selectedSourceStore, setSelectedSourceStore] = useState("all");
  const [selectedReasonFilter, setSelectedReasonFilter] = useState("all");
  const [selectedOperatorReason, setSelectedOperatorReason] = useState("all");
  const [selectedRequesterStore, setSelectedRequesterStore] = useState("all");
  const [selectedReportPicker, setSelectedReportPicker] = useState("all");
  const [selectedRegistryPicker, setSelectedRegistryPicker] = useState("all");
  const [selectedRegistryRequesterStore, setSelectedRegistryRequesterStore] = useState("all");
  const [assignmentDate, setAssignmentDate] = useState(todayISO());
  const assignmentDateRef = useRef(assignmentDate);
  useEffect(() => { assignmentDateRef.current = assignmentDate; }, [assignmentDate]);
  const [assignmentHistoryPage, setAssignmentHistoryPage] = useState(0);
  const assignmentHistoryPageRef = useRef(assignmentHistoryPage);
  useEffect(() => { assignmentHistoryPageRef.current = assignmentHistoryPage; }, [assignmentHistoryPage]);
  const [assignmentHistoryTotal, setAssignmentHistoryTotal] = useState(0);
  const [pickingDate, setPickingDate] = useState(todayISO());
  const pickingDateRef = useRef(pickingDate);
  useEffect(() => { pickingDateRef.current = pickingDate; }, [pickingDate]);
  const [reportDate, setReportDate] = useState(todayISO());
  const reportDateRef = useRef(reportDate);
  useEffect(() => { reportDateRef.current = reportDate; }, [reportDate]);
  const [registryDate, setRegistryDate] = useState(todayISO());
  const registryDateRef = useRef(registryDate);
  useEffect(() => { registryDateRef.current = registryDate; }, [registryDate]);
  const [productivityDateFrom, setProductivityDateFrom] = useState("");
  const productivityDateFromRef = useRef(productivityDateFrom);
  useEffect(() => { productivityDateFromRef.current = productivityDateFrom; }, [productivityDateFrom]);
  const [productivityDateTo, setProductivityDateTo] = useState("");
  const productivityDateToRef = useRef(productivityDateTo);
  useEffect(() => { productivityDateToRef.current = productivityDateTo; }, [productivityDateTo]);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  const [locationSort, setLocationSort] = useState<LocationSort>("asc");
  const [locationFilter, setLocationFilter] = useState<PickingLocationFilter>({ zone: "", lineal: "", metro: "", nivel: "" });
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [scannerRunning, setScannerRunning] = useState(false);
  const [codeMismatch, setCodeMismatch] = useState<{ expected: string; scanned: string } | null>(null);
  const [editingScanId, setEditingScanId] = useState("");
  const [editScanLocation, setEditScanLocation] = useState("");
  const [editScanQty, setEditScanQty] = useState("");
  const [scannerLocationIndex, setScannerLocationIndex] = useState(0);
  const scannerRef = useRef<Html5QrLike | null>(null);
  const scanHandledRef = useRef(false);
  const scannerContainerId = "picking-scanner";

  const manager = canManagePicking(user);
  const admin = user?.role === "Administrador";
  // Una fecha anterior en Asignación es una consulta de historial: muestra el
  // requerimiento aunque RMS ya lo haya recepcionado, pero sin permitir cambios.
  const historicalAssignmentView = manager && panel === "asignacion" && (!assignmentDate || assignmentDate < todayISO());
  const assignmentHistoryPages = Math.max(1, Math.ceil(assignmentHistoryTotal / 100));

  // Derivan del universo completo (filterSourceStores/filterReasons, ver loadData) y no
  // de `requests`, que ahora solo trae los requerimientos de la pestana/fecha activa: si
  // dependieran de `requests` el listado de opciones cambiaria segun la fecha elegida.
  const sourceStoreOptions = useMemo(
    () => [...filterSourceStores].sort((a, b) => a.label.localeCompare(b.label)),
    [filterSourceStores]
  );

  const reasonOptions = useMemo(
    () => [...filterReasons].sort((a, b) => a.label.localeCompare(b.label)),
    [filterReasons]
  );

  const sourceFilteredRequests = useMemo(
    () => selectedSourceStore === "all"
      ? requests
      : requests.filter(request => normalize(request.source_store_code || request.source_store_name) === selectedSourceStore),
    [requests, selectedSourceStore]
  );

  const reasonFilteredRequests = useMemo(
    () => selectedReasonFilter === "all"
      ? sourceFilteredRequests
      : sourceFilteredRequests.filter(request => normalize(request.reason) === selectedReasonFilter),
    [sourceFilteredRequests, selectedReasonFilter]
  );

  const filteredRequests = useMemo(
    () => reasonFilteredRequests.filter(request => sameDate(request.creation_date, assignmentDate)),
    [assignmentDate, reasonFilteredRequests]
  );

  const selectedRequest = useMemo(
    () => filteredRequests.find(request => request.id === selectedRequestId) || filteredRequests[0] || null,
    [filteredRequests, selectedRequestId]
  );

  const visibleLines = useMemo(
    () => lines.filter(line => line.request_id === selectedRequest?.id),
    [lines, selectedRequest?.id]
  );

  const assignmentsByLine = useMemo(() => {
    const grouped = new Map<string, PickingAssignment[]>();
    for (const assignment of assignments) {
      if (!grouped.has(assignment.line_id)) grouped.set(assignment.line_id, []);
      grouped.get(assignment.line_id)!.push(assignment);
    }
    return grouped;
  }, [assignments]);

  const parsedLocations = useMemo(() => {
    const rows: ParsedPickingLocation[] = [];
    for (const locations of Object.values(locationsByLine)) {
      for (const location of locations) {
        const parsed = parsePickingLocation(location);
        if (parsed) rows.push(parsed);
      }
    }
    return rows;
  }, [locationsByLine]);

  const locationFilterOptions = useMemo(() => {
    const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
    const zones = unique(parsedLocations.map(location => location.zone));
    const lineales = locationFilter.zone
      ? unique(parsedLocations.filter(location => location.zone === locationFilter.zone).map(location => location.lineal))
      : [];
    const metros = locationFilter.zone && locationFilter.lineal
      ? unique(parsedLocations
          .filter(location => location.zone === locationFilter.zone && location.lineal === locationFilter.lineal)
          .map(location => location.metro))
      : [];
    const niveles = locationFilter.zone && locationFilter.lineal && locationFilter.metro
      ? unique(parsedLocations
          .filter(location => location.zone === locationFilter.zone && location.lineal === locationFilter.lineal && location.metro === locationFilter.metro)
          .map(location => location.nivel))
      : [];
    return { zones, lineales, metros, niveles };
  }, [locationFilter.lineal, locationFilter.metro, locationFilter.zone, parsedLocations]);

  const locationFilteredLines = useMemo(() => {
    if (!locationFilter.zone) return visibleLines;
    return visibleLines.filter(line => {
      const assigned = assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
      if (Math.max(0, num(line.qty_requested) - assigned) <= 0) return false;
      return (locationsByLine[line.id] || []).some(location => {
        const parsed = parsePickingLocation(location);
        if (!parsed || parsed.zone !== locationFilter.zone) return false;
        if (locationFilter.lineal && parsed.lineal !== locationFilter.lineal) return false;
        if (locationFilter.metro && parsed.metro !== locationFilter.metro) return false;
        if (locationFilter.nivel && parsed.nivel !== locationFilter.nivel) return false;
        return true;
      });
    });
  }, [assignmentsByLine, locationFilter, locationsByLine, visibleLines]);

  const pickerNameById = useMemo(() => {
    const next = new Map<string, string>();
    for (const picker of pickers) next.set(picker.id, picker.full_name);
    return next;
  }, [pickers]);

  const assignmentPickerName = useCallback((assignment: PickingAssignment) => {
    return assignment.picker_id ? pickerNameById.get(assignment.picker_id) || assignment.picker_name : assignment.picker_name;
  }, [pickerNameById]);

  const scanPickerName = useCallback((scan: PickingScan) => {
    return scan.picker_id ? pickerNameById.get(scan.picker_id) || scan.picker_name || "-" : scan.picker_name || "-";
  }, [pickerNameById]);

  const selectedLineAssignments = useMemo(
    () => assignments.filter(assignment => {
      if (!selectedLineIds.has(assignment.line_id)) return false;
      if (selectedAssignedPicker === "all") return true;
      if (normalize(assignment.picker_id || assignment.picker_name) !== selectedAssignedPicker) return false;
      return assignmentProgressFilter === "todos" || num(assignment.picked_qty) <= 0;
    }),
    [assignmentProgressFilter, assignments, selectedAssignedPicker, selectedLineIds]
  );

  const selectedPicker = useMemo(
    () => pickers.find(picker => picker.id === selectedPickerId) || null,
    [pickers, selectedPickerId]
  );

  const assignedPickerOptions = useMemo(() => {
    const visibleLineIds = new Set(locationFilteredLines.map(line => line.id));
    const grouped = new Map<string, string>();
    for (const assignment of assignments) {
      if (!visibleLineIds.has(assignment.line_id)) continue;
      const key = normalize(assignment.picker_id || assignment.picker_name);
      if (!key) continue;
      grouped.set(key, assignmentPickerName(assignment));
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [assignmentPickerName, assignments, locationFilteredLines]);

  const sortedVisibleLines = useMemo(() => {
    return [...locationFilteredLines].sort((a, b) => {
      const aAssigned = assignmentsByLine.get(a.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
      const bAssigned = assignmentsByLine.get(b.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
      const aPending = Math.max(0, num(a.qty_requested) - aAssigned);
      const bPending = Math.max(0, num(b.qty_requested) - bAssigned);
      if (aPending > 0 && bPending <= 0) return -1;
      if (aPending <= 0 && bPending > 0) return 1;
      const aLoc = (locationsByLine[a.id] || [])[0] || "ZZZ";
      const bLoc = (locationsByLine[b.id] || [])[0] || "ZZZ";
      const cmp = aLoc.localeCompare(bLoc, "es");
      if (cmp !== 0) return locationSort === "asc" ? cmp : -cmp;
      return a.product_code.localeCompare(b.product_code, "es");
    });
  }, [assignmentsByLine, locationFilteredLines, locationSort, locationsByLine]);

  const assignmentFilteredLines = useMemo(() => {
    return sortedVisibleLines.filter(line => {
      const lineAssignments = assignmentsByLine.get(line.id) || [];
      if (selectedAssignedPicker === "all" && assignmentProgressFilter === "todos") return true;
      if (lineAssignments.length === 0) return true;
      return lineAssignments.some(assignment => {
        const matchesPicker = selectedAssignedPicker === "all" || normalize(assignment.picker_id || assignment.picker_name) === selectedAssignedPicker;
        const matchesProgress = assignmentProgressFilter === "todos" || num(assignment.picked_qty) <= 0;
        return matchesPicker && matchesProgress;
      });
    });
  }, [assignmentProgressFilter, assignmentsByLine, selectedAssignedPicker, sortedVisibleLines]);

  const firstScanDateByRequest = useMemo(() => {
    const requestIds = new Set(sourceFilteredRequests.map(request => request.id));
    const grouped = new Map<string, string>();
    for (const scan of scans) {
      if (!requestIds.has(scan.request_id)) continue;
      const scanDate = String(scan.created_at || "").slice(0, 10);
      if (!scanDate) continue;
      const current = grouped.get(scan.request_id);
      if (!current || scanDate < current) grouped.set(scan.request_id, scanDate);
    }
    return grouped;
  }, [scans, sourceFilteredRequests]);

  const assignmentEffectiveDate = useCallback((assignment: PickingAssignment) => {
    return assignment.picking_date || firstScanDateByRequest.get(assignment.request_id) || assignment.created_at;
  }, [firstScanDateByRequest]);

  const myAssignments = useMemo(() => {
    if (!user) return [];
    return assignments.filter(assignment => {
      const isMine = assignment.picker_id === user.id || normalize(assignment.picker_name) === normalize(user.full_name);
      if (!isMine) return false;
      return sameDate(assignmentEffectiveDate(assignment), pickingDate);
    });
  }, [assignmentEffectiveDate, assignments, pickingDate, user]);

  const requesterStoreOptions = useMemo(() => {
    const myRequestIds = new Set(myAssignments.map(assignment => assignment.request_id));
    const grouped = new Map<string, string>();
    for (const request of requests) {
      if (!myRequestIds.has(request.id)) continue;
      const key = requesterStoreKey(request);
      if (!key) continue;
      grouped.set(key, requesterStoreLabel(request));
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [myAssignments, requests]);

  const filteredMyAssignments = useMemo(() => {
    return myAssignments.filter(assignment => {
      const request = requests.find(item => item.id === assignment.request_id);
      if (selectedRequesterStore !== "all" && requesterStoreKey(request) !== selectedRequesterStore) return false;
      if (selectedOperatorReason !== "all" && normalize(request?.reason) !== selectedOperatorReason) return false;
      return true;
    });
  }, [myAssignments, requests, selectedRequesterStore, selectedOperatorReason]);

  const sortedMyAssignments = useMemo(() => {
    return [...filteredMyAssignments].sort((a, b) => {
      const aLoc = (locationsByLine[a.line_id] || [])[0] || "ZZZ";
      const bLoc = (locationsByLine[b.line_id] || [])[0] || "ZZZ";
      const cmp = aLoc.localeCompare(bLoc, "es");
      if (cmp !== 0) return cmp;
      const aLine = lines.find(line => line.id === a.line_id);
      const bLine = lines.find(line => line.id === b.line_id);
      return String(aLine?.product_code || "").localeCompare(String(bLine?.product_code || ""), "es");
    });
  }, [filteredMyAssignments, lines, locationsByLine]);

  const activeAssignment = useMemo(
    () => {
      const open = sortedMyAssignments.filter(item => num(item.picked_qty) < num(item.assigned_qty));
      return open.find(item => item.id === activeAssignmentId) || open[0] || null;
    },
    [activeAssignmentId, sortedMyAssignments]
  );

  const activeLine = useMemo(
    () => lines.find(line => line.id === activeAssignment?.line_id) || null,
    [activeAssignment?.line_id, lines]
  );

  const activeRequest = useMemo(
    () => requests.find(request => request.id === activeAssignment?.request_id) || null,
    [activeAssignment?.request_id, requests]
  );

  const assignmentCodeTotals = useMemo(() => {
    const requestIds = new Set(filteredRequests.map(request => request.id));
    const requiredCodes = lines.filter(line => requestIds.has(line.request_id)).length;
    const assignedCodes = new Set(assignments.filter(assignment => requestIds.has(assignment.request_id)).map(assignment => assignment.line_id)).size;
    const assignedRequests = filteredRequests.filter(request => {
      const requestLines = lines.filter(line => line.request_id === request.id);
      if (requestLines.length === 0) return false;
      const assignedLineIds = new Set(assignments.filter(assignment => assignment.request_id === request.id).map(assignment => assignment.line_id));
      return requestLines.every(line => assignedLineIds.has(line.id));
    }).length;
    return { requiredCodes, assignedCodes, pendingCodes: Math.max(0, requiredCodes - assignedCodes), assignedRequests };
  }, [assignments, filteredRequests, lines]);

  const summaryAssignments = useMemo(() => {
    const requestIds = new Set(reasonFilteredRequests.map(request => request.id));
    return assignments.filter(assignment => requestIds.has(assignment.request_id) && sameDate(assignmentEffectiveDate(assignment), reportDate));
  }, [assignmentEffectiveDate, assignments, reportDate, reasonFilteredRequests]);

  const summaryRequests = useMemo(() => {
    const requestIds = new Set(summaryAssignments.map(assignment => assignment.request_id));
    return reasonFilteredRequests.filter(request => requestIds.has(request.id));
  }, [reasonFilteredRequests, summaryAssignments]);

  const assignmentMatrix = useMemo(() => {
    const requestIds = new Set(summaryRequests.map(request => request.id));
    const requiredByStore = new Map<string, { label: string; required: number }>();
    const assignedLinesByStorePicker = new Map<string, Set<string>>();
    const assignedLinesByStore = new Map<string, Set<string>>();
    const pickerColumns = new Map<string, string>();

    for (const line of lines) {
      if (!requestIds.has(line.request_id)) continue;
      const request = summaryRequests.find(item => item.id === line.request_id);
      const storeKey = requesterStoreKey(request) || "SIN_TIENDA";
      const current = requiredByStore.get(storeKey) || { label: requesterStoreLabel(request), required: 0 };
      current.required += 1;
      requiredByStore.set(storeKey, current);
    }

    for (const assignment of summaryAssignments) {
      if (!requestIds.has(assignment.request_id)) continue;
      const request = summaryRequests.find(item => item.id === assignment.request_id);
      const storeKey = requesterStoreKey(request) || "SIN_TIENDA";
      const pickerKey = normalize(assignment.picker_id || assignment.picker_name) || "SIN_PICADOR";
      pickerColumns.set(pickerKey, assignmentPickerName(assignment));
      const spKey = `${storeKey}__${pickerKey}`;
      if (!assignedLinesByStorePicker.has(spKey)) assignedLinesByStorePicker.set(spKey, new Set());
      assignedLinesByStorePicker.get(spKey)!.add(assignment.line_id);
      if (!assignedLinesByStore.has(storeKey)) assignedLinesByStore.set(storeKey, new Set());
      assignedLinesByStore.get(storeKey)!.add(assignment.line_id);
    }

    const columns = [...pickerColumns.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
    const rows = [...requiredByStore.entries()].map(([key, value]) => {
      const assigned = assignedLinesByStore.get(key)?.size || 0;
      return {
        key,
        label: value.label,
        required: value.required,
        assigned,
        byPicker: Object.fromEntries(columns.map(column => [column.key, assignedLinesByStorePicker.get(`${key}__${column.key}`)?.size || 0])) as Record<string, number>,
      };
    }).sort((a, b) => a.label.localeCompare(b.label, "es"));

    return { columns, rows };
  }, [assignmentPickerName, lines, summaryAssignments, summaryRequests]);

  const summaryCodeTotals = useMemo(() => {
    const required = assignmentMatrix.rows.reduce((sum, row) => sum + row.required, 0);
    const assigned = assignmentMatrix.rows.reduce((sum, row) => sum + row.assigned, 0);
    return { required, assigned, pending: Math.max(0, required - assigned) };
  }, [assignmentMatrix.rows]);

  const reportAssignments = useMemo(() => {
    const requestIds = new Set(reasonFilteredRequests.map(request => request.id));
    return assignments.filter(assignment => {
      if (!requestIds.has(assignment.request_id)) return false;
      if (!sameDate(assignmentEffectiveDate(assignment), reportDate)) return false;
      return selectedReportPicker === "all" || normalize(assignment.picker_id || assignment.picker_name) === selectedReportPicker;
    });
  }, [assignmentEffectiveDate, assignments, reportDate, selectedReportPicker, reasonFilteredRequests]);

  const reportPickerOptions = useMemo(() => {
    const requestIds = new Set(reasonFilteredRequests.map(request => request.id));
    const grouped = new Map<string, string>();
    for (const assignment of assignments) {
      if (!requestIds.has(assignment.request_id)) continue;
      if (!sameDate(assignmentEffectiveDate(assignment), reportDate)) continue;
      const key = normalize(assignment.picker_id || assignment.picker_name);
      if (!key) continue;
      grouped.set(key, assignmentPickerName(assignment));
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [assignmentEffectiveDate, assignmentPickerName, assignments, reportDate, reasonFilteredRequests]);

  const reportScansByAssignment = useMemo(() => {
    const assignmentIds = new Set(reportAssignments.map(assignment => assignment.id));
    const grouped = new Map<string, number>();
    for (const scan of scans) {
      if (!assignmentIds.has(scan.assignment_id)) continue;
      grouped.set(scan.assignment_id, (grouped.get(scan.assignment_id) || 0) + num(scan.qty));
    }
    return grouped;
  }, [reportAssignments, scans]);

  const reportRows = useMemo(() => {
    const lineIds = new Set(reportAssignments.map(assignment => assignment.line_id));
    return lines.filter(line => lineIds.has(line.id)).map(line => {
      const request = requests.find(item => item.id === line.request_id);
      const lineAssignments = reportAssignments.filter(item => item.line_id === line.id);
      const assigned = lineAssignments.reduce((sum, item) => sum + num(item.assigned_qty), 0);
      const picked = lineAssignments.reduce((sum, item) => sum + (reportScansByAssignment.get(item.id) || 0), 0);
      return {
        line,
        request,
        assigned,
        picked,
        diffRequired: picked - assigned,
        diffStock: num(stockByLine[line.id]) - picked,
        stock: num(stockByLine[line.id]),
        pickers: lineAssignments.map(assignmentPickerName).join(", ") || "-",
      };
    });
  }, [assignmentPickerName, lines, reportAssignments, reportScansByAssignment, requests, stockByLine]);

  const reportCodeRows = useMemo(() => {
    return reportAssignments.map(assignment => {
      const request = requests.find(item => item.id === assignment.request_id);
      const picked = reportScansByAssignment.get(assignment.id) || 0;
      return {
        assignment,
        request,
        total: 1,
        done: isAssignmentComplete(assignment, picked) ? 1 : 0,
      };
    });
  }, [reportAssignments, reportScansByAssignment, requests]);

  const reportByStore = useMemo(() => {
    const grouped = new Map<string, { label: string; total: number; done: number }>();
    for (const row of reportCodeRows) {
      const label = requesterStoreLabel(row.request);
      const current = grouped.get(label) || { label, total: 0, done: 0 };
      current.total += row.total;
      current.done += row.done;
      grouped.set(label, current);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [reportCodeRows]);

  const reportRequests = useMemo(() => {
    return reasonFilteredRequests
      .map(request => {
        const rows = reportCodeRows.filter(row => row.request?.id === request.id);
        const total = rows.reduce((sum, row) => sum + row.total, 0);
        const done = rows.reduce((sum, row) => sum + row.done, 0);
        const assigned = total;
        const status = done >= total && total > 0 ? "Completado" : assigned > 0 ? "En proceso" : "Pendiente";
        return { request, total, done, assigned, status };
      })
      .filter(row => row.assigned > 0)
      .sort((a, b) => {
        if (a.status === "En proceso" && b.status !== "En proceso") return -1;
        if (a.status !== "En proceso" && b.status === "En proceso") return 1;
        return (b.request.creation_date || "").localeCompare(a.request.creation_date || "");
      });
  }, [reportCodeRows, reasonFilteredRequests]);

    const reportByPicker = useMemo(() => {
    const grouped = new Map<string, { label: string; total: number; done: number }>();
    for (const assignment of reportAssignments) {
      const label = assignmentPickerName(assignment);
      const current = grouped.get(label) || { label, total: 0, done: 0 };
      current.total += 1;
      current.done += isAssignmentComplete(assignment, reportScansByAssignment.get(assignment.id) || 0) ? 1 : 0;
      grouped.set(label, current);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [assignmentPickerName, reportAssignments, reportScansByAssignment]);

  const reportTotals = useMemo(() => {
    const required = reportCodeRows.reduce((sum, row) => sum + row.total, 0);
    const picked = reportCodeRows.reduce((sum, row) => sum + row.done, 0);
    return { required, picked, progress: pct(picked, required) };
  }, [reportCodeRows]);

  const selectedReportRequest = useMemo(
    () => reportRequests.find(row => row.request.id === selectedRequestId)?.request || reportRequests[0]?.request || null,
    [reportRequests, selectedRequestId]
  );

  const selectedRequestReport = useMemo(() => {
    if (!selectedReportRequest) return { total: 0, done: 0 };
    const rows = reportCodeRows.filter(row => row.request?.id === selectedReportRequest.id);
    return {
      total: rows.reduce((sum, row) => sum + row.total, 0),
      done: rows.reduce((sum, row) => sum + row.done, 0),
    };
  }, [reportCodeRows, selectedReportRequest]);

  const allScanRows = useMemo(() => {
    const requestIds = new Set(reasonFilteredRequests.map(request => request.id));
    return scans.filter(scan => requestIds.has(scan.request_id) && sameDate(scan.created_at, registryDate)).map(scan => {
      const line = lines.find(item => item.id === scan.line_id);
      const request = requests.find(item => item.id === scan.request_id);
      return { scan, line, request };
    });
  }, [lines, registryDate, requests, scans, reasonFilteredRequests]);

  const registryPickerOptions = useMemo(() => {
    const grouped = new Map<string, string>();
    for (const row of allScanRows) {
      const key = normalize(row.scan.picker_id || row.scan.picker_name);
      if (!key) continue;
      grouped.set(key, scanPickerName(row.scan));
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [allScanRows, scanPickerName]);

  const registryRequesterStoreOptions = useMemo(() => {
    const grouped = new Map<string, string>();
    for (const row of allScanRows) {
      const key = requesterStoreKey(row.request);
      if (!key) continue;
      grouped.set(key, requesterStoreLabel(row.request));
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [allScanRows]);

  const scanRows = useMemo(() => {
    return allScanRows.filter(row => {
      const pickerKey = normalize(row.scan.picker_id || row.scan.picker_name);
      const requesterKey = requesterStoreKey(row.request);
      if (selectedRegistryPicker !== "all" && pickerKey !== selectedRegistryPicker) return false;
      if (selectedRegistryRequesterStore !== "all" && requesterKey !== selectedRegistryRequesterStore) return false;
      return true;
    });
  }, [allScanRows, selectedRegistryPicker, selectedRegistryRequesterStore]);

  const productivityScanRows = useMemo(() => {
    const requestIds = new Set(reasonFilteredRequests.map(request => request.id));
    return scans
      .filter(scan => requestIds.has(scan.request_id) && inDateRange(scan.created_at, productivityDateFrom, productivityDateTo))
      .map(scan => {
        const line = lines.find(item => item.id === scan.line_id);
        const request = requests.find(item => item.id === scan.request_id);
        return { scan, line, request };
      });
  }, [lines, productivityDateFrom, productivityDateTo, requests, scans, reasonFilteredRequests]);

  const productivityRows = useMemo(() => {
    const grouped = new Map<string, { label: string; codes: Set<string>; units: number; locations: Set<string> }>();
    for (const row of productivityScanRows) {
      const key = normalize(row.scan.picker_id || row.scan.picker_name) || scanPickerName(row.scan);
      const current = grouped.get(key) || { label: scanPickerName(row.scan), codes: new Set<string>(), units: 0, locations: new Set<string>() };
      if (row.scan.line_id) current.codes.add(row.scan.line_id);
      current.units += num(row.scan.qty);
      const location = normalize(row.scan.location_code);
      if (location) current.locations.add(location);
      grouped.set(key, current);
    }
    return [...grouped.values()].sort((a, b) => b.units - a.units);
  }, [productivityScanRows, scanPickerName]);

  const productivityByCodes = useMemo(
    () => productivityRows.map(row => ({ label: row.label, value: row.codes.size })).sort((a, b) => b.value - a.value),
    [productivityRows]
  );

  const productivityByUnits = useMemo(
    () => productivityRows.map(row => ({ label: row.label, value: row.units })).sort((a, b) => b.value - a.value),
    [productivityRows]
  );

  const productivityByLocations = useMemo(
    () => productivityRows.map(row => ({ label: row.label, value: row.locations.size })).sort((a, b) => b.value - a.value),
    [productivityRows]
  );

  const productivityHourlyComparison = useMemo(() => {
    const palette = ["#2563eb", "#16a34a", "#eab308", "#dc2626", "#7c3aed", "#0891b2", "#f97316", "#475569"];
    const pickerColumns = new Map<string, string>();
    const hourRows = new Map<string, { hour: string; total: number; byPicker: Record<string, number>; codeSets: Record<string, Set<string>> }>();

    for (const row of productivityScanRows) {
      const pickerKey = normalize(row.scan.picker_id || row.scan.picker_name) || scanPickerName(row.scan);
      pickerColumns.set(pickerKey, scanPickerName(row.scan));
      const hour = new Date(row.scan.created_at).toLocaleTimeString("es-PE", { hour: "2-digit", hour12: false }) + ":00";
      const current = hourRows.get(hour) || { hour, total: 0, byPicker: {}, codeSets: {} };
      if (!current.codeSets[pickerKey]) current.codeSets[pickerKey] = new Set<string>();
      current.codeSets[pickerKey].add(row.scan.line_id || row.scan.assignment_id || row.scan.id);
      hourRows.set(hour, current);
    }

    const columns = [...pickerColumns.entries()]
      .map(([key, label], index) => ({ key, label, color: palette[index % palette.length] }))
      .sort((a, b) => a.label.localeCompare(b.label, "es"));
    const rows = [...hourRows.values()].sort((a, b) => a.hour.localeCompare(b.hour)).map(row => {
      const byPicker = Object.fromEntries(columns.map(column => [column.key, row.codeSets[column.key]?.size || 0])) as Record<string, number>;
      const total = columns.reduce((sum, column) => sum + byPicker[column.key], 0);
      return { hour: row.hour, total, byPicker };
    });
    const maxValue = rows.reduce((max, row) => Math.max(max, ...columns.map(column => row.byPicker[column.key] || 0)), 0);
    const maxTotal = rows.reduce((max, row) => Math.max(max, row.total), 0);
    const bestHour = rows.reduce<{ hour: string; total: number } | null>((best, row) => !best || row.total > best.total ? { hour: row.hour, total: row.total } : best, null);
    const bestPicker = bestHour
      ? columns
          .map(column => ({ label: column.label, color: column.color, value: rows.find(row => row.hour === bestHour.hour)?.byPicker[column.key] || 0 }))
          .sort((a, b) => b.value - a.value)[0] || null
      : null;
    const totalsByPicker = columns.map(column => ({
      ...column,
      total: rows.reduce((sum, row) => sum + (row.byPicker[column.key] || 0), 0),
    }));
    const bestJourneyPicker = [...totalsByPicker].sort((a, b) => b.total - a.total)[0] || null;
    const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
    return { columns, rows, maxValue, maxTotal, bestHour, bestPicker, bestJourneyPicker, totalsByPicker, grandTotal };
  }, [productivityScanRows, scanPickerName]);

  const operatorTotals = useMemo(() => {
    const assigned = filteredMyAssignments.reduce((sum, item) => sum + num(item.assigned_qty), 0);
    const picked = filteredMyAssignments.reduce((sum, item) => sum + num(item.picked_qty), 0);
    return { assigned, picked, progress: pct(picked, assigned) };
  }, [filteredMyAssignments]);

  const openOperatorAssignments = useMemo(
    () => sortedMyAssignments.filter(item => num(item.picked_qty) < num(item.assigned_qty)),
    [sortedMyAssignments]
  );

  const filteredMyAssignmentKeys = useMemo(() =>
    new Set(filteredMyAssignments.map(assignment => `${assignment.request_id}:${assignment.line_id}`)),
  [filteredMyAssignments]);

  const operatorScanRows = useMemo(
    () => allScanRows.filter(row => {
      const isMine = row.scan.picker_id === user?.id || normalize(row.scan.picker_name) === normalize(user?.full_name);
      if (!isMine) return false;
      if (!filteredMyAssignmentKeys.has(`${row.scan.request_id}:${row.scan.line_id}`)) return false;
      return selectedRequesterStore === "all" || requesterStoreKey(row.request) === selectedRequesterStore;
    }),
    [allScanRows, filteredMyAssignmentKeys, selectedRequesterStore, user]
  );

  const loadData = useCallback(async (currentUser: CyclicUser) => {
    setLoading(true);
    const currentUserCanManage = canManagePicking(currentUser);

    // Trae TODAS las filas paginando de 1000 en 1000 para evitar el limite de Supabase
    async function fetchAll<T>(buildQuery: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown }>): Promise<T[]> {
      const PAGE = 1000;
      let all: T[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await buildQuery(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        all = all.concat(rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return all;
    }

    // RMS puede marcar un requerimiento como recepcionado después de que el
    // picador lo haya trabajado. El avance sigue siendo válido y debe verse en
    // su fecha; por eso los reportes por día no dependen del estado actual de
    // RMS. La pestaña de Asignación conserva su propio filtro: solo activos.
    async function fetchPickingRowsForDate(date: string, picker?: CyclicUser) {
      const dayStart = `${date}T00:00:00.000Z`;
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
      const buildAssignmentsQuery = (legacy: boolean, identity?: "id" | "name") => (from: number, to: number) => {
        let query = supabase
          .from("picking_assignments")
          .select("*")
          .neq("status", "cancelado")
          .order("created_at", { ascending: false })
          .range(from, to);
        query = legacy
          ? query.is("picking_date", null).gte("created_at", dayStart).lt("created_at", dayEnd)
          : query.eq("picking_date", date);
        if (picker && identity === "id") query = query.eq("picker_id", picker.id);
        if (picker && identity === "name") query = query.eq("picker_name", picker.full_name);
        return query as unknown as Promise<{ data: PickingAssignment[] | null; error: unknown }>;
      };

      const queries: Array<Promise<PickingAssignment[]>> = [];
      for (const legacy of [false, true]) {
        if (picker) {
          queries.push(fetchAll<PickingAssignment>(buildAssignmentsQuery(legacy, "id")));
          queries.push(fetchAll<PickingAssignment>(buildAssignmentsQuery(legacy, "name")));
        } else {
          queries.push(fetchAll<PickingAssignment>(buildAssignmentsQuery(legacy)));
        }
      }
      const assignmentRows = [...new Map((await Promise.all(queries)).flat().map(row => [row.id, row])).values()];
      const requestIds = [...new Set(assignmentRows.map(row => row.request_id))];
      if (!requestIds.length) return [] as Array<{ assignment: PickingAssignment; request: PickingRequest; line: PickingLine }>;

      const [requestRows, lineRows] = await Promise.all([
        fetchAll<PickingRequest>((from, to) =>
          supabase.from("picking_requests").select("*").in("id", requestIds).is("hidden_at", null).range(from, to) as unknown as Promise<{ data: PickingRequest[] | null; error: unknown }>
        ),
        fetchAll<PickingLine>((from, to) =>
          supabase.from("picking_request_lines").select("*").in("request_id", requestIds).range(from, to) as unknown as Promise<{ data: PickingLine[] | null; error: unknown }>
        ),
      ]);
      const requestsById = new Map(requestRows.map(row => [row.id, row]));
      const linesById = new Map(lineRows.map(row => [row.id, row]));
      return assignmentRows.flatMap(assignment => {
        const request = requestsById.get(assignment.request_id);
        const line = linesById.get(assignment.line_id);
        return request && line ? [{ assignment, request, line }] : [];
      });
    }

    const [usersResp, storesResp, syncResp, syncFallbackResp] = await Promise.all([
      supabase
        .from("cyclic_users")
        .select("id,full_name,role,module_access,whatsapp")
        .eq("is_active", true)
        .order("full_name"),
      supabase.from("stores").select("id,code,name,erp_sede").eq("is_active", true),
      supabase.from("erp_sync_status").select("synced_at,updated_at").eq("id", "picking_requests").maybeSingle(),
      supabase.from("picking_requests").select("source_updated_at,updated_at").order("source_updated_at", { ascending: false }).limit(1),
    ]);

    setLastErpSync(syncResp.data?.synced_at || syncResp.data?.updated_at || syncFallbackResp.data?.[0]?.source_updated_at || syncFallbackResp.data?.[0]?.updated_at || null);
    setPickers(((usersResp.data || []) as CyclicUser[]).filter(item => item.role === "Operario" && canAccessModule(item, "picking")));
    setStores((storesResp.data || []) as StoreRow[]);

    try {
      if (currentUserCanManage) {
        // El filtro de tienda entrega / motivo del header es compartido por las 5
        // pestanas y debe reflejar el universo COMPLETO de requerimientos activos,
        // no solo los de la fecha que se esta mirando; se pide aparte, liviano (2
        // columnas, sin lines ni assignments), independiente del resto del fetch.
        const filterOptionsResp = await supabase
          .from("picking_requests")
          .select("source_store_code,source_store_name,reason")
          // Los motivos vigentes se cargan completos. Para no perder el
          // historial operativo, tambien se mantienen en los filtros los tres
          // motivos que Picking ya trabajaba antes de esta ampliacion.
          .or("status_code.eq.A,reason.eq.ABASTECIMIENTO,reason.eq.ABASTECIMIENTO URGENTE,reason.ilike.*IMPORT*")
          .is("hidden_at", null);

        if (filterOptionsResp.error) {
          toast.error("No pude leer picking_requests. Ejecuta primero supabase_picking.sql.");
          setLoading(false);
          return;
        }

        const filterRows = (filterOptionsResp.data || []) as Array<{ source_store_code: string; source_store_name: string | null; reason: string | null }>;
        const sourceStoreGrouped = new Map<string, string>();
        const reasonGrouped = new Map<string, string>();
        for (const row of filterRows) {
          const storeKey = normalize(row.source_store_code || row.source_store_name);
          if (storeKey) sourceStoreGrouped.set(storeKey, row.source_store_name || row.source_store_code);
          const reasonKey = normalize(row.reason);
          if (reasonKey) reasonGrouped.set(reasonKey, row.reason || reasonKey);
        }
        setFilterSourceStores([...sourceStoreGrouped.entries()].map(([key, label]) => ({ key, label })));
        setFilterReasons([...reasonGrouped.entries()].map(([key, label]) => ({ key, label })));

        // Cada pestana pide solo los datos de la fecha (o rango) que esta mirando en
        // ese momento, en vez del dataset activo completo (antes: TODOS los
        // requerimientos activos + sus 31,612 lineas + 28,085 asignaciones en una
        // sola carga, sin importar pestana ni fecha). Ver
        // supabase/migrations/20260720133000_picking_manager_scoped_queries.sql.
        if (panel === "asignacion") {
          // Para operar se muestran solo activos. Al elegir una fecha anterior,
          // esta misma pestaña se convierte en historial de solo lectura y
          // conserva los requerimientos que RMS ya recepcionó.
          const day = assignmentDateRef.current;
          const historicalDay = !day || day < todayISO();
          let requestsQuery = supabase
            .from("picking_requests")
            .select("*", { count: "exact" })
            .is("hidden_at", null)
            .order("creation_date", { ascending: false });
          if (!historicalDay) requestsQuery = requestsQuery.eq("status_code", "A");
          if (day) {
            const dayStart = `${day}T00:00:00.000Z`;
            const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
            requestsQuery = requestsQuery.gte("creation_date", dayStart).lt("creation_date", dayEnd);
          } else {
            const pageSize = 100;
            const historyPage = assignmentHistoryPageRef.current;
            requestsQuery = requestsQuery.range(historyPage * pageSize, (historyPage + 1) * pageSize - 1);
          }
          const requestsResp = await requestsQuery;

          if (requestsResp.error) {
            toast.error("No pude leer picking_requests. Ejecuta primero supabase_picking.sql.");
            setLoading(false);
            return;
          }

          const requestRows = (requestsResp.data || []) as PickingRequest[];
          setAssignmentHistoryTotal(!day ? (requestsResp.count || 0) : 0);
          setRequests(requestRows);
          if (!selectedRequestIdRef.current && requestRows[0]) setSelectedRequestId(requestRows[0].id);

          if (requestRows.length === 0) {
            setLines([]);
            setAssignments([]);
            setScans([]);
            setLoading(false);
            return;
          }

          const requestIds = requestRows.map(request => request.id);
          const [allLines, allAssignments] = await Promise.all([
            fetchAll<PickingLine>((from, to) =>
              supabase.from("picking_request_lines").select("*").in("request_id", requestIds).order("id").range(from, to) as unknown as Promise<{ data: PickingLine[] | null; error: unknown }>
            ),
            fetchAll<PickingAssignment>((from, to) =>
              supabase.from("picking_assignments").select("*").in("request_id", requestIds).neq("status", "cancelado").order("created_at", { ascending: false }).range(from, to) as unknown as Promise<{ data: PickingAssignment[] | null; error: unknown }>
            ),
          ]);
          setLines(allLines);
          setAssignments(allAssignments);
          // Asignacion no usa picking_scans en ninguna parte (ni la vista, ni sus
          // acciones de asignar/reasignar/quitar); se deja vacio para no traerlos.
          setScans([]);
        } else if (panel === "resumen" || panel === "reportes") {
          // Resumen y Reportes comparten "fecha efectiva" de asignacion (picking_date,
          // o si no existe el primer scan del requerimiento, o si no created_at); la
          // resuelve get_picking_assignments_by_date en el servidor. p_date null (boton
          // "Limpiar fecha") reproduce el fetch completo original sin filtro de fecha.
          type ReportRow = { assignment: PickingAssignment; request: PickingRequest; line: PickingLine };
          const selectedReportDate = reportDateRef.current;
          let rows: ReportRow[];
          if (selectedReportDate) {
            rows = await fetchPickingRowsForDate(selectedReportDate) as ReportRow[];
          } else {
            const rpcResp = await supabase.rpc("get_picking_assignments_by_date", { p_date: null });
            if (rpcResp.error) {
              toast.error("No pude leer picking_requests. Ejecuta primero supabase_picking.sql.");
              setLoading(false);
              return;
            }
            rows = (rpcResp.data || []) as ReportRow[];
          }
          const requestsById = new Map<string, PickingRequest>();
          const linesById = new Map<string, PickingLine>();
          const rowAssignments: PickingAssignment[] = [];
          for (const row of rows) {
            if (!requestsById.has(row.request.id)) requestsById.set(row.request.id, row.request);
            if (!linesById.has(row.line.id)) linesById.set(row.line.id, row.line);
            rowAssignments.push(row.assignment);
          }

          const requestIds = [...requestsById.keys()];
          setRequests([...requestsById.values()]);
          if (!selectedRequestIdRef.current && requestIds[0]) setSelectedRequestId(requestIds[0]);
          setAssignments(rowAssignments);

          const assignmentIds = rowAssignments.map(assignment => assignment.id);
          const [linesResp, scansResp] = await Promise.all([
            // Resumen necesita TODAS las lineas de cada requerimiento en pantalla (no
            // solo las asignadas) para el conteo "requerido vs asignado" y las filas
            // pendientes del Excel; Reportes solo usa lineas con asignacion, que ya
            // vienen en el join de arriba.
            panel === "resumen" && requestIds.length
              ? supabase.from("picking_request_lines").select("*").in("request_id", requestIds)
              : Promise.resolve({ data: null as PickingLine[] | null, error: null }),
            // reportScansByAssignment (pestana Reportes) suma TODOS los scans de cada
            // asignacion en pantalla, sin filtrarlos de nuevo por fecha (una asignacion
            // puede completarse en un dia distinto al de su fecha efectiva).
            assignmentIds.length
              ? supabase.from("picking_scans").select("*").in("assignment_id", assignmentIds)
              : Promise.resolve({ data: [] as PickingScan[], error: null }),
          ]);

          if (linesResp.error) toast.error("No pude leer lineas: " + linesResp.error.message);
          if (scansResp.error) toast.error("No pude leer registros: " + scansResp.error.message);

          setLines(panel === "resumen" && linesResp.data ? (linesResp.data as PickingLine[]) : [...linesById.values()]);
          setScans((scansResp.data || []) as PickingScan[]);
        } else {
          // Registros (un dia puntual) y Productividad (rango, puede venir con un solo
          // extremo o ninguno) comparten get_picking_scans_by_date_range. Ambos extremos
          // null reproduce el limite de 2000 escaneos mas recientes que ya usaba el
          // fetch completo original como "sin filtro de fecha".
          const pFrom = panel === "registros" ? (registryDateRef.current || null) : (productivityDateFromRef.current || null);
          const pTo = panel === "registros" ? (registryDateRef.current || null) : (productivityDateToRef.current || null);
          const rpcResp = await supabase.rpc("get_picking_scans_by_date_range", { p_from: pFrom, p_to: pTo });

          if (rpcResp.error) {
            toast.error("No pude leer registros: " + rpcResp.error.message);
            setLoading(false);
            return;
          }

          type ScanRow = { scan: PickingScan; assignment: PickingAssignment; request: PickingRequest; line: PickingLine };
          const rows = (rpcResp.data || []) as ScanRow[];
          const requestsById = new Map<string, PickingRequest>();
          const linesById = new Map<string, PickingLine>();
          const assignmentsById = new Map<string, PickingAssignment>();
          const rowScans: PickingScan[] = [];
          for (const row of rows) {
            if (!requestsById.has(row.request.id)) requestsById.set(row.request.id, row.request);
            if (!linesById.has(row.line.id)) linesById.set(row.line.id, row.line);
            if (row.assignment && !assignmentsById.has(row.assignment.id)) assignmentsById.set(row.assignment.id, row.assignment);
            rowScans.push(row.scan);
          }

          const requestIds = [...requestsById.keys()];
          setRequests([...requestsById.values()]);
          if (!selectedRequestIdRef.current && requestIds[0]) setSelectedRequestId(requestIds[0]);
          setLines([...linesById.values()]);
          // Solo para que el boton "Eliminar" de Registros (deleteScan) encuentre la
          // asignacion del scan en el estado local; Productividad no la usa.
          setAssignments([...assignmentsById.values()]);
          setScans(rowScans);
        }
      } else {
        // Operario: una sola consulta indexada en la base (get_my_picking_assignments,
        // ver supabase/migrations/20260714190000_picking_my_assignments_fn.sql) que
        // hace el JOIN asignacion+requerimiento+linea en el servidor, filtrado por
        // picker Y por la fecha seleccionada (pickingDate). Antes se traia el
        // historial COMPLETO del operario (cuentas de picking masivo acumulan miles
        // de asignaciones no canceladas a lo largo de meses) y se filtraba por fecha
        // recien en el navegador; ahora la base solo devuelve las filas del dia que
        // se esta mirando.
        type MyAssignmentRow = { assignment: PickingAssignment; request: PickingRequest; line: PickingLine };
        const rows = await fetchPickingRowsForDate(pickingDateRef.current, currentUser) as MyAssignmentRow[];

        const requestsById = new Map<string, PickingRequest>();
        const linesById = new Map<string, PickingLine>();
        const myAssignments: PickingAssignment[] = [];
        for (const row of rows) {
          if (!requestsById.has(row.request.id)) requestsById.set(row.request.id, row.request);
          if (!linesById.has(row.line.id)) linesById.set(row.line.id, row.line);
          myAssignments.push(row.assignment);
        }

        const requestRows = [...requestsById.values()];
        const requestIds = [...requestsById.keys()];

        const scansResp = requestIds.length
          ? await supabase.from("picking_scans").select("*").in("request_id", requestIds).eq("picker_id", currentUser.id).order("created_at", { ascending: false }).limit(500)
          : { data: [] as PickingScan[], error: null };
        if (scansResp.error) toast.error("No pude leer registros: " + scansResp.error.message);

        setRequests(requestRows);
        if (!selectedRequestIdRef.current && requestRows[0]) setSelectedRequestId(requestRows[0].id);
        setLines([...linesById.values()]);
        setAssignments(myAssignments);
        setScans((scansResp.data || []) as PickingScan[]);
      }
    } catch (error) {
      toast.error("No se pudo cargar el detalle completo de picking. Refresca o revisa el sync antes de asignar.");
      setLoading(false);
      return;
    }

    setLoading(false);
    // panel nunca cambia durante la vida de esta instancia (cada pestana es su propia
    // ruta/pagina que monta PickingModule de nuevo), asi que agregarlo a las deps no
    // recrea loadData en la practica; las fechas usan refs (como pickingDateRef) para
    // no forzar esa recreacion en cada tecleo del selector de fecha.
  }, [panel]);

  useEffect(() => {
    if (!selectedRequest || selectedRequestId === selectedRequest.id) return;
    const timer = window.setTimeout(() => setSelectedRequestId(selectedRequest.id), 0);
    return () => window.clearTimeout(timer);
  }, [selectedRequest, selectedRequestId]);

  useEffect(() => {
    if (selectedRequesterStore === "all") return;
    if (requesterStoreOptions.some(option => option.key === selectedRequesterStore)) return;
    const timer = window.setTimeout(() => setSelectedRequesterStore("all"), 0);
    return () => window.clearTimeout(timer);
  }, [requesterStoreOptions, selectedRequesterStore]);

  useEffect(() => {
    if (selectedAssignedPicker === "all") return;
    if (assignedPickerOptions.some(option => option.key === selectedAssignedPicker)) return;
    const timer = window.setTimeout(() => setSelectedAssignedPicker("all"), 0);
    return () => window.clearTimeout(timer);
  }, [assignedPickerOptions, selectedAssignedPicker]);

  useEffect(() => {
    if (selectedReportPicker === "all") return;
    if (reportPickerOptions.some(option => option.key === selectedReportPicker)) return;
    const timer = window.setTimeout(() => setSelectedReportPicker("all"), 0);
    return () => window.clearTimeout(timer);
  }, [reportPickerOptions, selectedReportPicker]);

  useEffect(() => {
    if (selectedRegistryPicker === "all") return;
    if (registryPickerOptions.some(option => option.key === selectedRegistryPicker)) return;
    const timer = window.setTimeout(() => setSelectedRegistryPicker("all"), 0);
    return () => window.clearTimeout(timer);
  }, [registryPickerOptions, selectedRegistryPicker]);

  useEffect(() => {
    if (selectedRegistryRequesterStore === "all") return;
    if (registryRequesterStoreOptions.some(option => option.key === selectedRegistryRequesterStore)) return;
    const timer = window.setTimeout(() => setSelectedRegistryRequesterStore("all"), 0);
    return () => window.clearTimeout(timer);
  }, [registryRequesterStoreOptions, selectedRegistryRequesterStore]);

  // Extraido a funcion aparte (no solo el efecto) porque printBatchAssignment
  // tambien la necesita: cuando imprime un lote que referencia lineas recien
  // llegadas (no estaban todavia en el estado `lines`), no puede esperar a
  // que este efecto reaccione en el proximo render -- ver comentario en
  // printBatchAssignment.
  async function resolveStockForLines(targetLines: PickingLine[], requestsList: PickingRequest[], storesList: StoreRow[]): Promise<Record<string, number>> {
    if (requestsList.length === 0 || targetLines.length === 0 || storesList.length === 0) return {};
    const sourceSedes = [...new Set(requestsList.map(request => {
      const sourceCode = normalize(request.source_store_code);
      const sourceName = normalize(request.source_store_name);
      const store = storesList.find(item =>
        normalize(item.code) === sourceCode ||
        normalize(item.erp_sede) === sourceCode ||
        normalize(item.name) === sourceName
      );
      return String(store?.erp_sede || store?.name || request.source_store_name || request.source_store_code || "").trim();
    }).filter(Boolean))];
    const codes = [...new Set(targetLines.flatMap(line => [line.product_code, line.sku].filter(Boolean) as string[]).map(normalize))];
    if (sourceSedes.length === 0 || codes.length === 0) return {};

    const stockRows: Array<{ sede: string | null; codsap: string | null; stock: number | string | null }> = [];
    for (let i = 0; i < codes.length; i += 500) {
      const { data } = await supabase
        .from("stock_general")
        .select("sede,codsap,stock")
        .in("sede", sourceSedes)
        .in("codsap", codes.slice(i, i + 500));
      stockRows.push(...((data || []) as typeof stockRows));
    }
    const bySedeCode = new Map<string, number>();
    for (const row of stockRows) {
      const key = `${normalize(row.sede)}__${normalize(row.codsap)}`;
      bySedeCode.set(key, (bySedeCode.get(key) || 0) + num(row.stock));
    }
    const next: Record<string, number> = {};
    for (const line of targetLines) {
      const request = requestsList.find(item => item.id === line.request_id);
      const sourceCode = normalize(request?.source_store_code);
      const sourceName = normalize(request?.source_store_name);
      const store = storesList.find(item =>
        normalize(item.code) === sourceCode ||
        normalize(item.erp_sede) === sourceCode ||
        normalize(item.name) === sourceName
      );
      const sede = normalize(store?.erp_sede || store?.name || request?.source_store_name || request?.source_store_code);
      next[line.id] = bySedeCode.get(`${sede}__${normalize(line.product_code)}`) || bySedeCode.get(`${sede}__${normalize(line.sku)}`) || 0;
    }
    return next;
  }

  useEffect(() => {
    void (async () => setStockByLine(await resolveStockForLines(lines, requests, stores)))();
  }, [lines, requests, stores]);

  const closeScanner = useCallback(async () => {
    try {
      await scannerRef.current?.stop();
      await scannerRef.current?.clear();
    } catch {}
    scannerRef.current = null;
    scanHandledRef.current = false;
    setScannerRunning(false);
    setScannerTarget(null);
  }, []);

  useEffect(() => {
    if (!scannerTarget) return;
    let cancelled = false;

    async function startScanner() {
      try {
        setScannerRunning(false);
        scanHandledRef.current = false;
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        const qr = new Html5Qrcode(scannerContainerId, {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93,
            Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.ITF,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
        }) as Html5QrLike;
        scannerRef.current = qr;
        await qr.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: scannerTarget === "product" ? 180 : 260 } },
          decodedText => {
            if (scanHandledRef.current) return;
            const clean = decodedText.trim();
            if (!clean) return;
            scanHandledRef.current = true;
            if (scannerTarget === "location") {
              setScanEntries(prev => prev.map((row, index) => index === scannerLocationIndex ? { ...row, location: clean } : row));
            }
            if (scannerTarget === "product") setScanProduct(clean);
            void closeScanner();
          },
          undefined
        );
        if (!cancelled) setScannerRunning(true);
      } catch (error) {
        toast.error("No se pudo abrir el escaner: " + (error instanceof Error ? error.message : String(error)));
        void closeScanner();
      }
    }

    void startScanner();
    return () => {
      cancelled = true;
      void closeScanner();
    };
  }, [closeScanner, scannerLocationIndex, scannerTarget]);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) {
      window.location.replace("/");
      return;
    }
    const parsed = JSON.parse(raw) as CyclicUser;
    if (!canAccessPicking(parsed)) {
      window.location.replace("/");
      return;
    }
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "picking", parsed)) setModuleDisabled(true);
    });
    const timer = window.setTimeout(() => {
      setUser(parsed);
      void loadData(parsed);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const operatorDateLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || manager) return;
    if (!operatorDateLoadedRef.current) {
      // La primera carga ya la hizo el efecto de montaje de arriba con este mismo
      // pickingDate inicial; evita duplicar el fetch al entrar a la pantalla.
      operatorDateLoadedRef.current = true;
      return;
    }
    void loadData(user);
  }, [pickingDate, user, manager, loadData]);

  // Equivalente a operatorDateLoadedRef, uno por pestana de manager: cada una pide
  // datos acotados a su propia fecha (ver loadData), asi que hay que refrescar
  // cuando el usuario cambia esa fecha sin salir de la pestana (cambiar de pestana
  // ya recarga solo, porque cada una es una ruta/pagina que monta el modulo de nuevo).
  const assignmentDateLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || !manager || panel !== "asignacion") return;
    if (!assignmentDateLoadedRef.current) {
      assignmentDateLoadedRef.current = true;
      return;
    }
    void loadData(user);
  }, [assignmentDate, assignmentHistoryPage, user, manager, panel, loadData]);

  const reportDateLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || !manager || (panel !== "resumen" && panel !== "reportes")) return;
    if (!reportDateLoadedRef.current) {
      reportDateLoadedRef.current = true;
      return;
    }
    void loadData(user);
  }, [reportDate, user, manager, panel, loadData]);

  const registryDateLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || !manager || panel !== "registros") return;
    if (!registryDateLoadedRef.current) {
      registryDateLoadedRef.current = true;
      return;
    }
    void loadData(user);
  }, [registryDate, user, manager, panel, loadData]);

  const productivityDateLoadedRef = useRef(false);
  useEffect(() => {
    if (!user || !manager || panel !== "productividad") return;
    if (!productivityDateLoadedRef.current) {
      productivityDateLoadedRef.current = true;
      return;
    }
    void loadData(user);
  }, [productivityDateFrom, productivityDateTo, user, manager, panel, loadData]);

  useEffect(() => {
    async function loadLocations() {
      const linesToLocate = manager
        ? visibleLines
        : lines.filter(line => myAssignments.some(assignment => assignment.line_id === line.id));
      const requestForLocations = manager ? selectedRequest : activeRequest;
      if (!requestForLocations || linesToLocate.length === 0 || stores.length === 0) return;
      const sourceCode = normalize(requestForLocations.source_store_code);
      const sourceName = normalize(requestForLocations.source_store_name);
      const store = stores.find(item =>
        normalize(item.code) === sourceCode ||
        normalize(item.erp_sede) === sourceCode ||
        normalize(item.name) === sourceName
      );
      if (!store) return;

      const keys = [...new Set(linesToLocate.flatMap(line => [line.product_code, line.sku, line.barcode].filter(Boolean) as string[]))];
      if (keys.length === 0) return;

      const [bySkuResp, byBarcodeResp] = await Promise.all([
        supabase.from("cyclic_products").select("id,sku,barcode").in("sku", keys),
        supabase.from("cyclic_products").select("id,sku,barcode").in("barcode", keys),
      ]);
      const products = ([...(bySkuResp.data || []), ...(byBarcodeResp.data || [])] as ProductRow[]);
      const productByKey = new Map<string, ProductRow>();
      for (const product of products) {
        productByKey.set(normalize(product.sku), product);
        productByKey.set(normalize(product.barcode), product);
      }
      const productIds = [...new Set(products.map(product => product.id))];
      const [byProductResp, byLocationSkuResp] = await Promise.all([
        productIds.length > 0
          ? supabase
              .from("product_locations")
              .select("product_id,sku,location,stored_quantity")
              .eq("is_active", true)
              .eq("store_id", store.id)
              .in("product_id", productIds)
              .order("location")
          : Promise.resolve({ data: [] }),
        supabase
          .from("product_locations")
          .select("product_id,sku,location,stored_quantity")
          .eq("is_active", true)
          .eq("store_id", store.id)
          .in("sku", keys)
          .order("location"),
      ]);

      const locations = ([...(byProductResp.data || []), ...(byLocationSkuResp.data || [])] as LocationRow[]);
      const quantityByProductLocation = new Map<string, number>();
      if (productIds.length > 0) {
        const { data: sessionsData } = await supabase
          .from("general_inventory_sessions")
          .select("id")
          .eq("store_id", store.id)
          .order("created_at", { ascending: false })
          .limit(40);
        const sessionIds = ((sessionsData || []) as Array<{ id: string }>).map(session => session.id);
        const sessionOrder = new Map(sessionIds.map((id, index) => [id, index]));
        if (sessionIds.length > 0) {
          const [validationResp, recountResp, countResp] = await Promise.all([
            supabase.from("general_inventory_validation_counts").select("session_id,product_id,location_code,quantity").in("session_id", sessionIds).in("product_id", productIds),
            supabase.from("general_inventory_recount_counts").select("session_id,product_id,location_code,quantity").in("session_id", sessionIds).in("product_id", productIds),
            supabase.from("general_inventory_counts").select("session_id,product_id,location_code,quantity").in("session_id", sessionIds).in("product_id", productIds),
          ]);
          const allCountRows = [
            ...(validationResp.data || []),
            ...(recountResp.data || []),
            ...(countResp.data || []),
          ] as Array<{ session_id: string; product_id: string; location_code: string | null; quantity: number | string | null }>;
          const byKeySession = new Map<string, Map<string, number>>();
          for (const row of allCountRows) {
            const location = normalize(row.location_code);
            if (!row.product_id || !location) continue;
            const key = `${row.product_id}__${location}`;
            if (!byKeySession.has(key)) byKeySession.set(key, new Map());
            const sessionMap = byKeySession.get(key)!;
            sessionMap.set(row.session_id, (sessionMap.get(row.session_id) || 0) + num(row.quantity));
          }
          for (const [key, sessionMap] of byKeySession.entries()) {
            const latest = [...sessionMap.entries()].sort((a, b) => (sessionOrder.get(a[0]) ?? 999999) - (sessionOrder.get(b[0]) ?? 999999))[0];
            if (latest) quantityByProductLocation.set(key, latest[1]);
          }
        }
      }
      const next: Record<string, string[]> = {};
      for (const line of linesToLocate) {
        const product = productByKey.get(normalize(line.product_code)) || productByKey.get(normalize(line.sku)) || productByKey.get(normalize(line.barcode));
        const productLocations = locations
          .filter(row =>
            row.product_id === product?.id ||
            normalize(row.sku) === normalize(line.sku) ||
            normalize(row.sku) === normalize(line.product_code)
          )
          .map(row => {
            const countedQty = row.product_id ? quantityByProductLocation.get(`${row.product_id}__${normalize(row.location)}`) : undefined;
            const hasStoredQuantity = row.stored_quantity !== null && row.stored_quantity !== undefined;
            const quantity = countedQty ?? (hasStoredQuantity ? num(row.stored_quantity) : null);
            return { location: row.location, quantity };
          })
          // Una ubicación activa registrada debe aparecer aunque todavía no
          // tenga cantidad contada o stock almacenado. No se inventa un 0 ni
          // se oculta la ubicación: solo mostramos la cantidad cuando existe
          // y es positiva.
          .filter(row => row.location)
          .map(row => row.quantity !== null && row.quantity > 0
            ? `${row.location} (${formatQty(row.quantity)})`
            : row.location);
        next[line.id] = [...new Set(productLocations)].sort((a, b) => (
          locationSort === "asc" ? a.localeCompare(b, "es") : b.localeCompare(a, "es")
        ));
      }
      setLocationsByLine(next);
    }

    void loadLocations();
  }, [activeRequest, lines, locationSort, manager, myAssignments, selectedRequest, stores, visibleLines]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedLineIds(prev => {
        const allowed = new Set(assignmentFilteredLines.map(line => line.id));
        const next = new Set([...prev].filter(id => allowed.has(id)));
        return next.size === prev.size ? prev : next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [assignmentFilteredLines]);

  async function assignSelectedLines() {
    if (historicalAssignmentView) {
      toast.warning("El historial es solo consulta: no se pueden crear asignaciones en una fecha anterior.");
      return;
    }
    if (!user || !selectedRequest || !selectedPickerId) {
      toast.warning("Selecciona picador y codigos.");
      return;
    }
    if (!pickingDate) {
      toast.warning("Selecciona una fecha de picking antes de asignar picadores.");
      return;
    }
    const picker = pickers.find(item => item.id === selectedPickerId);
    if (!picker) {
      toast.warning("Selecciona un picador valido.");
      return;
    }
    const rows = sortedVisibleLines
      .filter(line => selectedLineIds.has(line.id))
      .map(line => {
        const alreadyAssigned = assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
        const pending = Math.max(0, num(line.qty_requested) - alreadyAssigned);
        return { line, pending };
      })
      .filter(item => item.pending > 0);

    if (rows.length === 0) {
      toast.warning("Los codigos seleccionados no tienen pendiente por asignar.");
      return;
    }
    const invalidRows = rows.filter(item => !item.line.id || !item.line.product_code || !item.line.description);
    if (invalidRows.length > 0) {
      toast.warning(`Hay ${invalidRows.length} codigo(s) sin detalle completo. Refresca la sincronizacion antes de asignar.`);
      return;
    }

    const { error } = await supabase.from("picking_assignments").insert(rows.map(({ line, pending }) => ({
      request_id: selectedRequest.id,
      line_id: line.id,
      picker_id: picker.id,
      picker_name: picker.full_name,
      assigned_qty: pending,
      status: "pendiente",
      picking_date: pickingDate,
      created_by: user.id,
      created_by_name: user.full_name,
    })));
    if (error) {
      toast.error("No se pudo asignar seleccionados: " + error.message);
      return;
    }
    setSelectedLineIds(new Set());
    toast.success(`${rows.length} codigos asignados a ${picker.full_name}.`);
    await loadData(user);
  }

  async function reassignSelectedAssignments() {
    if (historicalAssignmentView) {
      toast.warning("El historial es solo consulta: no se pueden reasignar avances anteriores.");
      return;
    }
    if (!manager || !user) return;
    const picker = pickers.find(item => item.id === selectedPickerId);
    if (!picker) {
      toast.warning("Selecciona el nuevo picador.");
      return;
    }
    const rows = selectedLineAssignments.filter(assignment => (
      assignment.picker_id !== picker.id && normalize(assignment.picker_name) !== normalize(picker.full_name)
    ));
    if (rows.length === 0) {
      toast.warning("Selecciona codigos con asignaciones de otro picador.");
      return;
    }

    const { error } = await supabase
      .from("picking_assignments")
      .update({
        picker_id: picker.id,
        picker_name: picker.full_name,
        updated_at: new Date().toISOString(),
      })
      .in("id", rows.map(assignment => assignment.id));

    if (error) {
      toast.error("No se pudo reasignar seleccionados: " + error.message);
      return;
    }

    const rowIds = new Set(rows.map(assignment => assignment.id));
    setAssignments(prev => prev.map(item => (
      rowIds.has(item.id) ? { ...item, picker_id: picker.id, picker_name: picker.full_name } : item
    )));
    toast.success(`${rows.length} asignacion${rows.length !== 1 ? "es" : ""} reasignada${rows.length !== 1 ? "s" : ""} a ${picker.full_name}.`);
    await loadData(user);
  }

  async function removeSelectedAssignments() {
    if (historicalAssignmentView) {
      toast.warning("El historial es solo consulta: no se pueden quitar asignaciones anteriores.");
      return;
    }
    if (!manager || !user) return;
    const rows = selectedLineAssignments;
    if (rows.length === 0) {
      toast.warning("Selecciona codigos con asignaciones para quitar.");
      return;
    }
    const pickedRows = rows.filter(assignment => num(assignment.picked_qty) > 0);
    if (pickedRows.length > 0) {
      const confirmed = window.confirm(`Hay ${pickedRows.length} asignacion${pickedRows.length !== 1 ? "es" : ""} con picking registrado. Al quitar asignacion tambien se eliminaran esos registros. ¿Continuar?`);
      if (!confirmed) return;
    }

    const ids = rows.map(assignment => assignment.id);
    const { error } = await supabase.from("picking_assignments").delete().in("id", ids);
    if (error) {
      toast.error("No se pudo quitar la asignacion: " + error.message);
      return;
    }

    const idSet = new Set(ids);
    setAssignments(prev => prev.filter(item => !idSet.has(item.id)));
    setScans(prev => prev.filter(item => !idSet.has(item.assignment_id)));
    toast.success(`${rows.length} asignacion${rows.length !== 1 ? "es" : ""} quitada${rows.length !== 1 ? "s" : ""}. Los codigos vuelven a quedar disponibles.`);
    await loadData(user);
  }

  async function forceHideRequest(request: PickingRequest) {
    if (historicalAssignmentView) {
      toast.warning("El historial es solo consulta: no se pueden ocultar requerimientos anteriores.");
      return;
    }
    if (!admin || !user) {
      toast.warning("Solo el administrador puede forzar la eliminacion de requerimientos.");
      return;
    }
    const confirmed = window.confirm(`Forzar eliminacion del requerimiento ${request.doc_number || request.inv_request_no}? Ya no aparecera como pendiente en picking.`);
    if (!confirmed) return;

    const { error } = await supabase
      .from("picking_requests")
      .update({
        hidden_at: new Date().toISOString(),
        hidden_by: user.id,
        hidden_by_name: user.full_name,
        hidden_reason: "Forzado por administrador",
        updated_at: new Date().toISOString(),
      })
      .eq("id", request.id);

    if (error) {
      toast.error("No se pudo ocultar el requerimiento. Ejecuta el SQL actualizado de picking si falta hidden_at: " + error.message);
      return;
    }

    setRequests(prev => prev.filter(item => item.id !== request.id));
    if (selectedRequestId === request.id) setSelectedRequestId("");
    toast.success("Requerimiento ocultado por administrador.");
  }

  function toggleLine(lineId: string) {
    setSelectedLineIds(prev => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  function selectFirstPending(quantity: number) {
    const next = new Set<string>();
    for (const line of assignmentFilteredLines) {
      const assigned = assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
      if (num(line.qty_requested) - assigned <= 0) continue;
      next.add(line.id);
      if (next.size >= quantity) break;
    }
    setSelectedLineIds(next);
  }

  function selectAllAssignmentFilteredLines() {
    setSelectedLineIds(new Set(assignmentFilteredLines.map(line => line.id)));
  }

  function updateScanEntry(index: number, field: keyof ScanEntry, value: string) {
    setScanEntries(prev => prev.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  }

  function addScanEntry() {
    setScanEntries(prev => [...prev, { location: "", qty: "" }]);
  }

  function removeScanEntry(index: number) {
    setScanEntries(prev => prev.length <= 1 ? prev : prev.filter((_, rowIndex) => rowIndex !== index));
  }

  async function scannedCodeMatchesActiveLine(scanned: string, line: PickingLine) {
    const raw = String(scanned || "").trim();
    const candidates = [...new Set([
      raw,
      cleanCode(raw),
      fullProductCode(raw),
    ].filter(Boolean).map(normalize))];
    const expected = [line.product_code, line.sku, line.barcode].filter(Boolean).map(value => normalize(value));
    if (candidates.some(candidate => expected.includes(candidate))) return true;

    try {
      const [{ data: byUpc }, { data: byAlu }, { data: byErpSku }] = await Promise.all([
        supabase.from("codigos_barra").select("codsap,upc,alu").in("upc", candidates).not("codsap", "is", null).limit(20),
        supabase.from("codigos_barra").select("codsap,upc,alu").in("alu", candidates).not("codsap", "is", null).limit(20),
        supabase.from("cyclic_products").select("sku").in("erp_sku", candidates).eq("is_active", true).limit(20),
      ]);
      const mappedCodes = [...new Set([...(byUpc || []), ...(byAlu || [])].flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>)).map(normalize))];
      if (mappedCodes.some(code => expected.includes(code))) return true;
      const erpSkuCodes = [...new Set((byErpSku || []).map(row => normalize(row.sku)))];
      return erpSkuCodes.some(code => expected.includes(code));
    } catch (error) {
      console.warn("No se pudo validar UPC/ALU en picking:", error);
      return false;
    }
  }

  async function saveScan() {
    if (!user || !activeAssignment || !activeLine || !activeRequest) return;
    const rows = scanEntries
      .map(row => ({ location: cleanLocationLabel(row.location), qtyText: row.qty.trim(), qty: num(row.qty) }))
      .filter(row => row.location || row.qtyText);
    if (!scanProduct.trim() || rows.length === 0 || rows.some(row => !row.location || row.qty <= 0)) {
      toast.warning("Escanea producto y completa ubicacion/cantidad en todas las lineas.");
      return;
    }
    const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
    const pickedNext = num(activeAssignment.picked_qty) + totalQty;
    const isMatch = await scannedCodeMatchesActiveLine(scanProduct, activeLine);
    if (!isMatch) {
      setCodeMismatch({
        expected: [activeLine.product_code, activeLine.sku, activeLine.barcode, "UPC/ALU asociado"].filter(Boolean).join(" / "),
        scanned: scanProduct.trim(),
      });
      return;
    }
    const status = pickedNext >= num(activeAssignment.assigned_qty) ? "completado" : "en_proceso";

    const { data: insertedScans, error: scanError } = await supabase.from("picking_scans").insert(rows.map(row => ({
      assignment_id: activeAssignment.id,
      request_id: activeRequest.id,
      line_id: activeLine.id,
      picker_id: user.id,
      picker_name: user.full_name,
      location_code: normalize(row.location),
      scanned_product_code: scanProduct.trim(),
      scanned_barcode: scanProduct.trim(),
      qty: row.qty,
      is_match: isMatch,
    }))).select();
    if (scanError) {
      toast.error("No se pudo guardar el escaneo: " + scanError.message);
      return;
    }

    const updateRow: Record<string, unknown> = {
      picked_qty: pickedNext,
      status,
      completed_at: status === "completado" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    if (activeAssignment.status === "pendiente") updateRow.started_at = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("picking_assignments")
      .update(updateRow)
      .eq("id", activeAssignment.id);
    if (updateError) {
      toast.warning("Escaneo guardado, pero no se actualizo progreso: " + updateError.message);
      return;
    }

    setScanProduct("");
    setScanEntries([{ location: "", qty: "1" }]);
    setAssignments(prev => prev.map(item => (
      item.id === activeAssignment.id ? { ...item, picked_qty: pickedNext, status } : item
    )));
    if (insertedScans?.length) setScans(prev => [...(insertedScans as PickingScan[]), ...prev]);
    toast.success("Picking registrado.");
  }

  function startEditScan(scan: PickingScan) {
    setEditingScanId(scan.id);
    setEditScanLocation(scan.location_code);
    setEditScanQty(String(num(scan.qty)));
  }

  async function saveEditScan() {
    if (!user || !editingScanId) return;
    const qty = num(editScanQty);
    if (!editScanLocation.trim() || qty <= 0) {
      toast.warning("Ingresa ubicacion y cantidad valida.");
      return;
    }
    const scan = scans.find(item => item.id === editingScanId);
    if (!scan) return;
    const assignment = assignments.find(item => item.id === scan.assignment_id);
    if (!assignment) return;
    const assignmentScans = scans.filter(item => item.assignment_id === assignment.id);
    const pickedNext = assignmentScans.reduce((sum, item) => sum + (item.id === scan.id ? qty : num(item.qty)), 0);
    const status = pickedNext >= num(assignment.assigned_qty) ? "completado" : "en_proceso";

    const { error: scanError } = await supabase
      .from("picking_scans")
      .update({ location_code: normalize(editScanLocation), qty })
      .eq("id", editingScanId)
      .eq("picker_id", user.id);
    if (scanError) {
      toast.error("No se pudo editar el registro: " + scanError.message);
      return;
    }

    const { error: assignmentError } = await supabase
      .from("picking_assignments")
      .update({ picked_qty: pickedNext, status, updated_at: new Date().toISOString(), completed_at: status === "completado" ? new Date().toISOString() : null })
      .eq("id", assignment.id);
    if (assignmentError) {
      toast.warning("Registro editado, pero no se actualizo avance: " + assignmentError.message);
      return;
    }

    setEditingScanId("");
    setEditScanLocation("");
    setEditScanQty("");
    setScans(prev => prev.map(item => (
      item.id === editingScanId ? { ...item, location_code: normalize(editScanLocation), qty } : item
    )));
    setAssignments(prev => prev.map(item => (
      item.id === assignment.id ? { ...item, picked_qty: pickedNext, status } : item
    )));
    toast.success("Registro actualizado.");
  }

  async function deleteScan(scan: PickingScan) {
    if (!user) return;
    const canDelete = manager || scan.picker_id === user.id || normalize(scan.picker_name) === normalize(user.full_name);
    if (!canDelete) {
      toast.warning("No puedes eliminar un registro de otro picador.");
      return;
    }
    const confirmed = window.confirm(`Eliminar registro de ${scan.location_code} por ${formatQty(num(scan.qty))}? Se actualizara el avance del codigo.`);
    if (!confirmed) return;

    const assignment = assignments.find(item => item.id === scan.assignment_id);
    if (!assignment) {
      toast.error("No se encontro la asignacion del registro.");
      return;
    }

    let deleteQuery = supabase.from("picking_scans").delete().eq("id", scan.id);
    if (!manager) deleteQuery = deleteQuery.eq("picker_id", user.id);
    const { error: deleteError } = await deleteQuery;
    if (deleteError) {
      toast.error("No se pudo eliminar el registro: " + deleteError.message);
      return;
    }

    const { data: remainingRows, error: remainingError } = await supabase
      .from("picking_scans")
      .select("qty")
      .eq("assignment_id", assignment.id);
    if (remainingError) {
      toast.warning("Registro eliminado, pero no se pudo recalcular avance: " + remainingError.message);
      return;
    }

    const pickedNext = ((remainingRows || []) as Array<{ qty: number | string | null }>).reduce((sum, row) => sum + num(row.qty), 0);
    const status = pickedNext <= 0 ? "pendiente" : pickedNext >= num(assignment.assigned_qty) ? "completado" : "en_proceso";
    const { error: assignmentError } = await supabase
      .from("picking_assignments")
      .update({
        picked_qty: pickedNext,
        status,
        updated_at: new Date().toISOString(),
        completed_at: status === "completado" ? new Date().toISOString() : null,
      })
      .eq("id", assignment.id);
    if (assignmentError) {
      toast.warning("Registro eliminado, pero no se actualizo avance: " + assignmentError.message);
      return;
    }

    setScans(prev => prev.filter(item => item.id !== scan.id));
    setAssignments(prev => prev.map(item => (
      item.id === assignment.id ? { ...item, picked_qty: pickedNext, status } : item
    )));
    if (editingScanId === scan.id) setEditingScanId("");
    toast.success("Registro eliminado.");
  }

  async function downloadReport(scope: "global" | "mine") {
    const XLSX = await import("xlsx");
    // No confiar en el stockByLine del estado: si se descarga justo despues
    // de cambiar de pestana/fecha (el efecto que lo recalcula todavia no
    // termino), o si por cualquier otra razon quedo desactualizado, el
    // Excel salia con columnas de STOCK en 0 aunque el ERP tuviera stock
    // real -- mismo problema que se encontro y corrigio en printBatchAssignment.
    const freshStockByLine = await resolveStockForLines(lines, requests, stores);
    const assignmentRequestIds = new Set((panel === "resumen" ? summaryRequests : filteredRequests).map(request => request.id));
    const scopedGlobalAssignments = panel === "reportes"
      ? reportAssignments
      : panel === "resumen"
      ? summaryAssignments
      : assignments.filter(assignment => assignmentRequestIds.has(assignment.request_id));
    const rows = (scope === "mine" ? filteredMyAssignments : scopedGlobalAssignments).map(assignment => {
      const line = lines.find(item => item.id === assignment.line_id);
      const request = requests.find(item => item.id === assignment.request_id);
      const pickedForScope = scope === "global" && panel === "reportes"
        ? reportScansByAssignment.get(assignment.id) || 0
        : num(assignment.picked_qty);
      return {
        "REQUERIMIENTO": request?.doc_number || request?.inv_request_no || "",
        "TIENDA ENTREGA": request?.source_store_name || request?.source_store_code || "",
        "TIENDA REQUIERE": request?.destination_store_name || request?.destination_store_code || "",
        "PICADOR": assignmentPickerName(assignment),
        "N": line?.line_id ?? "",
        "ID (CODIGO)": line?.product_code || "",
        "BARRA": line?.barcode || "",
        "DESCRIPCION": line?.description || "",
        "PRES (UM)": line?.unit || "",
        "RQ (ASIGNADO)": num(assignment.assigned_qty),
        "PICADO": pickedForScope,
        "PENDIENTE": num(assignment.assigned_qty) - pickedForScope,
        "STOCK": num(freshStockByLine[assignment.line_id] ?? 0),
        "ZONA": (locationsByLine[assignment.line_id] || []).map(cleanLocationLabel).join(", "),
        "ESTADO": assignment.status,
        "ESTADO ASIGNACION": "ASIGNADO",
        "FECHA PICKING": assignment.picking_date || "",
        "FECHA ASIGNACION": assignment.created_at ? new Date(assignment.created_at).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "",
      };
    });

    if (scope === "global" && (panel === "asignacion" || panel === "resumen")) {
      const assignedLineIds = new Set(scopedGlobalAssignments.map(assignment => assignment.line_id));
      const pendingRows = lines
        .filter(line => assignmentRequestIds.has(line.request_id) && !assignedLineIds.has(line.id))
        .map(line => {
          const request = requests.find(item => item.id === line.request_id);
          return {
            "REQUERIMIENTO": request?.doc_number || request?.inv_request_no || "",
            "TIENDA ENTREGA": request?.source_store_name || request?.source_store_code || "",
            "TIENDA REQUIERE": request?.destination_store_name || request?.destination_store_code || "",
            "PICADOR": "PENDIENTE POR ASIGNAR",
            "N": line.line_id ?? "",
            "ID (CODIGO)": line.product_code || "",
            "BARRA": line.barcode || "",
            "DESCRIPCION": line.description || "",
            "PRES (UM)": line.unit || "",
            "RQ (ASIGNADO)": 0,
            "PICADO": 0,
            "PENDIENTE": num(line.qty_requested),
            "STOCK": num(freshStockByLine[line.id] ?? 0),
            "ZONA": (locationsByLine[line.id] || []).map(cleanLocationLabel).join(", "),
            "ESTADO": "pendiente",
            "ESTADO ASIGNACION": "PENDIENTE POR ASIGNAR",
            "FECHA PICKING": "",
            "FECHA ASIGNACION": "",
          };
        });
      rows.push(...pendingRows);
    }

    const ws = XLSX.utils.json_to_sheet(rows);

    // Ajustar ancho de columnas
    const colWidths = [
      { wch: 18 }, // REQUERIMIENTO
      { wch: 22 }, // TIENDA ENTREGA
      { wch: 22 }, // TIENDA REQUIERE
      { wch: 22 }, // PICADOR
      { wch: 6 },  // N
      { wch: 14 }, // ID
      { wch: 14 }, // BARRA
      { wch: 50 }, // DESCRIPCION
      { wch: 10 }, // PRES
      { wch: 14 }, // RQ
      { wch: 10 }, // PICADO
      { wch: 12 }, // PENDIENTE
      { wch: 10 }, // STOCK
      { wch: 20 }, // ZONA
      { wch: 14 }, // ESTADO
      { wch: 24 }, // ESTADO ASIGNACION
      { wch: 14 }, // FECHA PICKING
      { wch: 18 }, // FECHA
    ];
    ws["!cols"] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PICKING");
    const fileName = `picking_${scope}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  // Agrupa las asignaciones de un requerimiento por picador + lote (mismo minuto de created_at)
  // y devuelve los lotes ordenados cronologicamente con su indice por picador
  function buildAssignmentBatches(requestId: string) {
    const requestAssignments = assignments.filter(a => a.request_id === requestId);

    // Agrupar: clave = pickerName + minuto de created_at (ej: "PICADOR 1 CD__2026-05-27T10:32")
    const batchMap = new Map<string, PickingAssignment[]>();
    for (const a of requestAssignments) {
      const minute = a.created_at ? a.created_at.slice(0, 16) : "0000-00-00T00:00";
      const key = `${a.picker_name}__${minute}`;
      if (!batchMap.has(key)) batchMap.set(key, []);
      batchMap.get(key)!.push(a);
    }

    // Ordenar lotes por minuto ascendente (orden cronologico)
    const sortedKeys = [...batchMap.keys()].sort((a, b) => {
      const tA = a.split("__")[1] || "";
      const tB = b.split("__")[1] || "";
      return tA.localeCompare(tB);
    });

    // Contar cuantos lotes previos tiene cada picador para calcular el indice [1], [2]...
    const pickerBatchCount = new Map<string, number>();
    return sortedKeys.map(key => {
      const pickerName = key.split("__")[0];
      const count = (pickerBatchCount.get(pickerName) || 0) + 1;
      pickerBatchCount.set(pickerName, count);
      return {
        key,
        pickerName,
        batchIndex: count,
        assignedAt: batchMap.get(key)![0].created_at,
        assignments: batchMap.get(key)!,
      };
    });
  }

  async function printBatchAssignment(batchAssignments: PickingAssignment[], pickerName: string, batchIndex: number, batchTotal: number) {
    if (batchAssignments.length === 0) {
      toast.warning("Este lote no tiene codigos.");
      return;
    }

    let printLines = lines;
    let effectiveStockByLine = stockByLine;
    const localLineIds = new Set(printLines.map(line => line.id));
    const missingLineIds = [...new Set(batchAssignments.map(item => item.line_id).filter(id => !localLineIds.has(id)))];
    if (missingLineIds.length > 0) {
      const { data, error } = await supabase
        .from("picking_request_lines")
        .select("*")
        .in("id", missingLineIds);
      if (error) {
        toast.error("No se pudo completar el detalle del lote: " + error.message);
        return;
      }
      const fetched = (data || []) as PickingLine[];
      const newLines = fetched.filter(line => !localLineIds.has(line.id));
      printLines = [...printLines, ...newLines];
      if (newLines.length > 0) {
        setLines(prev => {
          const prevIds = new Set(prev.map(line => line.id));
          const additions = newLines.filter(line => !prevIds.has(line.id));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
        // El efecto que recalcula stockByLine recien va a reaccionar en el
        // proximo render (depende de `lines`), pero esta funcion sigue
        // corriendo sincrono y arma el HTML ya mismo -- sin esto, cualquier
        // linea que hubo que traer aca (por no estar todavia en el estado)
        // se imprimia siempre con stock 0, sin importar el stock real en el
        // ERP. Se resuelve aparte para estas lineas puntuales y se mezcla
        // con el stockByLine ya conocido, sin esperar al proximo render.
        const missingRequestIds = [...new Set(newLines.map(line => line.request_id))];
        const relatedForMissingStock = requests.filter(r => missingRequestIds.includes(r.id));
        const stockForNewLines = await resolveStockForLines(newLines, relatedForMissingStock, stores);
        effectiveStockByLine = { ...effectiveStockByLine, ...stockForNewLines };
      }
    }

    const lineById = new Map(printLines.map(line => [line.id, line]));
    const unresolved = batchAssignments.filter(assignment => !lineById.has(assignment.line_id));
    if (unresolved.length > 0) {
      toast.warning(`No se puede imprimir: ${unresolved.length} asignacion(es) no tienen detalle de producto sincronizado.`);
      return;
    }

    const assignedAt = batchAssignments[0].created_at
      ? new Date(batchAssignments[0].created_at).toLocaleString("es-PE", { dateStyle: "long", timeStyle: "short" })
      : new Date().toLocaleString("es-PE", { dateStyle: "long", timeStyle: "short" });

    const requestIds = [...new Set(batchAssignments.map(a => a.request_id))];
    const relatedRequests = requests.filter(r => requestIds.includes(r.id));
    const tiendaRequiere = relatedRequests[0]?.destination_store_name || relatedRequests[0]?.destination_store_code || "Tienda";
    const tiendaEntrega = relatedRequests[0]?.source_store_name || relatedRequests[0]?.source_store_code || "CD";
    const docNumbers = relatedRequests.map(pickingDocumentLabel).filter(Boolean).join(", ");
    const motivo = relatedRequests[0]?.reason || "ABASTECIMIENTO";

    // Mismo orden que ve el picador: primera ubicacion A-Z, desempate por codigo de producto A-Z
    const sorted = [...batchAssignments].sort((a, b) => {
      const aLoc = (locationsByLine[a.line_id] || []).map(cleanLocationLabel)[0] || "ZZZ";
      const bLoc = (locationsByLine[b.line_id] || []).map(cleanLocationLabel)[0] || "ZZZ";
      const cmp = aLoc.localeCompare(bLoc, "es");
      if (cmp !== 0) return cmp;
      const aLine = lineById.get(a.line_id);
      const bLine = lineById.get(b.line_id);
      return String(aLine?.product_code || "").localeCompare(String(bLine?.product_code || ""), "es");
    });

    const totalCodigos = sorted.length;
    const totalUnidades = sorted.reduce((s, a) => s + num(a.assigned_qty), 0);

    const rowsHtml = sorted.map((assignment, index) => {
      const line = lineById.get(assignment.line_id);
      const firstLocation = (locationsByLine[assignment.line_id] || []).map(cleanLocationLabel)[0] || "";
      const zona = firstLocation ? firstLocation.substring(0, 2).toUpperCase() : "-";
      return `
        <tr>
          <td class="c">${index + 1}</td>
          <td class="c">${line?.product_code || "-"}</td>
          <td class="desc">${line?.description || "-"}</td>
          <td class="c">${line?.unit || "-"}</td>
          <td class="c">${num(assignment.assigned_qty)}</td>
          <td class="c"></td>
          <td class="obs"></td>
          <td class="c">${num(effectiveStockByLine[assignment.line_id] ?? 0)}</td>
          <td class="c">${zona}</td>
        </tr>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Verificacion - ${pickerName} [${batchIndex}]</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 9px; color: #111; padding: 10mm 10mm 8mm 10mm; }

    .header-top { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin-bottom: 5px; }
    .logo { font-size: 14px; font-weight: 900; letter-spacing: 1px; color: #1e1b4b; }
    .title { font-size: 13px; font-weight: 900; text-align: center; text-transform: uppercase; letter-spacing: 0.5px; }
    .motivo-block { text-align: right; }
    .motivo-label { font-size: 8px; font-weight: 900; text-transform: uppercase; color: #666; }
    .motivo-val { font-size: 9px; font-weight: 700; }

    .batch-badge { display: inline-block; background: #1e1b4b; color: white; font-size: 11px; font-weight: 900; padding: 2px 10px; border-radius: 4px; margin-left: 8px; letter-spacing: 0.5px; }

    .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; border-top: 1.5px solid #1e1b4b; border-bottom: 1.5px solid #1e1b4b; padding: 4px 0; margin: 5px 0; }
    .info-item { font-size: 8.5px; }
    .info-item b { font-weight: 900; text-transform: uppercase; color: #444; display: block; font-size: 7.5px; margin-bottom: 1px; }

    .picker-verif { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 5px 0; }
    .picker-badge { font-size: 11px; font-weight: 900; color: #1e1b4b; border: 2px solid #1e1b4b; padding: 3px 8px; border-radius: 5px; display: inline-block; }
    .validator-line { font-size: 9px; line-height: 2.2; border-bottom: 1px solid #333; padding-bottom: 1px; }
    .validator-line b { font-weight: 900; }

    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    thead th { background: #1e1b4b; color: white; padding: 4px 2px; text-align: center; font-size: 8px; text-transform: uppercase; border: 1px solid #111; }
    thead th.left { text-align: left; padding-left: 3px; }
    tbody td { border: 1px solid #bbb; padding: 2.5px 2px; vertical-align: middle; font-size: 8.5px; }
    tbody td.c { text-align: center; }
    tbody td.desc { font-size: 8px; word-break: break-word; }
    tbody td.obs { min-height: 14px; }
    tbody tr:nth-child(even) { background: #f0eeff; }
    tfoot td { background: #dde4ff; font-weight: 900; font-size: 8.5px; border: 1px solid #999; padding: 3px 2px; }
    tfoot td.c { text-align: center; }

    @media print {
      body { padding: 8mm; }
      @page { margin: 6mm; size: A4 portrait; }
    }
  </style>
</head>
<body>

  <div class="header-top">
    <div class="logo">RASECORP</div>
    <div style="text-align:center">
      <span class="title">Lista de Picking &mdash; Verificacion</span>
      <span class="batch-badge">Asignacion ${batchIndex} de ${batchTotal}</span>
    </div>
    <div class="motivo-block">
      <div class="motivo-label">Motivo de requerimiento</div>
      <div class="motivo-val">${motivo}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-item"><b>Tienda que requiere</b>${tiendaRequiere}</div>
    <div class="info-item"><b>Tienda que entrega (CD)</b>${tiendaEntrega}</div>
    <div class="info-item"><b>Documento</b>${docNumbers}</div>
    <div class="info-item" style="grid-column:1/2"><b>Fecha y hora de asignacion</b>${assignedAt}</div>
    <div class="info-item" style="grid-column:2/4"><b>Codigos en este lote</b>${totalCodigos} codigos &nbsp;|&nbsp; ${totalUnidades} unidades</div>
  </div>

  <div class="picker-verif">
    <div>
      <div style="font-size:7.5px;font-weight:900;text-transform:uppercase;color:#666;margin-bottom:3px;">Picador</div>
      <div class="picker-badge">${pickerName} &nbsp;<span style="font-size:9px;color:#666;">[${batchIndex}/${batchTotal}]</span></div>
    </div>
    <div>
      <div class="validator-line"><b>Verificadora:</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:22px">N</th>
        <th style="width:62px">ID</th>
        <th class="left">Descripcion</th>
        <th style="width:30px">PRES</th>
        <th style="width:32px">RQ</th>
        <th style="width:36px">PICADO</th>
        <th style="width:90px">OBSERVACION</th>
        <th style="width:36px">STOCK</th>
        <th style="width:30px">ZONA</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="c">TOTAL LOTE: ${totalCodigos} codigos</td>
        <td class="c">${totalUnidades}</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      </tr>
    </tfoot>
  </table>

</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) {
      toast.error("No se pudo abrir la ventana de impresion. Permite ventanas emergentes.");
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  if (!user) {
    return <main className="min-h-screen bg-slate-100 p-6 text-slate-700">Validando acceso...</main>;
  }
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Picking" />;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
        <div className="mx-auto flex w-full max-w-[1800px] items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => window.location.href = "/"} className="rounded-xl border px-3 py-2 text-slate-700 hover:bg-slate-50" title="Menu principal">
              <Home size={18} />
            </button>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-white">
              <ScanLine size={24} />
            </div>
            <div>
              <h1 className="text-lg font-black">Picking</h1>
              <p className="text-xs font-semibold text-slate-500">Requerimientos ERP, asignacion y escaneo por picador</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => loadData(user)} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
              <RefreshCw size={16} />
            </button>
            <span className="rounded-full border bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{user.full_name}</span>
          </div>
        </div>
      </header>

      <section className="mx-auto w-full max-w-[1800px] p-4">
        {manager && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white px-4 py-3 shadow-sm">
          <div>
            <p className="text-xs font-black uppercase text-slate-500">Ultima sincronizacion ERP Picking</p>
            <p className="text-sm font-black text-slate-900">{formatSync(lastErpSync)}</p>
          </div>
          {manager && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-black uppercase text-slate-500">Tienda entrega</label>
              <select
                value={selectedSourceStore}
                onChange={event => setSelectedSourceStore(event.target.value)}
                className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
              >
                <option value="all">Todas las sedes</option>
                {sourceStoreOptions.map(option => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              <label className="text-xs font-black uppercase text-slate-500">Motivo</label>
              <select
                value={selectedReasonFilter}
                onChange={event => setSelectedReasonFilter(event.target.value)}
                className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
              >
                <option value="all">Todos los motivos</option>
                {reasonOptions.map(option => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              {panel === "productividad" ? (
                <>
                  <label className="text-xs font-black uppercase text-slate-500">Desde</label>
                  <input
                    type="date"
                    value={productivityDateFrom}
                    onChange={event => setProductivityDateFrom(event.target.value)}
                    className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                  />
                  <label className="text-xs font-black uppercase text-slate-500">Hasta</label>
                  <input
                    type="date"
                    value={productivityDateTo}
                    onChange={event => setProductivityDateTo(event.target.value)}
                    className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                  />
                  {(productivityDateFrom || productivityDateTo) && (
                    <button
                      onClick={() => {
                        setProductivityDateFrom("");
                        setProductivityDateTo("");
                      }}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-50"
                    >
                      Limpiar rango
                    </button>
                  )}
                </>
              ) : (
                <>
                  <label className="text-xs font-black uppercase text-slate-500">
                    {panel === "asignacion" ? "Creacion" : panel === "resumen" || panel === "reportes" ? "Fecha picking" : "Registro"}
                  </label>
                  <input
                    type="date"
                    value={panel === "asignacion" ? assignmentDate : panel === "resumen" || panel === "reportes" ? reportDate : registryDate}
                    onChange={event => {
                      if (panel === "asignacion") {
                        setAssignmentHistoryPage(0);
                        setAssignmentDate(event.target.value);
                      }
                      else if (panel === "resumen" || panel === "reportes") setReportDate(event.target.value);
                      else setRegistryDate(event.target.value);
                    }}
                    className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                  />
                  {(panel === "asignacion" ? assignmentDate : panel === "resumen" || panel === "reportes" ? reportDate : registryDate) && (
                    <button
                      onClick={() => {
                        if (panel === "asignacion") {
                          setAssignmentHistoryPage(0);
                          setAssignmentDate("");
                        }
                        else if (panel === "resumen" || panel === "reportes") setReportDate("");
                        else setRegistryDate("");
                      }}
                      className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-50"
                    >
                      Limpiar fecha
                    </button>
                  )}
                </>
              )}
              <div className="flex rounded-2xl border bg-slate-100 p-1">
                <Link
                  href={tabHref("asignacion")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "asignacion" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Asignacion
                </Link>
                <Link
                  href={tabHref("resumen")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "resumen" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Resumen
                </Link>
                <Link
                  href={tabHref("reportes")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "reportes" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Reportes
                </Link>
                <Link
                  href={tabHref("registros")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "registros" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Registros
                </Link>
                <Link
                  href={tabHref("productividad")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "productividad" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Productividad
                </Link>
              </div>
            </div>
          )}
        </div>}

        {manager && panel === "asignacion" && <div className="grid gap-3 md:grid-cols-5">
          {[
            ["Requerimientos totales", filteredRequests.length],
            ["Requerimientos asignados", assignmentCodeTotals.assignedRequests],
            ["Codigos requeridos", assignmentCodeTotals.requiredCodes],
            ["Codigos asignados", assignmentCodeTotals.assignedCodes],
            ["Codigos pendientes", assignmentCodeTotals.pendingCodes],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-500">{label}</p>
              <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
            </div>
          ))}
        </div>}

        {loading ? (
          <div className="mt-6 rounded-2xl border bg-white p-8 text-center text-sm font-bold text-slate-500">Cargando picking...</div>
        ) : manager && panel === "resumen" ? (
          <section className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["Codigos requeridos", summaryCodeTotals.required],
                ["Codigos asignados", summaryCodeTotals.assigned],
                ["Codigos pendientes", summaryCodeTotals.pending],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border bg-white p-4 shadow-sm">
                  <p className="text-xs font-black uppercase text-slate-500">{label}</p>
                  <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
                </div>
              ))}
            </div>
            <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
                <div>
                  <h2 className="font-black">Resumen tienda solicitante x picador</h2>
                  <p className="text-xs font-bold text-slate-500">Codigos asignados por picador sobre codigos requeridos de cada tienda.</p>
                </div>
                <button onClick={() => downloadReport("global")} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                  <Download size={16} />
                </button>
              </div>
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="sticky left-0 z-10 bg-slate-100 p-3 text-left">Tienda solicitante</th>
                      {assignmentMatrix.columns.map(column => (
                        <th key={column.key} className="p-3 text-right">{column.label}</th>
                      ))}
                      <th className="p-3 text-right">Total codigos asignados / requeridos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignmentMatrix.rows.map(row => (
                      <tr key={row.key} className="border-t">
                        <td className="sticky left-0 z-10 bg-white p-3 font-black">{row.label}</td>
                        {assignmentMatrix.columns.map(column => (
                          <td key={column.key} className="p-3 text-right font-black text-slate-700">
                            {row.byPicker[column.key] || 0}/{row.required}
                          </td>
                        ))}
                        <td className="p-3 text-right font-black text-violet-700">{row.assigned}/{row.required}</td>
                      </tr>
                    ))}
                    {assignmentMatrix.rows.length === 0 && (
                      <tr>
                        <td colSpan={assignmentMatrix.columns.length + 2} className="p-8 text-center text-sm font-bold text-slate-400">
                          Sin codigos para resumir.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : manager && panel === "asignacion" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]">
            <aside className="rounded-2xl border bg-white p-3 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-black">{!assignmentDate ? "Historial completo" : historicalAssignmentView ? "Historial de requerimientos" : "Requerimientos activos"}</h2>
              </div>
              {!assignmentDate && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-violet-50 px-3 py-2 text-xs font-bold text-violet-800">
                  <span>{assignmentHistoryTotal.toLocaleString("es-PE")} requerimientos · página {assignmentHistoryPage + 1} de {assignmentHistoryPages}</span>
                  <span className="flex gap-1">
                    <button disabled={assignmentHistoryPage === 0} onClick={() => setAssignmentHistoryPage(page => Math.max(0, page - 1))} className="rounded border border-violet-200 bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">Anterior</button>
                    <button disabled={assignmentHistoryPage + 1 >= assignmentHistoryPages} onClick={() => setAssignmentHistoryPage(page => Math.min(assignmentHistoryPages - 1, page + 1))} className="rounded border border-violet-200 bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">Siguiente</button>
                  </span>
                </div>
              )}
              <div className="max-h-[68vh] space-y-2 overflow-auto pr-1">
                {filteredRequests.map(request => {
                  const requestAssignments = assignments.filter(item => item.request_id === request.id);
                  const assignedLines = new Set(requestAssignments.map(item => item.line_id)).size;
                  const progress = pct(assignedLines, num(request.line_count));
                  return (
                    <button
                      key={request.id}
                      onClick={() => setSelectedRequestId(request.id)}
                      className={`w-full rounded-2xl border p-3 text-left hover:border-violet-400 ${selectedRequest?.id === request.id ? "border-violet-600 bg-violet-50" : "bg-white"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className={`text-[10px] font-black uppercase tracking-wide ${reasonBadgeClass(request.reason)}`}>{request.reason || "Sin motivo"}</p>
                          <p className="font-black">{request.doc_number || request.inv_request_no}</p>
                          <p className="text-xs font-bold text-slate-500">{request.source_store_name || request.source_store_code}</p>
                        </div>
                        <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-black text-emerald-700">{progress}%</span>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">{request.destination_store_name || request.destination_store_code}</p>
                      <div className="mt-3 h-2 rounded-full bg-slate-100">
                        <div className="h-2 rounded-full bg-violet-600" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="mt-1 text-xs font-black text-slate-500">{assignedLines} / {request.line_count} codigos asignados</p>
                    </button>
                  );
                })}
                {filteredRequests.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">{historicalAssignmentView ? "No hay requerimientos en esta fecha para esta sede." : "No hay requerimientos activos para esta sede."}</p>}
              </div>
            </aside>

            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              {selectedRequest ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                    <div>
                      <p className="text-xs font-black uppercase text-slate-500">{selectedRequest.reason || "Sin motivo"}</p>
                      <h2 className="text-2xl font-black">{selectedRequest.doc_number || selectedRequest.inv_request_no}</h2>
                      <p className="text-sm font-semibold text-slate-500">
                        Entrega: {selectedRequest.source_store_name || selectedRequest.source_store_code} | Requiere: {selectedRequest.destination_store_name || selectedRequest.destination_store_code}
                      </p>
                      <p className="text-xs font-semibold text-slate-400">{dateText(selectedRequest.creation_date)}</p>
                      {historicalAssignmentView && <p className="mt-1 text-xs font-black text-violet-700">Historial de solo consulta</p>}
                    </div>
                    {admin && !historicalAssignmentView && (
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => forceHideRequest(selectedRequest)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-black text-red-700 hover:bg-red-100">
                          Forzar eliminacion
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 rounded-2xl border bg-slate-50 p-3">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-black">Asignar a picador</p>
                        <p className="text-xs font-bold text-slate-500">Selecciona codigos o toma los primeros pendientes segun ubicacion.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => selectFirstPending(30)} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Primeros 30</button>
                        <button onClick={selectAllAssignmentFilteredLines} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Todos</button>
                        <button onClick={() => setSelectedLineIds(new Set())} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Limpiar</button>
                      </div>
                    </div>
                    <div className="grid gap-2 xl:grid-cols-[1fr_180px_auto_auto_auto]">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setPickerMenuOpen(open => !open)}
                          className="flex w-full items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2 text-left text-sm font-bold hover:bg-slate-50"
                        >
                          <span className="truncate">{selectedPicker?.full_name || "Picador"}</span>
                          <span className="text-slate-400">v</span>
                        </button>
                        {pickerMenuOpen && (
                          <div className="absolute left-0 right-0 z-30 mt-2 max-h-72 overflow-auto rounded-xl border bg-white p-1 shadow-xl">
                            {pickers.map(picker => (
                              <button
                                key={picker.id}
                                type="button"
                                onClick={() => {
                                  setSelectedPickerId(picker.id);
                                  setPickerMenuOpen(false);
                                }}
                                className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-bold hover:bg-violet-50 ${selectedPickerId === picker.id ? "bg-violet-100 text-violet-800" : "text-slate-700"}`}
                              >
                                {picker.full_name}
                              </button>
                            ))}
                            {pickers.length === 0 && <p className="px-3 py-2 text-xs font-bold text-slate-400">No hay picadores activos.</p>}
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-black uppercase text-slate-500">Fecha de picking</label>
                        <input
                          type="date"
                          value={pickingDate}
                          onChange={event => setPickingDate(event.target.value)}
                          className="w-full rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                        />
                      </div>
                      <button disabled={historicalAssignmentView} onClick={reassignSelectedAssignments} className="rounded-xl border bg-white px-4 py-2 text-sm font-black hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                        Reasignar seleccionados ({selectedLineAssignments.length})
                      </button>
                      <button disabled={historicalAssignmentView} onClick={removeSelectedAssignments} className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-black text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">
                        Quitar asignacion ({selectedLineAssignments.length})
                      </button>
                      <button disabled={historicalAssignmentView} onClick={assignSelectedLines} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <UserPlus size={16} />
                        <span className="ml-2">Asignar seleccionados ({selectedLineIds.size})</span>
                      </button>
                    </div>
                  </div>

                  {(() => {
                    if (!selectedRequest) return null;
                    const batches = buildAssignmentBatches(selectedRequest.id);
                    if (batches.length === 0) return null;
                    // Calcular cuantos lotes totales tiene cada picador para mostrar "X de Y"
                    const pickerTotals = new Map<string, number>();
                    for (const b of batches) pickerTotals.set(b.pickerName, (pickerTotals.get(b.pickerName) || 0) + 1);
                    return (
                      <div className="mt-3 rounded-2xl border bg-violet-50 p-3">
                        <p className="mb-2 text-xs font-black uppercase text-violet-700">Imprimir por lote de asignacion</p>
                        <div className="flex flex-wrap gap-2">
                          {batches.map(batch => (
                            <button
                              key={batch.key}
                              onClick={() => void printBatchAssignment(batch.assignments, batch.pickerName, batch.batchIndex, pickerTotals.get(batch.pickerName) || 1)}
                              className="flex items-center gap-1 rounded-xl border border-violet-300 bg-white px-3 py-2 text-xs font-black text-violet-800 hover:bg-violet-100"
                              title={`Asignado el ${batch.assignedAt ? new Date(batch.assignedAt).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "-"} · ${batch.assignments.length} codigos`}
                            >
                              <Printer size={13} />
                              <span>{batch.pickerName} [{batch.batchIndex}]</span>
                              <span className="ml-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-black text-violet-700">{batch.assignments.length}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="mt-3 rounded-2xl border bg-white p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-black uppercase text-slate-500">Filtrar ubicacion para asignar</p>
                        <p className="text-xs font-semibold text-slate-400">Selecciona en orden: zona, lineal, metro y nivel. El filtro muestra solo codigos pendientes por asignar.</p>
                      </div>
                      {(locationFilter.zone || locationFilter.lineal || locationFilter.metro || locationFilter.nivel) && (
                        <button
                          type="button"
                          onClick={() => {
                            setLocationFilter({ zone: "", lineal: "", metro: "", nivel: "" });
                            setSelectedLineIds(new Set());
                          }}
                          className="rounded-xl border px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-50"
                        >
                          Limpiar ubicacion
                        </button>
                      )}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <label className="text-xs font-black uppercase text-slate-500">
                        Zona
                        <select
                          value={locationFilter.zone}
                          onChange={event => setLocationFilter({ zone: event.target.value, lineal: "", metro: "", nivel: "" })}
                          className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black normal-case text-slate-800"
                        >
                          <option value="">Todas las zonas</option>
                          {locationFilterOptions.zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-black uppercase text-slate-500">
                        Lineal
                        <select
                          value={locationFilter.lineal}
                          disabled={!locationFilter.zone}
                          onChange={event => setLocationFilter(prev => ({ ...prev, lineal: event.target.value, metro: "", nivel: "" }))}
                          className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black normal-case text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          <option value="">Todos los lineales</option>
                          {locationFilterOptions.lineales.map(lineal => <option key={lineal} value={lineal}>{lineal}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-black uppercase text-slate-500">
                        Metro
                        <select
                          value={locationFilter.metro}
                          disabled={!locationFilter.lineal}
                          onChange={event => setLocationFilter(prev => ({ ...prev, metro: event.target.value, nivel: "" }))}
                          className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black normal-case text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          <option value="">Todos los metros</option>
                          {locationFilterOptions.metros.map(metro => <option key={metro} value={metro}>{metro}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-black uppercase text-slate-500">
                        Nivel
                        <select
                          value={locationFilter.nivel}
                          disabled={!locationFilter.metro}
                          onChange={event => setLocationFilter(prev => ({ ...prev, nivel: event.target.value }))}
                          className="mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm font-black normal-case text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          <option value="">Todos los niveles</option>
                          {locationFilterOptions.niveles.map(nivel => <option key={nivel} value={nivel}>{nivel}</option>)}
                        </select>
                      </label>
                    </div>
                    {locationFilter.zone && (
                      <p className="mt-2 text-xs font-bold text-violet-700">
                        {locationFilteredLines.length} codigo(s) pendiente(s) con la ubicacion seleccionada.
                      </p>
                    )}
                  </div>

                  <div className="mt-4 overflow-hidden rounded-2xl border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-white p-3">
                      <p className="text-xs font-black uppercase text-slate-500">{selectedLineIds.size} seleccionados - {assignmentFilteredLines.length} visibles</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={selectedAssignedPicker}
                          onChange={event => {
                            setSelectedAssignedPicker(event.target.value);
                            setSelectedLineIds(new Set());
                          }}
                          className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                        >
                          <option value="all">Todos los picadores asignados</option>
                          {assignedPickerOptions.map(option => (
                            <option key={option.key} value={option.key}>{option.label}</option>
                          ))}
                        </select>
                        <select
                          value={assignmentProgressFilter}
                          onChange={event => {
                            setAssignmentProgressFilter(event.target.value as AssignmentProgressFilter);
                            setSelectedLineIds(new Set());
                          }}
                          className="rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700"
                        >
                          <option value="todos">Todas las asignaciones</option>
                          <option value="pendiente">Solo pendientes por picar</option>
                        </select>
                        <button onClick={selectAllAssignmentFilteredLines} className="rounded-xl border px-3 py-2 text-xs font-black hover:bg-slate-50">
                          Seleccionar visibles
                        </button>
                        <button
                          onClick={() => setLocationSort(locationSort === "asc" ? "desc" : "asc")}
                          className="rounded-xl border px-3 py-2 text-xs font-black hover:bg-slate-50"
                        >
                          Ubicaciones {locationSort === "asc" ? "A-Z" : "Z-A"}
                        </button>
                      </div>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                        <tr>
                          <th className="w-10 p-3 text-left">
                            <input
                              type="checkbox"
                              checked={assignmentFilteredLines.length > 0 && assignmentFilteredLines.every(line => selectedLineIds.has(line.id))}
                              onChange={event => {
                                if (event.target.checked) setSelectedLineIds(new Set(assignmentFilteredLines.map(line => line.id)));
                                else setSelectedLineIds(new Set());
                              }}
                            />
                          </th>
                          <th className="p-3 text-left">Codigo</th>
                          <th className="p-3 text-left">Ubicaciones {locationSort === "asc" ? "A-Z" : "Z-A"}</th>
                          <th className="p-3 text-right">Req.</th>
                          <th className="p-3 text-right">Stock</th>
                          <th className="p-3 text-right">Asig.</th>
                          <th className="p-3 text-right">Picado</th>
                          <th className="p-3 text-left">Picadores</th>
                        </tr>
                      </thead>
                      <tbody>
                        {assignmentFilteredLines.map(line => {
                          const lineAssignments = assignmentsByLine.get(line.id) || [];
                          return (
                            <tr key={line.id} className="border-t align-top">
                              <td className="p-3">
                                <input type="checkbox" checked={selectedLineIds.has(line.id)} onChange={() => toggleLine(line.id)} />
                              </td>
                              <td className="p-3">
                                <p className="font-black">{line.product_code}</p>
                                <p className="text-xs text-slate-500">{line.description}</p>
                                <p className="text-xs text-slate-400">{line.barcode || line.sku}</p>
                              </td>
                              <td className="max-w-[260px] p-3 text-xs font-bold text-slate-600">
                                {(locationsByLine[line.id] || []).slice(0, 8).join(", ") || "Sin ubicacion registrada"}
                              </td>
                              <td className="p-3 text-right font-black">{num(line.qty_requested)}</td>
                              <td className="p-3 text-right font-black text-slate-600">{formatQty(num(stockByLine[line.id]))}</td>
                              <td className="p-3 text-right font-black">{lineAssignments.reduce((sum, item) => sum + num(item.assigned_qty), 0)}</td>
                              <td className="p-3 text-right font-black text-violet-700">{lineAssignments.reduce((sum, item) => sum + num(item.picked_qty), 0)}</td>
                              <td className="p-3">
                                <div className="space-y-2">
                                  {lineAssignments.map(item => (
                                    <div key={item.id} className="rounded-xl bg-slate-100 p-2">
                                      <p className="text-xs font-bold text-slate-700">{assignmentPickerName(item)}: {num(item.picked_qty)}/{num(item.assigned_qty)}</p>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="p-10 text-center text-sm font-bold text-slate-400">Selecciona un requerimiento.</div>
              )}
            </section>
          </div>
        ) : manager && panel === "reportes" ? (
          <section className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <DonutCard title="Global" done={reportTotals.picked} total={reportTotals.required} detail="Codigos completados vs asignados" />
              <DonutCard
                title="Requerimiento seleccionado"
                done={selectedRequestReport.done}
                total={selectedRequestReport.total}
                detail={selectedReportRequest?.doc_number || selectedReportRequest?.inv_request_no || "Sin seleccion"}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <BarChart3 size={18} />
                  <h2 className="font-black">Avance por tienda solicitante</h2>
                </div>
                <div className="space-y-3">
                  {reportByStore.map(row => (
                    <div key={row.label}>
                      <div className="mb-1 flex justify-between text-xs font-black text-slate-500">
                        <span>{row.label}</span>
                        <span>{formatQty(row.done)} / {formatQty(row.total)} ({pct(row.done, row.total)}%)</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-violet-600" style={{ width: `${pct(row.done, row.total)}%` }} /></div>
                    </div>
                  ))}
                  {reportByStore.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">Sin datos por tienda.</p>}
                </div>
              </div>

              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <BarChart3 size={18} />
                  <h2 className="font-black">Avance por picador</h2>
                </div>
                <div className="space-y-3">
                  {reportByPicker.map(row => (
                    <div key={row.label}>
                      <div className="mb-1 flex justify-between text-xs font-black text-slate-500">
                        <span>{row.label}</span>
                        <span>{formatQty(row.done)} / {formatQty(row.total)} ({pct(row.done, row.total)}%)</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-emerald-600" style={{ width: `${pct(row.done, row.total)}%` }} /></div>
                    </div>
                  ))}
                  {reportByPicker.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">Sin asignaciones por picador.</p>}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Requerimientos en proceso y completados</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {reportRequests.map(row => (
                  <button
                    key={row.request.id}
                    onDoubleClick={() => setSelectedRequestId(row.request.id)}
                    onClick={() => setSelectedRequestId(row.request.id)}
                    className={`rounded-2xl border p-4 text-left hover:border-violet-500 ${selectedReportRequest?.id === row.request.id ? "border-violet-600 bg-violet-50" : "bg-white"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={`text-[10px] font-black uppercase tracking-wide ${reasonBadgeClass(row.request.reason)}`}>{row.request.reason || "Sin motivo"}</p>
                        <p className="font-black">{row.request.doc_number || row.request.inv_request_no}</p>
                        <p className="text-xs font-bold text-slate-500">Solicita: {requesterStoreLabel(row.request)}</p>
                        <p className="text-xs font-bold text-slate-500">Entrega: {storeLabel(row.request)}</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-black ${row.status === "Completado" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{row.status}</span>
                    </div>
                    <div className="mt-3 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-violet-600" style={{ width: `${pct(row.done, row.total)}%` }} /></div>
                    <p className="mt-1 text-xs font-black text-slate-500">{formatQty(row.done)} / {formatQty(row.total)} codigos completados</p>
                  </button>
                ))}
                {reportRequests.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400 md:col-span-2 xl:col-span-3">Aun no hay requerimientos asignados.</p>}
              </div>
            </div>

            {selectedReportRequest && <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
                <div>
                  <h2 className="font-black">Diferencias por codigo</h2>
                  <p className="text-xs font-bold text-slate-500">Picado vs solicitado y stock restante despues de lo picado.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs font-black uppercase text-slate-500">Picador</label>
                  <select
                    value={selectedReportPicker}
                    onChange={event => setSelectedReportPicker(event.target.value)}
                    className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                  >
                    <option value="all">Todos los picadores</option>
                    {reportPickerOptions.map(option => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                  <button onClick={() => downloadReport("global")} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                    <Download size={16} />
                  </button>
                </div>
              </div>
              <div className="max-h-[460px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="p-3 text-left">Requerimiento</th>
                      <th className="p-3 text-left">Tienda</th>
                      <th className="p-3 text-left">Codigo</th>
                      <th className="p-3 text-left">Picador</th>
                      <th className="p-3 text-right">Solicitado</th>
                      <th className="p-3 text-right">Picado</th>
                      <th className="p-3 text-right">Stock</th>
                      <th className="p-3 text-right">Dif. solicitud</th>
                      <th className="p-3 text-right">Dif. stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.filter(row => row.request?.id === selectedReportRequest.id).map(row => (
                      <tr key={row.line.id} className="border-t">
                        <td className="p-3 font-bold">{row.request?.doc_number || row.request?.inv_request_no || "-"}</td>
                        <td className="p-3 text-xs font-bold text-slate-500">{storeLabel(row.request)}</td>
                        <td className="p-3">
                          <p className="font-black">{row.line.product_code}</p>
                          <p className="text-xs text-slate-500">{row.line.description}</p>
                        </td>
                        <td className="p-3 text-xs font-bold text-slate-500">{row.pickers}</td>
                        <td className="p-3 text-right font-black">{formatQty(num(row.line.qty_requested))}</td>
                        <td className="p-3 text-right font-black text-violet-700">{formatQty(row.picked)}</td>
                        <td className="p-3 text-right font-black">{formatQty(row.stock)}</td>
                        <td className={`p-3 text-right font-black ${row.diffRequired < 0 ? "text-red-600" : row.diffRequired > 0 ? "text-blue-700" : "text-emerald-700"}`}>{formatQty(row.diffRequired)}</td>
                        <td className={`p-3 text-right font-black ${row.diffStock < 0 ? "text-red-600" : "text-slate-700"}`}>{formatQty(row.diffStock)}</td>
                      </tr>
                    ))}
                    {reportRows.filter(row => row.request?.id === selectedReportRequest.id).length === 0 && <tr><td colSpan={9} className="p-8 text-center text-sm font-bold text-slate-400">Sin diferencias para mostrar.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>}
          </section>
        ) : manager && panel === "registros" ? (
          <section className="mt-4 overflow-hidden rounded-2xl border bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
              <div>
                <h2 className="font-black">Registros de picadores</h2>
                <p className="text-xs font-bold text-slate-500">Hora, picador, codigo solicitado, unidad ERP, ubicacion escaneada y cantidad registrada.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-black uppercase text-slate-500">Picador</label>
                <select
                  value={selectedRegistryPicker}
                  onChange={event => setSelectedRegistryPicker(event.target.value)}
                  className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                >
                  <option value="all">Todos los picadores</option>
                  {registryPickerOptions.map(option => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
                <label className="text-xs font-black uppercase text-slate-500">Tienda solicitante</label>
                <select
                  value={selectedRegistryRequesterStore}
                  onChange={event => setSelectedRegistryRequesterStore(event.target.value)}
                  className="rounded-xl border bg-white px-3 py-2 text-sm font-black text-slate-800"
                >
                  <option value="all">Todas las tiendas</option>
                  {registryRequesterStoreOptions.map(option => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="p-3 text-left">Hora</th>
                    <th className="p-3 text-left">Picador</th>
                    <th className="p-3 text-left">Tienda solicitante</th>
                    <th className="p-3 text-left">Requerimiento</th>
                    <th className="p-3 text-left">Codigo</th>
                    <th className="p-3 text-left">Descripcion</th>
                    <th className="p-3 text-left">UM</th>
                    <th className="p-3 text-left">Ubicacion</th>
                    <th className="p-3 text-right">Cantidad</th>
                    <th className="p-3 text-left">Escaneado</th>
                    <th className="p-3 text-right">Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {scanRows.map(({ scan, line, request }) => (
                    <tr key={scan.id} className="border-t">
                      <td className="p-3 text-xs font-bold text-slate-500">{dateText(scan.created_at)}</td>
                      <td className="p-3 font-bold">{scanPickerName(scan)}</td>
                      <td className="p-3 text-xs font-bold text-slate-500">{requesterStoreLabel(request)}</td>
                      <td className="p-3 font-bold">{request?.doc_number || request?.inv_request_no || "-"}</td>
                      <td className="p-3 font-black">{line?.product_code || "-"}</td>
                      <td className="p-3 text-xs font-bold text-slate-500">{line?.description || "-"}</td>
                      <td className="p-3 font-black">{line?.unit || "-"}</td>
                      <td className="p-3 font-black">{scan.location_code}</td>
                      <td className="p-3 text-right font-black">{formatQty(num(scan.qty))}</td>
                      <td className={`p-3 text-xs font-black ${scan.is_match ? "text-emerald-700" : "text-red-600"}`}>{scan.scanned_product_code || scan.scanned_barcode || "-"}</td>
                      <td className="p-3 text-right">
                        <button onClick={() => deleteScan(scan)} className="rounded-xl border border-red-200 px-3 py-2 text-xs font-black text-red-600 hover:bg-red-50">
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                  {scanRows.length === 0 && <tr><td colSpan={11} className="p-8 text-center text-sm font-bold text-slate-400">Aun no hay registros de picadores.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        ) : manager && panel === "productividad" ? (
          <section className="mt-4 space-y-4">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Productividad</h2>
              <p className="text-xs font-bold text-slate-500">Resumen por picador segun los registros del filtro de tienda entrega y rango de fechas.</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <BarListCard title="Codigos registrados" rows={productivityByCodes} colorClass="bg-violet-600" />
              <BarListCard title="Unidades registradas" rows={productivityByUnits} colorClass="bg-emerald-600" />
              <BarListCard title="Ubicaciones registradas" rows={productivityByLocations} colorClass="bg-cyan-600" />
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <div>
                <h2 className="text-2xl font-black">Productividad picking por hora</h2>
                <p className="text-sm font-bold text-slate-500">Cantidad de codigos pickeados por picador.</p>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="flex items-center gap-3 rounded-2xl border p-4">
                  <Clock className="text-blue-700" size={40} />
                  <div>
                    <p className="text-xs font-black uppercase text-slate-500">Hora mas productiva</p>
                    <p className="mt-1 text-3xl font-black text-blue-700">{productivityHourlyComparison.bestHour?.hour || "-"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border p-4">
                  <TrendingUp className="text-emerald-700" size={40} />
                  <div>
                    <p className="text-xs font-black uppercase text-slate-500">Codigos en mejor hora</p>
                    <p className="mt-1 text-3xl font-black text-emerald-700">{formatWhole(productivityHourlyComparison.bestHour?.total || 0)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border p-4">
                  <UserCircle className="text-violet-700" size={40} />
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase text-slate-500">Mejor picador en esa hora</p>
                    <p className="mt-1 truncate text-xl font-black text-violet-700">{productivityHourlyComparison.bestPicker?.label || "-"}</p>
                    <p className="text-xs font-black text-slate-600">{formatWhole(productivityHourlyComparison.bestPicker?.value || 0)} codigos</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border p-4">
                  <Trophy className="text-amber-500" size={40} />
                  <div>
                    <p className="text-xs font-black uppercase text-slate-500">Total codigos</p>
                    <p className="mt-1 text-3xl font-black text-amber-600">{formatWhole(productivityHourlyComparison.grandTotal)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border p-4">
                  <Trophy className="text-slate-900" size={40} />
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase text-slate-500">Mejor picador por jornada</p>
                    <p className="mt-1 truncate text-xl font-black text-slate-950">{productivityHourlyComparison.bestJourneyPicker?.label || "-"}</p>
                    <p className="text-xs font-black text-slate-600">{formatWhole(productivityHourlyComparison.bestJourneyPicker?.total || 0)} codigos</p>
                  </div>
                </div>
              </div>
              <div className="mt-4 overflow-hidden rounded-2xl border">
                <div className="border-b p-4 text-center">
                  <h3 className="text-lg font-black">Codigos pickeados por hora y picador</h3>
                </div>
                {productivityHourlyComparison.rows.length > 0 ? (() => {
                  const chart = {
                    left: 110,
                    top: 70,
                    width: Math.max(1500, productivityHourlyComparison.rows.length * 260),
                    height: 760,
                    bottom: 95,
                    legend: 280,
                  };
                  const graphWidth = chart.width - chart.left - chart.legend - 30;
                  const graphHeight = chart.height - chart.top - chart.bottom;
                  const yMax = Math.max(1, Math.ceil(Math.max(productivityHourlyComparison.maxTotal, productivityHourlyComparison.maxValue) / 10) * 10);
                  const groupWidth = graphWidth / productivityHourlyComparison.rows.length;
                  const barWidth = Math.max(18, Math.min(44, (groupWidth - 56) / Math.max(productivityHourlyComparison.columns.length, 1)));
                  const linePoints = productivityHourlyComparison.rows.map((row, index) => {
                    const x = chart.left + groupWidth * index + groupWidth / 2;
                    const y = chart.top + graphHeight - (row.total / yMax) * graphHeight;
                    return { x, y, total: row.total, hour: row.hour };
                  });
                  const linePath = linePoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
                  return (
                    <div className="overflow-x-auto">
                      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="min-w-[1500px]">
                        {[0, 0.25, 0.5, 0.75, 1].map(step => {
                          const value = Math.round(yMax * (1 - step));
                          const y = chart.top + graphHeight * step;
                          return (
                            <g key={step}>
                              <line x1={chart.left} x2={chart.left + graphWidth} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 4" />
                              <text x={chart.left - 18} y={y + 6} textAnchor="end" className="fill-slate-600 text-[18px] font-bold">{value}</text>
                            </g>
                          );
                        })}
                        <text x={chart.left - 70} y={chart.top - 28} className="fill-blue-700 text-[18px] font-black">Codigos</text>
                        {productivityHourlyComparison.rows.map((row, rowIndex) => {
                          const groupStart = chart.left + groupWidth * rowIndex;
                          return (
                            <g key={row.hour}>
                              {productivityHourlyComparison.columns.map((column, columnIndex) => {
                                const value = row.byPicker[column.key] || 0;
                                const height = (value / yMax) * graphHeight;
                                const x = groupStart + (groupWidth - (barWidth * productivityHourlyComparison.columns.length)) / 2 + columnIndex * barWidth;
                                const y = chart.top + graphHeight - height;
                                return (
                                  <g key={column.key}>
                                    <rect x={x} y={y} width={barWidth - 4} height={height} rx={4} fill={column.color} />
                                    {value > 0 && <text x={x + (barWidth - 4) / 2} y={y - 10} textAnchor="middle" className="fill-slate-950 text-[18px] font-black">{value}</text>}
                                  </g>
                                );
                              })}
                              <text x={groupStart + groupWidth / 2} y={chart.top + graphHeight + 44} textAnchor="middle" className="fill-slate-950 text-[20px] font-black">{row.hour}</text>
                            </g>
                          );
                        })}
                        <path d={linePath} fill="none" stroke="#0f52ba" strokeWidth={5} />
                        {linePoints.map(point => (
                          <g key={point.hour}>
                            <circle cx={point.x} cy={point.y} r={8} fill="#0f52ba" />
                            <text x={point.x} y={point.y - 22} textAnchor="middle" className="fill-blue-800 text-[20px] font-black">{point.total}</text>
                          </g>
                        ))}
                        <text x={chart.left + graphWidth / 2} y={chart.height - 24} textAnchor="middle" className="fill-slate-950 text-[20px] font-black">Hora</text>
                        {productivityHourlyComparison.columns.map((column, index) => (
                          <g key={column.key} transform={`translate(${chart.left + graphWidth + 42}, ${chart.top + 34 + index * 38})`}>
                            <rect width={18} height={18} rx={4} fill={column.color} />
                            <text x={30} y={16} className="fill-slate-950 text-[18px] font-bold">{column.label}</text>
                          </g>
                        ))}
                        <g transform={`translate(${chart.left + graphWidth + 42}, ${chart.top + 34 + productivityHourlyComparison.columns.length * 38})`}>
                          <line x1={0} x2={28} y1={9} y2={9} stroke="#0f52ba" strokeWidth={5} />
                          <circle cx={14} cy={9} r={7} fill="#0f52ba" />
                          <text x={42} y={16} className="fill-slate-950 text-[18px] font-bold">Total por hora</text>
                        </g>
                      </svg>
                    </div>
                  );
                })() : (
                  <p className="p-8 text-center text-sm font-bold text-slate-400">Sin registros en el rango seleccionado.</p>
                )}
              </div>
            </div>
          </section>
        ) : (
          <div className="mt-2 space-y-3">
            <section className="rounded-2xl border bg-white p-2.5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-black">{formatQty(operatorTotals.picked)} / {formatQty(operatorTotals.assigned)}</p>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-black text-violet-700">{operatorTotals.progress}%</span>
                  {pickingDate !== todayISO() && (
                    <button
                      type="button"
                      onClick={() => {
                        setPickingDate(todayISO());
                        setActiveAssignmentId("");
                      }}
                      className="rounded-lg border px-2 py-0.5 text-[11px] font-black text-slate-600"
                    >
                      Hoy
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-slate-100">
                <div className="h-1.5 rounded-full bg-violet-600" style={{ width: `${operatorTotals.progress}%` }} />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                <input
                  type="date"
                  value={pickingDate}
                  onChange={event => {
                    setPickingDate(event.target.value);
                    setActiveAssignmentId("");
                  }}
                  className="min-w-0 rounded-lg border bg-white px-1.5 py-1.5 text-[11px] font-black text-slate-800"
                />
                <select
                  value={selectedRequesterStore}
                  onChange={event => {
                    setSelectedRequesterStore(event.target.value);
                    setActiveAssignmentId("");
                  }}
                  className="min-w-0 rounded-lg border bg-white px-1.5 py-1.5 text-[11px] font-black text-slate-800"
                >
                  <option value="all">Todas las tiendas</option>
                  {requesterStoreOptions.map(option => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
                <select
                  value={selectedOperatorReason}
                  onChange={event => {
                    setSelectedOperatorReason(event.target.value);
                    setActiveAssignmentId("");
                  }}
                  className="min-w-0 rounded-lg border bg-white px-1.5 py-1.5 text-[11px] font-black text-slate-800"
                >
                  <option value="all">Todos los motivos</option>
                  {reasonOptions.map(option => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </div>
            </section>

            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-black">Codigos asignados</h2>
                <button onClick={() => downloadReport("mine")} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                  <Download size={16} />
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {openOperatorAssignments.map(assignment => {
                  const line = lines.find(item => item.id === assignment.line_id);
                  const request = requests.find(item => item.id === assignment.request_id);
                  const cardLocations = line ? (locationsByLine[line.id] || []) : [];
                  const pickedQty = num(assignment.picked_qty);
                  const assignedQty = num(assignment.assigned_qty);
                  const pendingQty = Math.max(0, assignedQty - pickedQty);
                  const isActive = activeAssignment?.id === assignment.id && activeAssignmentId === assignment.id;
                  return (
                    <div key={assignment.id} className="contents">
                      <button
                        onClick={() => setActiveAssignmentId(assignment.id)}
                        className={`w-full rounded-xl border p-3 text-left transition hover:border-violet-400 ${isActive ? "border-violet-600 bg-violet-50" : "bg-white"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-black leading-tight">{line?.product_code || "Codigo"}</p>
                            <p className="truncate text-xs font-black text-violet-700">Solicita: {requesterStoreLabel(request)}</p>
                            <p className="truncate text-xs font-bold text-slate-500">Entrega: {request?.source_store_name || request?.source_store_code}</p>
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black text-slate-600">{line?.unit || "-"}</span>
                        </div>
                        <p className={`mt-0.5 text-[10px] font-black uppercase tracking-wide ${reasonBadgeClass(request?.reason)}`}>{request?.reason || "Sin motivo"}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{line?.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cardLocations.length > 0 ? cardLocations.map(location => (
                            <span key={location} className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-black text-emerald-700">{cleanLocationLabel(location)}</span>
                          )) : <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-black text-slate-500">Sin ubicacion con stock</span>}
                        </div>
                        <div className="mt-2 grid grid-cols-4 overflow-hidden rounded-lg border bg-slate-50 text-center text-[11px] font-black">
                          <div className="border-r px-1 py-1">
                            <p className="text-slate-400">Asignado</p>
                            <p>{formatQty(assignedQty)}</p>
                          </div>
                          <div className="border-r px-1 py-1">
                            <p className="text-slate-400">Picado</p>
                            <p className="text-violet-700">{formatQty(pickedQty)}</p>
                          </div>
                          <div className="border-r px-1 py-1">
                            <p className="text-slate-400">Pendiente</p>
                            <p>{formatQty(pendingQty)}</p>
                          </div>
                          <div className="px-1 py-1">
                            <p className="text-slate-400">Stock actual</p>
                            <p>{formatQty(num(line ? stockByLine[line.id] : 0))}</p>
                          </div>
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-slate-100">
                          <div className="h-1.5 rounded-full bg-violet-600" style={{ width: `${pct(pickedQty, assignedQty)}%` }} />
                        </div>
                      </button>
                      {isActive && activeLine && (
                        <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-3 shadow-sm md:col-span-2 xl:col-span-3">
                          <div className="border-b border-violet-100 pb-3">
                            <div className="min-w-0">
                              <p className="text-xs font-black uppercase text-slate-500">{activeRequest?.doc_number || activeRequest?.inv_request_no}</p>
                              <h2 className="text-lg font-black leading-tight">{activeLine.product_code}</h2>
                              <p className="text-xs font-black text-violet-700">Solicita: {requesterStoreLabel(activeRequest)}</p>
                              <p className="text-xs font-semibold text-slate-500">{activeLine.description}</p>
                              <p className="text-xs font-black text-slate-700">Unidad solicitada: {activeLine.unit || "-"}</p>
                              <p className="text-xs font-bold text-slate-400">Ubicaciones: {(locationsByLine[activeLine.id] || []).map(cleanLocationLabel).join(", ") || "sin ubicacion registrada"}</p>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-2">
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <input value={scanProduct} onChange={event => setScanProduct(event.target.value)} className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold" placeholder="Escanear producto o barra" />
                              <button onClick={() => setScannerTarget("product")} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-white" title="Abrir escaner de producto">
                                <QrCode size={18} />
                              </button>
                            </div>
                            {scanEntries.map((entry, index) => {
                              const availableLocations = [...new Set((locationsByLine[activeLine.id] || []).map(cleanLocationLabel).filter(Boolean))];
                              return (
                                <div key={index} className="grid gap-2 rounded-xl border bg-white p-2 md:grid-cols-[1fr_110px_auto_auto]">
                                  <div className="grid grid-cols-[1fr_auto] gap-2">
                                    <input
                                      value={entry.location}
                                      onChange={event => updateScanEntry(index, "location", event.target.value)}
                                      list={`picking-locations-${activeLine.id}-${index}`}
                                      className="min-w-0 rounded-xl border px-3 py-2 text-sm font-bold uppercase"
                                      placeholder="Escanear o elegir ubicacion"
                                      autoFocus={index === 0}
                                    />
                                    <button
                                      onClick={() => { setScannerLocationIndex(index); setScannerTarget("location"); }}
                                      className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-white"
                                      title="Abrir escaner de ubicacion"
                                    >
                                      <QrCode size={18} />
                                    </button>
                                  </div>
                                  <input value={entry.qty} onChange={event => updateScanEntry(index, "qty", event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Cantidad" inputMode="decimal" />
                                  <button onClick={addScanEntry} className="rounded-xl border px-3 py-2 text-sm font-black hover:bg-slate-50">
                                    Agregar ubicacion
                                  </button>
                                  <button onClick={() => removeScanEntry(index)} className="rounded-xl border px-3 py-2 text-sm font-black text-red-600 hover:bg-red-50" disabled={scanEntries.length === 1}>
                                    Quitar
                                  </button>
                                  <datalist id={`picking-locations-${activeLine.id}-${index}`}>
                                    {availableLocations.map(location => <option key={location} value={location} />)}
                                  </datalist>
                                </div>
                              );
                            })}
                            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                              <button onClick={saveScan} className="rounded-xl bg-violet-600 px-3 py-3 text-sm font-black text-white hover:bg-violet-700">
                                <ClipboardList className="mr-1 inline" size={16} />
                                Guardar picking
                              </button>
                              <button onClick={() => { setScanProduct(""); setScanEntries([{ location: "", qty: "1" }]); }} className="rounded-xl border bg-white px-3 py-3 text-sm font-black hover:bg-slate-50">
                                Limpiar
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {openOperatorAssignments.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400 md:col-span-2 xl:col-span-3">{selectedRequesterStore === "all" ? "No tienes codigos pendientes." : "No tienes codigos pendientes para esta tienda."}</p>}
              </div>
            </section>

            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Mis registros</h2>
              <p className="text-xs font-bold text-slate-500">Puedes editar o eliminar registros. Se pedira confirmacion antes de eliminar.</p>
              <div className="mt-3 space-y-2">
                {operatorScanRows.map(({ scan, line }) => (
                  <div key={scan.id} className="rounded-2xl border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-black">{line?.product_code || scan.scanned_product_code}</p>
                        <p className="text-xs font-bold text-slate-500">{line?.description}</p>
                        <p className="text-xs font-black text-slate-600">{dateText(scan.created_at)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => startEditScan(scan)} className="rounded-xl border px-3 py-2 text-xs font-black hover:bg-slate-50">Editar</button>
                        <button onClick={() => deleteScan(scan)} className="rounded-xl border border-red-200 px-3 py-2 text-xs font-black text-red-600 hover:bg-red-50">Eliminar</button>
                      </div>
                    </div>
                    {editingScanId === scan.id ? (
                      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_120px_auto_auto]">
                        <input value={editScanLocation} onChange={event => setEditScanLocation(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Ubicacion" />
                        <input value={editScanQty} onChange={event => setEditScanQty(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Cantidad" inputMode="decimal" />
                        <button onClick={saveEditScan} className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-black text-white">Guardar</button>
                        <button onClick={() => setEditingScanId("")} className="rounded-xl border px-3 py-2 text-sm font-black hover:bg-slate-50">Cancelar</button>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm font-black text-slate-700">Ubicacion {scan.location_code} | Cantidad {formatQty(num(scan.qty))}</p>
                    )}
                  </div>
                ))}
                {operatorScanRows.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">Aun no tienes registros.</p>}
              </div>
            </section>
          </div>
        )}
      </section>

      {scannerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-black">{scannerTarget === "location" ? "Escanear ubicacion" : "Escanear producto"}</h2>
                <p className="text-xs font-bold text-slate-500">{scannerRunning ? "Camara activa" : "Iniciando camara..."}</p>
              </div>
              <button onClick={() => closeScanner()} className="rounded-xl border px-3 py-2 hover:bg-slate-50" title="Cerrar escaner">
                <X size={18} />
              </button>
            </div>
            <div id={scannerContainerId} className="overflow-hidden rounded-2xl border bg-slate-100" />
          </div>
        </div>
      )}

      {codeMismatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-black text-red-600">Codigo no solicitado</h2>
            <p className="mt-2 text-sm font-bold text-slate-600">El producto escaneado no coincide con el codigo asignado.</p>
            <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
              <p className="text-xs font-black uppercase text-slate-500">Solicitado</p>
              <p className="font-black">{codeMismatch.expected}</p>
              <p className="mt-2 text-xs font-black uppercase text-slate-500">Escaneado</p>
              <p className="font-black text-red-600">{codeMismatch.scanned}</p>
            </div>
            <button onClick={() => setCodeMismatch(null)} className="mt-4 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white">
              Entendido
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
