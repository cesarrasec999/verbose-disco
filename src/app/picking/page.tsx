"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, ClipboardList, Download, Home, QrCode, RefreshCw, ScanLine, UserPlus, X } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";

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

type PickingPanel = "asignacion" | "reportes" | "registros";
type LocationSort = "asc" | "desc";
type ScannerTarget = "location" | "product" | null;

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

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function csvValue(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function formatSync(value: string | null) {
  if (!value) return "Sin sincronizacion registrada";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
}

function formatQty(value: number) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(value);
}

function storeLabel(request: PickingRequest | null | undefined) {
  return request?.source_store_name || request?.source_store_code || "-";
}

function requesterStoreLabel(request: PickingRequest | null | undefined) {
  return request?.destination_store_name || request?.destination_store_code || "-";
}

function DonutCard({ title, done, total, detail }: { title: string; done: number; total: number; detail: string }) {
  const progress = pct(done, total);
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex items-center gap-4">
        <div
          className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(#7c3aed ${progress * 3.6}deg, #e2e8f0 0deg)` }}
        >
          <div className="grid h-16 w-16 place-items-center rounded-full bg-white text-lg font-black">{progress}%</div>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-black uppercase text-slate-500">{title}</p>
          <p className="mt-1 text-xl font-black text-slate-950">{formatQty(done)} / {formatQty(total)}</p>
          <p className="mt-1 text-xs font-bold text-slate-500">{detail}</p>
        </div>
      </div>
    </div>
  );
}

export default function PickingPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [requests, setRequests] = useState<PickingRequest[]>([]);
  const [lines, setLines] = useState<PickingLine[]>([]);
  const [assignments, setAssignments] = useState<PickingAssignment[]>([]);
  const [scans, setScans] = useState<PickingScan[]>([]);
  const [pickers, setPickers] = useState<CyclicUser[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [selectedLineId, setSelectedLineId] = useState("");
  const [selectedPickerId, setSelectedPickerId] = useState("");
  const [assignQty, setAssignQty] = useState("");
  const [activeAssignmentId, setActiveAssignmentId] = useState("");
  const [scanLocation, setScanLocation] = useState("");
  const [scanProduct, setScanProduct] = useState("");
  const [scanQty, setScanQty] = useState("1");
  const [locationsByLine, setLocationsByLine] = useState<Record<string, string[]>>({});
  const [stockByLine, setStockByLine] = useState<Record<string, number>>({});
  const [lastErpSync, setLastErpSync] = useState<string | null>(null);
  const [panel, setPanel] = useState<PickingPanel>("asignacion");
  const [selectedSourceStore, setSelectedSourceStore] = useState("all");
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  const [locationSort, setLocationSort] = useState<LocationSort>("asc");
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [scannerRunning, setScannerRunning] = useState(false);
  const [codeMismatch, setCodeMismatch] = useState<{ expected: string; scanned: string } | null>(null);
  const [editingScanId, setEditingScanId] = useState("");
  const [editScanLocation, setEditScanLocation] = useState("");
  const [editScanQty, setEditScanQty] = useState("");
  const [reassignPickerByAssignmentId, setReassignPickerByAssignmentId] = useState<Record<string, string>>({});
  const scannerRef = useRef<Html5QrLike | null>(null);
  const scanHandledRef = useRef(false);
  const scannerContainerId = "picking-scanner";

  const manager = canManagePicking(user);
  const admin = user?.role === "Administrador";

  const sourceStoreOptions = useMemo(() => {
    const grouped = new Map<string, string>();
    for (const request of requests) {
      const key = normalize(request.source_store_code || request.source_store_name);
      if (!key) continue;
      grouped.set(key, request.source_store_name || request.source_store_code);
    }
    return [...grouped.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [requests]);

  const filteredRequests = useMemo(
    () => selectedSourceStore === "all"
      ? requests
      : requests.filter(request => normalize(request.source_store_code || request.source_store_name) === selectedSourceStore),
    [requests, selectedSourceStore]
  );

  const selectedRequest = useMemo(
    () => filteredRequests.find(request => request.id === selectedRequestId) || filteredRequests[0] || null,
    [filteredRequests, selectedRequestId]
  );

  const visibleLines = useMemo(
    () => lines.filter(line => line.request_id === selectedRequest?.id),
    [lines, selectedRequest?.id]
  );

  const sortedVisibleLines = useMemo(() => {
    return [...visibleLines].sort((a, b) => {
      const aLoc = (locationsByLine[a.id] || [])[0] || "ZZZ";
      const bLoc = (locationsByLine[b.id] || [])[0] || "ZZZ";
      const cmp = aLoc.localeCompare(bLoc, "es");
      if (cmp !== 0) return locationSort === "asc" ? cmp : -cmp;
      return a.product_code.localeCompare(b.product_code, "es");
    });
  }, [locationSort, locationsByLine, visibleLines]);

  const assignmentsByLine = useMemo(() => {
    const grouped = new Map<string, PickingAssignment[]>();
    for (const assignment of assignments) {
      if (!grouped.has(assignment.line_id)) grouped.set(assignment.line_id, []);
      grouped.get(assignment.line_id)!.push(assignment);
    }
    return grouped;
  }, [assignments]);

  const myAssignments = useMemo(() => {
    if (!user) return [];
    return assignments.filter(assignment => assignment.picker_id === user.id || normalize(assignment.picker_name) === normalize(user.full_name));
  }, [assignments, user]);

  const sortedMyAssignments = useMemo(() => {
    return [...myAssignments].sort((a, b) => {
      const aLoc = (locationsByLine[a.line_id] || [])[0] || "ZZZ";
      const bLoc = (locationsByLine[b.line_id] || [])[0] || "ZZZ";
      const cmp = aLoc.localeCompare(bLoc, "es");
      if (cmp !== 0) return cmp;
      const aLine = lines.find(line => line.id === a.line_id);
      const bLine = lines.find(line => line.id === b.line_id);
      return String(aLine?.product_code || "").localeCompare(String(bLine?.product_code || ""), "es");
    });
  }, [lines, locationsByLine, myAssignments]);

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

  const totals = useMemo(() => {
    const requestIds = new Set(filteredRequests.map(request => request.id));
    const scopedAssignments = assignments.filter(assignment => requestIds.has(assignment.request_id));
    const required = filteredRequests.reduce((sum, request) => sum + num(request.qty_requested_total), 0);
    const assigned = scopedAssignments.reduce((sum, assignment) => sum + num(assignment.assigned_qty), 0);
    const picked = scopedAssignments.reduce((sum, assignment) => sum + num(assignment.picked_qty), 0);
    return { required, assigned, picked, progress: pct(picked, required) };
  }, [assignments, filteredRequests]);

  const reportRows = useMemo(() => {
    const requestIds = new Set(filteredRequests.map(request => request.id));
    return lines.filter(line => requestIds.has(line.request_id)).map(line => {
      const request = requests.find(item => item.id === line.request_id);
      const lineAssignments = assignments.filter(item => item.line_id === line.id);
      const assigned = lineAssignments.reduce((sum, item) => sum + num(item.assigned_qty), 0);
      const picked = lineAssignments.reduce((sum, item) => sum + num(item.picked_qty), 0);
      return {
        line,
        request,
        assigned,
        picked,
        diffRequired: picked - num(line.qty_requested),
        diffStock: picked - num(stockByLine[line.id]),
        stock: num(stockByLine[line.id]),
        pickers: lineAssignments.map(item => item.picker_name).join(", ") || "-",
      };
    });
  }, [assignments, filteredRequests, lines, requests, stockByLine]);

  const reportByStore = useMemo(() => {
    const grouped = new Map<string, { label: string; total: number; done: number }>();
    for (const row of reportRows) {
      const label = requesterStoreLabel(row.request);
      const current = grouped.get(label) || { label, total: 0, done: 0 };
      current.total += num(row.line.qty_requested);
      current.done += row.picked;
      grouped.set(label, current);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [reportRows]);

  const reportRequests = useMemo(() => {
    return filteredRequests
      .map(request => {
        const rows = reportRows.filter(row => row.request?.id === request.id);
        const total = rows.reduce((sum, row) => sum + num(row.line.qty_requested), 0);
        const done = rows.reduce((sum, row) => sum + row.picked, 0);
        const assigned = assignments.filter(item => item.request_id === request.id).reduce((sum, item) => sum + num(item.assigned_qty), 0);
        const status = done >= total && total > 0 ? "Completado" : assigned > 0 ? "En proceso" : "Pendiente";
        return { request, total, done, assigned, status };
      })
      .filter(row => row.assigned > 0)
      .sort((a, b) => {
        if (a.status === "En proceso" && b.status !== "En proceso") return -1;
        if (a.status !== "En proceso" && b.status === "En proceso") return 1;
        return (b.request.creation_date || "").localeCompare(a.request.creation_date || "");
      });
  }, [assignments, filteredRequests, reportRows]);

    const reportByPicker = useMemo(() => {
    const grouped = new Map<string, { label: string; total: number; done: number }>();
    for (const assignment of assignments) {
      const current = grouped.get(assignment.picker_name) || { label: assignment.picker_name, total: 0, done: 0 };
      current.total += num(assignment.assigned_qty);
      current.done += num(assignment.picked_qty);
      grouped.set(assignment.picker_name, current);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [assignments]);

  const selectedRequestReport = useMemo(() => {
    if (!selectedRequest) return { total: 0, done: 0 };
    const rows = reportRows.filter(row => row.request?.id === selectedRequest.id);
    return {
      total: rows.reduce((sum, row) => sum + num(row.line.qty_requested), 0),
      done: rows.reduce((sum, row) => sum + row.picked, 0),
    };
  }, [reportRows, selectedRequest]);

  const scanRows = useMemo(() => {
    return scans.map(scan => {
      const line = lines.find(item => item.id === scan.line_id);
      const request = requests.find(item => item.id === scan.request_id);
      return { scan, line, request };
    });
  }, [lines, requests, scans]);

  const operatorTotals = useMemo(() => {
    const assigned = myAssignments.reduce((sum, item) => sum + num(item.assigned_qty), 0);
    const picked = myAssignments.reduce((sum, item) => sum + num(item.picked_qty), 0);
    return { assigned, picked, progress: pct(picked, assigned) };
  }, [myAssignments]);

  const openOperatorAssignments = useMemo(
    () => sortedMyAssignments.filter(item => num(item.picked_qty) < num(item.assigned_qty)),
    [sortedMyAssignments]
  );

  const operatorScanRows = useMemo(
    () => scanRows.filter(row => row.scan.picker_id === user?.id || normalize(row.scan.picker_name) === normalize(user?.full_name)),
    [scanRows, user]
  );

  const loadData = useCallback(async (currentUser: CyclicUser) => {
    setLoading(true);
    setMessage("");
    const currentUserCanManage = canManagePicking(currentUser);

    const [requestsResp, usersResp, storesResp, syncResp, syncFallbackResp] = await Promise.all([
      supabase
        .from("picking_requests")
        .select("*")
        .eq("status_code", "A")
        .order("creation_date", { ascending: false })
        .limit(200),
      supabase
        .from("cyclic_users")
        .select("id,full_name,role,module_access,whatsapp")
        .eq("is_active", true)
        .order("full_name"),
      supabase.from("stores").select("id,code,name,erp_sede").eq("is_active", true),
      supabase.from("erp_sync_status").select("synced_at,updated_at").eq("id", "picking_requests").maybeSingle(),
      supabase.from("picking_requests").select("source_updated_at,updated_at").order("source_updated_at", { ascending: false }).limit(1),
    ]);

    if (requestsResp.error) {
      setMessage("No pude leer picking_requests. Ejecuta primero supabase_picking.sql.");
      setLoading(false);
      return;
    }

    const requestRows = ((requestsResp.data || []) as PickingRequest[]).filter(request => !request.hidden_at);
    setRequests(requestRows);
    setLastErpSync(syncResp.data?.synced_at || syncResp.data?.updated_at || syncFallbackResp.data?.[0]?.source_updated_at || syncFallbackResp.data?.[0]?.updated_at || null);
    if (!selectedRequestId && requestRows[0]) setSelectedRequestId(requestRows[0].id);
    setPickers(((usersResp.data || []) as CyclicUser[]).filter(item => canAccessModule(item, "picking")));
    setStores((storesResp.data || []) as StoreRow[]);

    if (requestRows.length === 0) {
      setLines([]);
      setAssignments([]);
      setScans([]);
      setLoading(false);
      return;
    }

    const requestIds = requestRows.map(request => request.id);
    const assignmentQuery = supabase
      .from("picking_assignments")
      .select("*")
      .in("request_id", requestIds)
      .neq("status", "cancelado")
      .order("created_at", { ascending: false });

    const [linesResp, assignmentsResp, scansResp] = await Promise.all([
      supabase.from("picking_request_lines").select("*").in("request_id", requestIds).order("line_id"),
      currentUserCanManage
        ? assignmentQuery
        : assignmentQuery.or(`picker_id.eq.${currentUser.id},picker_name.eq.${currentUser.full_name}`),
      currentUserCanManage
        ? supabase.from("picking_scans").select("*").in("request_id", requestIds).order("created_at", { ascending: false }).limit(500)
        : supabase.from("picking_scans").select("*").in("request_id", requestIds).eq("picker_id", currentUser.id).order("created_at", { ascending: false }).limit(200),
    ]);

    if (linesResp.error) setMessage("No pude leer lineas de picking: " + linesResp.error.message);
    if (assignmentsResp.error) setMessage("No pude leer asignaciones: " + assignmentsResp.error.message);
    if ("error" in scansResp && scansResp.error) setMessage("No pude leer registros: " + scansResp.error.message);

    setLines((linesResp.data || []) as PickingLine[]);
    setAssignments((assignmentsResp.data || []) as PickingAssignment[]);
    setScans((scansResp.data || []) as PickingScan[]);
    setLoading(false);
  }, [selectedRequestId]);

  useEffect(() => {
    if (!selectedRequest || selectedRequestId === selectedRequest.id) return;
    const timer = window.setTimeout(() => setSelectedRequestId(selectedRequest.id), 0);
    return () => window.clearTimeout(timer);
  }, [selectedRequest, selectedRequestId]);

  useEffect(() => {
    async function loadStock() {
      if (requests.length === 0 || lines.length === 0 || stores.length === 0) {
        setStockByLine({});
        return;
      }
      const sourceSedes = [...new Set(requests.map(request => {
        const sourceCode = normalize(request.source_store_code);
        const sourceName = normalize(request.source_store_name);
        const store = stores.find(item =>
          normalize(item.code) === sourceCode ||
          normalize(item.erp_sede) === sourceCode ||
          normalize(item.name) === sourceName
        );
        return String(store?.erp_sede || store?.name || request.source_store_name || request.source_store_code || "").trim();
      }).filter(Boolean))];
      const codes = [...new Set(lines.flatMap(line => [line.product_code, line.sku].filter(Boolean) as string[]).map(normalize))];
      if (sourceSedes.length === 0 || codes.length === 0) {
        setStockByLine({});
        return;
      }

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
      for (const line of lines) {
        const request = requests.find(item => item.id === line.request_id);
        const sourceCode = normalize(request?.source_store_code);
        const sourceName = normalize(request?.source_store_name);
        const store = stores.find(item =>
          normalize(item.code) === sourceCode ||
          normalize(item.erp_sede) === sourceCode ||
          normalize(item.name) === sourceName
        );
        const sede = normalize(store?.erp_sede || store?.name || request?.source_store_name || request?.source_store_code);
        next[line.id] = bySedeCode.get(`${sede}__${normalize(line.product_code)}`) || bySedeCode.get(`${sede}__${normalize(line.sku)}`) || 0;
      }
      setStockByLine(next);
    }

    void loadStock();
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
        const mod = await import("html5-qrcode");
        const qr = new mod.Html5Qrcode(scannerContainerId) as Html5QrLike;
        scannerRef.current = qr;
        await qr.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 260 } },
          decodedText => {
            if (scanHandledRef.current) return;
            const clean = decodedText.trim();
            if (!clean) return;
            scanHandledRef.current = true;
            if (scannerTarget === "location") setScanLocation(clean);
            if (scannerTarget === "product") setScanProduct(clean);
            void closeScanner();
          },
          undefined
        );
        if (!cancelled) setScannerRunning(true);
      } catch (error) {
        setMessage("No se pudo abrir el escaner: " + (error instanceof Error ? error.message : String(error)));
        void closeScanner();
      }
    }

    void startScanner();
    return () => {
      cancelled = true;
      void closeScanner();
    };
  }, [closeScanner, scannerTarget]);

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
    const timer = window.setTimeout(() => {
      setUser(parsed);
      void loadData(parsed);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

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
            const quantity = countedQty ?? num(row.stored_quantity);
            return { location: row.location, quantity };
          })
          .filter(row => row.location && row.quantity > 0)
          .map(row => `${row.location} (${formatQty(row.quantity)})`);
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
        const allowed = new Set(visibleLines.map(line => line.id));
        const next = new Set([...prev].filter(id => allowed.has(id)));
        return next.size === prev.size ? prev : next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [visibleLines]);

  async function assignPicker() {
    if (!user || !selectedRequest || !selectedLineId || !selectedPickerId) {
      setMessage("Selecciona requerimiento, codigo y picador.");
      return;
    }
    const line = lines.find(item => item.id === selectedLineId);
    const picker = pickers.find(item => item.id === selectedPickerId);
    const qty = num(assignQty);
    if (!line || !picker || qty <= 0) {
      setMessage("Ingresa una cantidad valida para asignar.");
      return;
    }
    const alreadyAssigned = assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
    if (alreadyAssigned + qty > num(line.qty_requested)) {
      setMessage("La asignacion supera la cantidad requerida.");
      return;
    }

    const { error } = await supabase.from("picking_assignments").insert({
      request_id: selectedRequest.id,
      line_id: line.id,
      picker_id: picker.id,
      picker_name: picker.full_name,
      assigned_qty: qty,
      status: "pendiente",
      created_by: user.id,
      created_by_name: user.full_name,
    });
    if (error) {
      setMessage("No se pudo asignar: " + error.message);
      return;
    }
    setAssignQty("");
    setMessage("Asignacion registrada.");
    await loadData(user);
  }

  async function assignSelectedLines() {
    if (!user || !selectedRequest || !selectedPickerId) {
      setMessage("Selecciona picador y codigos.");
      return;
    }
    const picker = pickers.find(item => item.id === selectedPickerId);
    if (!picker) {
      setMessage("Selecciona un picador valido.");
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
      setMessage("Los codigos seleccionados no tienen pendiente por asignar.");
      return;
    }

    const { error } = await supabase.from("picking_assignments").insert(rows.map(({ line, pending }) => ({
      request_id: selectedRequest.id,
      line_id: line.id,
      picker_id: picker.id,
      picker_name: picker.full_name,
      assigned_qty: pending,
      status: "pendiente",
      created_by: user.id,
      created_by_name: user.full_name,
    })));
    if (error) {
      setMessage("No se pudo asignar seleccionados: " + error.message);
      return;
    }
    setSelectedLineIds(new Set());
    setMessage(`${rows.length} codigos asignados a ${picker.full_name}.`);
    await loadData(user);
  }

  async function reassignAssignment(assignmentId: string) {
    if (!manager || !user) return;
    const assignment = assignments.find(item => item.id === assignmentId);
    const picker = pickers.find(item => item.id === reassignPickerByAssignmentId[assignmentId]);
    if (!assignment || !picker) {
      setMessage("Selecciona el nuevo picador.");
      return;
    }
    if (assignment.picker_id === picker.id || normalize(assignment.picker_name) === normalize(picker.full_name)) {
      setMessage("Ese codigo ya esta asignado a ese picador.");
      return;
    }

    const { error } = await supabase
      .from("picking_assignments")
      .update({
        picker_id: picker.id,
        picker_name: picker.full_name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", assignment.id);

    if (error) {
      setMessage("No se pudo reasignar: " + error.message);
      return;
    }

    setAssignments(prev => prev.map(item => (
      item.id === assignment.id ? { ...item, picker_id: picker.id, picker_name: picker.full_name } : item
    )));
    setReassignPickerByAssignmentId(prev => {
      const next = { ...prev };
      delete next[assignment.id];
      return next;
    });
    setMessage(`Codigo reasignado a ${picker.full_name}.`);
    await loadData(user);
  }

  async function forceHideRequest(request: PickingRequest) {
    if (!admin || !user) {
      setMessage("Solo el administrador puede forzar la eliminacion de requerimientos.");
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
      setMessage("No se pudo ocultar el requerimiento. Ejecuta el SQL actualizado de picking si falta hidden_at: " + error.message);
      return;
    }

    setRequests(prev => prev.filter(item => item.id !== request.id));
    if (selectedRequestId === request.id) setSelectedRequestId("");
    setMessage("Requerimiento ocultado por administrador.");
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
    for (const line of sortedVisibleLines) {
      const assigned = assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0;
      if (num(line.qty_requested) - assigned <= 0) continue;
      next.add(line.id);
      if (next.size >= quantity) break;
    }
    setSelectedLineIds(next);
  }

  async function saveScan() {
    if (!user || !activeAssignment || !activeLine || !activeRequest) return;
    const qty = num(scanQty);
    if (!scanLocation.trim() || !scanProduct.trim() || qty <= 0) {
      setMessage("Escanea ubicacion, producto y cantidad.");
      return;
    }
    const pickedNext = num(activeAssignment.picked_qty) + qty;
    const isMatch = [activeLine.product_code, activeLine.sku, activeLine.barcode].some(value => normalize(value) === normalize(scanProduct));
    if (!isMatch) {
      setCodeMismatch({
        expected: [activeLine.product_code, activeLine.sku, activeLine.barcode].filter(Boolean).join(" / "),
        scanned: scanProduct.trim(),
      });
      return;
    }
    const status = pickedNext >= num(activeAssignment.assigned_qty) ? "completado" : "en_proceso";

    const { error: scanError } = await supabase.from("picking_scans").insert({
      assignment_id: activeAssignment.id,
      request_id: activeRequest.id,
      line_id: activeLine.id,
      picker_id: user.id,
      picker_name: user.full_name,
      location_code: normalize(scanLocation),
      scanned_product_code: scanProduct.trim(),
      scanned_barcode: scanProduct.trim(),
      qty,
      is_match: isMatch,
    });
    if (scanError) {
      setMessage("No se pudo guardar el escaneo: " + scanError.message);
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
      setMessage("Escaneo guardado, pero no se actualizo progreso: " + updateError.message);
      return;
    }

    setScanLocation("");
    setScanProduct("");
    setScanQty("1");
    setAssignments(prev => prev.map(item => (
      item.id === activeAssignment.id ? { ...item, picked_qty: pickedNext, status } : item
    )));
    setMessage("Picking registrado.");
    await loadData(user);
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
      setMessage("Ingresa ubicacion y cantidad valida.");
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
      setMessage("No se pudo editar el registro: " + scanError.message);
      return;
    }

    const { error: assignmentError } = await supabase
      .from("picking_assignments")
      .update({ picked_qty: pickedNext, status, updated_at: new Date().toISOString(), completed_at: status === "completado" ? new Date().toISOString() : null })
      .eq("id", assignment.id);
    if (assignmentError) {
      setMessage("Registro editado, pero no se actualizo avance: " + assignmentError.message);
      return;
    }

    setEditingScanId("");
    setEditScanLocation("");
    setEditScanQty("");
    setAssignments(prev => prev.map(item => (
      item.id === assignment.id ? { ...item, picked_qty: pickedNext, status } : item
    )));
    setMessage("Registro actualizado.");
    await loadData(user);
  }

  function downloadReport(scope: "global" | "mine") {
    const rows = (scope === "mine" ? myAssignments : assignments).map(assignment => {
      const line = lines.find(item => item.id === assignment.line_id);
      const request = requests.find(item => item.id === assignment.request_id);
      return [
        request?.doc_number || request?.inv_request_no || "",
        request?.source_store_name || request?.source_store_code || "",
        request?.destination_store_name || request?.destination_store_code || "",
        assignment.picker_name,
        line?.product_code || "",
        line?.barcode || "",
        line?.description || "",
        assignment.assigned_qty,
        assignment.picked_qty,
        num(assignment.assigned_qty) - num(assignment.picked_qty),
        assignment.status,
      ];
    });
    const header = ["requerimiento", "tienda_entrega", "tienda_requiere", "picador", "codigo", "barra", "descripcion", "asignado", "picado", "pendiente", "estado"];
    const csv = [header, ...rows].map(row => row.map(csvValue).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `picking_${scope}_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!user) {
    return <main className="min-h-screen bg-slate-100 p-6 text-slate-700">Validando acceso...</main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
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

      <section className="mx-auto max-w-7xl p-4">
        {message && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">{message}</div>}

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
              <div className="flex rounded-2xl border bg-slate-100 p-1">
                <button
                  onClick={() => setPanel("asignacion")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "asignacion" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Asignacion
                </button>
                <button
                  onClick={() => setPanel("reportes")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "reportes" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Reportes
                </button>
                <button
                  onClick={() => setPanel("registros")}
                  className={`rounded-xl px-4 py-2 text-sm font-black ${panel === "registros" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                >
                  Registros
                </button>
              </div>
            </div>
          )}
        </div>}

        {manager && panel === "asignacion" && <div className="grid gap-3 md:grid-cols-3">
          {[
            ["Requerimientos", filteredRequests.length],
            ["Codigos requeridos", totals.required],
            ["Codigos asignados", totals.assigned],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-500">{label}</p>
              <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
            </div>
          ))}
        </div>}

        {loading ? (
          <div className="mt-6 rounded-2xl border bg-white p-8 text-center text-sm font-bold text-slate-500">Cargando picking...</div>
        ) : manager && panel === "asignacion" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]">
            <aside className="rounded-2xl border bg-white p-3 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-black">Requerimientos activos</h2>
                <button onClick={() => downloadReport("global")} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                  <Download size={16} />
                </button>
              </div>
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
                {filteredRequests.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400">No hay requerimientos activos para esta sede.</p>}
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
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {admin && (
                        <button onClick={() => forceHideRequest(selectedRequest)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-black text-red-700 hover:bg-red-100">
                          Forzar eliminacion
                        </button>
                      )}
                      <button onClick={() => window.location.href = "/"} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                        <ArrowLeft size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border bg-slate-50 p-3">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-black">Asignar a picador</p>
                        <p className="text-xs font-bold text-slate-500">Selecciona codigos o toma los primeros pendientes segun ubicacion.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => selectFirstPending(30)} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Primeros 30</button>
                        <button onClick={() => setSelectedLineIds(new Set(sortedVisibleLines.map(line => line.id)))} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Todos</button>
                        <button onClick={() => setSelectedLineIds(new Set())} className="rounded-xl border bg-white px-3 py-2 text-xs font-black hover:bg-slate-50">Limpiar</button>
                      </div>
                    </div>
                    <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                      <select value={selectedPickerId} onChange={event => setSelectedPickerId(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold">
                        <option value="">Picador</option>
                        {pickers.map(picker => <option key={picker.id} value={picker.id}>{picker.full_name}</option>)}
                      </select>
                      <button onClick={assignSelectedLines} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white hover:bg-violet-700">
                        <UserPlus size={16} />
                        <span className="ml-2">Asignar seleccionados ({selectedLineIds.size})</span>
                      </button>
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-black text-slate-500">Asignar codigo puntual</summary>
                      <div className="mt-2 grid gap-2 md:grid-cols-[1fr_140px_auto]">
                        <select value={selectedLineId} onChange={event => setSelectedLineId(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold">
                          <option value="">Codigo</option>
                          {sortedVisibleLines.map(line => (
                            <option key={line.id} value={line.id}>{line.product_code} - Pend. {Math.max(0, num(line.qty_requested) - (assignmentsByLine.get(line.id)?.reduce((sum, item) => sum + num(item.assigned_qty), 0) || 0))}</option>
                          ))}
                        </select>
                        <input value={assignQty} onChange={event => setAssignQty(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold" placeholder="Cantidad" inputMode="decimal" />
                        <button onClick={assignPicker} className="rounded-xl border bg-white px-4 py-2 text-sm font-black hover:bg-slate-50">
                          Asignar puntual
                        </button>
                      </div>
                    </details>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-2xl border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-white p-3">
                      <p className="text-xs font-black uppercase text-slate-500">{selectedLineIds.size} seleccionados</p>
                      <button
                        onClick={() => setLocationSort(locationSort === "asc" ? "desc" : "asc")}
                        className="rounded-xl border px-3 py-2 text-xs font-black hover:bg-slate-50"
                      >
                        Ubicaciones {locationSort === "asc" ? "A-Z" : "Z-A"}
                      </button>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                        <tr>
                          <th className="w-10 p-3 text-left">
                            <input
                              type="checkbox"
                              checked={sortedVisibleLines.length > 0 && sortedVisibleLines.every(line => selectedLineIds.has(line.id))}
                              onChange={event => {
                                if (event.target.checked) setSelectedLineIds(new Set(sortedVisibleLines.map(line => line.id)));
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
                        {sortedVisibleLines.map(line => {
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
                                      <p className="text-xs font-bold text-slate-700">{item.picker_name}: {num(item.picked_qty)}/{num(item.assigned_qty)}</p>
                                      <div className="mt-1 grid gap-1 sm:grid-cols-[1fr_auto]">
                                        <select
                                          value={reassignPickerByAssignmentId[item.id] || ""}
                                          onChange={event => setReassignPickerByAssignmentId(prev => ({ ...prev, [item.id]: event.target.value }))}
                                          className="min-w-0 rounded-lg border bg-white px-2 py-1 text-xs font-bold"
                                        >
                                          <option value="">Reasignar a...</option>
                                          {pickers.map(picker => <option key={picker.id} value={picker.id}>{picker.full_name}</option>)}
                                        </select>
                                        <button onClick={() => reassignAssignment(item.id)} className="rounded-lg bg-slate-950 px-2 py-1 text-xs font-black text-white">
                                          Reasignar
                                        </button>
                                      </div>
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
              <DonutCard title="Global" done={totals.picked} total={totals.required} detail="Picado vs solicitado total" />
              <DonutCard
                title="Requerimiento seleccionado"
                done={selectedRequestReport.done}
                total={selectedRequestReport.total}
                detail={selectedRequest?.doc_number || selectedRequest?.inv_request_no || "Sin seleccion"}
              />
            </div>

            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Requerimientos en proceso y completados</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {reportRequests.map(row => (
                  <button
                    key={row.request.id}
                    onDoubleClick={() => setSelectedRequestId(row.request.id)}
                    onClick={() => setSelectedRequestId(row.request.id)}
                    className={`rounded-2xl border p-4 text-left hover:border-violet-500 ${selectedRequest?.id === row.request.id ? "border-violet-600 bg-violet-50" : "bg-white"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black">{row.request.doc_number || row.request.inv_request_no}</p>
                        <p className="text-xs font-bold text-slate-500">Solicita: {requesterStoreLabel(row.request)}</p>
                        <p className="text-xs font-bold text-slate-500">Entrega: {storeLabel(row.request)}</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-black ${row.status === "Completado" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{row.status}</span>
                    </div>
                    <div className="mt-3 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-violet-600" style={{ width: `${pct(row.done, row.total)}%` }} /></div>
                    <p className="mt-1 text-xs font-black text-slate-500">{formatQty(row.done)} / {formatQty(row.total)} picado</p>
                  </button>
                ))}
                {reportRequests.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400 md:col-span-2 xl:col-span-3">Aun no hay requerimientos asignados.</p>}
              </div>
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

            {selectedRequest && <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
                <div>
                  <h2 className="font-black">Diferencias por codigo</h2>
                  <p className="text-xs font-bold text-slate-500">Picado vs solicitado y picado vs stock actual de la tienda que entrega.</p>
                </div>
                <button onClick={() => downloadReport("global")} className="rounded-xl border px-3 py-2 text-sm font-bold hover:bg-slate-50">
                  <Download size={16} />
                </button>
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
                    {reportRows.filter(row => row.request?.id === selectedRequest.id).map(row => (
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
                        <td className={`p-3 text-right font-black ${row.diffStock > 0 ? "text-red-600" : "text-slate-700"}`}>{formatQty(row.diffStock)}</td>
                      </tr>
                    ))}
                    {reportRows.filter(row => row.request?.id === selectedRequest.id).length === 0 && <tr><td colSpan={9} className="p-8 text-center text-sm font-bold text-slate-400">Sin diferencias para mostrar.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>}
          </section>
        ) : manager && panel === "registros" ? (
          <section className="mt-4 overflow-hidden rounded-2xl border bg-white shadow-sm">
            <div className="border-b p-4">
              <h2 className="font-black">Registros de picadores</h2>
              <p className="text-xs font-bold text-slate-500">Hora, picador, codigo solicitado, unidad ERP, ubicacion escaneada y cantidad registrada.</p>
            </div>
            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="p-3 text-left">Hora</th>
                    <th className="p-3 text-left">Picador</th>
                    <th className="p-3 text-left">Requerimiento</th>
                    <th className="p-3 text-left">Codigo</th>
                    <th className="p-3 text-left">Descripcion</th>
                    <th className="p-3 text-left">UM</th>
                    <th className="p-3 text-left">Ubicacion</th>
                    <th className="p-3 text-right">Cantidad</th>
                    <th className="p-3 text-left">Escaneado</th>
                  </tr>
                </thead>
                <tbody>
                  {scanRows.map(({ scan, line, request }) => (
                    <tr key={scan.id} className="border-t">
                      <td className="p-3 text-xs font-bold text-slate-500">{dateText(scan.created_at)}</td>
                      <td className="p-3 font-bold">{scan.picker_name || "-"}</td>
                      <td className="p-3 font-bold">{request?.doc_number || request?.inv_request_no || "-"}</td>
                      <td className="p-3 font-black">{line?.product_code || "-"}</td>
                      <td className="p-3 text-xs font-bold text-slate-500">{line?.description || "-"}</td>
                      <td className="p-3 font-black">{line?.unit || "-"}</td>
                      <td className="p-3 font-black">{scan.location_code}</td>
                      <td className="p-3 text-right font-black">{formatQty(num(scan.qty))}</td>
                      <td className={`p-3 text-xs font-black ${scan.is_match ? "text-emerald-700" : "text-red-600"}`}>{scan.scanned_product_code || scan.scanned_barcode || "-"}</td>
                    </tr>
                  ))}
                  {scanRows.length === 0 && <tr><td colSpan={9} className="p-8 text-center text-sm font-bold text-slate-400">Aun no hay registros de picadores.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="mt-4 space-y-4">
            <section className="rounded-2xl border bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">Mi avance</p>
                  <p className="text-xl font-black">{formatQty(operatorTotals.picked)} / {formatQty(operatorTotals.assigned)}</p>
                </div>
                <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-black text-violet-700">{operatorTotals.progress}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-violet-600" style={{ width: `${operatorTotals.progress}%` }} />
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
                            <p className="truncate text-xs font-bold text-slate-500">{request?.source_store_name || request?.source_store_code}</p>
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black text-slate-600">{line?.unit || "-"}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{line?.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cardLocations.length > 0 ? cardLocations.map(location => (
                            <span key={location} className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-black text-emerald-700">{location.replace(/\s*\([^)]*\)\s*$/, "")}</span>
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
                              <p className="text-xs font-semibold text-slate-500">{activeLine.description}</p>
                              <p className="text-xs font-black text-slate-700">Unidad solicitada: {activeLine.unit || "-"}</p>
                              <p className="text-xs font-bold text-slate-400">Ubicaciones: {(locationsByLine[activeLine.id] || []).map(location => location.replace(/\s*\([^)]*\)\s*$/, "")).join(", ") || "sin ubicacion registrada"}</p>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_120px_auto_auto]">
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <input value={scanLocation} onChange={event => setScanLocation(event.target.value)} className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold" placeholder="Escanear ubicacion" autoFocus />
                              <button onClick={() => setScannerTarget("location")} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-white" title="Abrir escaner de ubicacion">
                                <QrCode size={18} />
                              </button>
                            </div>
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <input value={scanProduct} onChange={event => setScanProduct(event.target.value)} className="min-w-0 rounded-xl border bg-white px-3 py-2 text-sm font-bold" placeholder="Escanear producto o barra" />
                              <button onClick={() => setScannerTarget("product")} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-white" title="Abrir escaner de producto">
                                <QrCode size={18} />
                              </button>
                            </div>
                            <input value={scanQty} onChange={event => setScanQty(event.target.value)} className="rounded-xl border bg-white px-3 py-2 text-sm font-bold" placeholder="Cantidad" inputMode="decimal" />
                            <button onClick={saveScan} className="rounded-xl bg-violet-600 px-3 py-2 text-sm font-black text-white hover:bg-violet-700">
                              <ClipboardList className="mr-1 inline" size={16} />
                              Guardar
                            </button>
                            <button onClick={() => { setScanLocation(""); setScanProduct(""); setScanQty("1"); }} className="rounded-xl border bg-white px-3 py-2 text-sm font-black hover:bg-slate-50">
                              Otra
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {openOperatorAssignments.length === 0 && <p className="p-6 text-center text-sm font-bold text-slate-400 md:col-span-2 xl:col-span-3">No tienes codigos pendientes.</p>}
              </div>
            </section>

            <section className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="font-black">Mis registros</h2>
              <p className="text-xs font-bold text-slate-500">Puedes editar ubicacion y cantidad. No se eliminan registros.</p>
              <div className="mt-3 space-y-2">
                {operatorScanRows.map(({ scan, line }) => (
                  <div key={scan.id} className="rounded-2xl border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-black">{line?.product_code || scan.scanned_product_code}</p>
                        <p className="text-xs font-bold text-slate-500">{line?.description}</p>
                        <p className="text-xs font-black text-slate-600">{dateText(scan.created_at)}</p>
                      </div>
                      <button onClick={() => startEditScan(scan)} className="rounded-xl border px-3 py-2 text-xs font-black hover:bg-slate-50">Editar</button>
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
